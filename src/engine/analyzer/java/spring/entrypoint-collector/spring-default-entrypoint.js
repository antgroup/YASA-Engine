const astUtil = require('../../../../../util/ast-util')
const config = require('../../../../../config')
const { entryPointAndSourceAtSameTime } = require('../../../../../config')

const defaultSpringAnnotations = [
  'RequestMapping',
  'GetMapping',
  'PostMapping',
  'PutMapping',
  'DeleteMapping',
  'PatchMapping',
  'Path',
]

/**
 *
 * @param packageManager
 */
function getSpringEntryPointAndSource(packageManager) {
  const TaintSource = []
  let entryPoints = astUtil.satisfy(
    packageManager,
    (n) =>
      n.vtype === 'fclos' &&
      n.ast?._meta &&
      n.ast?._meta.modifiers &&
      n.ast?._meta.modifiers.some((m) => defaultSpringAnnotations.some((annotation) => m.includes(annotation))),
    (node, prop) => prop === 'field',
    null,
    true
  )
  if (!entryPoints) {
    entryPoints = []
  } else if (!Array.isArray(entryPoints)) {
    entryPoints = [entryPoints]
  }
  for (const entrypoint of entryPoints) {
    if (entrypoint.vtype === 'fclos' && entrypoint.ast?.loc?.sourcefile) {
      const mainDirPrefix = config.maindirPrefix
      entrypoint.filePath = mainDirPrefix
        ? entrypoint.ast?.loc.sourcefile.substring(
            entrypoint.ast?.loc.sourcefile.indexOf(mainDirPrefix) + mainDirPrefix.length
          )
        : entrypoint.ast?.loc.sourcefile
      entrypoint.functionName = entrypoint.sid
      entrypoint.attribute = 'HTTP'
    }
    if (entryPointAndSourceAtSameTime && entrypoint.ast?.parameters && entrypoint.ast?.id.type === 'Identifier') {
      for (const param of entrypoint.ast.parameters) {
        if (param.type === 'VariableDeclaration' && param.id?.type === 'Identifier') {
          TaintSource.push({
            introPoint: 4,
            path: param.id.name,
            scopeFunc: entrypoint.ast.id.name,
            scopeFile: entrypoint.ast.loc?.sourcefile,
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
