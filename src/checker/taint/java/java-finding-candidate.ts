import type { TaintFinding } from '../../../engine/analyzer/common/common-types'
import type { TraceItem } from '../../../util/finding-util'
import { getCalleeEntry } from './callee-entry'

type SourceLocation = {
  sourcefile?: string
  start?: { line?: number; column?: number }
  end?: { line?: number; column?: number }
}

type NodeMeta = { nodehash?: unknown }
type AstNode = {
  loc?: SourceLocation
  _meta?: NodeMeta
  id?: { name?: string; loc?: SourceLocation }
  body?: { loc?: SourceLocation }
  [key: string]: unknown
}
type CallstackFrame = { vtype?: string; ast?: { node?: AstNode }; [key: string]: unknown }
type CallsiteFrame = { code?: string; nodeHash?: string | number; loc?: SourceLocation; [key: string]: unknown }
export type JavaCandidateFinding = TaintFinding & {
  trace?: TraceItem[]
  callstack?: unknown
  callsites?: unknown
  sinkAttribute?: string[]
  traceRejectReason?: string
  node?: AstNode
}
type TraceIdentity = { file: string; startLine: number; endLine: number }

const ARG_PASS_ORDER_OUT_OF_CALLSTACK = 'ARG_PASS_ORDER_OUT_OF_CALLSTACK'
export const JAVA_CANDIDATE_FINDING_MARKER = 'isJavaCandidateFinding'

function asCandidateFinding(finding: TaintFinding): JavaCandidateFinding {
  return finding as JavaCandidateFinding
}

function getNodeHash(node: AstNode | undefined): string | number | undefined {
  const value = node?._meta?.nodehash
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

function getLocation(value: { loc?: SourceLocation; file?: string; line?: number | number[] } | undefined): TraceIdentity | undefined {
  if (!value) return undefined
  const loc = value.loc ?? (value as { node?: { loc?: SourceLocation } }).node?.loc
  const file = loc?.sourcefile ?? value.file
  const rawStart = loc?.start?.line ?? value.line
  const rawEnd = loc?.end?.line ?? value.line
  const startLine = Array.isArray(rawStart) ? rawStart[0] : rawStart
  const endLine = Array.isArray(rawEnd) ? rawEnd[rawEnd.length - 1] : rawEnd
  if (typeof file !== 'string' || file.length === 0 || typeof startLine !== 'number' || typeof endLine !== 'number') return undefined
  return { file, startLine, endLine }
}

function locationKey(value: { loc?: SourceLocation; file?: string; line?: number | number[]; node?: AstNode } | undefined): string | undefined {
  const location = getLocation(value)
  if (!location) return undefined
  const nodeHash = getNodeHash(value?.node)
  return `${location.file}:${location.startLine}-${location.endLine}${nodeHash === undefined ? '' : `#${nodeHash}`}`
}

function isValidTraceBoundaryStep(step: TraceItem | undefined, expectedTag: string): boolean {
  if (step?.tag !== expectedTag) return false
  return Boolean(getLocation(step) && getNodeHash(step.node as AstNode | undefined) !== undefined)
}

function cloneNodeWithLocation(node: AstNode, location: SourceLocation, nodehash: string | number): AstNode {
  return { ...node, loc: location, _meta: { ...node._meta, nodehash } }
}

function getCallstackAndCallsites(finding: JavaCandidateFinding): { callstack: CallstackFrame[]; callsites: CallsiteFrame[] } | undefined {
  if (!Array.isArray(finding.callstack) || !Array.isArray(finding.callsites)) return undefined
  const callstack = finding.callstack as CallstackFrame[]
  const callsites = finding.callsites as CallsiteFrame[]
  if (callstack.length < 2 || callstack.length !== callsites.length) return undefined
  for (let index = 0; index < callstack.length; index++) {
    const frame = callstack[index]
    const frameNode = frame?.ast?.node
    const callsite = callsites[index]
    if (!callsite || !getLocation(callsite) || callsite.nodeHash === undefined) return undefined
    if (frame?.vtype !== 'fclos' || !frameNode || !getLocation(frameNode) || getNodeHash(frameNode) === undefined) continue
  }
  return { callstack, callsites }
}

/**
 * finding签名定义为 SOURCE、SINK、按调用路径顺序排列的 CALL+ARG PASS 对和 SINK ATTRIBUTE。
 * 该签名同时服务正常 finding 与候补 finding，位置键保留既有 Java 去重语义。
 */
export function getJavaFindingSignature(finding: TaintFinding): string | undefined {
  if (!finding) throw new TypeError('Java finding signature received null finding')
  if (finding.type !== 'taint_flow_java_input' && finding.type !== 'taint_flow_java_input_inner') return undefined
  const candidate = asCandidateFinding(finding)
  if (!Array.isArray(candidate.trace) || candidate.trace.length < 2) return undefined
  const source = candidate.trace.find((step) => step?.tag === 'SOURCE: ')
  const sink = [...candidate.trace].reverse().find((step) => step?.tag === 'SINK: ')
  const sourceKey = locationKey(source)
  const sinkKey = locationKey(sink)
  if (!sourceKey || !sinkKey) return undefined
  const groups: string[] = []
  for (let index = 0; index < candidate.trace.length; index++) {
    const call = candidate.trace[index]
    if (call?.tag !== 'CALL: ') continue
    const argPass = candidate.trace[index + 1]
    if (argPass?.tag !== 'ARG PASS: ') continue
    const callKey = locationKey(call)
    const argPassKey = locationKey(argPass)
    if (!callKey || !argPassKey) return undefined
    groups.push(`${callKey}\u0001${argPassKey}`)
    index++
  }
  const sinkAttribute = Array.isArray(candidate.sinkAttribute) ? candidate.sinkAttribute.slice().sort().join(',') : ''
  return `${sourceKey}\u0003${sinkKey}\u0005${sinkAttribute}\u0004${groups.join('\u0002')}`
}

/**
 * 仅基于唯一 ARG_PASS_ORDER_OUT_OF_CALLSTACK 拒绝原因重建保守 Java 候补。
 * 原 finding 不会被修改或恢复；候补的 trace、callstack、callsites 使用同一可信调用结构裁剪。
 */
export function buildJavaCandidateFinding(finding: TaintFinding): TaintFinding | undefined {
  if (!finding) throw new TypeError('Candidate reconstruction received null finding')
  const sourceFinding = asCandidateFinding(finding)
  if (sourceFinding.traceRejectReason !== ARG_PASS_ORDER_OUT_OF_CALLSTACK) return undefined
  if (!Array.isArray(sourceFinding.trace) || sourceFinding.trace.length < 2) return undefined
  const source = sourceFinding.trace[0]
  const sink = sourceFinding.trace[sourceFinding.trace.length - 1]
  if (!isValidTraceBoundaryStep(source, 'SOURCE: ') || !isValidTraceBoundaryStep(sink, 'SINK: ')) return undefined
  if (sourceFinding.sinkAttribute && sourceFinding.sinkAttribute.some((attribute) => typeof attribute !== 'string')) return undefined
  const structure = getCallstackAndCallsites(sourceFinding)
  if (!structure) return undefined
  const { callstack, callsites } = structure
  const rootNode = callstack[0]?.ast?.node
  if (!rootNode || !getLocation(rootNode) || getNodeHash(rootNode) === undefined) return undefined
  const candidateTrace: TraceItem[] = [source]
  const candidateCallstack: CallstackFrame[] = []
  const candidateCallsites: CallsiteFrame[] = []
  for (let index = 0; index < callstack.length; index++) {
    const frame = callstack[index]
    const frameNode = frame?.ast?.node
    const callsite = callsites[index]
    const calleeEntry = getCalleeEntry(frame)
    const frameLocation = getLocation(frameNode)
    const callsiteLocation = getLocation(callsite)
    const frameHash = getNodeHash(frameNode)
    const callsiteHash = callsite?.nodeHash
    if (!frameNode || !calleeEntry || !frameLocation || !callsiteLocation || frameHash === undefined || callsiteHash === undefined || !callsite?.loc) continue
    candidateCallstack.push(frame)
    candidateCallsites.push(callsite)
    if (index === 0) continue
    const callNode = cloneNodeWithLocation(frameNode, callsite.loc, callsiteHash)
    candidateTrace.push({ file: callsiteLocation.file, line: callsiteLocation.startLine, tag: 'CALL: ', node: callNode, affectedNodeName: calleeEntry.name })
    candidateTrace.push({ file: calleeEntry.file, line: calleeEntry.line, tag: 'ARG PASS: ', node: calleeEntry.node, affectedNodeName: calleeEntry.name })
  }
  candidateTrace.push(sink)
  const edgePairs = candidateTrace.filter((step) => step?.tag === 'CALL: ').length
  if (candidateCallstack.length !== edgePairs + 1 || candidateCallsites.length !== candidateCallstack.length) return undefined
  const candidate: JavaCandidateFinding = { ...sourceFinding, trace: candidateTrace, callstack: candidateCallstack, callsites: candidateCallsites }
  candidate[JAVA_CANDIDATE_FINDING_MARKER] = true
  return candidate
}

export function isJavaCandidateFinding(finding: TaintFinding): finding is JavaCandidateFinding {
  return asCandidateFinding(finding)[JAVA_CANDIDATE_FINDING_MARKER] === true
}
