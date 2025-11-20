const uuid = require('node-uuid')
const config = require('../config')

interface TraceItem {
  file?: string
  line?: number | number[]
  tag?: string
  node?: any
  affectedNodeName?: string
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
function getBwdTrace(root: any, lines: TraceItem[], tagName?: string): void {
  if (!root) return

  const worklist = [root]
  const visited = new Set()
  while (worklist.length > 0) {
    const node = worklist.shift()
    if (!node || visited.has(node)) continue
    visited.add(node)
    const { trace } = node
    if (trace) {
      for (let i = trace.length - 1; i >= 0; i--) {
        const item = trace[i]
        const prev_item = lines[lines.length - 1]
        if (!prev_item || prev_item.file !== item.file || prev_item.line !== item.line || prev_item.tag !== item.tag)
          lines.push(item)
      }
      if (tagName && node?._tags.has(tagName)) {
        return
      }
    }

    // now go through the sub nodes
    if (Array.isArray(node)) {
      for (const child of node) {
        worklist.push(child)
      }
      continue
    }

    if (!node.type) continue
    if (!node.hasTagRec) continue

    switch (node.type) {
      case 'MemberAccess': {
        worklist.push(node.object)
        worklist.push(node.property)
        break
      }
      case 'BinaryOperation': {
        worklist.push(node.left)
        worklist.push(node.right)
        break
      }
      case 'UnaryOperation': {
        worklist.push(node.subExpression)
        break
      }
      case 'FunctionCall': {
        worklist.push(node.expression)
        worklist.push(node.arguments)
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
function getTrace(node: any, tagName?: string): TraceItem[] {
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
