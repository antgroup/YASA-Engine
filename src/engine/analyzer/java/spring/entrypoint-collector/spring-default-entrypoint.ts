const AstUtil = require('../../../../../util/ast-util')
const Config = require('../../../../../config')
const { entryPointAndSourceAtSameTime } = require('../../../../../config')

export {}

const defaultSpringAnnotations = [
  'RequestMapping',
  'GetMapping',
  'PostMapping',
  'PutMapping',
  'DeleteMapping',
  'PatchMapping',
  'Path',
  'Tool',
  'McpTool',
]

/**
 *
 * @param packageManager
 */
function getSpringEntryPointAndSource(packageManager: any) {
  const TaintSource: any[] = []

  const entryPoints = []
  const visited = new Set()
  let list = []
  list.push(packageManager)
  while (list.length > 0) {
    const newList = []
    for (const item of list) {
      if (!item || visited.has(item)) continue
      visited.add(item)
      if (item.vtype === 'fclos') {
        if (
          !item.ast.node ||
          item.ast.node.type !== 'FunctionDefinition' ||
          !item.ast.node._meta ||
          !Array.isArray(item.ast.node._meta.modifiers)
        ) {
          continue
        }
        for (const modifier of item.ast.node._meta.modifiers) {
          let found = false
          for (const springAnnotation of defaultSpringAnnotations) {
            if (modifier.includes(springAnnotation)) {
              found = true
              break
            }
          }
          if (found) {
            entryPoints.push(item)
            break
          }
        }
      } else if (item.vtype === 'class' || item.vtype === 'package') {
        if (item.members?.size > 0) {
          for (const key of item.members.keys()) {
            const member = item.members.get(key)
            if (member) newList.push(member)
          }
        }
      }
    }
    list = newList
  }

  for (const entrypoint of entryPoints) {
    if (entrypoint.vtype === 'fclos' && entrypoint.ast?.node?.loc?.sourcefile) {
      const mainDirPrefix = Config.maindirPrefix
      entrypoint.filePath = mainDirPrefix
        ? entrypoint.ast?.node?.loc.sourcefile.substring(
            entrypoint.ast?.node?.loc.sourcefile.indexOf(mainDirPrefix) + mainDirPrefix.length
          )
        : entrypoint.ast?.node?.loc.sourcefile
      entrypoint.functionName = entrypoint.sid
      entrypoint.attribute = 'HTTP'
    }
    if (entryPointAndSourceAtSameTime && entrypoint.ast?.node?.parameters && entrypoint.ast?.node?.id.type === 'Identifier') {
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
  return { selfCollectSpringEntryPoints: entryPoints, selfCollectSpringTaintSource: TaintSource }
}

module.exports = {
  getSpringEntryPointAndSource,
}
