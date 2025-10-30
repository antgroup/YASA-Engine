// used for dump call graph
import type { IConfig } from '../../config'

const _ = require('lodash')
const symAddressCallgraph = require('../../engine/analyzer/common/sym-address')
const kitCallgraph = require('../common/checker-kit')
const configCallgraph = require('../../config')
const CheckerCallgraph = require('../common/checker')
const CallgraphOutputStrategyCallgraph = require('../common/output/callgraph-output-strategy')

let ConfigCallgraph: IConfig
let loggerCallgraph: any
/**
 * CallgraphChecker represents calling relationships between procedures.
 * CallgraphChecker has nodes and edges.
 * In order to distinguish from analyzer's node, node in CallgraphChecker will be represented as GNode
 * Each GNode represents a procedure and each Edge (f, g) indicates that procedure f calls procedure g.
 * GNode is identified by 2 cases:
 * 1. procedure name and file location of definition, while the definition of the procedure can be reason out
 * 2. the expression sid of the call site, while 1st is not the case,
 *     e.g. console.log(), console is the built-in object, where log can't not be reason out, so the callee GNode
 *     will be represented as 'console.log'
 * Addition:
 * - anonymous function will be denoted from it's call site expression sid to make more sense
 */
class CallgraphChecker extends CheckerCallgraph {
  mng: any

  kit: any

  /**
   *
   * @param mng
   */
  constructor(mng: any) {
    super(mng, 'callgraph')
    this.mng = mng
    this.kit = kitCallgraph
    loggerCallgraph = kitCallgraph.logger(__filename)
    ConfigCallgraph = this.kit.Config
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any): void {
    if (configCallgraph.dumpAllCG) {
      const fullCallGraphFileEntryPoint = require('../common/full-callgraph-file-entrypoint')
      fullCallGraphFileEntryPoint.makeFullCallGraph(analyzer)
    }
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtNewObject(analyzer: any, scope: any, node: any, state: any, info: any): void {
    this.triggerAtFunctionCallBefore(analyzer, scope, node, state, info)
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const { fclos, argvalues, ainfo } = info
    if (fclos === undefined) {
      return
    }
    const stack = state.callstack
    const to = fclos
    const toAST = fclos && fclos.fdef
    const call_site_node = node

    const from = stack[stack.length - 1] || { name: '<__entry_point__>', sid: '<__entry_point__>', vtype: 'fclos' }
    const fromAST = from.fdef
    const callgraph = (ainfo.callgraph = ainfo.callgraph || new this.kit.Graph())
    const fromNode = callgraph.addNode(this.prettyPrint(from, fromAST, call_site_node), {
      funcDef: fromAST,
      funcSymbol: from,
    })
    const toNode = callgraph.addNode(this.prettyPrint(to, toAST, call_site_node), { funcDef: toAST, funcSymbol: to })
    callgraph.addEdge(fromNode, toNode, { callSite: call_site_node })
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtEndOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const finding = analyzer.ainfo.callgraph
    finding.type = this.getCheckerId()
    this.mng.newFinding(finding, CallgraphOutputStrategyCallgraph.outputStrategyId)
  }

  /**
   *
   * @param fclos fclos
   * @param fdef function definition
   * @param callSiteNode call site node
   */
  prettyPrint(fclos: any, fdef: any, callSiteNode: any): string {
    let ret: string = ''
    let name: string
    if (!fdef || !fdef.name || fdef.name === '<anonymous>') {
      if (fclos) {
        // 针对[]byte(xx)场景，fclos是一个symbol value，且fclos.qid是ArrayType这个identifier节点，而非string，因此这里if条件需做限定
        if (fclos.qid && typeof fclos.qid === 'string') {
          ret = fclos.qid
        } else if (fclos.vtype && fclos.vtype === 'union') {
          const fclosArray = fclos.value
          if (Array.isArray(fclosArray)) {
            const fclos = _.find(fclosArray, (f: any) => f.id)
            if (fclos) {
              ret = fclos.id
            }
          }
        } else if (fclos.vtype && fclos.type !== 'MemberAccess') {
          // 针对[]byte(xx)场景，fclos是一个symbol value，且fclos.qid是ArrayType这个identifier节点，而非string，因此这里if条件需做限定
          if (fclos.name) {
            ret = fclos.name
          } else if (
            (typeof fclos.id !== 'string' && fclos.id?.name) ||
            (typeof fclos.sid !== 'string' && fclos.sid?.name)
          ) {
            ret = fclos.id?.name || fclos.sid?.name
          }
          let { parent } = fclos
          while (parent) {
            if (['object', 'modScope', 'fclos', 'symbol'].indexOf(parent.vtype) === -1) break
            name = parent.id || parent.name || parent.sid
            if (!name) break
            ret = `${name}.${ret}`
            parent = parent.parent
          }
          if (!ret) {
            ret = symAddressCallgraph.toStringID(callSiteNode)
          }
        } else if (fclos.type) {
          // fclos.type
          ret = symAddressCallgraph.toStringID(fclos)
        } else {
          ret = symAddressCallgraph.toStringID(callSiteNode)
        }
      } else {
        ret = symAddressCallgraph.toStringID(callSiteNode)
      }
    } else {
      // pretty print fdef
      name = fdef.name || '<anonymous>'
      // try to attach namespace
      if (fclos && fclos.__proto__.constructor.name !== 'BVT') {
        if (fclos.vtype === 'class') {
          // e.g. javascript function class
          name = `new ${name}`
        } else if (fclos.parent?.vtype === 'class' || fclos.parent?.fdef?.type === 'ClassDefinition') {
          const nsDef = fclos.parent.fdef
          const nsName = nsDef?.name || '<anonymous>'
          if (name === '_CTOR_') {
            name = `new ${nsName}`
          } else {
            name = `${nsName} :: ${name}`
          }
        }
      }

      ret = name
    }
    if (!ret) {
      ret = 'undefined'
    }
    ret = ret.split('\n')[0]
    ret = ret.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'")
    if (ret.length > 200) {
      ret = `${ret.slice(0, 200)}...`
    }
    // attach loc
    if (fdef) {
      ret += this.printLoc(fdef)
    }
    return ret
  }

  /**
   *
   * @param ast
   */
  printLoc(ast: any): string {
    let sourcefile: string
    sourcefile = ast?.loc?.sourcefile
    if (sourcefile) {
      const splits = sourcefile.split('/')
      sourcefile = splits[splits.length - 1]
    }
    const startLine = ast && ast.loc.start.line
    const endLine = ast && ast.loc.end.line

    return ` \\n[${sourcefile} : ${startLine}_${endLine}]`
  }
}

module.exports = CallgraphChecker
