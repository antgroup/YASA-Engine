const QidUnifyUtil = require('./qid-unify-util')
const path = require('path')
const Config = require('../config')

interface GraphNode {
  id: string
  opts: any
}

interface GraphEdge {
  id: string
  sourceNodeId: string
  targetNodeId: string
  opts: any
}

/** 调用点位置三元组，用于区分同一 caller→callee 的不同调用行 */
interface CallSiteLoc {
  sourcefile?: string
  start?: { line?: number; column?: number }
  end?: { line?: number; column?: number }
}

/** addEdge 的 opts 中与调用点定位相关的字段 */
interface EdgeCallSiteOpts {
  /** 直接内联的调用点 loc（来自 extractCallSiteInfo） */
  callSite?: { loc?: CallSiteLoc }
  /** 调用点 AST 节点 nodehash（来自 callgraph-checker） */
  callSiteNodehash?: string
}

/**
 *
 */
class GraphClass {
  nodes: Map<string, GraphNode>

  edges: Map<string, GraphEdge>

  /**
   *
   */
  constructor() {
    this.nodes = new Map()
    this.edges = new Map()
  }

  /**
   *
   * @param node_id
   * @param opts
   */
  addNode(node_id: string, opts: any): GraphNode {
    if (node_id === undefined) {
      node_id = 'undefined'
    }
    if (node_id === 'hasOwnProperty') {
      node_id = '[hasOwnProperty]'
    }
    node_id = QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(node_id)
    // node 名内嵌的绝对路径段统一相对化，保持可移植性且不破坏语义分隔（同基准下绝对→相对是确定映射）
    node_id = this.relativePathsInNodeId(node_id)
    const node: GraphNode = { id: node_id, opts }
    this.nodes.set(node_id, node)
    return node
  }

  /**
   * 将 node 名中出现的绝对路径子串统一相对化为项目根相对路径
   * 匹配以 / 开头、由路径字字符（字母数字._-/~）组成的连续子串，逐段相对化
   * 项目外路径（相对化后仍以 .. 开头）回退原绝对路径，避免破坏唯一性
   */
  private relativePathsInNodeId(nodeId: string): string {
    let result = nodeId.replace(/(?:^|[^\w./~])(\/[\w./~-]+)/g, (match, p1: string) => {
      const rel = this.toRelativeSourceFile(p1)
      // 字符串起始的绝对路径直接替换为相对路径；非起始位置保留前导字符再拼 rel
      return match === p1 ? rel : match.charAt(0) + rel
    })
    // 残留前导 /（qid 命名惯例 /src/...），strlen >1 且非 UNC 路径时剥离
    if (result.startsWith('/') && !result.startsWith('//') && result.length > 1) {
      result = result.substring(1)
    }
    return result
  }

  /**
   * 将调用点源码绝对路径转成相对路径，基准取 Config.maindir（CLI 注入的项目根，
   * starter 解析 --sourcePath 时写入）或 Config.sourcePath，取不到时回退绝对路径
   */
  private toRelativeSourceFile(sourcefile: string): string {
    const base: string = (Config && (Config.maindir || Config.sourcePath)) || ''
    if (!base) return sourcefile
    try {
      const rel = path.relative(base, sourcefile)
      // path.relative 对无共同前缀的路径返回以 .. 开头，此时回退原值保稳定
      return rel && !rel.startsWith('..') ? rel : sourcefile
    } catch (_e) {
      return sourcefile
    }
  }

  /**
   * 从 opts 推导调用点定位 key，用于区分同一 caller→callee 的不同调用行
   * 优先级：callSite.loc 三元组（人类可读）> callSiteNodehash（AST 节点唯一）> 空
   * 同一调用点多次 addEdge 会得到相同 key，仍能按 Map.set 合并去重
   */
  private buildCallSiteKey(opts: EdgeCallSiteOpts | undefined): string {
    if (!opts) return ''
    const loc = opts.callSite?.loc
    if (loc && loc.sourcefile && loc.start && typeof loc.start.line === 'number') {
      const file = this.toRelativeSourceFile(loc.sourcefile)
      return `loc:${file}:${loc.start.line}:${loc.start.column ?? 0}`
    }
    if (opts.callSiteNodehash) return `nh:${opts.callSiteNodehash}`
    return ''
  }

  /**
   *
   * @param n1
   * @param n2
   * @param opts
   */
  addEdge(n1: GraphNode, n2: GraphNode, opts: any): void {
    const callSiteKey = this.buildCallSiteKey(opts as EdgeCallSiteOpts | undefined)
    // edge 唯一性加入调用点定位：同 caller→同 callee 的不同调用行各占一条边，
    // 同调用点多次 addEdge 仍按 Map.set 合并去重；无调用点信息时回退旧的 caller->callee 语义
    const edge_id = callSiteKey
      ? `${n1.id}->${n2.id}@${callSiteKey}`
      : `${n1.id}->${n2.id}`
    const edge: GraphEdge = {
      id: edge_id,
      sourceNodeId: n1.id,
      targetNodeId: n2.id,
      opts,
    }
    this.edges.set(edge_id, edge)
  }

  /**
   *
   */
  getNodesAsArray() {
    return Array.from(this.nodes.values())
  }

  /**
   *
   */
  getEdgesAsArray() {
    return Array.from(this.edges.values())
  }

  /**
   * 将callgraph的内容dump出去
   * @param astManager AST 管理器，用于从 nodehash 还原 AST 对象
   * @param symbolTable 符号表管理器，用于从 UUID 还原符号值对象
   */
  dumpGraph(astManager?: any, symbolTable?: any): { nodes: Record<string, any>; edges: Record<string, any> } {
    const newEdges = [...this.edges.entries()]
      .filter(([key, value]) => !key.includes('entry_point'))
      .reduce(
        (acc, [key, value]) => {
          const { opts, ...otherField } = value
          // 从 callSiteNodehash 还原 callSite
          // eslint-disable-next-line prefer-const
          let { callSite, ...rest } = opts
          if (opts.callSiteNodehash && astManager) {
            callSite = astManager.get(opts.callSiteNodehash)
          }
          acc[key] = { ...otherField, callSite: { loc: callSite?.loc }, ...rest }
          return acc
        },
        {} as Record<string, any>
      )
    const newNodes = [...this.nodes.entries()]
      .filter(([key, value]) => !key.includes('entry_point'))
      .reduce(
        (acc, [key, value]) => {
          const { opts, ...otherField } = value
          // 从 nodehash 和 UUID 还原 funcDef 和 funcSymbol
          let { funcDef } = opts
          let { funcSymbol } = opts
          if (opts.funcDefNodehash && astManager) {
            funcDef = astManager.get(opts.funcDefNodehash)
          }
          if (opts.funcSymbolUuid && symbolTable) {
            funcSymbol = symbolTable.get(opts.funcSymbolUuid)
          }
          acc[key] = {
            ...otherField,
            funcDef: funcDef?.loc ? { loc: funcDef?.loc, name: funcDef?.name } : undefined,
            fullName: funcSymbol?.qid && funcDef ? funcSymbol?.logicalQid : key,
          }
          return acc
        },
        {} as Record<string, any>
      )
    return {
      nodes: newNodes,
      edges: newEdges,
    }
  }
}

export { GraphClass as Graph }
