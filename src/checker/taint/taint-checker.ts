import type { TaintFinding } from '../../engine/analyzer/common/common-types'
import type { TraceItem } from '../../util/finding-util'

const _ = require('lodash')
const Checker = require('../common/checker')
const Config = require('../../config')
const TaintCheckerAstUtil = require('../../util/ast-util')
const TaintCheckerFindingUtil = require('../../util/finding-util')
const TaintCheckerSourceLine = require('../../engine/analyzer/common/source-line')
const entryPointConfig = require('../../engine/analyzer/common/entrypoint/current-entrypoint')
const TaintCheckerRules = require('../common/rules-basic-handler')
const taintCheckerCommonUtil = require('../../util/common-util')
const { buildJavaCandidateFinding } = require('./java/java-finding-candidate') as typeof import('./java/java-finding-candidate')
const { getCalleeEntry } = require('./java/callee-entry') as typeof import('./java/callee-entry')

interface SourceLocation {
  sourcefile?: string
  start?: { line?: number }
  end?: { line?: number }
}

interface AstNodeWithLocation {
  type?: string
  loc?: SourceLocation
  _meta?: { nodehash?: string }
  parent?: AstNodeWithLocation
  id?: { name?: string; loc?: SourceLocation }
  body?: { loc?: SourceLocation }
}

interface CallstackFrame {
  vtype?: string
  ast?: { node?: AstNodeWithLocation }
  fname?: string
  qid?: string
}

interface CallsiteFrame {
  code?: string
  nodeHash?: string
  loc?: SourceLocation
}

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
      const traceStack = TaintCheckerFindingUtil.getTrace(argNode, tagName)
      if (!Array.isArray(traceStack)) {
        return null
      }
      const canonicalTrace = traceStack.filter((item: TraceItem) => item.tag !== 'Field: ')
      const boundaryTrace = this.extractBoundaryValidTrace(canonicalTrace)
      if (this.isExplicitForeignSourceTrace(boundaryTrace)) {
        return null
      }
      for (const item of boundaryTrace) {
        if (item.tag === 'Return value: ') item.tag = 'Return Value: '
      }
      const trace = TaintCheckerSourceLine.getNodeTrace(fclos, callNode) as TraceItem
      finding.callstack = callstack
      if (!this.validateSourceCallstackConnection(boundaryTrace, callstack)) {
        return null
      }
      if (trace) {
        trace.tag = 'SINK: '
        trace.affectedNodeName = TaintCheckerAstUtil.prettyPrint(callNode?.callee)
      }
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
      if (trace) boundaryTrace.push(trace)
      finding.trace = boundaryTrace
      finding.matchedSanitizerTags = matchedSanitizerTags
      if (!this.validateTraceBoundary(finding, trace)) {
        return null
      }
      // callstack-only 输出需要为缺少 body 内 trace step 的调用补充可见桥接节点。
      // 其他输出模式保留原始 trace，不额外注入展示用节点。
      const traceStrategy = Config.taintTraceOutputStrategy
      const isCallstackOnly = traceStrategy === 'callstack-only' || traceStrategy === 'folded' || !traceStrategy
      if (isCallstackOnly) {
        finding.trace = this.filterTraceToCallstackOrder(finding, finding.trace) as TraceItem[]
        finding.trace = this.synthesizeBridgeSteps(finding, finding.trace) as TraceItem[]
        if (!this.validateArgPassSegmentWithinFrame(finding)) {
          return null
        }
        this.dedupCallArgPassEdgesByCallee(finding)
        if (!this.validateTraceBoundary(finding, trace)) return null
        if (!this.verifyCallstackEdgeInvariant(finding)) return null
        // 动态 ARG PASS 作用域栈后补：剔除 taint 整段复制串进来的孤儿步（跨函数但非合法入/出帧）。
        // 仅 Java finding；User 2026-09-20 授权的落点 D 后补例外（绕过「源头修」铁律）。
        this.pruneOrphanByArgPassScopeStack(finding)
        // 结果层裁剪 propagation 乱序步（细节见 truncateAfterSinkFrameEnter）：sink 帧入帧后浅帧续行、
        // 入帧边前的幻影 body、紧接入帧边的早返 CALL RETURN。不丢 SOURCE/SINK/ARG PASS，validPairs 不变。
        this.truncateAfterSinkFrameEnter(finding)
        // buildJavaCandidateFinding 是 Java 专精资产，依赖 Java callstack+callsites 结构重建最小链路；
        // 非 Java finding 走它会因结构不符 return null 整条丢。仅对 Java taint type finding 触发 mock 重建路径。
        if ((finding.type === 'taint_flow_java_input' || finding.type === 'taint_flow_java_input_inner') && !this.verifyArgPassOrderConsistency(finding)) {
          const candidate = buildJavaCandidateFinding(finding)
          if (!candidate) return null
          // 原 finding 继续拒绝；该标记仅供 Java 入口 collector 接收精简候补。
          return candidate
        }
      }
    }
    if (finding?.trace) {
      finding.trace = this.filterDuplicateSource(finding, finding.trace) as TraceItem[]
      finding.trace = this.dedupAdjacentTraceSteps(finding, finding.trace) as TraceItem[]
    }
    if (!this.validateTraceBoundary(finding)) return null
    return finding
  }

  private isExplicitForeignSourceTrace(trace: TraceItem[]): boolean {
    const currentOwner = entryPointConfig.getEntryPointOwnerKey()
    if (!currentOwner) return false
    for (const item of trace) {
      if (item?.tag !== 'SOURCE: ') continue
      const owner = item?.source_owner_ep
      if (typeof owner === 'string' && owner.length > 0 && owner !== currentOwner) return true
    }
    return false
  }

  /** 历史传播合并可能保留旧边界；输出前只收敛到当前 SOURCE 到当前 sink 的连续片段。 */
  private extractBoundaryValidTrace(trace: TraceItem[]): TraceItem[] {
    const firstSourceIdx = trace.findIndex((item: TraceItem) => item?.tag === 'SOURCE: ')
    if (firstSourceIdx < 0) return trace
    let endIdx = trace.length
    for (let i = firstSourceIdx + 1; i < trace.length; i++) {
      if (trace[i]?.tag === 'SINK: ') {
        endIdx = i + 1
        break
      }
    }
    return firstSourceIdx === 0 && endIdx === trace.length ? trace : trace.slice(firstSourceIdx, endIdx)
  }

  /**
   * finding 边界只做真实性校验，不重排证据链；SOURCE/SINK 不在首尾说明 trace 不可信。
   * @param finding
   * @param expectedSink 当前命中的 sink step，用于禁止历史 SINK 冒充边界
   * @returns true 表示 trace 可输出；false 表示边界缺失或结构错误
   */
  private validateTraceBoundary(finding: TaintFinding, expectedSink?: TraceItem): boolean {
    const trace = finding?.trace as TraceItem[] | undefined
    if (!Array.isArray(trace) || trace.length < 2) return false

    const firstStep = trace[0]
    const lastStep = trace[trace.length - 1]
    if (firstStep?.tag !== 'SOURCE: ' || lastStep?.tag !== 'SINK: ') return false
    if (expectedSink && lastStep !== expectedSink) return false
    if (!lastStep?.file && !lastStep?.node?.loc?.sourcefile) return false

    for (let i = 1; i < trace.length - 1; i++) {
      const tag = trace[i]?.tag
      if (tag === 'SOURCE: ' || tag === 'SINK: ') return false
    }
    return true
  }


  private getCallstackFunctionHashes(callstack: unknown): Set<string> {
    const hashes = new Set<string>()
    if (!Array.isArray(callstack)) return hashes
    for (const fclos of callstack as CallstackFrame[]) {
      const hash = fclos?.ast?.node?._meta?.nodehash
      if (typeof hash === 'string' && hash) hashes.add(hash)
    }
    return hashes
  }

  /**
   * Java callstack-only 链路必须由真实 SOURCE 函数进入当前 callstack，避免跨入口污染节点被错拼到当前 sink。
   * @param traceStack
   * @param callstack
   */
  private validateSourceCallstackConnection(traceStack: TraceItem[], callstack: unknown): boolean {
    if (!Array.isArray(traceStack) || traceStack.length === 0) return true
    const sourceStep = traceStack[0]
    const sourceFile = sourceStep?.node?.loc?.sourcefile || sourceStep?.file
    if (sourceStep?.tag !== 'SOURCE: ' || typeof sourceFile !== 'string' || !sourceFile.endsWith('.java')) return true
    const currentOwner = entryPointConfig.getEntryPointOwnerKey()
    if (typeof sourceStep?.source_owner_ep === 'string' && sourceStep.source_owner_ep === currentOwner) return true
    const sourceFunctionHash = this.getStepFunctionNodeHash(sourceStep)
    if (!sourceFunctionHash) return true
    const callstackFunctionHashes = this.getCallstackFunctionHashes(callstack)
    if (callstackFunctionHashes.size === 0) return true
    return callstackFunctionHashes.has(sourceFunctionHash)
  }

  /**
   * 计算 step 所属的最近 FunctionDefinition nodeHash，避免外层函数行号范围误覆盖匿名/嵌套函数。
   * @param step
   */
  private getStepFunctionNodeHash(step: TraceItem): string | undefined {
    let node = step?.node as AstNodeWithLocation | undefined
    while (node) {
      if (node.type === 'FunctionDefinition') {
        const nodeHash = node._meta?.nodehash
        return typeof nodeHash === 'string' && nodeHash ? nodeHash : undefined
      }
      node = node.parent
    }
    return undefined
  }

  /**
   * 计算 step 在 callstack 中的 innermost 覆盖 fclos idx（最深覆盖）。返回 -1 表示该 step 不在任何
   * callstack fclos body 范围内（helper 函数体 / 外部）。
   * @param step
   * @param callstack
   */
  private getStepInnermostIdx(step: TraceItem, callstack: CallstackFrame[], useFunctionHash = true): number {
    const sFile = step?.node?.loc?.sourcefile || step?.file
    const useFunctionNodeHash =
      useFunctionHash
      && typeof sFile === 'string'
      && sFile.endsWith('.java')
      && step?.tag !== 'SOURCE: '
      && step?.tag !== 'SINK: '
    if (useFunctionNodeHash) {
      const stepFunctionNodeHash = this.getStepFunctionNodeHash(step)
      if (stepFunctionNodeHash) {
        for (let j = 0; j < callstack.length; j++) {
          const fclosNodeHash = callstack[j]?.ast?.node?._meta?.nodehash
          if (fclosNodeHash === stepFunctionNodeHash) return j
        }
        // 闭包/lambda 的 FunctionDefinition 不在 callstack 上，fallback 到行号范围匹配
      }
    }

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
   * 校验每个 ARG PASS 后的传播片段仍处于该 ARG PASS 对应的 callstack frame 内。
   * @param finding
   * @returns true 表示 segment 未漂移；false 表示整条 finding 应被丢弃
   */
  private validateArgPassSegmentWithinFrame(finding: TaintFinding): boolean {
    const callstack = finding?.callstack
    const trace = finding?.trace as TraceItem[] | undefined
    if (!Array.isArray(callstack) || !Array.isArray(trace)) return true

    const frames = callstack as CallstackFrame[]
    let currentFrameIdx = -1
    let pendingCallFrameIdx = -1
    for (let i = 0; i < trace.length; i++) {
      const step = trace[i]
      if (step?.tag === 'ARG PASS: ') {
        currentFrameIdx = this.getStepInnermostIdx(step, frames)
        pendingCallFrameIdx = -1
        continue
      }
      if (currentFrameIdx < 0) continue
      if (step?.tag === 'SOURCE: ' || step?.tag === 'SINK: ') continue
      if (step?.tag === 'CALL: ') {
        // 闭包孤儿 CALL：不参与帧追踪，避免扰乱 pendingCallFrameIdx
        if (!step._orphanCall) {
          pendingCallFrameIdx = this.getStepInnermostIdx(step, frames, false)
        }
        continue
      }

      const stepLineRaw = step?.node?.loc?.start?.line ?? step?.line
      const stepLine = Array.isArray(stepLineRaw) ? stepLineRaw[0] : stepLineRaw
      const stepFile = step?.node?.loc?.sourcefile || step?.file
      if (typeof stepLine !== 'number' || typeof stepFile !== 'string') continue

      const actualFrameIdx = this.getStepInnermostIdx(step, frames, false)
      if (actualFrameIdx === currentFrameIdx) {
        pendingCallFrameIdx = -1
        continue
      }
      if (pendingCallFrameIdx === currentFrameIdx && actualFrameIdx > currentFrameIdx) {
        currentFrameIdx = actualFrameIdx
        pendingCallFrameIdx = -1
        continue
      }
      // 闭包链：CALL 已解析到更深 frame，后续步确认在同一 frame
      if (pendingCallFrameIdx >= 0 && actualFrameIdx === pendingCallFrameIdx && actualFrameIdx > currentFrameIdx) {
        currentFrameIdx = actualFrameIdx
        pendingCallFrameIdx = -1
        continue
      }
      if (step?.tag === 'Return Value: ' && this.isReturnValueBackToCurrentFrame(trace, frames, i, currentFrameIdx)) {
        continue
      }
      // 闭包/lambda 返回：CALL RETURN 回到更浅 frame 是合法的函数返回转移
      if (step?.tag === 'CALL RETURN:' && actualFrameIdx >= 0 && actualFrameIdx < currentFrameIdx) {
        currentFrameIdx = actualFrameIdx
        pendingCallFrameIdx = -1
        continue
      }
      // 闭包链执行完毕后，污点在祖先 frame 继续传播（如闭包回调结果被外层方法使用）
      if (actualFrameIdx >= 0 && actualFrameIdx < currentFrameIdx && pendingCallFrameIdx < 0) {
        currentFrameIdx = actualFrameIdx
        continue
      }

      finding.traceRejectReason = 'ARG_PASS_SEGMENT_OUT_OF_FRAME'
      return false
    }

    return true
  }

  /**
   * Python 嵌套 class method 可能不进入 callstack；其 Return Value 可短暂落到外层行号范围，随后必须回到当前 frame。
   * @param trace
   * @param frames
   * @param returnIdx
   * @param currentFrameIdx
   */
  private isReturnValueBackToCurrentFrame(
    trace: TraceItem[],
    frames: CallstackFrame[],
    returnIdx: number,
    currentFrameIdx: number
  ): boolean {
    for (let j = returnIdx + 1; j < trace.length; j++) {
      const nextStep = trace[j]
      if (nextStep?.tag === 'ARG PASS: ' || nextStep?.tag === 'SINK: ') return false
      if (nextStep?.tag === 'SOURCE: ') continue
      const nextLineRaw = nextStep?.node?.loc?.start?.line ?? nextStep?.line
      const nextLine = Array.isArray(nextLineRaw) ? nextLineRaw[0] : nextLineRaw
      const nextFile = nextStep?.node?.loc?.sourcefile || nextStep?.file
      if (typeof nextLine !== 'number' || typeof nextFile !== 'string') continue
      return this.getStepInnermostIdx(nextStep, frames, false) === currentFrameIdx
    }
    return false
  }

  /**
   * 两阶段裁剪 trace 到 callstack 对齐状态：
   *
   * Step 1a：只保留 SOURCE / SINK 与 callstack body 内 step，callstack 外传播节点由生成源头修复。
   *
   * 第二类裁剪：遍历剩余 trace，维护 `expected`（下一跳应进入的 callstack idx，初始 = 1）。遇到 ARG PASS：
   *   - innermost === expected（callee-side，在被调方 body 内）→ 接受，expected++
   *   - innermost === expected - 1（caller-side，在 caller body 内）→ 接受，expected++（放宽）
   *   - 其它（包括 innermost > expected 的跳层、innermost < expected-1 的回跳、以及 expected 已到顶之后的
   *     多余 ARG PASS）→ 丢弃，同时把紧邻前一个 CALL step 一起丢（成对清理，避免孤儿 CALL）
   *
   * 执行完后 trace 里的 CALL+ARG PASS 对严格对应 callstack 的跳转序列（可能仍有缺失，缺失由后续
   * synthesizeBridgeSteps 合成补齐）。
   * @param finding
   */
  filterTraceToCallstackOrder(finding: TaintFinding, traceSource?: TraceItem[]): TraceItem[] | void {
    const callstack = finding?.callstack
    const trace = traceSource ?? finding?.trace
    if (!Array.isArray(callstack) || !Array.isArray(trace)) return

    // 获取 callstack 上所有 FunctionDefinition 的 nodeHash，用于识别闭包/lambda 步骤。
    const callstackHashes = this.getCallstackFunctionHashes(callstack)

    // 仅移除生成阶段明确标记、且闭包 owner 不在候选 callstack 的相邻回调边；保留其余传播链路。
    const foreignCallbackPair = new Set<number>()
    for (let i = 0; i < trace.length - 1; i++) {
      const call = trace[i]
      const argPass = trace[i + 1]
      if (call?.tag !== 'CALL: ' || argPass?.tag !== 'ARG PASS: ') continue
      if (call?._callbackEdge !== true || argPass?._callbackEdge !== true) continue
      const owner = call._callbackClosureOwnerHash
      if (typeof owner !== 'string' || owner.length === 0 || owner !== argPass._callbackClosureOwnerHash) continue
      if (!callstackHashes.has(owner)) {
        foreignCallbackPair.add(i)
        foreignCallbackPair.add(i + 1)
      }
    }
    const traceWithoutForeignCallbackPairs = trace.filter((_: TraceItem, i: number) => !foreignCallbackPair.has(i))

    // helper body materialization 来自真实参数/返回值，需保留 caller-side helper 调用连通的局部片段。
    const inCallstack: TraceItem[] = traceWithoutForeignCallbackPairs.filter((s: TraceItem) => {
      if (s?.tag === 'SOURCE: ' || s?.tag === 'SINK: ') return true
      const fnHash = this.getStepFunctionNodeHash(s)
      if (fnHash && !callstackHashes.has(fnHash)) return false
      return this.getStepInnermostIdx(s, callstack) >= 0
    })

    // CALL+ARG PASS 对按语义 caller/callee 边去重，避免同一调用边被多个变量展开放大。
    let expected = 1
    const drop = new Set<number>()
    const seenCallArgEdges = new Set<string>()
    for (let i = 0; i < inCallstack.length; i++) {
      const s = inCallstack[i]
      if (s?.tag !== 'ARG PASS: ') continue
      const inner = this.getStepInnermostIdx(s, callstack)
      if (inner < 0) continue
      // 顶边识别：真 callee-side enter edge 的 ARG PASS 落点必须在被进入帧的签名行附近；
      // 回调体内部的 instance-method receiver 伪边（如 result.setXxx(...)）落点在帧 body 内，与签名行相差很远。
      // 伪边 drop 清掉噪音，但这条 ARG PASS 原本替 propagation 漏记的真 enter 边占了进入 inner 帧的位置，
      // 故仍将 expected 推进到 inner+1，让后续真边能匹配，避免真链整条丢。
      if (inner >= 1 && inner < callstack.length) {
        const frameLoc = callstack[inner]?.ast?.node?.loc
        const frameStart = frameLoc?.start?.line
        const sLineRaw = s?.node?.loc?.start?.line ?? s?.line
        const sLine = Array.isArray(sLineRaw) ? sLineRaw[0] : sLineRaw
        if (typeof frameStart === 'number' && typeof sLine === 'number' && sLine > frameStart + 3) {
          drop.add(i)
          if (i > 0 && inCallstack[i - 1]?.tag === 'CALL: ') drop.add(i - 1)
          expected = inner + 1
          continue
        }
      }
      // 闭包/lambda：ARG PASS 进入不在 callstack 上的闭包函数体，丢弃该 ARG PASS 但保留前驱 CALL
      const stepFnHash = this.getStepFunctionNodeHash(s)
      if (stepFnHash && !callstackHashes.has(stepFnHash)) {
        drop.add(i)
        // 标记前驱 CALL 为孤儿：保留显示但不参与 validator 帧追踪
        if (i > 0 && inCallstack[i - 1]?.tag === 'CALL: ') {
          inCallstack[i - 1]._orphanCall = true
        }
        continue
      }
      const isNextCalleeArg = inner === expected
      // callstack-only 统一口径：ARG PASS 进 callee 帧须严格匹配 expected（callee-side），
      // 或匹配 expected-1（caller-side，callstack 跨帧缺 callee 帧时的兜底；inner>=1 排除 FILE_BEGIN
      // 入口对自身形参的噪声 ARG PASS——callstack[0] 已是入口函数自身 nil：se问c特，
      // inner===0 时不应作 caller-side 接受否则会吃掉 expected 槽并使真 callee 边被丢）。
      // 按 callee idx 去重保证每个方法跳转只保留一条可见点边，普适所有语言。
      const isLegacyCallerArg = inner === expected - 1 && inner >= 1
      if (expected < callstack.length && (isNextCalleeArg || isLegacyCallerArg)) {
        const prevCallIdx = i > 0 && inCallstack[i - 1]?.tag === 'CALL: ' ? i - 1 : -1
        const edgeKey = `callee:${inner}`
        if (seenCallArgEdges.has(edgeKey)) {
          drop.add(i)
          if (prevCallIdx >= 0) drop.add(prevCallIdx)
          continue
        }
        seenCallArgEdges.add(edgeKey)
        expected++
      } else {
        drop.add(i)
        // 成对丢弃：紧邻前一个 CALL step 是这条 ARG PASS 的 caller，一起清理避免孤儿 CALL
        if (i > 0 && inCallstack[i - 1]?.tag === 'CALL: ') drop.add(i - 1)
      }
    }

    const filtered = inCallstack.filter((_: TraceItem, i: number) => !drop.has(i))
    if (traceSource) return filtered
    finding.trace = filtered
  }

  /**
   * 按 callstack callee 层收敛 CALL->ARG PASS，保证每个方法跳转只保留一条可见点边。
   * @param finding
   */
  private dedupCallArgPassEdgesByCallee(finding: TaintFinding): void {
    const callstack = finding?.callstack
    const trace = finding?.trace
    if (!Array.isArray(callstack) || !Array.isArray(trace)) return
    const seenCalleeIdx = new Set<number>()
    const drop = new Set<number>()
    for (let i = 0; i < trace.length; i++) {
      const step = trace[i]
      if (step?.tag !== 'ARG PASS: ') continue
      const calleeIdx = this.getStepInnermostIdx(step, callstack)
      if (calleeIdx < 1) continue
      if (seenCalleeIdx.has(calleeIdx)) {
        drop.add(i)
        if (i > 0 && trace[i - 1]?.tag === 'CALL: ') drop.add(i - 1)
        continue
      }
      seenCalleeIdx.add(calleeIdx)
    }
    finding.trace = trace.filter((_: TraceItem, i: number) => !drop.has(i))
  }

  /**
   * callstack-only 结果层裁剪：清掉 taint propagation 因「先记返回值 / 先探被调方 body」造成的乱序步。
   *
   * trace 按"数据流探索顺序"记录、不是运行时执行顺序——propagation 会把被调方的 body 和 return 提前记在
   * 真正入帧边(ARG PASS)之前，使 trace 看起来进进出出、前后错乱。这里按"应处于的位置"删三类噪声步；
   * 都不丢 SOURCE / SINK / ARG PASS 自身，所以 verifyCallstackEdgeInvariant 的点边计数不变。
   *
   * 一、sink 帧入帧之后的浅帧续行：sink 帧(最深)入帧 ARG PASS 之后到 SINK 之间、比 sink 帧更浅的任意步，
   *   是越过 sink 之后的 caller/sibling 探索，全丢；并丢与 SINK 同行的冗余 Return Value。入帧前的 forward
   *   path 已含全部唯一入边，入帧后无唯一入边，丢浅帧步不丢唯一覆盖。
   *
   * 二、入帧边之前的幻影 body：某 callstack 帧 F 的 body 步出现在 F 自己的首条真实入帧 ARG PASS 之前——
   *   propagation 先探了 F 的 body 才补入帧边，这段 body 是幻影，丢。不丢"紧接 ARG PASS 的 CALL"(入帧边
   *   caller 侧)，以免拆掉 getJavaFindingSignature 的 CALL+ARG PASS 对。入口 head 帧无入帧边，不处理。
   *
   * 三、入帧即返的早返：紧接 ARG PASS 入帧边之后的 CALL RETURN——"刚进帧就返回"，是 return 提前记在 body
   *   之前，丢。往前跳过已被「二」丢的幻影 body，找上一个未丢步看是不是 ARG PASS。
   * @param finding
   */
  private truncateAfterSinkFrameEnter(finding: TaintFinding): void {
    const callstack = finding?.callstack
    const trace = finding?.trace as TraceItem[] | undefined
    if (!Array.isArray(callstack) || !Array.isArray(trace) || trace.length < 2) return
    const sinkStep = trace[trace.length - 1]
    if (sinkStep?.tag !== 'SINK: ') return
    const sinkFrameIdx = this.getStepInnermostIdx(sinkStep, callstack as CallstackFrame[])
    if (sinkFrameIdx < 1) return

    // sink 内层帧入帧 ARG PASS 下标（dedup 后每 callee idx 仅一条；取最后一个 inner==sinkFrameIdx 的 ARG PASS）
    let enterIdx = -1
    for (let i = 0; i < trace.length - 1; i++) {
      if (trace[i]?.tag === 'ARG PASS: ' && this.getStepInnermostIdx(trace[i], callstack as CallstackFrame[]) === sinkFrameIdx) {
        enterIdx = i
      }
    }
    if (enterIdx < 0) return

    const sinkFile = sinkStep?.node?.loc?.sourcefile || sinkStep?.file
    const sinkLineRaw = sinkStep?.node?.loc?.start?.line ?? sinkStep?.line
    const sinkLine = Array.isArray(sinkLineRaw) ? sinkLineRaw[0] : sinkLineRaw

    const drop = new Set<number>()
    for (let i = enterIdx + 1; i < trace.length - 1; i++) {
      const s = trace[i]
      if (!s) continue
      const inner = this.getStepInnermostIdx(s, callstack as CallstackFrame[])
      // 浅帧续行：比 sink 帧更浅的 callstack 帧内的任意步，全丢（sink 帧最深，入帧后无唯一入边，不破不变量）。
      if (inner >= 0 && inner < sinkFrameIdx) {
        drop.add(i)
        continue
      }
      // 与 SINK 同文件同行（且同 sink 帧）的 Return Value = sink 表达式自身的 return，冗余
      const tagNorm = typeof s?.tag === 'string' ? s.tag.trim() : ''
      if (tagNorm === 'Return Value:' && inner === sinkFrameIdx && typeof sinkLine === 'number' && sinkFile) {
        const sFile = s?.node?.loc?.sourcefile || s?.file
        const sLineRaw = s?.node?.loc?.start?.line ?? s?.line
        const sLine = Array.isArray(sLineRaw) ? sLineRaw[0] : sLineRaw
        if (sFile === sinkFile && sLine === sinkLine) drop.add(i)
      }
    }

    // 处理 docstring 之二、之三（幻影 body、入帧即返）。归帧用 getStepInnermostIdx：Java 走函数 nodeHash、其它语言走行号范围。
    {
      // 记每个 callstack 帧的首条"真实"入帧 ARG PASS 下标（跳过 _synthetic 合成边）。
      const firstEnterByFrame = new Map<number, number>()
      for (let i = 0; i < trace.length; i++) {
        if (trace[i]?.tag !== 'ARG PASS: ' || trace[i]?._synthetic) continue
        const inner = this.getStepInnermostIdx(trace[i], callstack as CallstackFrame[])
        if (inner < 1 || firstEnterByFrame.has(inner)) continue
        firstEnterByFrame.set(inner, i)
      }
      // body 步若在所属帧的入帧边之前 = 幻影 body，丢。不丢 ARG PASS 自身；不丢"紧接 ARG PASS 的 CALL"(入帧边
      //   caller 侧)，保护 CALL+ARG PASS 对不拆。
      for (let i = 1; i < trace.length - 1; i++) {
        if (drop.has(i)) continue
        const s = trace[i]
        if (!s || s?.tag === 'ARG PASS: ' || s?.tag === 'SOURCE: ' || s?.tag === 'SINK: ') continue
        if (s?.tag === 'CALL: ' && trace[i + 1]?.tag === 'ARG PASS: ') continue
        const inner = this.getStepInnermostIdx(s, callstack as CallstackFrame[])
        if (inner < 1) continue
        const firstPos = firstEnterByFrame.get(inner)
        if (typeof firstPos === 'number' && i < firstPos) drop.add(i)
      }
      // 紧接入帧边 ARG PASS 之后的 CALL RETURN = "入帧即返"，丢。往前跳过已被丢的幻影 body，找上一个未丢步
      //   看是不是 ARG PASS；正常 return-value 链前驱是 CALL/body，不会误中。
      for (let i = 1; i < enterIdx; i++) {
        if (drop.has(i)) continue
        const s = trace[i]
        if (!s || s?.tag !== 'CALL RETURN:') continue
        let prev = i - 1
        while (prev >= 0 && drop.has(prev)) prev--
        if (trace[prev]?.tag !== 'ARG PASS: ') continue
        drop.add(i)
      }
    }

    if (drop.size === 0) return
    finding.trace = trace.filter((_: TraceItem, i: number) => !drop.has(i))
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

    const outputtableFclosIdx = new Set<number>()
    for (let i = 0; i < callstack.length; i++) {
      const fclos = callstack[i]
      if (!fclos || (fclos.vtype !== 'fclos' && fclos.vtype !== 'scope')) continue
      const loc = fclos.ast?.node?.loc
      if (!loc?.sourcefile || typeof loc.start?.line !== 'number' || typeof loc.end?.line !== 'number') continue
      outputtableFclosIdx.add(i)
    }

    // 收集所有 ARG PASS step 覆盖的可输出 fclos idx，保持与 synthesizeBridgeSteps 相同的索引空间。
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
      if (innermost >= 1 && outputtableFclosIdx.has(innermost)) argPassFclosIdx.add(innermost)
    }

    const pairs = argPassFclosIdx.size
    const sinks = trace.filter((s: any) => s?.tag === 'SINK: ').length
    // 只数 synthesizeBridgeSteps 能生成 CALL+ARG PASS 的 fclos；无 loc 桥接帧和非 fclos wrapper 不参与边计数。
    const countedFcloses = outputtableFclosIdx.size
    const nodes = countedFcloses + 1
    const edges = pairs + sinks
    // 放宽不变量：允许 callstack 中存在未被 trace ARG PASS 覆盖的中间帧（nodes > edges + 1），
    // 这些帧在 SARIF 输出时由 synthesizeBridgeSteps 尽力补齐，但补不齐不应丢弃整条 finding。
    // 原严格等式 nodes === edges + 1 在深调用链（如 PersonalRecallWorker→recall→HRSI→buildHa3RecallSql→ICC.search）
    // 中因 helper 函数体无 ARG PASS step 导致 invariant 失衡，误杀有效 finding。
    return edges >= 1 && nodes >= edges + 1
  }

  /**
   * 按「动态 ARG PASS 作用域栈」剔除 taint 整段复制串进来的孤儿步（落点 D，User 2026-09-20 授权后补）。
   *
   * 遍历 trace 维护「当前栈顶函数」栈：元素是 callstack frame idx，初始含入口帧 frame[0]：
   * - CALL: + 紧接 ARG PASS: 成对 → 若 ARG PASS 进入更深的 callstack 帧则压栈，CALL/ARG PASS 均保留
   * - CALL RETURN: → 与栈顶同帧: in-place return 不退栈；退到栈顶下一帧: 退栈一层；除此以外的为孤儿剔除
   * - 其他步（Var Pass / Field / Return Value / 未配对的 CALL / ARG PASS）必须落在当前栈顶函数内
   *   （inner === 当前栈顶 frame idx），不在栈顶函数者 = taint 整段复制串进来的孤儿，剔除
   * - SOURCE: / SINK: 边界步始终保留
   *
   * 待剔除步形成的反例：异步体 sink record 携带同步入口的历史足迹步（如 caller-side find() 的
   * CALL/CALL RETURN/Var Pass），被平铺进 trace 与异步体步混排，形成跨函数无入帧边的跳跃。本方法
   * 严格按动态栈语义校验，与「补 ARG PASS 入帧边亦被 filter 丢」的难点无关——剔除而非追加。
   *
   * 仅对 callstack-only 输出路径的 Java taint-flow finding 启用，在 verifyCallstackEdgeInvariant
   * 通过后、truncateAfterSinkFrameEnter 之前介入。
   * @param finding 仅 Java finding；finding.trace 被原地裁剪。
   */
  private pruneOrphanByArgPassScopeStack(finding: TaintFinding): void {
    const callstack = finding?.callstack
    const trace = finding?.trace as TraceItem[] | undefined
    if (!Array.isArray(callstack) || !Array.isArray(trace) || trace.length === 0) return
    if (finding.type !== 'taint_flow_java_input' && finding.type !== 'taint_flow_java_input_inner') return
    const frames = callstack as CallstackFrame[]
    if (frames.length === 0) return

    // 当前作用域栈：元素是 callstack frame idx；初始含入口帧 frame[0]
    const scope: number[] = [0]
    const top = (): number => scope[scope.length - 1]
    const drop = new Set<number>()

    for (let i = 0; i < trace.length; i++) {
      const step = trace[i]
      const tag = typeof step?.tag === 'string' ? step.tag : ''
      if (tag === 'SOURCE: ' || tag === 'SINK: ') {
        continue
      }

      // CALL + 紧接 ARG PASS 成对：transit进 callee 帧
      if (tag === 'CALL: ' && i + 1 < trace.length && trace[i + 1]?.tag === 'ARG PASS: ') {
        const argPassInner = this.getStepInnermostIdx(trace[i + 1], frames)
        if (argPassInner > top()) {
          // 进入更深的 callstack 帧：压栈
          scope.push(argPassInner)
        }
        // 保留 CALL 与 ARG PASS 两步；跳过 ARG PASS 避免重复处理
        i++
        continue
      }

      // CALL RETURN：同帧 in-place return 不退栈；退到栈顶下一帧退栈一层；其余孤儿剔除
      if (tag === 'CALL RETURN:') {
        const retInner = this.getStepInnermostIdx(step, frames)
        if (retInner === top()) {
          continue
        }
        if (scope.length > 1 && retInner === scope[scope.length - 2]) {
          scope.pop()
          continue
        }
        drop.add(i)
        continue
      }

      // 其他步：必须落在当前栈顶函数内；不在栈顶即孤儿
      const stepInner = this.getStepInnermostIdx(step, frames)
      if (stepInner !== top()) {
        drop.add(i)
      }
    }

    if (drop.size === 0) return
    finding.trace = trace.filter((_: TraceItem, idx: number) => !drop.has(idx))
  }

  /**
   * 校验 ARG PASS step 的 callstack-idx 沿 SOURCE→SINK 方向单调不减（外层帧先于内层帧被进入）。
   *
   * 来源：taint record 在子调用返回后，其调用点/body step 仍可能残留在向下游传播的值上，导致一条
   * finding 的 trace 里内层帧的 ARG PASS 出现在外层帧之前（如 update 流被 get 的 send body 污染：
   * seq=[2,1]）。这种 trace 与 callstack 嵌套顺序矛盾，是传播层污染在输出端的可见形态——跳边
   * （内层 callsite 出现在外层 region）、CALL+ARG PASS 对顺序倒置，并使 order-sensitive 去重 key
   * 与同结构的干净 finding 错开，制造重复 finding。校验失败即丢弃该 finding。
   *
   * 仅对 callstack-only 的 Java finding 启用：idx 取 getStepInnermostIdx 的最深覆盖 fclos；
   * 映射不到 callstack（idx<0，如 helper/闭包）的 ARG PASS 不参与比较，避免误判。
   * @param finding
   * @returns true 表示 ARG PASS 顺序与 callstack 嵌套一致；false 表示污染倒序，应丢弃
   */
  private verifyArgPassOrderConsistency(finding: TaintFinding): boolean {
    const callstack = finding?.callstack
    const trace = finding?.trace
    if (!Array.isArray(callstack) || !Array.isArray(trace)) return true
    const frames = callstack as CallstackFrame[]
    let prevIdx = -1
    for (const s of trace as TraceItem[]) {
      if (s?.tag !== 'ARG PASS: ') continue
      const idx = this.getStepInnermostIdx(s, frames)
      if (idx < 0) continue
      if (idx < prevIdx) {
        finding.traceRejectReason = 'ARG_PASS_ORDER_OUT_OF_CALLSTACK'
        return false
      }
      prevIdx = idx
    }
    return true
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
  synthesizeBridgeSteps(finding: TaintFinding, traceSource?: TraceItem[]): TraceItem[] | void {
    const callstack = finding?.callstack
    const trace = traceSource ?? finding?.trace
    const callsites = finding?.callsites
    if (!Array.isArray(callstack) || !Array.isArray(trace) || trace.length === 0) return traceSource ? trace : undefined

    type FclosInfo = {
      idx: number
      file: string
      startLine: number
      endLine: number
      node: NonNullable<TraceItem['node']>
      fname: string
      entry: ReturnType<typeof getCalleeEntry>
    }
    const fcloses: FclosInfo[] = []
    callstack.forEach((fclos: TaintFinding, idx: number) => {
      if (!fclos || (fclos.vtype !== 'fclos' && fclos.vtype !== 'scope')) return
      const loc = fclos.ast?.node?.loc
      const sourcefile: string | undefined = loc?.sourcefile
      const startLine = loc?.start?.line
      const endLine = loc?.end?.line
      const entry = getCalleeEntry(fclos)
      if (!sourcefile || typeof startLine !== 'number' || typeof endLine !== 'number' || !entry) return
      fcloses.push({
        idx,
        file: sourcefile,
        startLine,
        endLine,
        node: fclos.ast.node,
        fname: entry.name,
        entry,
      })
    })
    if (fcloses.length === 0) return traceSource ? trace : undefined

    const sinkIdx = trace.length - 1
    const sinkStepIsSinkTag = trace[sinkIdx]?.tag === 'SINK: '

    // 计算每个 step 的 depth（最深覆盖 fclos idx）；未被任何 fclos 覆盖的 step depth=-1。
    // 合成 step 也正常参与深度计算，保证 synthesizeBridgeSteps 幂等（二次调用时合成 ARG PASS 已覆盖原 uncovered fclos 不会再次注入）。
    const depths: number[] = trace.map((s: TraceItem) => {
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

    // fclos 覆盖判据：入帧 ARG PASS 落在 fclos 签名行 ±1 内才算覆盖该 fclos。
    // 严格化（落点 E）：filter 在某些异步路径把 caller-side 的 base-object ARG PASS（如
    // executor.submit 的 receiver）按行号误接受为 callee 帧 enter ARG PASS —— 该 ARG PASS 落在
    // callee body 远区（sLine > frame.startLine+1）而非签名行，原先 coveredByArgPass 只判
    // "depths[i]>=0 && tag==='ARG PASS: '"，把 body 远区 ARG PASS 也算覆盖，使该 frame 误判为已覆盖，
    // 跳过 synthesize 现有 SYN 桥补机制，导致 SARIF 跨帧跳跃（如 idx#4 step15 CALL offer@1013 →
    // step16 CALL submit@788 之间缺 SYN 1014 CALL invoke + SYN 786 ARG PASS 入帧边）。
    // 闭包捕获场景下深层 fclos 只会出现 SOURCE 而无形参 ARG PASS，必须由 synthesize 补桥接，否则
    // verifyCallstackEdgeInvariant 数不到这一对会丢整条 finding；故此处 SOURCE 不再计为已覆盖。
    const coveredByArgPass: Set<number> = new Set()
    trace.forEach((s: TraceItem, i: number) => {
      if (depths[i] >= 0 && s?.tag === 'ARG PASS: ') {
        const frameIdx = depths[i]
        const frame = fcloses.find((f) => f.idx === frameIdx)
        // 无匹配 frame（理论上不发生）：保留旧行为，不阻断已 active 的覆盖判定。
        if (!frame) {
          coveredByArgPass.add(frameIdx)
          return
        }
        const sLineRaw = s?.node?.loc?.start?.line ?? s?.line
        const sLine = Array.isArray(sLineRaw) ? sLineRaw[0] : sLineRaw
        // ARG PASS 该值是 callee 签名行 ±1 内才视为入帧边；不能解析 sLine 时保留旧行为（不丢已 active 覆盖）。
        if (typeof sLine !== 'number' || sLine === frame.startLine || sLine === frame.startLine + 1) {
          coveredByArgPass.add(frameIdx)
        }
      }
    })
    // 入口 fclos（idx 0）不需要合成；非 callstack 节点不参与覆盖判定。
    const uncovered = fcloses.filter((f) => f.idx > 0 && !coveredByArgPass.has(f.idx))
    if (uncovered.length === 0) {
      // uncovered=0 不代表无孤儿 ARG PASS：内层 CALL RETURN 后直接接外层 ARG PASS 时，
      // 外层 CALL tag 未随子值传播到位，send 穿越对缺 CALL 半边。必须补齐再返回。
      this.completeOrphanArgPassCalls(trace, callstack, callsites)
      return traceSource ? trace : undefined
    }

    // 为每个 uncovered fclos 找插入位置：只能在 SOURCE 与 SINK 之间补桥，避免 synthetic CALL/ARG PASS 堆到 trace 顶部。
    type Insertion = { beforeIdx: number; fclos: FclosInfo }
    const insertions: Insertion[] = []
    const firstMiddleIdx = trace[0]?.tag === 'SOURCE: ' ? 1 : 0
    for (const f of uncovered) {
      let beforeIdx = sinkStepIsSinkTag ? sinkIdx : trace.length
      for (let i = firstMiddleIdx; i < trace.length; i++) {
        if (sinkStepIsSinkTag && i === sinkIdx) break
        if (trace[i]?._synthetic) continue
        if (trace[i]?.tag === 'SOURCE: ' || trace[i]?.tag === 'SINK: ') continue
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
      const calleeEntry = ins.fclos.entry
      if (!calleeEntry) continue
      const signatureLine = calleeEntry.line
      const argPassNode = calleeEntry.node
      const callsite = Array.isArray(callsites) ? callsites[ins.fclos.idx] : undefined
      const siteLoc = callsite?.loc
      const siteLineRaw = siteLoc?.start?.line
      const siteLine = Array.isArray(siteLineRaw) ? siteLineRaw[0] : siteLineRaw
      const hasSiteLoc = typeof siteLine === 'number' && typeof siteLoc?.sourcefile === 'string'
      const argPassStep = {
        file: ins.fclos.file,
        line: signatureLine,
        tag: 'ARG PASS: ',
        node: argPassNode,
        affectedNodeName: ins.fclos.fname,
        _synthetic: true,
      }
      if (!hasSiteLoc) {
        trace.splice(ins.beforeIdx, 0, argPassStep)
        continue
      }
      const callNode = Object.create(ins.fclos.node) as NonNullable<TraceItem['node']>
      callNode.loc = siteLoc
      if (typeof callsite?.nodeHash !== 'undefined') {
        callNode._meta = { nodehash: callsite.nodeHash }
      }
      const callStep = {
        file: siteLoc.sourcefile,
        line: siteLine,
        tag: 'CALL: ',
        node: callNode,
        affectedNodeName: ins.fclos.fname,
        _synthetic: true,
      }
      trace.splice(ins.beforeIdx, 0, callStep, argPassStep)
    }

    // 补齐孤立 ARG PASS：若紧邻前驱不是 CALL（analyzer 在某些 AST 模式下——例如 Python
    // fullfileManagerMade 入口或嵌套 def 跨层调用——只写了 ARG PASS 没写 CALL）则按 callsites[innermost_idx]
    // 合成一个 CALL 插到它前面，保证 CALL/ARG PASS 成对出现。反向遍历避免 splice 导致索引失效。
    // 仅当 callsite line 与 ARG PASS step line 不同才合成：JS entrypoint 的 callsites[0] 常指向 fclos 自身
    // body 起始行，不是真正的 caller-side callsite，用这种 loc 造 CALL 会重复 ARG PASS 的位置信息。
    // 注意：该补齐步骤独立于 uncovered fclos 的桥接插入——即使所有 fclos 都已有 ARG PASS（uncovered=0），
    // 仍可能出现"内层 CALL RETURN 后直接接外层 ARG PASS"的孤儿（外层 CALL tag 未随子值传播到位），
    // 故必须无条件执行，不可被上方 uncovered=0 的提前返回跳过。
    this.completeOrphanArgPassCalls(trace, callstack, callsites)
    return traceSource ? trace : undefined
  }

  /**
   * 补齐孤立 ARG PASS：若紧邻前驱不是 CALL（analyzer 在某些 AST 模式下——例如 Python
   * fullfileManagerMade 入口或嵌套 def 跨层调用——只写了 ARG PASS 没写 CALL）则按 callsites[innermost_idx]
   * 合成一个 CALL 插到它前面，保证 CALL/ARG PASS 成对出现。反向遍历避免 splice 导致索引失效。
   * 仅当 callsite line 与 ARG PASS step line 不同才合成：JS entrypoint 的 callsites[0] 常指向 fclos 自身
   * body 起始行，不是真正的 caller-side callsite，用这种 loc 造 CALL 会重复 ARG PASS 的位置信息。
   *
   * 从 synthesizeBridgeSteps 抽出为独立方法，使其在 uncovered=0 的提前返回路径也能调用——
   * 见 synthesizeBridgeSteps 末尾与上方 uncovered 提前返回处两处调用点。
   * @param trace 原地修改
   * @param callstack
   * @param callsites
   */
  private completeOrphanArgPassCalls(trace: TraceItem[], callstack: CallstackFrame[], callsites: CallsiteFrame[] | undefined): void {
    if (!Array.isArray(trace) || !Array.isArray(callstack)) return
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
      const calleeEntry = getCalleeEntry(fclos)
      if (!calleeEntry) continue
      const fname = calleeEntry.name
      const callNode = Object.create(fclos?.ast?.node || {}) as NonNullable<TraceItem['node']>
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
   * 相邻 trace step 折叠：紧邻两步若 `node._meta.nodehash` 相等（或 nodehash 缺位时
   * `(file, 起始行, affectedNodeName)` 三元组相等）即视为同一物理位置的重复展开，仅保留首条。
   *
   * 来源：fan-out 循环（同一 callsite 多次 invoke 不同子类型 / 重复 fclos 调度）在 `addSrcLineInfo`
   * 内多次把 callsite step 推入 trace 累积容器，导致 finding.trace 出现成串字面相同的 CALL/ARG PASS。
   * 在此处折叠后，下游所有出口（stdout `formatTraces` / SARIF `getTaintFlowAsSarif` / attackTrace 等）
   * 共享同一份已折叠的 finding.trace，口径统一。SARIF emitter 的相邻 dedup 退化为幂等兜底。
   *
   * SOURCE/SINK step 同样参与折叠：实际数据里 fan-out 不会在两个语义边界 step 之间堆同 hash 帧，
   * 但若 source-line 累积引入了相邻同 hash 的 SOURCE/SINK 副本，按 nodehash 折叠也是正确的语义。
   * @param finding
   */
  dedupAdjacentTraceSteps(finding: TaintFinding, traceSource?: TraceItem[]): TraceItem[] | void {
    const trace: TraceItem[] | undefined = traceSource ?? finding.trace
    if (!finding || !Array.isArray(trace) || trace.length < 2) return traceSource ? trace : undefined
    const keyOf = (step: TraceItem): string => {
      const tag = step?.tag ?? ''
      const node = step?.node as { _meta?: { nodehash?: unknown }, loc?: { sourcefile?: string, start?: { line?: number } } } | undefined
      const hash = node?._meta?.nodehash
      if (hash != null) return `h:${tag}|${String(hash)}|${step?.affectedNodeName ?? ''}`
      const file = node?.loc?.sourcefile || step?.file || ''
      const lineRaw = node?.loc?.start?.line ?? step?.line
      const line = Array.isArray(lineRaw) ? lineRaw[0] : lineRaw
      return `p:${tag}|${file}|${line ?? ''}|${step?.affectedNodeName ?? ''}`
    }
    const out: TraceItem[] = []
    let prevKey: string | null = null
    for (const step of trace) {
      const key = keyOf(step)
      if (prevKey !== null && prevKey === key) continue
      out.push(step)
      prevKey = key
    }
    if (traceSource) return out
    finding.trace = out
  }

  /**
   * 去掉链路中重复的source，以免链路可读性降低
   * @param finding
   */
  filterDuplicateSource(finding: TaintFinding, traceSource?: TraceItem[]): TraceItem[] | void {
    const trace = traceSource ?? finding?.trace
    if (!finding || !Array.isArray(trace)) return traceSource ? trace : undefined
    // 语义：保留 trace 中首个 SOURCE step，丢弃后续重复。原实现按位置（key > 1）判定在 SOURCE 前插入合成
    // CALL/ARG PASS 的场景会误删真实 SOURCE；改为按"已见过一次 SOURCE 就丢后续"的语义。
    const newTrace = []
    let sawSource = false
    for (const step of trace) {
      const isSource =
        step?.tag === 'SOURCE: ' || (typeof step?.str === 'string' && step.str.includes('SOURCE: '))
      if (isSource) {
        if (sawSource) continue
        sawSource = true
      }
      newTrace.push(step)
    }
    if (traceSource) return newTrace
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
