import fs from 'fs'
import * as numsetBigraph from './olist'

interface GraphNode {
  attr: {
    node_id?: number
    pp?: () => string
    [key: string]: any
  }
}

interface BiGraph {
  succ: any[]
  prec: any[]
  id2node: GraphNode[]
  nodeId: (nd: GraphNode) => number
  addVertex: (data: GraphNode) => number
  addEdge: (from: GraphNode, to: GraphNode) => void
  addEdges: (from: GraphNode, tos: GraphNode[]) => void
  iter: (cb: (from: GraphNode, to?: GraphNode) => void) => void
  hasEdge: (from: GraphNode, to: GraphNode) => boolean
  hasVertex: (vertex: GraphNode) => GraphNode | undefined
  iterNodes: (cb: (nd: GraphNode) => void) => void
  onsucc: (from: GraphNode, cb: (nd: GraphNode) => void) => void
  onprec: (from: GraphNode, cb: (nd: GraphNode) => void) => void
  dotify: () => string
  writeDOTFile: (fn: string) => string
}

/* Bi-directional graphs represented using adjacency sets. */
/**
 *
 */
function GraphBigraph(this: BiGraph): BiGraph {
  this.succ = []
  this.prec = []

  const id2node = (this.id2node = [])
  let nextNodeId = 0

  const nodeId = (this.nodeId = function (nd: GraphNode): number {
    let id: any
    if (nd.attr.hasOwnProperty('node_id')) {
      id = nd.attr.node_id
    } else {
      id = nextNodeId++
      nd.attr.node_id = id
    }
    (id2node as any)[+id] = nd
    return +id
  })

  this.addVertex = function (this: BiGraph, data: GraphNode): number {
    const id = nodeId(data)
    this.succ[id] = []
    this.prec[id] = []
    return id
  }

  this.addEdge = function (this: BiGraph, from: GraphNode, to: GraphNode): void {
    const fromId = nodeId(from)
    const toId = nodeId(to)
    if (fromId === toId) return
    this.succ[fromId] = numsetBigraph.add(this.succ[fromId], toId)
    this.prec[toId] = numsetBigraph.add(this.prec[toId], fromId)
  }

  this.addEdges = function (this: BiGraph, from: GraphNode, tos: GraphNode[]): void {
    for (let i = 0; i < tos.length; ++i) this.addEdge(from, tos[i])
  }

  this.iter = function (this: BiGraph, cb: (from: GraphNode, to?: GraphNode) => void): void {
    for (let i = 0; i < this.succ.length; ++i) {
      var from = id2node[i]
      if (this.succ[i] === undefined) {
        cb(from)
        continue
      }
      numsetBigraph.iter(this.succ[i], function (succ: number) {
        cb(from, id2node[succ])
      })
    }
  }

  this.hasEdge = function (this: BiGraph, from: GraphNode, to: GraphNode): boolean {
    const fromId = nodeId(from)
    const toId = nodeId(to)
    return numsetBigraph.contains(this.succ[fromId], toId)
  }

  this.hasVertex = function (this: BiGraph, vertex: GraphNode): GraphNode | undefined {
    const id = nodeId(vertex)
    return id2node[id]
  }

  // ***

  this.iterNodes = function (this: BiGraph, cb: (nd: GraphNode) => void): void {
    for (let i = 0; i < this.id2node.length; ++i) {
      const nd = id2node[i]
      cb(nd)
    }
  }

  this.onsucc = function (this: BiGraph, from: GraphNode, cb: (nd: GraphNode) => void): void {
    const i = from.attr.node_id!
    numsetBigraph.iter(this.succ[i], function (succ: number) {
      cb(id2node[succ])
    })
  }

  this.onprec = function (this: BiGraph, from: GraphNode, cb: (nd: GraphNode) => void): void {
    const i = from.attr.node_id!
    numsetBigraph.iter(this.prec[i], function (prec: number) {
      cb(id2node[prec])
    })
  }

  // ***

  this.dotify = function (this: BiGraph): string {
    let res = ''
    res += 'digraph FG {\n'
    this.iter(function (from: GraphNode, to?: GraphNode) {
      if (to) res += `  "${from.attr.pp?.()}" -> "${to.attr.pp?.()}";\n`
      else res += `  "${from.attr.pp?.()}";\n`
    })
    res += '}\n'
    return res
  }

  this.writeDOTFile = function (this: BiGraph, fn: string): string {
    const dot = this.dotify()
    fs.writeFileSync(fn, dot)
    return dot
  }

  return this as any as BiGraph
}

export { GraphBigraph as Graph }
