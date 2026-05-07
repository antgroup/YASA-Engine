const _ = require('lodash')
const Checker = require('../common/checker')
const Config = require('../../config')
const TaintCheckerAstUtil = require('../../util/ast-util')
const TaintCheckerFindingUtil = require('../../util/finding-util')
const TaintCheckerSourceLine = require('../../engine/analyzer/common/source-line')
const entryPointConfig = require('../../engine/analyzer/common/current-entrypoint')
const TaintCheckerRules = require('../common/rules-basic-handler')
const taintCheckerCommonUtil = require('../../util/common-util')
const QidUnifyUtil = require('../../util/qid-unify-util')

/**
 * basic class for taint-flow checker
 */
class TaintChecker extends Checker {
  sourceScope: any

  /**
   * constructor of TaintChecker
   * @param resultManager
   * @param checkerId
   */
  constructor(resultManager: any, checkerId: any) {
    super(resultManager, checkerId)
    this.sourceScope = {
      complete: false,
      value: [],
      fillLineValues: [],
    }
    taintCheckerCommonUtil.initSourceScope(this.sourceScope, this.checkerRuleConfigContent.sources?.TaintSource)
    this.sinkRuleArray = undefined
    this.matchSinkRuleResultMap = new Map()
  }

  /**
   * construct Taint flow finding detail info
   * @param finding
   */
  buildTaintFindingDetail(finding: any): any {
    const argNode = finding.nd
    const tagName = finding.kind
    const callNode = finding.node
    const sinkRule = finding.ruleName
    const { fclos, matchedSanitizerTags, callstack } = finding
    if (finding && argNode && argNode.taint?.isTaintedRec) {
      let traceStack = TaintCheckerFindingUtil.getTrace(argNode, tagName)
      const trace = TaintCheckerSourceLine.getNodeTrace(fclos, callNode)
      // 暂时统一去掉Field，不然展示出来的链路会重复
      traceStack = traceStack.filter((item: any) => item.tag !== 'Field: ')
      for (const i in traceStack) {
        if (traceStack[i].tag === 'Return value: ') {
          traceStack[i].tag = 'Return Value: '
        }
      }
      finding.trace = traceStack
      trace.tag = 'SINK: '
      trace.affectedNodeName = TaintCheckerAstUtil.prettyPrint(callNode?.callee)
      const arr = sinkRule.split('\nSINK Attribute: ')
      if (arr.length === 1) {
        finding.sinkRule = arr[0]
      } else if (arr.length === 2) {
        finding.sinkRule = arr[0]
        finding.sinkAttribute = arr[1].split(',')
      }
      finding.sinkInfo = {
        sinkRule: finding.sinkRule,
        sinkAttribute: finding.sinkAttribute,
      }
      const currentEntryPoint = entryPointConfig.getCurrentEntryPoint()
      finding.entrypointLoc = currentEntryPoint?.entryPointSymVal?.ast?.node?.loc
      finding.entrypoint = _.pickBy(_.clone(currentEntryPoint), (value: any) => !_.isObject(value))
      finding.trace.push(trace)
      finding.matchedSanitizerTags = matchedSanitizerTags
      finding.callstack = callstack
      // R21 判据 A：对 live callstack 中 body 内零 step 的 fclos 追加 synthetic CALL+ARG PASS step。
      // 仅在 taintTraceOutputStrategy=callstack-only（默认）下自动生效；非 CO 模式下 raw trace 本身已含 helper body step，无需补齐。
      const traceStrategy = Config.taintTraceOutputStrategy
      const isCallstackOnly = traceStrategy === 'callstack-only' || traceStrategy === 'folded' || !traceStrategy
      if (isCallstackOnly) {
        this.filterTraceToCallstackOrder(finding)
        this.synthesizeBridgeSteps(finding)
        if (!this.verifyCallstackEdgeInvariant(finding)) return null
      }
    }
    this.filterDuplicateSource(finding)
    return finding
  }

  /**
   * 计算 step 在 callstack 中的 innermost 覆盖 fclos idx（最深覆盖）。返回 -1 表示该 step 不在任何
   * callstack fclos body 范围内（helper 函数体 / 外部）。
   * @param step
   * @param callstack
   */
  private getStepInnermostIdx(step: any, callstack: any[]): number {
    const sFile = step?.node?.loc?.sourcefile || step?.file
    const sLineRaw = step?.node?.loc?.start?.line ?? step?.line
    const sLine = Array.isArray(sLineRaw) ? sLineRaw[0] : sLineRaw
    if (typeof sLine !== 'number') return -1
    let innermost = -1
    for (let j = 0; j < callstack.length; j++) {
      const loc = callstack[j]?.ast?.node?.loc
      if (!loc?.sourcefile || typeof loc.start?.line !== 'number' || typeof loc.end?.line !== 'number') continue
      if (sFile === loc.sourcefile && sLine >= loc.start.line && sLine <= loc.end.line) {
        if (j > innermost) innermost = j
      }
    }
    return innermost
  }

  /**
   * 两阶段裁剪 trace 到 callstack 对齐状态：
   *
   * Step 1a：丢弃所有 `innermost === -1`（不在任何 callstack fclos body 内）的 step——helper 函数体里的
   *   CALL / ARG PASS / Var Pass / CALL RETURN 等都会被清除。SOURCE / SINK step 例外保留（它们的 loc 可能
   *   指向不在 callstack 的上下文，但语义上必须保留）。
   *
   * Step 1b：walk 剩余 trace，维护 `expected`（下一跳应进入的 callstack idx，初始 = 1）。遇到 ARG PASS：
   *   - innermost === expected（callee-side，在被调方 body 内）→ 接受，expected++
   *   - innermost === expected - 1（caller-side，在 caller body 内）→ 接受，expected++（放宽）
   *   - 其它（包括 innermost > expected 的跳层、innermost < expected-1 的回跳、以及 expected 已到顶之后的
   *     多余 ARG PASS）→ 丢弃，同时把紧邻前一个 CALL step 一起丢（成对清理，避免孤儿 CALL）
   *
   * 执行完后 trace 里的 CALL+ARG PASS 对严格对应 callstack 的跳转序列（可能仍有缺失，缺失由后续
   * synthesizeBridgeSteps 合成补齐）。
   * @param finding
   */
  filterTraceToCallstackOrder(finding: any): void {
    const callstack = finding?.callstack
    const trace = finding?.trace
    if (!Array.isArray(callstack) || !Array.isArray(trace)) return

    // Step 1a：清掉 callstack 外的所有 step（SOURCE/SINK 豁免）
    const inCallstack = trace.filter((s: any) => {
      if (s?.tag === 'SOURCE: ' || s?.tag === 'SINK: ') return true
      return this.getStepInnermostIdx(s, callstack) >= 0
    })

    // Step 1b：CALL+ARG PASS 对按 callstack 顺序过滤
    let expected = 1
    const drop = new Set<number>()
    for (let i = 0; i < inCallstack.length; i++) {
      const s = inCallstack[i]
      if (s?.tag !== 'ARG PASS: ') continue
      const inner = this.getStepInnermostIdx(s, callstack)
      // 只有 expected 尚未到达栈顶时才有新跳转可接受；inner 等于 expected（callee-side）或 expected-1（caller-side）即视为合法下一跳
      if (expected < callstack.length && (inner === expected || inner === expected - 1)) {
        expected++
      } else {
        drop.add(i)
        // 成对丢弃：紧邻前一个 CALL step 是这条 ARG PASS 的 caller，一起清理避免孤儿 CALL
        if (i > 0 && inCallstack[i - 1]?.tag === 'CALL: ') drop.add(i - 1)
      }
    }

    finding.trace = inCallstack.filter((_: any, i: number) => !drop.has(i))
  }

  /**
   * 校验 CO 模式下 callstack 与 trace 的点-边不变量：callstack.length+1（点数：fclos+sink 条目）必须
   * 等于 "有效 CALL+ARG PASS 对数 + SINK 数"（边数）+ 1。
   *
   * 有效对：ARG PASS step 的 innermost 覆盖 fclos 为 callstack 非入口条目（idx ≥ 1）。Helper 函数
   * （如 `getUrl`，不在 sink 时 callstack 上）的 CALL+ARG PASS 不计。按 fclos idx 去重——同 fclos 多个
   * ARG PASS 只算 1 对。
   *
   * 违反即说明 synthesizeBridgeSteps 漏补桥接帧或 trace 与 callstack 结构不一致，返回 false 让上层丢弃 finding。
   * @param finding
   * @returns true 表示通过校验；false 表示违反不变量，finding 应被丢弃
   */
  verifyCallstackEdgeInvariant(finding: any): boolean {
    const callstack = finding?.callstack
    const trace = finding?.trace
    if (!Array.isArray(callstack) || !Array.isArray(trace)) return true

    // 收集所有 ARG PASS step innermost 覆盖的 fclos idx（仅 idx >= 1）
    const argPassFclosIdx = new Set<number>()
    for (const s of trace) {
      if (s?.tag !== 'ARG PASS: ') continue
      const sFile = s?.node?.loc?.sourcefile || s?.file
      const sLineRaw = s?.node?.loc?.start?.line ?? s?.line
      const sLine = Array.isArray(sLineRaw) ? sLineRaw[0] : sLineRaw
      if (typeof sLine !== 'number') continue
      let innermost = -1
      for (let j = 0; j < callstack.length; j++) {
        const loc = callstack[j]?.ast?.node?.loc
        if (!loc?.sourcefile || typeof loc.start?.line !== 'number' || typeof loc.end?.line !== 'number') continue
        if (sFile === loc.sourcefile && sLine >= loc.start.line && sLine <= loc.end.line) {
          if (j > innermost) innermost = j
        }
      }
      if (innermost >= 1) argPassFclosIdx.add(innermost)
    }

    const pairs = argPassFclosIdx.size
    const sinks = trace.filter((s: any) => s?.tag === 'SINK: ').length
    // 与 synthesizeBridgeSteps 的 fcloses 收录条件保持对齐：只数 callstack 中有合法 loc（含 sourcefile + start/end line）
    // 的条目，再 +1 计入 SARIF prepareCallstackElements 追加的 sink 条目。无 loc 的桥接帧（如 lib summary 的
    // `<global>.Promise`）合成阶段拿不到 file:line 也补不出 CALL+ARG PASS，按节点数计入会让 invariant 永远失衡。
    let countedFcloses = 0
    for (const fclos of callstack) {
      const loc = fclos?.ast?.node?.loc
      if (!loc?.sourcefile || typeof loc.start?.line !== 'number' || typeof loc.end?.line !== 'number') continue
      countedFcloses++
    }
    const nodes = countedFcloses + 1
    const edges = pairs + sinks
    return nodes === edges + 1
  }

  /**
   * 对 finding.callstack 中"body 内零 trace step"的 fclos 插入一对 synthetic CALL + ARG PASS step。
   *
   * 核心算法（按 callstack 深度穿插插入，而非一律追加末尾）：
   *   1. 给 callstack 每个 fclos 编 depth（= 其在 callstack 的 idx，0 = 最外层入口，高 = 更深）
   *   2. 给 trace 每个非合成 step 算 depth = callstack 中包含该 step file:line 的 **最深** fclos idx
   *   3. 找出 "没有任何 step 落在其 body 内" 的 fclos（uncovered fclos）
   *   4. 对每个 uncovered fclos f @ depth d：
   *        在 trace 中找到第一个 depth(step) ≥ d 的 step，把 CALL+ARG PASS(f) 插在该 step 之前
   *        （即：从 callstack 浅处走向 ≥ d 的深度转换点）
   *
   * synthetic step 的 node 字段设为 fclos.ast.node（FunctionDefinition），使 SARIF 的 codeFlow
   * nodeHash（取自 item.node._meta.nodehash）恰等于 callstack 对应条目的 nodeHash。
   *
   * 标记 _synthetic:true 供 isNewFinding 在 CO 折叠判据时过滤合成 step 再比较，防止 degenerate
   * SOURCE+SINK 折叠被破坏。_synthetic 字段不经 SARIF 序列化路径。
   *
   * 同一 beforeIdx 多条 uncovered fclos 按深度从 inner 到 outer 依次 splice，splice 的"插入即推后"
   * 语义使最终 trace 中外层 fclos 排在内层之前；SINK step 保持末尾。
   * @param finding
   */
  synthesizeBridgeSteps(finding: any): void {
    const callstack = finding?.callstack
    const trace = finding?.trace
    const callsites = finding?.callsites
    if (!Array.isArray(callstack) || !Array.isArray(trace) || trace.length === 0) return

    type FclosInfo = {
      idx: number
      file: string
      startLine: number
      endLine: number
      node: any
      fname: string
    }
    const fcloses: FclosInfo[] = []
    callstack.forEach((fclos: any, idx: number) => {
      if (!fclos || fclos.vtype !== 'fclos') return
      const loc = fclos.ast?.node?.loc
      const sourcefile: string | undefined = loc?.sourcefile
      const startLine = loc?.start?.line
      const endLine = loc?.end?.line
      if (!sourcefile || typeof startLine !== 'number' || typeof endLine !== 'number') return
      // fname 用 QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix 统一清洗：去掉 `<block>` / `<global>.packageManager` /
      // `<instance>` / `<copied*>` / `<cloned*>` / `<syslib*>` 等流敏感标签与 yasa 内部前缀，保证 affectedNodeName 可读
      const rawName = fclos.ast?.node?.id?.name || fclos.fname || fclos.qid || '<bridge>'
      const cleanedName = QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(rawName) || rawName
      fcloses.push({
        idx,
        file: sourcefile,
        startLine,
        endLine,
        node: fclos.ast.node,
        fname: cleanedName,
      })
    })
    if (fcloses.length === 0) return

    const sinkIdx = trace.length - 1
    const sinkStepIsSinkTag = trace[sinkIdx]?.tag === 'SINK: '

    // 计算每个 step 的 depth（最深覆盖 fclos idx）；未被任何 fclos 覆盖的 step depth=-1。
    // 合成 step 也正常参与深度计算，保证 synthesizeBridgeSteps 幂等（二次调用时合成 ARG PASS 已覆盖原 uncovered fclos 不会再次注入）。
    const depths: number[] = trace.map((s: any) => {
      const sFile = s?.node?.loc?.sourcefile || s?.file
      const sLineRaw = s?.node?.loc?.start?.line ?? s?.line
      const sLine = Array.isArray(sLineRaw) ? sLineRaw[0] : sLineRaw
      if (typeof sLine !== 'number') return -1
      let innermost = -1
      for (const f of fcloses) {
        if (sFile === f.file && sLine >= f.startLine && sLine <= f.endLine) {
          if (f.idx > innermost) innermost = f.idx
        }
      }
      return innermost
    })

    // fclos 覆盖判据：body 内需要至少一条 ARG PASS step（自然或合成均可）。
     // 闭包捕获场景下深层 fclos 只会出现 SOURCE 而无形参 ARG PASS，必须由 synthesize 补桥接，否则
     // verifyCallstackEdgeInvariant 数不到这一对会丢整条 finding；故此处 SOURCE 不再计为已覆盖。
    const coveredByArgPass = new Set<number>()
    trace.forEach((s: any, i: number) => {
      if (depths[i] < 0) return
      if (s?.tag === 'ARG PASS: ') {
        coveredByArgPass.add(depths[i])
      }
    })
    // 入口 fclos（idx 0）不需要合成（它由 SOURCE step 标记入参），其它 fclos 若无 ARG PASS 覆盖即需合成
    const uncovered = fcloses.filter((f) => f.idx > 0 && !coveredByArgPass.has(f.idx))
    if (uncovered.length === 0) return

    // 为每个 uncovered fclos 找插入位置：trace 中第一个 depth >= f.idx 的 step；找不到则在 SINK 前兜底
    // 跳过 _synthetic step（保证幂等）和 SOURCE step（语义：SOURCE 是污点起点，应排在 CALL/ARG PASS 之前）
    type Insertion = { beforeIdx: number; fclos: FclosInfo }
    const insertions: Insertion[] = []
    for (const f of uncovered) {
      let beforeIdx = sinkStepIsSinkTag ? sinkIdx : trace.length
      for (let i = 0; i < trace.length; i++) {
        if (sinkStepIsSinkTag && i === sinkIdx) break
        if (trace[i]?._synthetic) continue
        if (trace[i]?.tag === 'SOURCE: ') continue
        if (depths[i] >= f.idx) {
          beforeIdx = i
          break
        }
      }
      insertions.push({ beforeIdx, fclos: f })
    }

    // 按 beforeIdx 降序处理，避免前插导致后续 idx 失效；同 beforeIdx 时 fclos.idx 降序（inner 先 splice
    // 进去，外层后 splice 会占据更靠前位置，最终 outer→inner 顺序正确）
    insertions.sort((a, b) => {
      if (a.beforeIdx !== b.beforeIdx) return b.beforeIdx - a.beforeIdx
      return b.fclos.idx - a.fclos.idx
    })

    for (const ins of insertions) {
      // 选 signature 行：优先 fdef.id（方法名所在行），其次 body 起始行，最后回落到 fdef.loc.start.line。
      // fdef.loc.start 可能落在注解（@Override）或匿名类 new 表达式所在行，导致 SARIF snippet 取到错误源码。
      const idLine = ins.fclos.node?.id?.loc?.start?.line
      const bodyLine = ins.fclos.node?.body?.loc?.start?.line
      const signatureLine: number =
        typeof idLine === 'number' ? idLine : typeof bodyLine === 'number' ? bodyLine : ins.fclos.startLine
      // ARG PASS wrapper：loc 落 callee 签名行，_meta.nodehash 经原型继承自 fdef.ast.node（保 callstack nodeHash 等式）
      const argPassNode = Object.create(ins.fclos.node)
      argPassNode.loc = {
        sourcefile: ins.fclos.file,
        start: { line: signatureLine, column: 0 },
        end: { line: signatureLine, column: 0 },
      }
      // CALL wrapper：优先用 finding.callsites[idx] 的真实 callsite（loc 落在 caller body 的 CallExpression 所在行），
      // nodehash 取 callsites[idx].nodeHash；callsites 缺位或字段不全时回退到 fdef 签名行 + fdef nodehash（与旧行为等价）。
      const callsite = Array.isArray(callsites) ? callsites[ins.fclos.idx] : undefined
      const siteLoc = callsite?.loc
      const siteLineRaw = siteLoc?.start?.line
      const siteLine = Array.isArray(siteLineRaw) ? siteLineRaw[0] : siteLineRaw
      const hasSiteLoc = typeof siteLine === 'number' && typeof siteLoc?.sourcefile === 'string'
      let callNode: any
      let callFile: string
      let callLine: number
      if (hasSiteLoc) {
        callFile = siteLoc.sourcefile
        callLine = siteLine
        // 以 fdef 为原型，确保 nodehash 缺位时自然回退到 fdef._meta.nodehash
        callNode = Object.create(ins.fclos.node)
        callNode.loc = siteLoc
        if (typeof callsite?.nodeHash !== 'undefined') {
          callNode._meta = { nodehash: callsite.nodeHash }
        }
      } else {
        callFile = ins.fclos.file
        callLine = signatureLine
        callNode = argPassNode
      }
      const callStep = {
        file: callFile,
        line: callLine,
        tag: 'CALL: ',
        node: callNode,
        affectedNodeName: ins.fclos.fname,
        _synthetic: true,
      }
      const argPassStep = {
        file: ins.fclos.file,
        line: signatureLine,
        tag: 'ARG PASS: ',
        node: argPassNode,
        affectedNodeName: ins.fclos.fname,
        _synthetic: true,
      }
      trace.splice(ins.beforeIdx, 0, callStep, argPassStep)
    }

    // Pass 2：扫描每个 ARG PASS step，若紧邻前驱不是 CALL（analyzer 在某些 AST 模式下——例如 Python
    // fullfileManagerMade 入口或嵌套 def 跨层调用——只写了 ARG PASS 没写 CALL）则按 callsites[innermost_idx]
    // 合成一个 CALL 插到它前面，保证 CALL/ARG PASS 成对出现。反向遍历避免 splice 导致索引失效。
    // 仅当 callsite line 与 ARG PASS step line 不同才合成：JS entrypoint 的 callsites[0] 常指向 fclos 自身
    // body 起始行，不是真正的 caller-side callsite，用这种 loc 造 CALL 会重复 ARG PASS 的位置信息。
    for (let i = trace.length - 1; i >= 0; i--) {
      const step = trace[i]
      if (step?.tag !== 'ARG PASS: ') continue
      if (i > 0 && trace[i - 1]?.tag === 'CALL: ') continue
      const innermostIdx = this.getStepInnermostIdx(step, callstack)
      if (innermostIdx < 0) continue
      const callsite = Array.isArray(callsites) ? callsites[innermostIdx] : undefined
      const siteLoc = callsite?.loc
      const siteLineRaw = siteLoc?.start?.line
      const siteLine = Array.isArray(siteLineRaw) ? siteLineRaw[0] : siteLineRaw
      if (typeof siteLine !== 'number' || typeof siteLoc?.sourcefile !== 'string') continue
      const argPassLineRaw = step?.node?.loc?.start?.line ?? step?.line
      const argPassLine = Array.isArray(argPassLineRaw) ? argPassLineRaw[0] : argPassLineRaw
      const argPassFile = step?.node?.loc?.sourcefile || step?.file
      if (siteLine === argPassLine && siteLoc.sourcefile === argPassFile) continue
      const fclos = callstack[innermostIdx]
      const rawName = fclos?.ast?.node?.id?.name || fclos?.fname || fclos?.qid || '<bridge>'
      const fname = QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(rawName) || rawName
      const callNode = Object.create(fclos?.ast?.node || {})
      callNode.loc = siteLoc
      if (typeof callsite?.nodeHash !== 'undefined') {
        callNode._meta = { nodehash: callsite.nodeHash }
      }
      const callStep = {
        file: siteLoc.sourcefile,
        line: siteLine,
        tag: 'CALL: ',
        node: callNode,
        affectedNodeName: fname,
        _synthetic: true,
      }
      trace.splice(i, 0, callStep)
    }
  }

  /**
   * 去掉链路中重复的source，以免链路可读性降低
   * @param finding
   */
  filterDuplicateSource(finding: any): void {
    if (!finding || !finding.trace || !Array.isArray(finding.trace)) return
    // 语义：保留 trace 中首个 SOURCE step，丢弃后续重复。原实现按位置（key > 1）判定在 SOURCE 前插入合成
    // CALL/ARG PASS 的场景会误删真实 SOURCE；改为按"已见过一次 SOURCE 就丢后续"的语义。
    const newTrace = []
    let sawSource = false
    for (const step of finding.trace) {
      const isSource =
        step?.tag === 'SOURCE: ' || (typeof step?.str === 'string' && step.str.includes('SOURCE: '))
      if (isSource) {
        if (sawSource) continue
        sawSource = true
      }
      newTrace.push(step)
    }
    finding.trace = newTrace
  }

  /**
   * construct taint flow finding object with detail info
   * @param checkerId
   * @param checkerDesc
   * @param node
   * @param nd
   * @param fclos
   * @param kind
   * @param ruleName
   * @param matchedSanitizerTags
   * @param callstack
   */
  buildTaintFinding(
    checkerId: any,
    checkerDesc: any,
    node: any,
    nd: any,
    fclos: any,
    kind: any,
    ruleName: any,
    matchedSanitizerTags: any,
    callstack: any,
    callsites?: any
  ): any {
    const taintFlowFinding = this.buildTaintFindingObject(
      checkerId,
      checkerDesc,
      node,
      nd,
      fclos,
      kind,
      ruleName,
      matchedSanitizerTags,
      callstack,
      callsites
    )
    return this.buildTaintFindingDetail(taintFlowFinding)
  }

  /**
   * construct taint flow finding object
   * @param checkerId
   * @param checkerDesc
   * @param node
   * @param nd
   * @param fclos
   * @param kind
   * @param ruleName
   * @param matchedSanitizerTags
   * @param callstack
   */
  buildTaintFindingObject(
    checkerId: any,
    checkerDesc: any,
    node: any,
    nd: any,
    fclos: any,
    kind: any,
    ruleName: any,
    matchedSanitizerTags: any,
    callstack: any,
    callsites?: any
  ): any {
    const taintFlowFinding = TaintCheckerRules.getFinding(checkerId, checkerDesc, node)
    taintFlowFinding.nd = nd
    taintFlowFinding.node = node
    taintFlowFinding.fclos = fclos
    taintFlowFinding.kind = kind
    taintFlowFinding.ruleName = ruleName
    taintFlowFinding.matchedSanitizerTags = matchedSanitizerTags
    taintFlowFinding.callstack = callstack
    // callsites 与 callstack 长度一致，每项结构 { code, nodeHash, loc }，由 analyzer 在 CallExpression 进入被调函数时入栈
    taintFlowFinding.callsites = callsites
    return taintFlowFinding
  }

  /**
   *
   * @param tagName
   * @param sources
   */
  addSourceTagForSourceScope(tagName: string, sources: any): void {
    if (!sources || !tagName) return
    if (Array.isArray(sources) && sources.length > 0) {
      for (const source of sources) {
        source.kind = source.kind || []
        source.kind = Array.isArray(source.kind) ? source.kind : [source.kind]
        if (!source.kind.includes(tagName)) {
          source.kind.push(tagName)
        }
      }
    }
  }

  /**
   *
   * @param tagName
   * @param checkerRuleConfigContent
   */
  addSourceTagForcheckerRuleConfigContent(tagName: string, checkerRuleConfigContent: any): void {
    if (!tagName) return
    if (
      Array.isArray(checkerRuleConfigContent.sources?.TaintSource) &&
      checkerRuleConfigContent.sources?.TaintSource.length > 0
    ) {
      for (const source of checkerRuleConfigContent.sources?.TaintSource) {
        source.kind = source.kind || []
        source.kind = Array.isArray(source.kind) ? source.kind : [source.kind]
        if (!source.kind.includes(tagName)) {
          source.kind.push(tagName)
        }
      }
    }
    if (
      Array.isArray(checkerRuleConfigContent.sources?.FuncCallArgTaintSource) &&
      checkerRuleConfigContent.sources?.FuncCallArgTaintSource.length > 0
    ) {
      for (const source of checkerRuleConfigContent.sources?.FuncCallArgTaintSource) {
        source.kind = source.kind || []
        source.kind = Array.isArray(source.kind) ? source.kind : [source.kind]
        if (!source.kind.includes(tagName)) {
          source.kind.push(tagName)
        }
      }
    }
    if (
      Array.isArray(checkerRuleConfigContent.sources?.FuncCallReturnValueTaintSource) &&
      checkerRuleConfigContent.sources?.FuncCallReturnValueTaintSource.length > 0
    ) {
      for (const source of checkerRuleConfigContent.sources?.FuncCallReturnValueTaintSource) {
        source.kind = source.kind || []
        source.kind = Array.isArray(source.kind) ? source.kind : [source.kind]
        if (!source.kind.includes(tagName)) {
          source.kind.push(tagName)
        }
      }
    }
  }
}

module.exports = TaintChecker
