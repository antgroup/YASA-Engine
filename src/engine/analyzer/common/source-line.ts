import type { TraceItem, TraceWriteOptions } from '../../../util/finding-util'
import type { TaintRecord } from './value/taint-record'
export {}
const _ = require('lodash')
const Config = require('../../../config')
const { prettyPrint } = require('../../../util/ast-util')
const {
  buildCrossCallVisitedKey,
  probeCrossCallVisited,
  markCrossCallVisited,
} = require('./cross-call-visited')
const { buildNewCopiedWithTag, shallowCopyValue } = require('../../../util/clone-util')
const QidUnifyUtil = require('../../../util/qid-unify-util')
const VariableUtil = require('../../../util/variable-util')
/** **************** source code line management *********************** */

type SourceLineNode = TraceItem['node'] & { parent?: SourceLineNode }
export interface TraceProvenanceOptions {
  callbackEdge?: boolean
  callbackClosureOwnerHash?: string
}

type SourceLineValue = {
  vtype?: string
  sid?: string
  logicalQid?: string
  ast?: { node?: unknown }
  type?: string
  value?: Record<string, SourceLineValue> | SourceLineValue[] | unknown
  taint?: TaintRecord
  _field?: Record<string, SourceLineValue> | SourceLineValue[]
  members?: Map<string, SourceLineValue>
  arguments?: SourceLineValue[]
  left?: SourceLineValue
  right?: SourceLineValue
  expression?: SourceLineValue
  children?: Record<string, SourceLineValue | undefined>
  object?: SourceLineValue
  property?: SourceLineValue
  misc_?: { buffer?: SourceLineValue[] }
  getChild?: (key: string) => SourceLineValue | undefined | null
  getFieldValue?: (key: string) => SourceLineValue | undefined | null
  setFieldValue?: (key: string, value: SourceLineValue) => void
}

type SourceLineResult = SourceLineValue & { taint: TaintRecord }

type SourceCodeAnalyzer = {
  sourceCodeCache?: Map<string, string[]> | Record<string, string[] | string>
  // 是否启用跨 addSrcLineInfo 调用 visited memo（卡点 A Step A）。
  // 仅 Python analyzer 入口循环会按入口重置；未挂载重置 hook 的语言（JS/Go/Java）必须关闭，避免跨入口污染。
  crossCallVisitedEnabled?: boolean
  enableNestedSourceLineIsolation?: boolean
}

// 全局 analyzer 引用，用于访问 sourceCodeCache
let globalAnalyzer: SourceCodeAnalyzer | null = null

// 无 analyzer 场景（如 dumpAllAST）共享的模块级单例 cache
// 不能每次 new 一个新 Map，否则 storeCode 写入和 getCodeByLocation 读取用的是不同实例
const fallbackSourceCodeCache: Map<string, string[]> = new Map<string, string[]>()

/**
 * 设置全局 analyzer 实例
 * @param analyzer analyzer 实例
 */
function setGlobalAnalyzer(analyzer: SourceCodeAnalyzer) {
  globalAnalyzer = analyzer
}

/**
 * 获取全局 analyzer 实例
 * @returns analyzer 实例
 */
function getGlobalAnalyzer() {
  return globalAnalyzer
}

/**
 * 获取 sourceCodeCache（统一使用 analyzer.sourceCodeCache）
 * @returns sourceCodeCache Map，存储文件的行数组
 */
function getSourceCodeCache(): Map<string, string[]> {
  if (globalAnalyzer && globalAnalyzer.sourceCodeCache instanceof Map) {
    return globalAnalyzer.sourceCodeCache
  }
  // 没有全局 analyzer 时（如 dumpAllAST），使用模块级单例 Map
  // 修复：之前每次 new Map 导致 storeCode 写入和后续读取用的是不同实例，
  // 使 addNodeHash 拿不到源码，走 prettyPrint fallback，与 analyzer 路径产生 hash 不一致
  if (!globalAnalyzer) {
    return fallbackSourceCodeCache
  }
  // 如果 sourceCodeCache 不是 Map，转换为 Map
  if (
    globalAnalyzer.sourceCodeCache &&
    typeof globalAnalyzer.sourceCodeCache === 'object' &&
    !(globalAnalyzer.sourceCodeCache instanceof Map) &&
    !Array.isArray(globalAnalyzer.sourceCodeCache)
  ) {
    const map = new Map<string, string[]>()
    const sourceCodeCache = globalAnalyzer.sourceCodeCache
    for (const key in sourceCodeCache) {
      if (Object.prototype.hasOwnProperty.call(sourceCodeCache, key)) {
        const value = sourceCodeCache[key]
        // 兼容处理：如果是字符串，转换为数组
        map.set(key, typeof value === 'string' ? value.split(/\n/) : value)
      }
    }
    globalAnalyzer.sourceCodeCache = map
    return map
  }
  return fallbackSourceCodeCache
}


/**
 *
 * @param val
 * @param node
 * @param sourcefile
 * @param tag
 * @param affectedNodeName
 */
function addSrcLineInfo(
  val: SourceLineValue | SourceLineValue[] | undefined | null,
  node: SourceLineNode,
  sourcefile: string | undefined,
  tag: string,
  affectedNodeName: string | undefined,
  options?: TraceWriteOptions & TraceProvenanceOptions
): SourceLineValue | SourceLineValue[] | undefined | null {
  if (!val) return val
  if (!node.loc) return val
  let sig = '<NodeLocUnknown>'
  if (node.loc?.sourcefile && typeof node.loc?.sourcefile === 'string') {
    sig = `${node.loc?.sourcefile.substring((node.loc?.sourcefile.lastIndexOf('/') || 0) + 1, node.loc?.sourcefile.lastIndexOf('.'))}_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}`
  }
  if (Array.isArray(val)) {
    let arrayHasTag = false
    for (const eachVal of val) {
      if ((eachVal as any).taint?.isTaintedRec) {
        arrayHasTag = true
        break
      }
    }
    if (!arrayHasTag) {
      return val
    }
    // 添加copied主要是为了生成新的符号值，避免覆盖原有的表项，这个跟符号值树使用内存维护有区别
    const newVal = buildNewCopiedWithTag(globalAnalyzer, val, sig)
    // @ts-ignore
    newVal.value = val.value
    for (const eachVal of newVal) {
      const start_line = node.loc.start?.line ?? 0
      const end_line = node.loc.end?.line ?? start_line
      const tline = start_line === end_line ? start_line : _.range(start_line, end_line + 1)
      const traceItem: TraceItem = {
    file: sourcefile,
    line: tline,
    node,
    tag,
    affectedNodeName,
    _callbackEdge: options?.callbackEdge,
    _callbackClosureOwnerHash: options?.callbackClosureOwnerHash,
  }

      eachVal.taint.dedupLastTrace(sourcefile, node.loc.start?.line, tag, options)

      // traceItem 延迟交给递归传播，避免根值与子字段重复写入。
      processFieldAndArguments(eachVal, eachVal, 0, { ids: new Set(), buckets: new Map() }, node, traceItem, options)
    }
    return newVal
  }
  if (!val.taint?.isTaintedRec || !sourcefile) return val

  const start_line = node.loc.start?.line ?? 0
  const end_line = node.loc.end?.line ?? start_line
  const tline = start_line === end_line ? start_line : _.range(start_line, end_line + 1)
  const traceItem: TraceItem = {
    file: sourcefile,
    line: tline,
    node,
    tag,
    affectedNodeName,
    _callbackEdge: options?.callbackEdge,
    _callbackClosureOwnerHash: options?.callbackClosureOwnerHash,
  }

  if (val.taint.hasTraces()) {
    val.taint.dedupLastTrace(sourcefile, start_line, tag, options)

    let newVal
    if (Config.shareSourceLineSet) {
      newVal = val
    } else {
      newVal = buildNewCopiedWithTag(globalAnalyzer, val, sig)
      newVal.value = val.value
    }
    // 根值已有 trace 时先补当前 trace，子字段递归阶段只做去重合并。
    if (traceItem && newVal.taint?.hasTags()) {
      newVal.taint.addTraceToAllTags(traceItem, options)
    }
    // traceItem 延迟交给递归传播，避免根值与子字段重复写入。
    processFieldAndArguments(newVal, newVal, 0, { ids: new Set(), buckets: new Map() }, node, traceItem, options)
    return newVal
  }
  const newVal = buildNewCopiedWithTag(globalAnalyzer, val, sig)
  newVal.value = val.value

  // traceItem 延迟交给递归传播，避免根值与子字段重复写入。
  processFieldAndArguments(newVal, newVal, 0, { ids: new Set(), buckets: new Map() }, node, traceItem, options)
  return newVal
}

/**
 *
 * @param val
 * @param res
 * @param stack
 * @param visited
 * @param node
 * @param traceItem - The trace item to be added during recursion
 */
function getLastTraceVariantKey(val: SourceLineValue): string {
  const trace = val?.taint?.getFirstTrace?.()
  if (!Array.isArray(trace) || trace.length === 0) return '<empty>'
  const last = trace[trace.length - 1]
  return `${last?.file ?? ''}:${JSON.stringify(last?.line ?? '')}:${last?.tag ?? ''}:${last?.affectedNodeName ?? ''}`
}

function isTerminalStringValueOfTrace(traceItem?: TraceItem): boolean {
  return traceItem?.affectedNodeName === 'String' && prettyPrint(traceItem?.node).includes('String.valueOf')
}

function shouldPropagateTraceItemAtStack(traceItem: TraceItem, stack: number): boolean {
  if (traceItem?.tag === 'Return Value: ') return true
  return !isTerminalStringValueOfTrace(traceItem) || stack <= 2
}

function needsNestedSourceLineIsolation(val: unknown, traceItem?: unknown): boolean {
  const candidate = val as { taint?: { hasTags?: () => boolean } } | null | undefined
  return Boolean(globalAnalyzer?.enableNestedSourceLineIsolation && traceItem && candidate?.taint?.hasTags?.())
}

const NESTED_ISOLATION_QID_MARKER = '<nested_'
let _nestedIsolationSeq = 0

type NestedIsolatedValue = SourceLineValue & {
  _qid?: string
  _logicalQid?: string
  uuid?: string | null
  calculateAndRegisterUUID?: () => void
}

function isolateNestedSourceLineValue(val: SourceLineValue, traceItem?: TraceItem): SourceLineValue {
  if (!needsNestedSourceLineIsolation(val, traceItem)) return val

  const sourceVal = val as NestedIsolatedValue
  // 已隔离的值复用当前 symbolTable 条目，避免递归传播重复注册等价副本。
  if (sourceVal._qid?.includes(NESTED_ISOLATION_QID_MARKER)) return val

  const isolatedVal = shallowCopyValue(val) as NestedIsolatedValue
  isolatedVal.value = sourceVal.value
  // qid 后缀只用于嵌套 trace 隔离，避免子值与原值共享同一 symbolTable 项。
  isolatedVal._qid = `${isolatedVal._qid ?? ''}<nested_${++_nestedIsolationSeq}_endtag>`
  isolatedVal._logicalQid = undefined
  isolatedVal.uuid = null
  isolatedVal.calculateAndRegisterUUID?.()
  return isolatedVal
}

type VisitState = {
  ids: Set<SourceLineValue>
  // 结构等价桶索引（vtype:sid:logicalQid:astNodeRef:type:taintFlag）。
  // 把昂贵的 getLastTraceVariantKey 留到桶内 live 状态比较，避免 snapshot 漏掉
  // 后续被加深的 trace 步（例如匿名函数 wrapper 的延迟传播）。
  buckets: Map<string, SourceLineValue[]>
}

// AST 节点标识符缓存：用于桶键拼接。原结构比对用 === 引用相等，这里用模块内单调 id 还原同一语义。
const astNodeIdCache: WeakMap<object, number> = new WeakMap<object, number>()
let astNodeIdSeq = 0
function getAstNodeId(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  let id = astNodeIdCache.get(node as object)
  if (id === undefined) {
    id = ++astNodeIdSeq
    astNodeIdCache.set(node as object, id)
  }
  return String(id)
}

function buildBucketKey(val: SourceLineValue): string | null {
  if (val.vtype === 'union' || val.vtype === 'BVT') return null
  return `${val.vtype ?? ''}|${val.sid ?? ''}|${val.logicalQid ?? ''}|${val.type ?? ''}|${val.taint?.isTaintedRec ? '1' : '0'}|${getAstNodeId(val.ast?.node)}`
}

function processFieldAndArguments(
  val: SourceLineValue,
  res: SourceLineResult,
  stack: number,
  visited: VisitState,
  node: SourceLineNode,
  traceItem?: TraceItem,
  options?: TraceWriteOptions
): void {
  if (visited.ids.has(val)) {
    return
  }
  // 跨 addSrcLineInfo 调用 memo：本入口内同一污染子树（全 tag 末步指纹相同）已递归灌过 trace。
  // 命中时仍执行 propagateTraceFrom（保证 res 取得末步），仅跳过子树递归（buildNestedTraceCopy 风暴源）。
  // 仅 Python analyzer（crossCallVisitedEnabled=true 且按入口 reset）启用，避免 JS/Go/Java 跨入口污染。
  // union/BVT（buildBucketKey 返 null）不进跨调用 memo，只走下方单次 visited 引用相等。
  let crossCallMemoSkipped = false
  const bucketKey = buildBucketKey(val)
  if (globalAnalyzer?.crossCallVisitedEnabled === true && bucketKey !== null) {
    const crossCallKey = buildCrossCallVisitedKey(bucketKey, val.taint)
    if (crossCallKey !== null) {
      if (probeCrossCallVisited(crossCallKey)) {
        crossCallMemoSkipped = true
      } else {
        markCrossCallVisited(crossCallKey)
      }
    }
  }
  if (bucketKey !== null) {
    const bucket = visited.buckets.get(bucketKey)
    if (bucket && bucket.length > 0) {
      const valLastKey = getLastTraceVariantKey(val)
      for (const a of bucket) {
        if (getLastTraceVariantKey(a) === valLastKey) {
          return
        }
      }
    }
  }
  visited.ids.add(val)
  if (bucketKey !== null) {
    const bucket = visited.buckets.get(bucketKey)
    if (bucket) bucket.push(val)
    else visited.buckets.set(bucketKey, [val])
  }
  if (traceItem && val?.taint?.hasTags()) {
    val.taint.propagateTraceFrom(res.taint, shouldPropagateTraceItemAtStack(traceItem, stack) ? traceItem : undefined, options)
  }
  if (stack >= 20 || crossCallMemoSkipped) {
    return
  }

  // 仅递归处理仍携带污点的符号值。
  if (!val.taint?.isTaintedRec) {
    return
  }

  // res trace 或当前 traceItem 至少存在其一时，才需要继续向子值传播。
  if (!res.taint.hasTraces() && !traceItem) {
    return
  }
  if (val.taint?.isTaintedRec && val.vtype === 'BVT') {
    const childValue: Record<string, SourceLineValue> = val.value && typeof val.value === 'object' && !Array.isArray(val.value) ? val.value as Record<string, SourceLineValue> : {}
    const childKeys = Object.keys(childValue)
    for (const key of childKeys) {
      const arg = val.getChild?.(key)
      if (arg == null) continue
      if (arg.taint?.isTaintedRec) {
        const nextArg = isolateNestedSourceLineValue(arg, traceItem)
        if (nextArg !== arg) childValue[key] = nextArg
        processFieldAndArguments(nextArg, res, stack + 1, visited, node, traceItem, options)
      }
    }
  } else if (
    typeof val?._field !== 'undefined' &&
    (Array.isArray(val?._field) || Object.getOwnPropertyNames(val?._field).length !== 0) &&
    val.taint?.isTaintedRec
  ) {
    if (Array.isArray(val._field)) {
      for (const argI in val._field) {
        const arg = val.getFieldValue?.(argI)
        if (arg?.taint?.isTaintedRec) {
          const nextArg = isolateNestedSourceLineValue(arg, traceItem)
          if (nextArg !== arg) val.setFieldValue?.(argI, nextArg)
          processFieldAndArguments(nextArg, res, stack + 1, visited, node, traceItem, options)
        }
      }
    } else if (val.members) {
      for (const key of val.members.keys()) {
        const arg = val.members.get(key)
        if (typeof arg === 'undefined' || arg === null || !arg.taint) {
          continue
        }
        if (arg.taint?.isTaintedRec) {
          const nextArg = isolateNestedSourceLineValue(arg, traceItem)
          if (nextArg !== arg) val.members.set(key, nextArg)
          processFieldAndArguments(nextArg, res, stack + 1, visited, node, traceItem, options)
        }
      }
    }
  }
  if (val?.taint?.isTaintedRec && Array.isArray(val?.arguments)) {
    const argsSnapshot = val.arguments
    for (let argIdx = 0; argIdx < argsSnapshot.length; argIdx++) {
      const arg = argsSnapshot[argIdx]
      if (typeof arg === 'undefined' || arg === null) {
        continue
      }
      try {
        if (arg.taint?.isTaintedRec) {
          const nextArg = isolateNestedSourceLineValue(arg, traceItem)
          if (nextArg !== arg) argsSnapshot[argIdx] = nextArg
          processFieldAndArguments(nextArg, res, stack + 1, visited, node, traceItem, options)
        }
      } catch (e) {}
    }
  }
  if (val?.left?.taint?.isTaintedRec) {
    val.left = isolateNestedSourceLineValue(val.left, traceItem)
    processFieldAndArguments(val.left, res, stack + 1, visited, node, traceItem, options)
  }
  if (val?.right?.taint?.isTaintedRec) {
    val.right = isolateNestedSourceLineValue(val.right, traceItem)
    processFieldAndArguments(val.right, res, stack + 1, visited, node, traceItem, options)
  }
  if (val?.expression?.taint?.isTaintedRec) {
    val.expression = isolateNestedSourceLineValue(val.expression, traceItem)
    processFieldAndArguments(val.expression, res, stack + 1, visited, node, traceItem, options)
  }
  if (val?.children && val.vtype !== 'BVT') {
    for (const key in val.children) {
      if (Object.prototype.hasOwnProperty.call(val.children, key)) {
        const children = val.children[key]
        if (typeof children === 'undefined') {
          continue
        }
        if (children.taint?.isTaintedRec) {
          const nextChildren = isolateNestedSourceLineValue(children, traceItem)
          if (nextChildren !== children) val.children[key] = nextChildren
          processFieldAndArguments(nextChildren, res, stack + 1, visited, node, traceItem, options)
        }
      }
    }
  }

  if (val.vtype === 'symbol') {
    const processMemberAccess = (target: 'object' | 'property') => {
      const targetRef = target === 'object' ? val.object : val.property
      if (!targetRef) return

      if (targetRef.object && targetRef?.object?.sid && targetRef?.object?.sid?.includes('__tmp')) {
        return
      }

      const nextTarget = isolateNestedSourceLineValue(targetRef, traceItem)
      if (nextTarget !== targetRef) {
        if (target === 'object') {
          val.object = nextTarget
        } else {
          val.property = nextTarget
        }
      }
      processFieldAndArguments(nextTarget, res, stack + 1, visited, node, traceItem, options)
    }

    if (val.object?.taint && val.object.taint?.isTaintedRec) {
      processMemberAccess('object')
    }

    if (val.property?.taint && val.property.taint?.isTaintedRec) {
      processMemberAccess('property')
    }
  }
  if (val?.misc_?.buffer && Array.isArray(val.misc_.buffer)) {
    for (const bufferI in val.misc_.buffer) {
      const buffer = val.misc_.buffer[bufferI]
      if (buffer.taint?.isTaintedRec) {
        const nextBuffer = isolateNestedSourceLineValue(buffer, traceItem)
        if (nextBuffer !== buffer) val.misc_.buffer[bufferI] = nextBuffer
        processFieldAndArguments(nextBuffer, res, stack + 1, visited, node, traceItem, options)
      }
    }
  }
}

/**
 *
 * @param fdef
 * @param node
 */
function getNodeTrace(fdef: any, node: any) {
  if (!node) return
  const { loc } = node
  if (!loc) return {}

  let src_node = node
  let sourcefile = fdef?.loc?.sourcefile
  while (src_node && !src_node?.loc?.sourcefile) {
    src_node = src_node.parent
  }
  if (src_node) {
    sourcefile = src_node?.loc?.sourcefile
  }

  const line = loc.start?.line === loc.end?.line ? loc.start?.line : _.range(loc.start?.line, loc.end?.line + 1)
  if (sourcefile === undefined) {
    sourcefile = node?.loc?.sourcefile
  }
  return { file: sourcefile, node, line }
}

/**
 *
 * @param sourcefile
 * @param code
 */
function storeCode(sourcefile: string, code: string) {
  const codeCache = getSourceCodeCache()
  const fname = sourcefile ? sourcefile.toString() : `_f_${codeCache.size}`
  const lines = (code as string).split(/\n/)
  codeCache.set(fname, lines)
  // 同时更新 analyzer.sourceCodeCache（如果存在）
  if (globalAnalyzer) {
    globalAnalyzer.sourceCodeCache = codeCache
  }
  return fname
}

const TRACE_LINE_MAX_LEN = 200

// trace 单行超长时尾部截断；匿名函数 / 长字面量在源码中常常铺成单行 800+ 字符。
function truncateTraceLine(code: any): any {
  if (typeof code !== 'string') return code
  if (code.length <= TRACE_LINE_MAX_LEN) return code
  return `${code.substring(0, TRACE_LINE_MAX_LEN)}...`
}

/**
 *
 * @param item
 */
function formatSingleTrace(item: any) {
  let res = ''
  let prev_file: any
  let prev_line: any
  if (item.str) {
    const lno = item.line
    if (lno) {
      const pat = lno < 10 ? '   ' : lno < 100 ? '  ' : ' '
      res += `  ${lno}:${pat}`
    }
    res += `${item.str}\n`
    prev_line = -1
    return res
  }

  let fname = item.file
  if (!fname) {
    let fnode = item.node
    while (fnode) {
      if (fnode.loc.sourcefile) {
        fname = fnode.loc.sourcefile
        break
      }
      fnode = fnode.parent
    }
  }
  if (fname && fname !== prev_file) {
    if (!fname.startsWith('_f_')) {
      res += ` ${item.shortfile || fname}\n`
    }
  }
  const affectName = item.affectedNodeName
  if (affectName !== undefined) {
    res += `  ` + `AffectedNodeName: ${affectName}\n`
  }
  let code
  // CALL tag 的 loc 覆盖整个 call 表达式，遇到匿名函数/lambda 时会把整个函数体行号范围都展开，
  // 导致 trace 极其冗长。CALL 跨度超过 10 行时只保留首行调用点。
  const isCallTag = item.tag === 'CALL: '
  if (fname) {
    const codeCache = getSourceCodeCache()
    const flines = codeCache.get(fname)
    let lines = Array.isArray(item.line) ? item.line : [item.line]
    if (isCallTag && lines.length > 10) lines = [lines[0]]
    for (let i = 0; i < lines.length; i++) {
      const lno = lines[i]
      if (lno === prev_line && !(i == 0 && prev_file !== fname)) continue
      prev_line = lno
      code = flines?.[lno - 1]
      if (item.tag) code = `${item.tag} ${code}`
      code = truncateTraceLine(code)
      const pat = lno < 10 ? '   ' : lno < 100 ? '  ' : ' '
      res += `  ${lno}:${pat}${code}\n`
    }
  } else {
    const lno = item.line
    if (lno === prev_line) return res
    prev_line = lno
    code = prettyPrint(item.node)
    const pat = lno < 10 ? '   ' : lno < 100 ? '  ' : ' '
    if (item.tag) code = `${item.tag} ${code}`
    code = truncateTraceLine(code)
    res += `  ${lno}:${pat}${code}\n`
  }
  prev_file = fname
  return res
}

/**
 *
 * @param trace
 */
function formatTraces(trace: any) {
  let res = ''
  for (const item of trace) {
    res += formatSingleTrace(item)
  }
  res = res.substring(0, res.length - 1)
  return res
}

/**
 *
 * @param loc
 */
function getCodeByLocation(loc: any) {
  const sourcefile = loc?.sourcefile
  const startLine = loc?.start?.line
  const endLine = loc?.end?.line

  if (sourcefile && startLine && endLine) {
    const codeCache = getSourceCodeCache()
    const lines = codeCache.get(sourcefile)
    if (lines) {
      const startIdx = startLine - 1
      const endIdx = endLine - 1
      const targetLines = lines.slice(startIdx, endIdx + 1)
      if (targetLines.length === 0) return ''
      return targetLines.join('\n')
    }
  }
  return ''
}

/**
 *
 * @param sourcefile
 */
function getCodeBySourceFile(sourcefile: string) {
  const codeCache = getSourceCodeCache()
  if (sourcefile && codeCache.has(sourcefile)) {
    const lines = codeCache.get(sourcefile)
    if (lines && lines.length > 0) {
      return lines.join('\n')
    }
  }
  return ''
}

module.exports = {
  addSrcLineInfo,
  getNodeTrace,
  storeCode,
  formatTraces,
  formatSingleTrace,
  getCodeByLocation,
  getCodeBySourceFile,
  setGlobalAnalyzer,
  getGlobalAnalyzer,
}
