/**
 *
 */
class Graph {
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
  addNode(node_id, opts) {
    if (node_id === undefined) {
      node_id = 'undefined'
    }
    if (node_id === 'hasOwnProperty') {
      node_id = '[hasOwnProperty]'
    }
    const node = { id: node_id, opts }
    this.nodes.set(node_id, node)
    return node
  }

  /**
   *
   * @param n1
   * @param n2
   * @param opts
   */
  addEdge(n1, n2, opts) {
    const edge_id = `${n1.id}->${n2.id}`
    const edge = {
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
  dumpGraph() {
    const newEdges = [...this.edges.entries()]
      .filter(([key, value]) => !key.includes('entry_point'))
      .reduce((acc, [key, value]) => {
        const { opts, ...otherField } = value
        const { callSite, ...rest } = opts
        acc[key] = { ...otherField, callSite, ...rest }
        return acc
      }, {})
    const newNodes = [...this.nodes.entries()]
      .filter(([key, value]) => !key.includes('entry_point'))
      .reduce((acc, [key, value]) => {
        const { opts, ...otherField } = value
        const { funcDef } = opts
        acc[key] = { ...otherField, funcDef }
        return acc
      }, {})
    return {
      nodes: newNodes,
      edges: newEdges,
    }
  }
}

exports.Graph = Graph
