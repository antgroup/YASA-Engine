const config = require('../../config')
const EntryPoint = require('../../engine/analyzer/common/entrypoint')
const constValue = require('../../util/constant')
const CheckerManager = require('../../engine/analyzer/common/checker-manager')
const BasicRuleHandler = require('./rules-basic-handler')
const callGraphRule = require('../callgraph/callgraph-checker')
const options = require('../../config')
const { Graph } = require('../../util/graph')
const logger = require('../../util/logger')(__filename)

/**
 * generate full callGraph by funcSymbolTable
 * @param analyzer
 */
function makeFullCallGraph(analyzer) {
  config.loadDefaultRule = false
  config.loadExternalRule = false
  config.makeAllCG = true
  const newCheckerManager = new CheckerManager(undefined, undefined, undefined, BasicRuleHandler)
  newCheckerManager.doRegister(callGraphRule, newCheckerManager)
  config.loadDefaultRule = true
  config.loadExternalRule = true
  const backupCheckerManager = analyzer.checkerManager
  analyzer.checkerManager = newCheckerManager
  analyzer.ainfo.callgraph = analyzer.ainfo.callgraph || new Graph()
  if (analyzer.ainfo.callgraph && Object.keys(analyzer.funcSymbolTable).length > 0) {
    const alreadyCheckList = [] // 分析过的callnode一定会出现在nodes中
    for (const node of analyzer.ainfo.callgraph.nodes.values()) {
      if (node.opts?.funcSymbol) {
        alreadyCheckList.push(node.opts?.funcSymbol)
      }
    }
    let totalCount = 0
    Object.entries(analyzer.funcSymbolTable).forEach(([key, funcSymbol]) => {
      if (!alreadyCheckList.includes(funcSymbol) && funcSymbol.fdef && funcSymbol.fdef.type === 'FunctionDefinition') {
        totalCount += 1
      }
    })
    let analyzedCount = 0
    let already10Percent = false
    let already30Percent = false
    let already70Percent = false
    logger.info('makeAllCG-start')
    Object.entries(analyzer.funcSymbolTable).forEach(([key, funcSymbol]) => {
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
      if (!alreadyCheckList.includes(funcSymbol) && funcSymbol.fdef && funcSymbol.fdef.type === 'FunctionDefinition') {
        alreadyCheckList.push(funcSymbol)
        const argValues = []
        analyzer.executeCall(
          funcSymbol.fdef,
          funcSymbol,
          argValues,
          analyzer.initState(funcSymbol.parent),
          funcSymbol.parent
        )
      }
    })
    logger.info('\tmakeAllCG-100%')
  }
  analyzer.checkerManager = backupCheckerManager
  config.makeAllCG = false
}
/**
 * 从CallGraph中拿取边界作为全func类型的Entrypoint
 * @param callGraph
 */
function getAllEntryPointsUsingCallGraph(callGraph) {
  const entryPoints = {
    fclosEntryPoints: new Map(),
  }
  for (const f of callGraph.nodes.keys()) {
    const thisNode = callGraph.nodes.get(f)
    if (!thisNode.opts?.funcDef) {
      continue
    }
    let hasCalled = false
    for (const ek of callGraph.edges.keys()) {
      // 需要准确比较ast上的loc，因为函数符号值由于有new等问题不一定是同一个
      const targetNode = callGraph.nodes.get(callGraph.edges.get(ek).targetNodeId)
      if (thisNode && targetNode && !callGraph.edges.get(ek)?.sourceNodeId.includes('entry_point')) {
        if (
          targetNode.opts?.funcDef?.loc?.sourcefile &&
          targetNode.opts?.funcDef?.loc?.start?.line &&
          targetNode.opts?.funcDef?.loc?.end?.line &&
          targetNode.opts?.funcDef?.loc?.sourcefile === thisNode.opts?.funcDef?.loc?.sourcefile &&
          targetNode.opts?.funcDef?.loc?.start?.line === thisNode.opts?.funcDef?.loc?.start?.line &&
          targetNode.opts?.funcDef?.loc?.end?.line === thisNode.opts?.funcDef?.loc?.end?.line
        ) {
          hasCalled = true
          break
        }
      }
    }
    if (!hasCalled) {
      entryPoints.fclosEntryPoints.set(thisNode.id, thisNode.opts.funcSymbol)
    }
  }
  const newEntryPointList = []
  for (const entry of entryPoints.fclosEntryPoints.values()) {
    const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
    entryPoint.scopeVal = entry.parent
    entryPoint.argValues = []
    entryPoint.functionName = entry.fdef?.id?.name
    entryPoint.filePath = entry.fdef?.loc?.sourcefile?.startsWith(config.maindirPrefix)
      ? entry.fdef?.loc?.sourcefile?.substring(config.maindirPrefix.length)
      : entry.fdef?.loc?.sourcefile
    entryPoint.attribute = 'fullCallGraphMade'
    entryPoint.packageName = undefined
    entryPoint.entryPointSymVal = entry
    newEntryPointList.push(entryPoint)
  }
  return newEntryPointList
}

/**
 * 若为弱类型脚本语言，则加入所有文件作为EntryPoint
 * @param fileManager
 */
function getAllFileEntryPointsUsingFileManager(fileManager) {
  const entryPoints = []
  if (options.language === 'python' || options.language === 'javascript') {
    if (fileManager) {
      Object.values(fileManager).forEach((file) => {
        if (!file.ast || file.ast.type !== 'CompileUnit') return
        const entryPoint = new EntryPoint(constValue.ENGIN_START_FILE_BEGIN)
        entryPoint.scopeVal = file
        entryPoint.argValues = undefined
        entryPoint.functionName = undefined
        entryPoint.filePath = file?.ast?.sourcefile || file?.ast?.loc?.sourcefile
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
 * 当loc在函数内，推导函数对应的callGraph边界当Entrypoint（函数类型），不在函数内，就拿相应文件当Entrypoint（文件类型）
 * @param locs need an array
 * @param callGraph
 * @param fileManager
 */
function getEntryPointsUsingCallGraphByLoc(locs, callGraph, fileManager) {
  const newEntryPointList = []
  if (!callGraph || !locs || !Array.isArray(locs)) {
    return newEntryPointList
  }
  for (const loc of locs) {
    if (!loc.sourcefile || !loc.start?.line || !loc.end.line) {
      continue
    }
    const alreadyCalculate = []
    const node = getNodeInCallGraphByLoc(loc, callGraph.nodes)
    if (node) {
      const fclosNodes = getFclosEntryPointsUsingCallGraphByTargetNode(node.id, callGraph, alreadyCalculate)
      if (fclosNodes && Array.isArray(fclosNodes) && fclosNodes.length > 0) {
        for (const f of fclosNodes) {
          const entry = f.opts.funcSymbol
          const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
          entryPoint.scopeVal = entry.parent
          entryPoint.argValues = []
          entryPoint.functionName = entry.fdef?.id?.name
          entryPoint.filePath = entry.fdef?.loc?.sourcefile?.startsWith(config.maindirPrefix)
            ? entry.fdef?.loc?.sourcefile?.substring(config.maindirPrefix.length)
            : entry.fdef?.loc?.sourcefile
          entryPoint.attribute = 'FuncEntryPointByLoc'
          entryPoint.packageName = undefined
          entryPoint.entryPointSymVal = entry
          newEntryPointList.push(entryPoint)
        }
      }
    } else {
      const file = fileManager[loc.sourcefile]
      if (file) {
        const entryPoint = new EntryPoint(constValue.ENGIN_START_FILE_BEGIN)
        entryPoint.scopeVal = file
        entryPoint.argValues = undefined
        entryPoint.functionName = undefined
        entryPoint.filePath = file?.ast?.sourcefile || file?.ast?.loc?.sourcefile
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
 *
 * @param key
 * @param callGraph
 * @param alreadyCalculate
 */
function getFclosEntryPointsUsingCallGraphByTargetNode(key, callGraph, alreadyCalculate) {
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
  const targetNodes = [key]
  const circularDetected = []
  const res = []
  while (targetNodes.length > 0) {
    const n = targetNodes.shift()
    if (alreadyCalculate.includes(n)) {
      continue
    }
    if (circularDetected.includes(n)) {
      if (callGraph.nodes.get(n)?.opts?.funcDef) {
        res.push(callGraph.nodes.get(n))
      }
      continue
    }
    circularDetected.push(n)
    alreadyCalculate.push(n)
    let hasFind = false
    for (const ek of callGraph.edges.keys()) {
      // 需要准确比较ast上的loc，因为函数符号值由于有new等问题不一定是同一个
      const targetNodeAST = callGraph.nodes.get(callGraph.edges.get(ek).targetNodeId).opts?.funcDef
      const thisNodeAST = callGraph.nodes.get(n).opts?.funcDef
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
      if (callGraph.nodes.get(n)?.opts?.funcDef) {
        res.push(callGraph.nodes.get(n))
      }
    }
  }
  return res
}

/**
 *
 * @param loc
 * @param nodes
 */
function getNodeInCallGraphByLoc(loc, nodes) {
  let tempStartLine = -1
  let tempEndLine = Number.MAX_VALUE
  let tempKey
  if (!loc.sourcefile || !loc.start?.line || !loc.end?.line || !nodes || nodes.length === 0) {
    return null
  }
  for (const key of nodes.keys()) {
    if (key.includes('\\n[')) {
      const filename = nodes.get(key)?.opts?.funcDef?.loc?.sourcefile
      const startLine = nodes.get(key)?.opts?.funcDef?.loc?.start?.line
      const endLine = nodes.get(key)?.opts?.funcDef?.loc?.end?.line
      if (loc.sourcefile === filename && loc.start.line >= startLine && loc.end.line <= endLine) {
        if (loc.start.line > tempStartLine && loc.end.line < tempEndLine) {
          tempStartLine = loc.start.line
          tempEndLine = loc.end.line
          tempKey = key
        }
      }
    }
  }
  if (tempKey) return nodes.get(tempKey)
  return null
}

module.exports = {
  makeFullCallGraph,
  getAllEntryPointsUsingCallGraph,
  getAllFileEntryPointsUsingFileManager,
  getEntryPointsUsingCallGraphByLoc,
  getFclosEntryPointsUsingCallGraphByTargetNode,
}
