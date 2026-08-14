const { PythonTaintAbstractChecker } = require('./python-taint-abstract-checker')
const { markTaintSource } = require('../common-kit/source-util')
const entryPointConfig = require('../../../engine/analyzer/common/entrypoint/current-entrypoint')

const AU_GET_DATA_RECEIVER_NAMES = new Set(['input_object', 'tool_input'])
const AU_LIFECYCLE_METHODS = new Set(['customized_execute', 'execute', 'parse_input'])
const AU_METADATA_KEYS = new Set([
  'traceid',
  'trace_id',
  'token',
  'timestamp',
  'starttime',
  'start_time',
  'endtime',
  'end_time',
  'success',
  'memory',
  'module',
  'class',
])

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' ? (value as UnknownRecord) : undefined
}

function getStringField(value: unknown, field: string): string | undefined {
  const raw = asRecord(value)?.[field]
  return typeof raw === 'string' ? raw : undefined
}

function normalizeKey(key: string): string {
  return key.replace(/[-\s]/g, '_').toLowerCase()
}

export function isAgentUniverseMetadataKey(key: string | undefined): boolean {
  if (!key) return false
  return AU_METADATA_KEYS.has(normalizeKey(key))
}

function extractLiteralString(node: unknown): string | undefined {
  const record = asRecord(node)
  if (record?.type !== 'Literal') return undefined
  const value = record.value
  return typeof value === 'string' ? value : undefined
}

function extractGetDataKey(node: unknown, callInfo: unknown): string | undefined {
  const nodeRecord = asRecord(node)
  const hasAstArguments = Array.isArray(nodeRecord?.arguments) && (nodeRecord!.arguments as unknown[]).length > 0
  const positionalArg = hasAstArguments ? (nodeRecord!.arguments as unknown[])[0] : undefined
  const directKey = extractLiteralString(positionalArg)
  if (directKey) return directKey
  if (hasAstArguments) return undefined
  const callArgs = asRecord(callInfo)?.args
  if (!Array.isArray(callArgs)) return undefined
  const firstArg = callArgs.find((arg: unknown) => {
    const record = asRecord(arg)
    return record?.kind === 'positional' && record?.index === 0
  })
  return extractLiteralString(asRecord(firstArg)?.value)
}

function getMemberAccessPropertyName(node: unknown): string | undefined {
  const record = asRecord(node)
  if (record?.type !== 'MemberAccess') return undefined
  return getStringField(record.property, 'name')
}

function getMemberAccessObjectName(node: unknown): string | undefined {
  const record = asRecord(node)
  if (record?.type !== 'MemberAccess') return undefined
  return getStringField(record.object, 'name')
}

function containsAuTypeEvidence(value: unknown, depth = 0): boolean {
  if (depth > 8) return false
  const record = asRecord(value)
  if (!record) return false
  const fields = ['sid', 'qid', 'logicalQid', 'name']
  for (const field of fields) {
    const text = getStringField(record, field)
    if (!text) continue
    if (
      text.includes('agentuniverse') ||
      text.includes('agentUniverse') ||
      text.endsWith('InputObject') ||
      text.endsWith('ToolInput') ||
      text.endsWith('AgentTemplate') ||
      text.endsWith('.Tool')
    ) {
      return true
    }
  }
  return (
    containsAuTypeEvidence(record.parent, depth + 1) ||
    containsAuTypeEvidence(record._this, depth + 1) ||
    containsAuTypeEvidence(record.object, depth + 1) ||
    containsAuTypeEvidence(record.rtype, depth + 1) ||
    containsAuTypeEvidence(record._base, depth + 1)
  )
}

function isAgentUniverseEntryPoint(entryPoint: unknown): boolean {
  if (!entryPoint) return false
  const record = asRecord(entryPoint)
  return record?.framework === 'agentuniverse' || record?.attribute === 'AgentUniverse'
}

function getEnclosingFunctionName(scope: unknown, fclos: unknown): string | undefined {
  const candidates: unknown[] = [
    scope,
    fclos,
    asRecord(fclos)?.parent,
    asRecord(scope)?.parent,
  ]
  for (const candidate of candidates) {
    const ast = asRecord(candidate)?.ast
    const node = asRecord(ast)?.node ?? asRecord(ast)?.fdef ?? ast
    const name = getStringField(asRecord(node)?.id, 'name')
    if (name) return name
  }
  return undefined
}

/**
 * AgentUniverse 框架 source 标记 checker
 *
 * 在 AU lifecycle 方法（customized_execute / execute / parse_input）内，
 * 将 InputObject.get_data() / ToolInput.get_data() 返回值标记为 PYTHON_INPUT source，
 * 排除 traceId/token/timestamp 等元数据 literal key。
 */
class AgentUniverseTaintChecker extends PythonTaintAbstractChecker {
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_python_agentuniverse_input')
  }

  triggerAtFunctionCallAfter(analyzer: any, scope: any, node: any, state: any, info: any): void {
    super.triggerAtFunctionCallAfter(analyzer, scope, node, state, info)
    const { fclos, ret, callInfo } = info
    if (!ret?.taint) return

    // 1. callee 是 get_data？
    const callee = node?.callee
    if (getMemberAccessPropertyName(callee) !== 'get_data') return

    // 2. receiver 是 input_object / tool_input？
    const receiverName = getMemberAccessObjectName(callee)
    if (!receiverName || !AU_GET_DATA_RECEIVER_NAMES.has(receiverName)) return

    // 3. 外层函数是 AU lifecycle method？
    const lifecycleName = getEnclosingFunctionName(scope, fclos)
    if (!lifecycleName || !AU_LIFECYCLE_METHODS.has(lifecycleName)) return

    // 4. entrypoint 是 AU 或 fclos/scope 有 AU 类型证据？
    if (isAgentUniverseEntryPoint(entryPointConfig.getCurrentEntryPoint())) {
      // 快速路径：当前 entrypoint 是 AU
    } else if (containsAuTypeEvidence(fclos) || containsAuTypeEvidence(scope)) {
      // fallback：fclos/scope 链上有 AU 类型证据
    } else {
      return
    }

    // 5. 提取 key 参数，排除 metadata
    const key = extractGetDataKey(node, callInfo)
    if (isAgentUniverseMetadataKey(key)) return

    // 6. 标记返回值为 PYTHON_INPUT
    markTaintSource(ret, { path: node, kind: 'PYTHON_INPUT' })
  }
}

module.exports = AgentUniverseTaintChecker
module.exports.isAgentUniverseMetadataKey = isAgentUniverseMetadataKey