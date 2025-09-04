const fs = require('fs')
const numset = require('./olist')

/* Bi-directional graphs represented using adjacency sets. */
/**
 *
 */
function Graph() {
  this.succ = []
  this.prec = []

  const id2node = (this.id2node = [])
  let nextNodeId = 0

  const nodeId = (this.nodeId = function (nd) {
    const id = nd.attr.hasOwnProperty('node_id') ? nd.attr.node_id : (nd.attr.node_id = nextNodeId++)
    id2node[+id] = nd
    return id
  })

  this.addVertex = function (data) {
    const id = nodeId(data)
    this.succ[id] = []
    this.prec[id] = []
    return id
  }

  this.addEdge = function (from, to) {
    const fromId = nodeId(from)
    const toId = nodeId(to)
    if (fromId === toId) return
    this.succ[fromId] = numset.add(this.succ[fromId], toId)
    this.prec[toId] = numset.add(this.prec[toId], fromId)
  }

  this.addEdges = function (from, tos) {
    for (let i = 0; i < tos.length; ++i) this.addEdge(from, tos[i])
  }

  this.iter = function (cb) {
    for (let i = 0; i < this.succ.length; ++i) {
      var from = id2node[i]
      if (this.succ[i] === undefined) {
        cb(from)
        continue
      }
      numset.iter(this.succ[i], function (succ) {
        cb(from, id2node[succ])
      })
    }
  }

  this.hasEdge = function (from, to) {
    const fromId = nodeId(from)
    const toId = nodeId(to)
    return numset.contains(this.succ[fromId], toId)
  }

  this.hasVertex = function (vertex) {
    const id = nodeId(vertex)
    return id2node[id]
  }

  // ***

  this.iterNodes = function (cb) {
    for (let i = 0; i < this.id2node.length; ++i) {
      const nd = id2node[i]
      cb(nd)
    }
  }

  this.onsucc = function (from, cb) {
    const i = from.attr.node_id
    numset.iter(this.succ[i], function (succ) {
      cb(id2node[succ])
    })
  }

  this.onprec = function (from, cb) {
    const i = from.attr.node_id
    numset.iter(this.prec[i], function (prec) {
      cb(id2node[prec])
    })
  }

  // ***

  this.dotify = function () {
    let res = ''
    res += 'digraph FG {\n'
    this.iter(function (from, to) {
      if (to) res += `  "${from.attr.pp()}" -> "${to.attr.pp()}";\n`
      else res += `  "${from.attr.pp()}";\n`
    })
    res += '}\n'
    return res
  }

  this.writeDOTFile = function (fn) {
    const dot = this.dotify()
    fs.writeFileSync(fn, dot)
    return dot
  }
}

exports.Graph = Graph
