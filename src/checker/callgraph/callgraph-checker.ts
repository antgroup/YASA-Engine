// used for dump call graph
import type TypeRelatedInfoResolver from '../../resolver/common/type-related-info-resolver'

const _ = require('lodash')
const symAddressCallgraph = require('../../engine/analyzer/common/sym-address')
const kitCallgraph = require('../common/checker-kit')
const configCallgraph = require('../../config')
const CheckerCallgraph = require('../common/checker')
const CallgraphOutputStrategyCallgraph = require('../common/output/callgraph-output-strategy')
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
      const typeResolver: TypeRelatedInfoResolver | undefined = this.getTypeResolver(analyzer)
      if (typeResolver) {
        fullCallGraphFileEntryPoint.makeFullCallGraphByType(analyzer, typeResolver)
      } else {
        fullCallGraphFileEntryPoint.makeFullCallGraph(analyzer)
      }
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
    const { fclos, ainfo } = info
    if (!fclos) {
      return
    }
    const fdecl = fclos.ast?.fdef
    if (fdecl && fdecl.type !== 'FunctionDefinition') {
      return
    }
    const stack = state.callstack
    if (!stack) {
      return
    }
    const to = fclos
    const toAST = fclos.ast?.fdef
    const callSiteNode = node

    const from = stack[stack.length - 1] || { name: '<__entry_point__>', sid: '<__entry_point__>', vtype: 'fclos' }
    const fromAST = from.ast?.fdef
    if (fromAST && fromAST.type !== 'FunctionDefinition' && from.vtype !== 'fclos') {
      return
    }
    const callgraph = (ainfo.callgraph = ainfo.callgraph || new this.kit.Graph())

    // 获取 AST 的 nodehash 和符号值的 UUID
    const fromASTNodehash = fromAST?._meta?.nodehash || null
    const fromFuncSymbolUuid = from?.uuid || null
    const toASTNodehash = toAST?._meta?.nodehash || null
    const toFuncSymbolUuid = to?.uuid || null

    const fromNode = callgraph.addNode(this.prettyPrint(from, fromAST, callSiteNode), {
      funcDefNodehash: fromASTNodehash,
      funcSymbolUuid: fromFuncSymbolUuid,
    })

    // 存储 callSite 的 nodehash
    const callSiteNodehash = callSiteNode?._meta?.nodehash || null
    const toNode = callgraph.addNode(this.prettyPrint(to, toAST, callSiteNode), {
      funcDefNodehash: toASTNodehash,
      funcSymbolUuid: toFuncSymbolUuid,
    })
    callgraph.addEdge(fromNode, toNode, { callSiteNodehash })
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
    if (finding) {
      finding.type = this.getCheckerId()
      // 在 finding 中存储 astManager 和 symbolTable 的引用，供 dumpGraph 使用
      ;(finding as any).astManager = analyzer.astManager
      ;(finding as any).symbolTable = analyzer.symbolTable
      this.mng.newFinding(finding, CallgraphOutputStrategyCallgraph.outputStrategyId)
    }
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
    // 临时补丁，防止stc 漏洞uk变化
    if (!fdef || !fdef.name || fdef.name.includes('<anonymous') || fdef?.loc?.sourcefile?.endsWith('.go')) {
      if (fclos) {
        // 针对[]byte(xx)场景，fclos是一个symbol value，且fclos.qid是ArrayType这个identifier节点，而非string，因此这里if条件需做限定
        if (fclos.qid && typeof fclos.qid === 'string') {
          ret = fclos.qid
        } else if (fclos.vtype && fclos.vtype === 'union') {
          let fclosArray = fclos.value
          if (fclosArray && !Array.isArray(fclosArray)) {
            fclosArray = Object.entries(fclosArray)
          }
          const f = _.find(fclosArray, (f1: any) => f1.sid)
          if (f) {
            ret = f.sid
          }
        } else if (fclos.vtype && fclos.type !== 'MemberAccess') {
          // 针对[]byte(xx)场景，fclos是一个symbol value，且fclos.qid是ArrayType这个identifier节点，而非string，因此这里if条件需做限定
          if (fclos.name) {
            ret = fclos.name
          } else if (typeof fclos.sid !== 'string' && fclos.sid?.name) {
            ret = fclos.sid?.name
          }
          let { parent } = fclos
          while (parent) {
            if (['object', 'modScope', 'fclos', 'symbol'].indexOf(parent.vtype) === -1) break
            name = parent.name || parent.sid
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
      name =
        fdef.name ||
        `<anonymousFunc_${fdef?.loc?.start?.line}_${fdef?.loc?.start?.column}_${fdef?.loc?.end?.line}_${fdef?.loc?.end?.column}>`
      // try to attach namespace
      if (fclos && fclos.__proto__.constructor.name !== 'BVTValue') {
        if (fclos.vtype === 'class') {
          // e.g. javascript function class
          name = `new ${name}`
        } else if (fclos.parent?.vtype === 'class' || fclos.parent?.ast.fdef?.type === 'ClassDefinition') {
          const nsDef = fclos.parent.ast.fdef
          const nsName =
            nsDef?.name ||
            `<anonymousFunc_${nsDef?.loc?.start?.line}_${nsDef?.loc?.start?.column}_${nsDef?.loc?.end?.line}_${nsDef?.loc?.end?.column}>`
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
    if (ret.length > 500) {
      ret = `${ret.slice(0, 500)}...`
    }
    // attach loc
    if (fdef && fdef?.loc) {
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
    const startLine = ast && ast?.loc?.start?.line
    const endLine = ast && ast?.loc?.end?.line

    return ` \\n[${sourcefile} : ${startLine}_${endLine}]`
  }

  /**
   * get type resolver
   * @param analyzer
   * @returns {TypeRelatedInfoResolver|undefined}
   */
  getTypeResolver(analyzer: any): TypeRelatedInfoResolver | undefined {
    let resolver: TypeRelatedInfoResolver | undefined
    if (configCallgraph.cgAlgo === 'CHA') {
      resolver = analyzer.typeResolver
    }
    return resolver
  }
}

module.exports = CallgraphChecker
