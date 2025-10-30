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
  addNode(node_id: string | undefined, opts: any): GraphNode {
    if (node_id === undefined) {
      node_id = 'undefined'
    }
    if (node_id === 'hasOwnProperty') {
      node_id = '[hasOwnProperty]'
    }
    const node: GraphNode = { id: node_id, opts }
    this.nodes.set(node_id, node)
    return node
  }

  /**
   *
   * @param n1
   * @param n2
   * @param opts
   */
  addEdge(n1: GraphNode, n2: GraphNode, opts: any): void {
    const edge_id = `${n1.id}->${n2.id}`
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
   */
  dumpGraph(): { nodes: Record<string, any>; edges: Record<string, any> } {
    const newEdges = [...this.edges.entries()]
      .filter(([key, value]) => !key.includes('entry_point'))
      .reduce((acc, [key, value]) => {
        const { opts, ...otherField } = value
        const { callSite, ...rest } = opts
        acc[key] = { ...otherField, callSite: { loc: callSite?.loc }, ...rest }
        return acc
      }, {} as Record<string, any>)
    const newNodes = [...this.nodes.entries()]
      .filter(([key, value]) => !key.includes('entry_point'))
      .reduce((acc, [key, value]) => {
        const { opts, ...otherField } = value
        const { funcDef, funcSymbol } = opts
        acc[key] = { ...otherField, funcDef: { loc: funcDef?.loc, name: funcDef?.name }, fullName: funcSymbol?._qid }
        return acc
      }, {} as Record<string, any>)
    return {
      nodes: newNodes,
      edges: newEdges,
    }
  }
}

export { GraphClass as Graph }
