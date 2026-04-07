const astUtilJava = require('../../../../../util/ast-util')
const configJava = require('../../../../../config')
const { entryPointAndSourceAtSameTime: entryPointAndSourceAtSameTimeJava } = require('../../../../../config')

export {}

/**
 * get java main entrypoint
 * @param packageManager
 */
function getJavaMainEntryPointAndSource(packageManager: any) {
  const TaintSource: any[] = []

  const entryPoints = []
  let list = []
  list.push(packageManager)
  while (list.length > 0) {
    const newList = []
    for (const item of list) {
      if (item.vtype === 'fclos') {
        if (item.ast?.node?.type === 'FunctionDefinition' && item.ast?.node?.id?.name === 'main') {
          entryPoints.push(item)
        }
      } else if (item.vtype === 'class' || item.vtype === 'package') {
        if (item.members?.size > 0) {
          for (const key of item.members.keys()) {
            newList.push(item.members.get(key))
          }
        }
      }
    }
    list = newList
  }

  for (const entrypoint of entryPoints) {
    if (entrypoint.vtype === 'fclos' && entrypoint.ast?.node?.loc?.sourcefile) {
      const mainDirPrefix = configJava.maindirPrefix
      entrypoint.filePath = mainDirPrefix
        ? entrypoint.ast?.node?.loc.sourcefile.substring(
            entrypoint.ast?.node?.loc.sourcefile.indexOf(mainDirPrefix) + mainDirPrefix.length
          )
        : entrypoint.ast?.node?.loc.sourcefile
      entrypoint.functionName = entrypoint.sid
      entrypoint.attribute = 'HTTP'
    }
    if (entryPointAndSourceAtSameTimeJava && entrypoint.ast?.node?.parameters && entrypoint.ast?.node?.id.type === 'Identifier') {
      for (const param of entrypoint.ast.node.parameters) {
        if (param.type === 'VariableDeclaration' && param.id?.type === 'Identifier') {
          TaintSource.push({
            introPoint: 4,
            path: param.id.name,
            scopeFunc: entrypoint.ast.node.id.name,
            scopeFile: entrypoint.ast.node.loc?.sourcefile,
            locStart: param.id.loc?.start.line,
            locEnd: param.id.loc?.end.line,
            locColumnStart: param.id.loc?.start.column,
            locColumnEnd: param.id.loc?.end.column,
          })
        }
      }
    }
  }
  return { selfCollectMainEntryPoints: entryPoints, selfCollectMainTaintSource: TaintSource }
}

module.exports = {
  getJavaMainEntryPointAndSource,
}
