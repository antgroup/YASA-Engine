// eslint-disable-next-line @typescript-eslint/no-var-requires

const _ = require('lodash')
const { AstUtil } = require('../checker-kit')
const logger = require('../../../util/logger')(__filename)

/**
 *
 */
class Position {
  /**
   *
   * @param line
   * @param column
   */
  constructor(line, column) {
    this.line = line
    this.column = column
  }
}

/**
 *
 */
class SourceLocation {
  /**
   *
   * @param filename
   * @param startLine
   * @param startColumn
   * @param endLine
   * @param endColumn
   */
  constructor(filename, startLine, startColumn, endLine, endColumn) {
    this.filename = filename
    this.start = new Position(startLine, startColumn)
    this.end = new Position(endLine, endColumn)
  }
}

/**
 *
 * @param pos1
 * @param pos2
 * @param ref
 */
function comparePositions(pos1, pos2, ref) {
  const pos1Dist =
    Math.abs(pos1.start.line - ref.start.line) +
    Math.abs(pos1.end.line - ref.end.line) +
    Math.abs(pos1.start.column - ref.start.column) +
    Math.abs(pos1.end.column - ref.end.column)
  const pos2Dist =
    Math.abs(pos2.start.line - ref.start.line) +
    Math.abs(pos2.end.line - ref.end.line) +
    Math.abs(pos2.start.column - ref.start.column) +
    Math.abs(pos2.end.column - ref.end.column)
  if (pos1Dist < pos2Dist) {
    return -1
  }
  if (pos1Dist > pos2Dist) {
    return 1
  }
  return 0
}

/**
 *
 * @param node
 * @param path
 */
function buildPath(node, path = []) {
  if (node.parent) {
    return buildPath(node.parent, [node].concat(path))
  }
  return path
}

// 递归遍历AST，找出在目标行范围内的所有节点
/**
 *
 * @param node
 * @param targetStartLine
 * @param targetEndLine
 * @param collectedNodes
 * @param level
 * @param parent
 */
function traverseAndCollectNodes(node, targetStartLine, targetEndLine, collectedNodes, level = 0, parent = null) {
  if (!node) return
  const currentNodePath = buildPath(node)
  if (node.loc && node.loc.start.line <= targetEndLine && node.loc.end.line >= targetStartLine) {
    collectedNodes.push({ node, level, path: currentNodePath })
  }
  for (const key in node) {
    if (
      [
        'parent',
        'rrefs',
        'trace',
        'updates',
        'type',
        'ast',
        'loc',
        'sort',
        '_tags',
        'uninit',
        'callnode',
        'names',
        '_this',
        'varType',
        '_meta',
      ].indexOf(key) !== -1
    )
      continue
    if (node.hasOwnProperty(key)) {
      const child = node[key]
      if (Array.isArray(child)) {
        child.forEach((c) =>
          traverseAndCollectNodes(c, targetStartLine, targetEndLine, collectedNodes, level + 1, node)
        )
      } else if (child && typeof child === 'object') {
        traverseAndCollectNodes(child, targetStartLine, targetEndLine, collectedNodes, level + 1, node)
      }
    }
  }
}

/**
 *
 * @param childPath
 * @param potentialParentPath
 */
function isDirectParent(childPath, potentialParentPath) {
  return (
    childPath.length + 1 === potentialParentPath.length &&
    potentialParentPath.slice(0, -1).every((val, index) => val === childPath[index])
  )
}

// 寻找AST中距离给定位置最近的节点
/**
 *
 * @param ast
 * @param loc
 * @param flag
 */
function findClosestNode(ast, loc, flag) {
  const targetStartLine = loc.start.line
  const targetEndLine = loc.end.line
  let closestNode = null
  let closestNodeLevel = -1
  const collectedNodes = []
  traverseAndCollectNodes(ast, targetStartLine, targetEndLine, collectedNodes)
  collectedNodes.forEach(({ node, level, path }) => {
    if (
      !closestNode ||
      comparePositions(node.loc, closestNode.loc, loc) < 0 ||
      (comparePositions(node.loc, closestNode.loc, loc) === 0 &&
        !collectedNodes.some(
          ({ node: otherNode, path: otherPath }) =>
            otherNode !== node &&
            otherNode.loc.start.line <= targetEndLine &&
            otherNode.loc.end.line >= targetStartLine &&
            isDirectParent(otherPath, path)
        ))
    ) {
      closestNode = node
      closestNodeLevel = level
    }
  })
  if (flag === 'source') {
    closestNode._meta.isSource = true
    closestNode._meta.sourcePos = `${loc.filename}:${loc.start.line}:${loc.start.column}:${loc.end.line}:${loc.end.column}`
  } else if (flag === 'sink') {
    closestNode._meta.isSink = true
    closestNode._meta.sinkPos = `${loc.filename}:${loc.start.line}:${loc.start.column}:${loc.end.line}:${loc.end.column}`
  }
  return closestNode
}

// function convertToUAST (ast, startline, startcolumn, endline, endcolumn, flag) {
//   const sourceLoc = new SourceLocation(startline, startcolumn, endline,
//     endcolumn)
//   let result = findClosestNode(ast, sourceLoc, flag)
//   return result
// }

// location = filename:startLine:startcolomn:endline:endcolumn
/**
 *
 * @param ast
 * @param location
 * @param flag
 */
function convertToUAST(ast, location, flag) {
  const sourceLoc = convertToSourceLocation(location)
  return findClosestNode(ast, sourceLoc, flag)
}

/**
 *
 * @param location
 */
function convertToSourceLocation(location) {
  const locs = location.split(':')
  if (locs.length !== 5) {
    return null
  }
  return new SourceLocation(locs[0], locs[1], locs[2], locs[3], locs[4])
}

/**
 *
 * @param options
 * @param ast
 * @param filename
 */
function introduceFlowConfig(options, ast, filename) {
  if (!options || !options.FlowConfig) {
    return
  }

  // 考虑绝对路径和相对路径,采用endswith判断
  if (options?.FlowConfig?.source && options?.FlowConfig?.sink) {
    for (const sourceLoc of options.FlowConfig.source) {
      const sourcepos = sourceLoc.split(':')
      const sourcefile = sourcepos[0]
      if (filename.endsWith(sourcefile)) {
        convertToUAST(ast, sourceLoc, 'source')
      }
    }

    for (const sinkLoc of options.FlowConfig.sink) {
      const sinkpos = sinkLoc.split(':')
      const sinkfile = sinkpos[0]
      if (filename.endsWith(sinkfile)) {
        convertToUAST(ast, sinkLoc, 'sink')
      }
    }
  }
}

// filemanager = {filename : scope(filescope) }
// 从source的文件出发
/**
 *
 * @param options
 * @param fileManager
 * @param analyzer
 */
function calcEntryPointAndRun(options, fileManager, analyzer) {
  if (!options || !options.FlowConfig) {
    return
  }

  for (const filename in fileManager) {
    for (const sourcefile in options.FlowConfig.sourcefiles) {
      if (filename.endsWith(sourcefile)) {
        const filescope = fileManager[filename]
        let entryPoints = AstUtil.satisfy(filescope, (n) => n.vtype === 'fclos' && n.ast, null, null, true)
        if (_.isEmpty(entryPoints)) {
          logger.info('entryPoint is not found')
          return
        }
        if (Array.isArray(entryPoints)) {
          entryPoints = _.uniqBy(entryPoints, (value) => value.fdef)
        } else {
          entryPoints = [entryPoints]
        }
        const state = analyzer.initState(filescope)
        entryPoints.forEach((main) => {
          const nd = AstUtil.satisfy(main.ast, (n) => n?._meta?.isSource === true)
          if (nd) {
            const argValues = []
            for (const key in main?.ast?.parameters) {
              argValues.push(analyzer.processInstruction(filescope, main.ast.parameters[key], state))
            }
            logger.info(`entryPoint ${main?.ast?.loc?.sourcefile}:${main.id}`)
            analyzer.executeCall(main.ast, main, argValues, state, filescope)
          }
        })
      }
    }
  }
}

module.exports = {
  convertToUAST,
  introduceFlowConfig,
  calcEntryPointAndRun,
}
