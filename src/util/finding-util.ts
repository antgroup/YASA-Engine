const uuid = require('node-uuid')
const config = require('../config')

interface TraceItem {
  file?: string
  line?: number | number[]
  tag?: string
  source_owner_ep?: string
  node?: {
    loc?: { sourcefile?: string; start?: { line?: number; column?: number }; end?: { line?: number; column?: number } }
    _meta?: { nodehash?: unknown }
    id?: { name?: string; loc?: { start?: { line?: number } } }
    body?: { loc?: { start?: { line?: number } } }
  }
  affectedNodeName?: string
  _synthetic?: boolean
  _orphanCall?: boolean
  /** trace 生成阶段标记的回调边及其闭包归属。 */
  _callbackEdge?: boolean
  _callbackClosureOwnerHash?: string
  str?: string
}

export interface TraceWriteOptions {
  callbackEdge?: boolean
  callbackClosureOwnerHash?: string
}

export type { TraceItem }


interface TraceTaintCarrier {
  type?: 'MemberAccess' | 'BinaryExpression' | 'UnaryOperation' | 'FunctionCall' | string
  taint?: {
    isTaintedRec?: boolean
    getFirstTrace?: () => TraceItem[] | null
    getTrace?: (tag: string) => TraceItem[] | null
    containsTag?: (tag: string) => boolean
  }
  object?: TraceTaintCarrier
  property?: TraceTaintCarrier
  left?: TraceTaintCarrier
  right?: TraceTaintCarrier
  subExpression?: TraceTaintCarrier
  expression?: TraceTaintCarrier
  arguments?: TraceTaintCarrier[]
}

interface RangePosition {
  character: number
  line: number
}

/**
 * Obtain the source lines for all involved components (breath-first version)
 * @param root
 * @param lines
 * @param tagName
 */
function getBwdTrace(root: TraceTaintCarrier | TraceTaintCarrier[] | undefined | null, lines: TraceItem[], tagName?: string): void {
  if (!root) return

  const worklist: Array<{ node: any; depth: number }> = [{ node: root, depth: 0 }]
  const visited = new Set()
  const maxDepth = tagName ? 8 : Number.POSITIVE_INFINITY
  while (worklist.length > 0) {
    const current = worklist.shift()
    if (!current) break
    const { node, depth } = current
    if (!node || visited.has(node) || depth > maxDepth) continue
    visited.add(node)

    const enqueue = (child: any): void => {
      if (child && typeof child === 'object' && !visited.has(child)) worklist.push({ node: child, depth: depth + 1 })
    }

    if (Array.isArray(node)) {
      for (const child of node) enqueue(child)
      continue
    }
    if (!node.taint) continue
    const trace = tagName ? node.taint.getTrace?.(tagName) : node.taint.getFirstTrace?.()
    if (trace && trace.length > 0) {
      for (let i = trace.length - 1; i >= 0; i--) {
        const item = trace[i]
        const prev_item = lines[lines.length - 1]
        if (!prev_item || prev_item.file !== item.file || prev_item.line !== item.line || prev_item.tag !== item.tag)
          lines.push(item)
      }
      if (tagName && (node?.taint.containsTag?.(tagName) || trace.some((item: TraceItem) => item?.tag === 'SOURCE: '))) {
        return
      }
    }

    if (!node.taint?.isTaintedRec) continue

    const buffer = typeof node.getMisc === 'function' ? node.getMisc('buffer') : node.misc_?.buffer
    if (Array.isArray(buffer)) for (const child of buffer) enqueue(child)
    if (node.vtype === 'union' && Array.isArray(node.value)) {
      for (const child of node.value) enqueue(child)
    } else if (node.value && typeof node.value === 'object') {
      for (const child of Object.values(node.value)) enqueue(child)
    }
    const members = node._members
    if (members && typeof members.forEach === 'function') {
      try {
        members.forEach((child: any) => enqueue(child))
      } catch (_error) {
        // 代理成员可能抛出迭代异常，忽略后继续其它路径。
      }
    }

    // 子节点遍历（数组分支已在出队前处理）
    if (!node.type) continue

    switch (node.type) {
      case 'MemberAccess': {
        enqueue(node.object)
        enqueue(node.property)
        break
      }
      case 'BinaryExpression': {
        enqueue(node.left)
        enqueue(node.right)
        break
      }
      case 'UnaryOperation': {
        enqueue(node.subExpression)
        break
      }
      case 'FunctionCall': {
        enqueue(node.expression)
        enqueue(node.arguments)
        break
      }
    } // end switch
  } // end for
}
/**
 * remove the shared prefix of the file paths
 * @param original
 * @returns {*}
 */
function shortenSourceFile(original: string): string {
  const path_prefix = config.maindirPrefix
  if (path_prefix) {
    if (original.startsWith(path_prefix)) {
      return original.substring(path_prefix.length)
    }
  }
  return original
}

/**
 * sourceFileURI
 * @param original
 */
function sourceFileURI(original: string): string {
  if (original) {
    const filepath = shortenSourceFile(original)
    if (!filepath.startsWith('/')) return `file:///${filepath}`
    return `file://${filepath}`
  }
  return ''
}

/**
 * convert the ast node to the range in the report
 * @param node
 */
function convertNode2Range(node: any): RangePosition[] {
  let startCharacter = 0
  let endCharacter = -1
  let startLine = 0
  let endLine = 0
  if (typeof node.loc?.start?.column !== 'undefined') startCharacter = node.loc.start.column
  if (typeof node.loc?.end?.column !== 'undefined') endCharacter = node.loc.end.column
  if (typeof node.loc?.start?.line !== 'undefined' && node.loc?.start?.line > 0) startLine = node.loc.start.line
  if (typeof node.loc?.end?.line !== 'undefined' && node.loc?.end?.line > 0) endLine = node.loc.end.line
  return [
    {
      character: startCharacter,
      line: startLine,
    },
    {
      character: endCharacter,
      line: endLine,
    },
  ]
}

/**
 * get trace
 * @param node
 * @param tagName
 */
function getTrace(node: TraceTaintCarrier | undefined | null, tagName?: string): TraceItem[] {
  const direct = tagName && node?.taint?.getTrace?.(tagName)
  if (Array.isArray(direct) && direct.length > 0) return [...direct]
  const res: TraceItem[] = []
  getBwdTrace(node, res, tagName)
  return res.reverse()
}

/**
 * add a new finding to findings, category by outputStrategyId
 * @param findings
 * @param finding
 * @param outputStrategyId
 * @param info
 * @param info.sourcefile
 */
function addFinding(
  findings: Record<string, any[]>,
  finding: Record<string, any>,
  outputStrategyId: string,
  info?: { sourcefile?: string }
): void {
  let categoryFindings = findings[outputStrategyId]
  if (!categoryFindings) {
    findings[outputStrategyId] = []
    categoryFindings = findings[outputStrategyId]
  }
  if (info && info.sourcefile) {
    finding.sourcefile = info.sourcefile
  }

  finding.id = uuid.v4()
  categoryFindings.push(finding)
}

export { sourceFileURI, convertNode2Range, getTrace, shortenSourceFile, addFinding }
