const QidUnifyUtil = require('../../../util/qid-unify-util') as { qidUnifyByRemoveAngleAndPrefix(value: string): string }

export type CalleeEntryLocation = {
  sourcefile: string
  start: { line: number; column?: number }
  end: { line: number; column?: number }
}

type NodeLocation = {
  sourcefile?: string
  start?: { line?: number; column?: number }
  end?: { line?: number; column?: number }
}

type CalleeEntryNode = {
  loc?: NodeLocation
  _meta?: { nodehash?: unknown }
  id?: { name?: string; loc?: NodeLocation }
  body?: { loc?: NodeLocation }
  [key: string]: unknown
}

type CalleeEntryFrame = {
  fname?: string
  qid?: string
  ast?: { node?: CalleeEntryNode }
}

export type CalleeEntry = {
  file: string
  line: number
  loc: CalleeEntryLocation
  node: CalleeEntryNode
  name: string
}

function validLocation(location: NodeLocation | undefined): { file: string; line: number; column?: number } | undefined {
  const file = location?.sourcefile
  const line = location?.start?.line
  if (typeof file !== 'string' || file.length === 0 || typeof line !== 'number') return undefined
  return { file, line, column: location?.start?.column }
}

/**
 * 统一 callee-entry 展示位置：方法标识符、方法体、函数节点依次回退，并压缩为单行。
 * 节点显式复制 frame nodeHash，避免位置包装丢失调用栈身份。
 */
export function getCalleeEntry(frame: unknown): CalleeEntry | undefined {
  if (!frame || typeof frame !== 'object') return undefined
  const candidate = frame as CalleeEntryFrame
  const node = candidate.ast?.node
  if (!node) return undefined
  const selected = validLocation(node.id?.loc) ?? validLocation(node.body?.loc) ?? validLocation(node.loc)
  if (!selected) return undefined
  const nodehash = node._meta?.nodehash
  const loc: CalleeEntryLocation = {
    sourcefile: selected.file,
    start: { line: selected.line, column: selected.column ?? 0 },
    end: { line: selected.line, column: selected.column ?? 0 },
  }
  const wrappedNode: CalleeEntryNode = { ...node, loc, _meta: { ...node._meta, nodehash } }
  const rawName = node.id?.name || candidate.fname || candidate.qid || '<bridge>'
  const name = QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(rawName) || rawName
  return { file: selected.file, line: selected.line, loc, node: wrappedNode, name }
}
