import type TypeRelatedInfoResolver from '../../resolver/common/type-related-info-resolver'
import symAddressCallgraph from '../../engine/analyzer/common/sym-address'

const config = require('../../config')
const EntryPoint = require('../../engine/analyzer/common/entrypoint')
const constValue = require('../../util/constant')
const CheckerManager = require('../../engine/analyzer/common/checker-manager')
const BasicRuleHandler = require('./rules-basic-handler')
const callGraphRule = require('../callgraph/callgraph-checker')
const options = require('../../config')
const { Graph } = require('../../util/graph')
const logger = require('../../util/logger')(__filename)
const sourceLine = require('../../engine/analyzer/common/source-line')
const { performanceTracker } = require('../../util/performance-tracker')

/**
 *
 * @param ast
 */
function printLoc(ast: any): string {
  let sourcefile: string
  sourcefile = ast?.loc?.sourcefile
  if (sourcefile) {
    const splits = sourcefile.split('/')
    sourcefile = splits[splits.length - 1]
  }
  const startLine = ast && ast?.loc?.start.line
  const endLine = ast && ast?.loc?.end.line

  return ` \\n[${sourcefile} : ${startLine}_${endLine}]`
}

/**
 *
 * @param fclos fclos
 * @param fdef function definition
 * @param callSiteNode call site node
 * @param callSiteLiteral
 * @param calleeType
 * @param fsig
 */
function prettyPrint(
  fclos: any,
  fdef: any,
  callSiteNode: any,
  callSiteLiteral: string,
  calleeType: string,
  fsig: string
): string {
  let ret: string = ''
  let name: string
  if (!fdef || !fdef.name || fdef.name === '<anonymous>') {
    if (calleeType !== '' && fsig !== '') {
      ret = `${calleeType}.${fsig}`
    } else if (callSiteLiteral !== '') {
      ret = callSiteLiteral
    } else {
      ret = symAddressCallgraph.toStringID(callSiteNode) || ''
    }
  } else {
    // pretty print fdef
    name = fdef.name || '<anonymous>'
    // try to attach namespace
    if (fclos && fclos.__proto__.constructor.name !== 'BVTValue') {
      if (fclos.vtype === 'class') {
        // e.g. javascript function class
        name = `new ${name}`
      } else if (fclos.parent?.vtype === 'class' || fclos.parent?.ast.fdef?.type === 'ClassDefinition') {
        const nsDef = fclos.parent.ast.fdef
        let nsName = nsDef?.name || '<anonymous>'
        if (fclos.parent.qid) {
          nsName = fclos.parent.qid
        }
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
    ret += printLoc(fdef)
  }
  return ret
}

/**
 * 从 nodehash 和 UUID 还原 funcDef 和 funcSymbol
 * @param node callgraph 节点
 * @param astManager AST 管理器
 * @param symbolTable 符号表管理器
 * @returns 包含 funcDef 和 funcSymbol 的对象
 */
function restoreNodeFromReferences(node: any, astManager?: any, symbolTable?: any): { funcDef: any; funcSymbol: any } {
  const funcDef =
    node.opts?.funcDefNodehash && astManager ? astManager.get(node.opts.funcDefNodehash) : node.opts?.funcDef
  const funcSymbol =
    node.opts?.funcSymbolUuid && symbolTable ? symbolTable.get(node.opts.funcSymbolUuid) : node.opts?.funcSymbol
  return { funcDef, funcSymbol }
}

/**
 * generate full callGraph by funcSymbolTable
 * @param analyzer
 */
function makeFullCallGraph(analyzer: any): void {
  performanceTracker.start(`startAnalyze.makeFullCallGraph(BySymbolInterpret)`)
  config.loadDefaultRule = false
  config.loadExternalRule = false
  config.makeAllCG = true
  const newCheckerManager = new CheckerManager(undefined, undefined, undefined, undefined, BasicRuleHandler)
  newCheckerManager.doRegister(callGraphRule, newCheckerManager)
  config.loadDefaultRule = true
  config.loadExternalRule = true
  const backupCheckerManager = analyzer.checkerManager
  analyzer.checkerManager = newCheckerManager
  analyzer.ainfo.callgraph = analyzer.ainfo.callgraph || new Graph()
  if (analyzer.ainfo.callgraph && Object.keys(analyzer.topScope.context.funcs).length > 0) {
    const alreadyCheckList: any[] = [] // 分析过的callnode一定会出现在nodes中
    for (const node of analyzer.ainfo.callgraph.nodes.values()) {
      // 从 UUID 还原 funcSymbol
      if (node.opts?.funcSymbolUuid) {
        const funcSymbol = analyzer.symbolTable.get(node.opts.funcSymbolUuid)
        if (funcSymbol) {
          alreadyCheckList.push(funcSymbol)
        }
      }
    }
    let totalCount = 0
    Object.entries(analyzer.topScope.context.funcs).forEach(([key, funcSymbol]) => {
      const funcSymbolAny = funcSymbol as any
      if (
        !alreadyCheckList.includes(funcSymbolAny) &&
        funcSymbolAny.ast.fdef &&
        funcSymbolAny.ast.fdef.type === 'FunctionDefinition'
      ) {
        totalCount += 1
      }
    })
    let analyzedCount = 0
    let already10Percent = false
    let already30Percent = false
    let already70Percent = false
    logger.info('makeAllCG-start')
    Object.entries(analyzer.topScope.context.funcs).forEach(([key, funcSymbol]) => {
      analyzedCount += 1
      if (analyzedCount > totalCount * 0.1 && !already10Percent) {
        logger.info('\tmakeAllCG-10%')
        already10Percent = true
      }
      if (analyzedCount > totalCount * 0.3 && !already30Percent) {
        logger.info('\tmakeAllCG-30%')
        already30Percent = true
      }

      if (analyzedCount > totalCount * 0.7 && !already70Percent) {
        logger.info('\tmakeAllCG-70%')
        already70Percent = true
      }
      const funcSymbolAny2 = funcSymbol as any
      if (
        !alreadyCheckList.includes(funcSymbolAny2) &&
        funcSymbolAny2.ast.fdef &&
        funcSymbolAny2.ast.fdef.type === 'FunctionDefinition'
      ) {
        alreadyCheckList.push(funcSymbolAny2)
        analyzer.executeCall(
          funcSymbolAny2.ast.fdef,
          funcSymbolAny2,
          analyzer.initState(funcSymbolAny2.parent),
          funcSymbolAny2.parent
        )
      }
    })
    logger.info('\tmakeAllCG-100%')
  }
  analyzer.checkerManager = backupCheckerManager
  config.makeAllCG = false
  performanceTracker.end(`startAnalyze.makeFullCallGraph(BySymbolInterpret)`)
}

/**
 * generate full callGraph by funcSymbolTable without symbol interpret
 * @param analyzer
 * @param resolver
 */
function makeFullCallGraphByType(analyzer: any, resolver: TypeRelatedInfoResolver) {
  if (!resolver || (resolver.resolveFinish && analyzer?.ainfo?.callgraph)) {
    return
  }

  performanceTracker.start('startAnalyze.makeFullCallGraphByType')

  if (!resolver.resolveFinish) {
    resolver.resolve(analyzer)
  }

  // Helper function to extract only location and name from AST to reduce memory usage
  const extractFuncDefInfo = (ast: any): { loc?: any; name?: any; id?: any } | null => {
    if (!ast) return null
    return {
      loc: ast.loc,
      name: ast.name,
      id: ast.id, // Store id for functionName access
    }
  }

  // Helper function to extract only location from callSite AST to reduce memory usage
  const extractCallSiteInfo = (callSite: any): { loc?: any } | null => {
    if (!callSite) return null
    return {
      loc: callSite.loc,
    }
  }

  const graph = new Graph()
  Object.entries(analyzer.funcSymbolTable).forEach(([, funcSymbol]) => {
    const funcSymbolAny = funcSymbol as any
    if (funcSymbolAny.invocationMap instanceof Map) {
      for (const invocationArray of funcSymbolAny.invocationMap.values()) {
        for (const invocation of invocationArray) {
          const fromNode = graph.addNode(
            prettyPrint(
              invocation.fromScope,
              invocation.fromScopeAst,
              invocation.callSite,
              invocation.callSiteLiteral,
              invocation.calleeType,
              invocation.fsig
            ),
            {
              funcDef: extractFuncDefInfo(invocation.fromScopeAst),
              funcSymbol: invocation.fromScope,
            }
          )
          const toNode = graph.addNode(
            prettyPrint(
              invocation.toScope,
              invocation.toScopeAst,
              invocation.callSite,
              invocation.callSiteLiteral,
              invocation.calleeType,
              invocation.fsig
            ),
            {
              funcDef: extractFuncDefInfo(invocation.toScopeAst),
              funcSymbol: invocation.toScope,
            }
          )
          graph.addEdge(fromNode, toNode, { callSite: extractCallSiteInfo(invocation.callSite) })
        }
      }
    }
  })
  analyzer.ainfo.callgraph = graph

  performanceTracker.end('startAnalyze.makeFullCallGraphByType')
}

/**
 * 从CallGraph中拿取边界作为全func类型的Entrypoint
 * @param callGraph
 * @param analyzer
 */
function getAllEntryPointsUsingCallGraph(callGraph: any, analyzer?: any): any[] {
  const entryPoints = {
    fclosEntryPoints: new Map<string, any>(),
  }
  const astManager = analyzer?.astManager
  const symbolTable = analyzer?.symbolTable

  for (const f of callGraph.nodes.keys()) {
    const thisNode = callGraph.nodes.get(f)
    // 从 nodehash 和 UUID 还原 funcDef 和 funcSymbol
    const thisNodeFuncDef =
      thisNode.opts?.funcDefNodehash && astManager
        ? astManager.get(thisNode.opts.funcDefNodehash)
        : thisNode.opts?.funcDef
    const thisNodeFuncSymbol =
      thisNode.opts?.funcSymbolUuid && symbolTable
        ? symbolTable.get(thisNode.opts.funcSymbolUuid)
        : thisNode.opts?.funcSymbol

    if (!thisNodeFuncDef) {
      continue
    }
    let hasCalled = false
    for (const ek of callGraph.edges.keys()) {
      // 需要准确比较ast上的loc，因为函数符号值由于有new等问题不一定是同一个
      const targetNode = callGraph.nodes.get(callGraph.edges.get(ek).targetNodeId)
      if (thisNode && targetNode && !callGraph.edges.get(ek)?.sourceNodeId.includes('entry_point')) {
        // 从 nodehash 还原 targetNode 的 funcDef
        const targetNodeFuncDef =
          targetNode.opts?.funcDefNodehash && astManager
            ? astManager.get(targetNode.opts.funcDefNodehash)
            : targetNode.opts?.funcDef

        if (
          targetNodeFuncDef?.loc?.sourcefile &&
          targetNodeFuncDef?.loc?.start?.line &&
          targetNodeFuncDef?.loc?.end?.line &&
          targetNodeFuncDef?.loc?.sourcefile === thisNodeFuncDef?.loc?.sourcefile &&
          targetNodeFuncDef?.loc?.start?.line === thisNodeFuncDef?.loc?.start?.line &&
          targetNodeFuncDef?.loc?.end?.line === thisNodeFuncDef?.loc?.end?.line
        ) {
          hasCalled = true
          break
        }
      }
    }
    if (!hasCalled && thisNodeFuncSymbol) {
      entryPoints.fclosEntryPoints.set(thisNode.id, thisNodeFuncSymbol)
    }
  }
  const newEntryPointList: any[] = []
  for (const entry of entryPoints.fclosEntryPoints.values()) {
    const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
    entryPoint.scopeVal = entry.parent
    entryPoint.argValues = []
    entryPoint.functionName = entry.ast.fdef?.id?.name
    entryPoint.filePath = entry.ast.fdef?.loc?.sourcefile?.startsWith(config.maindirPrefix)
      ? entry.ast.fdef?.loc?.sourcefile?.substring(config.maindirPrefix.length)
      : entry.ast.fdef?.loc?.sourcefile
    entryPoint.attribute = 'fullCallGraphMade'
    entryPoint.packageName = undefined
    entryPoint.entryPointSymVal = entry
    newEntryPointList.push(entryPoint)
  }
  return newEntryPointList
}

/**
 * 若为弱类型脚本语言，则加入所有文件作为EntryPoint
 * @param analyzer
 */
function getAllFileEntryPointsUsingFileManager(analyzer: any): any[] {
  const entryPoints: any[] = []
  if (options.language === 'python' || options.language === 'javascript') {
    if (analyzer?.fileManager) {
      Object.values(analyzer?.fileManager).forEach((fileEntry: any) => {
        const fileUuid = typeof fileEntry === 'string' ? fileEntry : fileEntry.uuid
        const file = analyzer.symbolTable.get(fileUuid)
        if (!file?.ast?.node || file.ast.node.type !== 'CompileUnit') return
        const entryPoint = new EntryPoint(constValue.ENGIN_START_FILE_BEGIN)
        entryPoint.scopeVal = file
        entryPoint.argValues = undefined
        entryPoint.functionName = undefined
        entryPoint.filePath = file?.ast?.node?.loc?.sourcefile
        entryPoint.attribute = 'fullfileManagerMade'
        entryPoint.packageName = undefined
        entryPoint.entryPointSymVal = file
        entryPoints.push(entryPoint)
      })
    }
  }
  return entryPoints
}

/**
 * 当函数内存在关键词时，推导函数对应的callGraph边界当Entrypoint（函数类型），不在函数内，就拿相应文件当Entrypoint（文件类型）
 * @param keywords need an array
 * @param callGraph
 * @param fileManager
 * @param analyzer
 */
function getEntryPointsUsingCallGraphByKeyWords(
  keywords: string[],
  callGraph: any,
  fileManager: any,
  analyzer?: any
): any[] {
  const newEntryPointList: any[] = []
  if (!callGraph || !keywords || !Array.isArray(keywords)) {
    return newEntryPointList
  }
  const astManager = analyzer?.astManager
  const symbolTable = analyzer?.symbolTable

  for (const keyword of keywords) {
    const alreadyCalculate: any[] = []
    const nodes = getNodeInCallGraphByKeyword(keyword, callGraph.nodes, astManager)
    for (const node of nodes) {
      // const node = getNodeInCallGraphByKeyword(keyword, callGraph.nodes)
      if (node) {
        const fclosNodes = getFclosEntryPointsUsingCallGraphByTargetNode(
          node.id,
          callGraph,
          alreadyCalculate,
          astManager,
          symbolTable
        )
        if (fclosNodes && Array.isArray(fclosNodes) && fclosNodes.length > 0) {
          for (const f of fclosNodes) {
            const { funcSymbol: entry } = restoreNodeFromReferences(f, astManager, symbolTable)
            if (!entry) continue
            const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
            entryPoint.scopeVal = entry.parent
            entryPoint.argValues = []
            entryPoint.functionName = entry.ast.fdef?.id?.name
            entryPoint.filePath = entry.ast.fdef?.loc?.sourcefile?.startsWith(config.maindirPrefix)
              ? entry.ast.fdef?.loc?.sourcefile?.substring(config.maindirPrefix.length)
              : entry.ast.fdef?.loc?.sourcefile
            entryPoint.attribute = 'FuncEntryPointByLoc'
            entryPoint.packageName = undefined
            entryPoint.entryPointSymVal = entry
            newEntryPointList.push(entryPoint)
          }
        }
      }
    }

    for (const fileEntry of Object.values(fileManager)) {
      const fileUuid = typeof fileEntry === 'string' ? fileEntry : (fileEntry as any).uuid
      const file = symbolTable?.get(fileUuid)
      if (!file) continue
      const content = sourceLine.getCodeBySourceFile(file?.ast?.node?.loc?.sourcefile)
      if (content.includes(keyword)) {
        const entryPoint = new EntryPoint(constValue.ENGIN_START_FILE_BEGIN)
        entryPoint.scopeVal = file
        entryPoint.argValues = undefined
        entryPoint.functionName = undefined
        entryPoint.filePath = file?.ast?.node?.sourcefile || file?.ast?.node?.loc?.sourcefile
        entryPoint.attribute = 'FileEntryPointByLoc'
        entryPoint.packageName = undefined
        entryPoint.entryPointSymVal = file
        newEntryPointList.push(entryPoint)
      }
    }
  }
  return newEntryPointList
}

/**
 * 当loc在函数内，推导函数对应的callGraph边界当Entrypoint（函数类型），不在函数内，就拿相应文件当Entrypoint（文件类型）
 * @param locs need an array
 * @param callGraph
 * @param fileManager
 * @param analyzer
 */
function getEntryPointsUsingCallGraphByLoc(locs: any[], callGraph: any, fileManager: any, analyzer?: any): any[] {
  const newEntryPointList: any[] = []
  if (!callGraph || !locs || !Array.isArray(locs)) {
    return newEntryPointList
  }
  const astManager = analyzer?.astManager
  const symbolTable = analyzer?.symbolTable

  for (const loc of locs) {
    if (!loc.sourcefile || !loc.start?.line || !loc.end?.line) {
      continue
    }
    const alreadyCalculate: any[] = []
    const node = getNodeInCallGraphByLoc(loc, callGraph.nodes, astManager)
    if (node) {
      const fclosNodes = getFclosEntryPointsUsingCallGraphByTargetNode(
        node.id,
        callGraph,
        alreadyCalculate,
        astManager,
        symbolTable
      )
      if (fclosNodes && Array.isArray(fclosNodes) && fclosNodes.length > 0) {
        for (const f of fclosNodes) {
          const { funcSymbol: entry } = restoreNodeFromReferences(f, astManager, symbolTable)
          if (!entry) continue
          const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
          entryPoint.scopeVal = entry.parent
          entryPoint.argValues = []
          entryPoint.functionName = entry.ast.fdef?.id?.name
          entryPoint.filePath = entry.ast.fdef?.loc?.sourcefile?.startsWith(config.maindirPrefix)
            ? entry.ast.fdef?.loc?.sourcefile?.substring(config.maindirPrefix.length)
            : entry.ast.fdef?.loc?.sourcefile
          entryPoint.attribute = 'FuncEntryPointByLoc'
          entryPoint.packageName = undefined
          entryPoint.entryPointSymVal = entry
          newEntryPointList.push(entryPoint)
        }
      }
    } else {
      const fileEntry = fileManager[loc.sourcefile]
      if (fileEntry) {
        const fileUuid = typeof fileEntry === 'string' ? fileEntry : (fileEntry as any).uuid
        const file = symbolTable?.get(fileUuid)
        if (file) {
          const entryPoint = new EntryPoint(constValue.ENGIN_START_FILE_BEGIN)
          entryPoint.scopeVal = file
          entryPoint.argValues = undefined
          entryPoint.functionName = undefined
          entryPoint.filePath = file?.ast?.node?.sourcefile || file?.ast?.node?.loc?.sourcefile
          entryPoint.attribute = 'FileEntryPointByLoc'
          entryPoint.packageName = undefined
          entryPoint.entryPointSymVal = file
          newEntryPointList.push(entryPoint)
        }
      }
    }
  }
  return newEntryPointList
}

/**
 *
 * @param key
 * @param callGraph
 * @param alreadyCalculate
 * @param astManager
 * @param symbolTable
 */
function getFclosEntryPointsUsingCallGraphByTargetNode(
  key: any,
  callGraph: any,
  alreadyCalculate: any[],
  astManager?: any,
  symbolTable?: any
): any[] | null {
  if (
    !key ||
    !callGraph ||
    !callGraph.nodes ||
    !callGraph.edges ||
    callGraph.nodes.size === 0 ||
    callGraph.edges.size === 0
  ) {
    return null
  }
  const targetNodes: any[] = [key]
  const circularDetected: any[] = []
  const res: any[] = []
  while (targetNodes.length > 0) {
    const n = targetNodes.shift()
    if (alreadyCalculate.includes(n)) {
      continue
    }
    if (circularDetected.includes(n)) {
      const node = callGraph.nodes.get(n)
      const { funcDef } = restoreNodeFromReferences(node, astManager, symbolTable)
      if (funcDef) {
        res.push(node)
      }
      continue
    }
    circularDetected.push(n)
    alreadyCalculate.push(n)
    let hasFind = false
    for (const ek of callGraph.edges.keys()) {
      // 需要准确比较ast上的loc，因为函数符号值由于有new等问题不一定是同一个
      const targetNode = callGraph.nodes.get(callGraph.edges.get(ek).targetNodeId)
      const thisNode = callGraph.nodes.get(n)
      const { funcDef: targetNodeAST } = restoreNodeFromReferences(targetNode, astManager, symbolTable)
      const { funcDef: thisNodeAST } = restoreNodeFromReferences(thisNode, astManager, symbolTable)
      if (
        thisNodeAST &&
        targetNodeAST &&
        callGraph.edges.get(ek)?.sourceNodeId &&
        !callGraph.edges.get(ek)?.sourceNodeId.includes('entry_point') &&
        targetNodeAST.loc?.sourcefile &&
        targetNodeAST.loc?.start?.line &&
        targetNodeAST.loc?.end?.line &&
        targetNodeAST.loc?.sourcefile === thisNodeAST.loc?.sourcefile &&
        targetNodeAST.loc?.start?.line === thisNodeAST.loc?.start?.line &&
        targetNodeAST.loc?.end?.line === thisNodeAST.loc?.end?.line
      ) {
        targetNodes.push(callGraph.edges.get(ek)?.sourceNodeId)
        hasFind = true
      }
    }
    if (!hasFind) {
      const node = callGraph.nodes.get(n)
      const { funcDef } = restoreNodeFromReferences(node, astManager, symbolTable)
      if (funcDef) {
        res.push(node)
      }
    }
  }
  return res
}

/**
 *
 * @param loc
 * @param nodes
 * @param astManager
 */
function getNodeInCallGraphByLoc(loc: any, nodes: any, astManager?: any): any {
  let tempStartLine = -1
  let tempEndLine = Number.MAX_VALUE
  let tempKey
  if (!loc.sourcefile || !loc.start?.line || !loc.end?.line || !nodes || nodes.length === 0) {
    return null
  }
  for (const key of nodes.keys()) {
    if (key.includes('\\n[')) {
      const node = nodes.get(key)
      const { funcDef } = restoreNodeFromReferences(node, astManager)
      const filename = funcDef?.loc?.sourcefile
      const startLine = funcDef?.loc?.start?.line
      const endLine = funcDef?.loc?.end?.line
      if (loc.sourcefile === filename && loc.start?.line >= startLine && loc.end?.line <= endLine) {
        if (startLine > tempStartLine && endLine < tempEndLine) {
          tempStartLine = startLine
          tempEndLine = endLine
          tempKey = key
        }
      }
    }
  }
  if (tempKey) return nodes.get(tempKey)
  return null
}

/**
 * 判断函数中是否包含关键字
 * @param keyword
 * @param nodes
 * @param astManager
 */
function getNodeInCallGraphByKeyword(keyword: string, nodes: any, astManager?: any): any[] {
  const result: any[] = []
  if (keyword === '') {
    return result
  }
  for (const key of nodes.keys()) {
    if (key.includes('\\n[')) {
      const node = nodes.get(key)
      const { funcDef } = restoreNodeFromReferences(node, astManager)
      if (funcDef) {
        const content = sourceLine.getCodeByLocation(funcDef?.loc)
        if (content.includes(keyword)) {
          result.push(node)
        }
      }
    }
  }
  return result
}

module.exports = {
  makeFullCallGraph,
  makeFullCallGraphByType,
  getAllEntryPointsUsingCallGraph,
  getAllFileEntryPointsUsingFileManager,
  getEntryPointsUsingCallGraphByLoc,
  getFclosEntryPointsUsingCallGraphByTargetNode,
  getEntryPointsUsingCallGraphByKeyWords,
  prettyPrint,
}
