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
const QidUnifyUtil = require('../../util/qid-unify-util')

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
}

interface CallstackFrame {
  vtype?: string
  ast?: { node?: AstNodeWithLocation }
  fname?: string
  qid?: string
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
        const isJavaFinding = this.isJavaFindingTrace(finding)
        finding.trace = this.filterTraceToCallstackOrder(finding, finding.trace, isJavaFinding) as TraceItem[]
        finding.trace = this.synthesizeBridgeSteps(finding, finding.trace) as TraceItem[]
        if (!this.validateArgPassSegmentWithinFrame(finding)) {
          return null
        }
        if (isJavaFinding) this.dedupCallArgPassEdgesByCallee(finding)
        if (!this.validateTraceBoundary(finding, trace)) return null
        if (!this.verifyCallstackEdgeInvariant(finding)) return null
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

  private isJavaFindingTrace(finding: TaintFinding): boolean {
    const trace = finding?.trace
    if (Array.isArray(trace)) {
      for (const step of trace) {
        const sourcefile = step?.node?.loc?.sourcefile || step?.file
        if (typeof sourcefile === 'string' && sourcefile.endsWith('.java')) return true
      }
    }
    const callstack = finding?.callstack
    if (Array.isArray(callstack)) {
      for (const fclos of callstack as CallstackFrame[]) {
        const sourcefile = fclos?.ast?.node?.loc?.sourcefile
        if (typeof sourcefile === 'string' && sourcefile.endsWith('.java')) return true
      }
    }
    return false
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
  filterTraceToCallstackOrder(finding: TaintFinding, traceSource?: TraceItem[], javaStrictCalleeOnly = false): TraceItem[] | void {
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
      const isLegacyCallerArg = !javaStrictCalleeOnly && inner === expected - 1
      // Java callstack-only 链路需要严格 callee-side ARG PASS；其他语言保留旧 caller/callee 双接受口径。
      if (expected < callstack.length && (isNextCalleeArg || isLegacyCallerArg)) {
        if (javaStrictCalleeOnly) {
          const prevCallIdx = i > 0 && inCallstack[i - 1]?.tag === 'CALL: ' ? i - 1 : -1
          const edgeKey = `callee:${inner}`
          if (seenCallArgEdges.has(edgeKey)) {
            drop.add(i)
            if (prevCallIdx >= 0) drop.add(prevCallIdx)
            continue
          }
          seenCallArgEdges.add(edgeKey)
        }
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
      if (!fclos || fclos.vtype !== 'fclos') continue
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
    }
    const fcloses: FclosInfo[] = []
    callstack.forEach((fclos: TaintFinding, idx: number) => {
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

    // fclos 覆盖判据：body 内需要至少一条 ARG PASS step（自然或合成均可）。
     // 闭包捕获场景下深层 fclos 只会出现 SOURCE 而无形参 ARG PASS，必须由 synthesize 补桥接，否则
     // verifyCallstackEdgeInvariant 数不到这一对会丢整条 finding；故此处 SOURCE 不再计为已覆盖。
    const coveredByArgPass: Set<number> = new Set()
    trace.forEach((s: TraceItem, i: number) => {
      if (depths[i] >= 0 && s?.tag === 'ARG PASS: ') {
        coveredByArgPass.add(depths[i])
      }
    })
    // 入口 fclos（idx 0）不需要合成；非 callstack 节点不参与覆盖判定。
    const uncovered = fcloses.filter((f) => f.idx > 0 && !coveredByArgPass.has(f.idx))
    if (uncovered.length === 0) return traceSource ? trace : undefined

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
    return traceSource ? trace : undefined
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
