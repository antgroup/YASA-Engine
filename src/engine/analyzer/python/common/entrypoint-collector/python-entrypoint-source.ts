/**
 *
 * @param fileName
 * @param funcName
 * @param funcAst
 * @param paramIndexArray
 */
function findSourceOfFuncParam(fileName: any, funcName: any, funcAst: any, paramIndexArray?: number[]) {
  const sourceArray: any[] = []

  if (!funcAst || !funcAst.parameters) {
    return sourceArray
  }

  for (const index in funcAst.parameters) {
    const param = funcAst.parameters[index]
    if (param.type !== 'VariableDeclaration' && param.id?.type !== 'Identifier') {
      continue
    }

    let indexMatch = false
    if (!paramIndexArray) {
      indexMatch = true
    } else if (paramIndexArray.includes(Number(index))) {
      indexMatch = true
    }
    if (!indexMatch) {
      continue
    }

    const source = {
      introPoint: 4,
      kind: 'PYTHON_INPUT',
      path: param.id.name,
      scopeFunc: funcName,
      scopeFile: fileName,
      locStart: funcAst.loc?.start.line,
      locEnd: funcAst.loc?.end.line,
      locColumnStart: funcAst.loc?.start.column,
      locColumnEnd: funcAst.loc?.end.column,
    }
    sourceArray.push(source)
  }

  return sourceArray
}

export = {
  findSourceOfFuncParam,
}
