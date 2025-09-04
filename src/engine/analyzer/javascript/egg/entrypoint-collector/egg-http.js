const astUtil = require('../../../../../util/ast-util')
/**
 * 路由的完整定义
 * router.verb('path-match', app.controller.action);
 * router.verb('router-name', 'path-match', app.controller.action);
 * router.verb('path-match', middleware1, ..., middlewareN, app.controller.action);
 * router.verb('router-name', 'path-match', middleware1, ..., middlewareN, app.controller.action);
 *  app.rpcAndGet(
 *     'agreement.getAgreementMiniloanCtrl',
 *     jiebeiResultWrap,
 *     app.controller.agreement.list.getAgreementMiniloanCtrl,
 *   );
 */
const httpMethodList = [
  'head',
  'options',
  'get',
  'post',
  'delete',
  'put',
  'patch',
  'del',
  'redirect',
  'rpcAndGet',
  'rpcAndPost',
]
const defaultEggTaintSource = [
  'ctx.query',
  'ctx.queries',
  'ctx.params',
  'ctx.request',
  'this.ctx.query',
  'this.ctx.queries',
  'this.ctx.params',
  'this.ctx.request',
]

/**
 *
 * @param fileManager
 */
function getEggHttpEntryPointsAndSources(fileManager) {
  const entryPoints = []
  const uastUrlInfoList = []
  const TaintSource = []
  const routerFiles = calcRouterFileList(fileManager)
  if (routerFiles.length === 0) {
    return { entryPoints, TaintSource }
  }
  for (const routerFile of routerFiles) {
    if (routerFile.includes('/app/public') || fileManager[routerFile] === null) {
      continue
    }
    EggRouterVisitor.routerList = []
    astUtil.visit(fileManager[routerFile].ast, EggRouterVisitor)
    uastUrlInfoList.push(...EggRouterVisitor.routerList)
  }
  if (!uastUrlInfoList.length > 0) {
    return { entryPoints, TaintSource }
  }

  for (const uastUrlInfo of uastUrlInfoList) {
    for (const filePath of Object.getOwnPropertyNames(fileManager)) {
      if (isJsFileWithControllerPathCorrespond(filePath, uastUrlInfo.controllerAction)) {
        if (filePath.includes('/app/public')) {
          continue
        }
        uastUrlInfo.relativePath =
          filePath.indexOf('/app/') !== -1 ? filePath.slice(filePath.indexOf('/app/')) : filePath
        EggMethodVisitor.uastUrlInfo = uastUrlInfo
        astUtil.visit(fileManager[filePath].ast, EggMethodVisitor)
      }
    }
  }
  for (const uastUrlInfo of uastUrlInfoList) {
    if (!uastUrlInfo.relativePath || !uastUrlInfo.methodName) {
      continue
    }
    entryPoints.push({
      attribute: 'HTTP',
      filePath: uastUrlInfo.relativePath,
      functionName: uastUrlInfo.methodName,
    })
    if (uastUrlInfo.paramList) {
      for (const param of uastUrlInfo.paramList) {
        TaintSource.push({
          introPoint: 4,
          kind: 'EGG_INPUT',
          path: param.paramName,
          scopeFunc: uastUrlInfo.methodName,
          scopeFile: uastUrlInfo.relativePath,
          locStart: param.locStart,
          locEnd: param.locEnd,
          locColumnStart: param.locColumnStart,
          locColumnEnd: param.locColumnEnd,
        })
      }
    }
  }

  // 加载默认source
  for (const d of defaultEggTaintSource) {
    TaintSource.push({
      introPoint: 4,
      kind: 'EGG_INPUT',
      path: d,
      scopeFile: 'all',
      scopeFunc: 'all',
    })
  }

  return { entryPoints, TaintSource }
}

/**
 *
 * @param fileManager
 */
function calcRouterFileList(fileManager) {
  const routerFileList = []

  for (const file of Object.getOwnPropertyNames(fileManager)) {
    const codeContent = astUtil.prettyPrintAST(fileManager[file].ast)
    for (const method of httpMethodList) {
      if (codeContent.includes(`.${method}(`)) {
        routerFileList.push(file)
        break // 找到后停止检查其他方法
      }
    }
  }
  return routerFileList
}

/**
 *
 * @param jsFilePath
 * @param controllerPath
 */
function isJsFileWithControllerPathCorrespond(jsFilePath, controllerPath) {
  // 提取文件路径并去除后缀
  const jsFilePathWithoutSuffix = jsFilePath.split('.').slice(0, -1).join('').toLowerCase()

  // 按 '/' 分割路径并反转
  const jsFilePathWithoutSuffixList = jsFilePathWithoutSuffix.split('/')
  jsFilePathWithoutSuffixList.reverse()

  // 如果 controllerPath 包含 '.'
  if (controllerPath && typeof controllerPath.includes === 'function' && controllerPath.includes('.')) {
    // 按 '.' 分割 controllerPath 并反转
    const controllerPathList = controllerPath.split('.')
    controllerPathList.reverse()

    // 循环遍历 controllerPathList，比较与 jsFilePathWithoutSuffixList 是否匹配
    for (let i = 0; i < jsFilePathWithoutSuffixList.length; i++) {
      if (controllerPathList.length > i + 1) {
        const jsFilePath = jsFilePathWithoutSuffixList[i]
        const controller = controllerPathList[i + 1]

        // 调用 getEggCamelResult 进行转换并比较
        if (getEggCamelResult(jsFilePath).toLowerCase() !== controller.toLowerCase()) {
          return false
        }
      } else {
        break
      }
    }
    return true
  }
  return false
}

/**
 *
 * @param str
 */
function getEggCamelResult(str) {
  const words = str.split('_')
  let result = words[0].toLowerCase()

  for (let i = 1; i < words.length; i++) {
    const word = words[i]
    const firstLetter = word.charAt(0).toUpperCase()
    const restOfWord = word.slice(1).toLowerCase()
    result += firstLetter + restOfWord
  }

  return result
}

let EggRouterVisitor = {
  routerList: [],

  CallExpression(node) {
    if (node == null) {
      return false
    }
    if (!(node.callee?.type === 'MemberAccess') || !(node.callee?.property?.type === 'Identifier')) {
      return false
    }
    let controllerAction = ''
    const uastUrlInfo = {}
    const methodName = node.callee.property.name
    if (httpMethodList.includes(methodName)) {
      const argumentList = node.arguments
      if (argumentList.length < 2) {
        return false
      }
      if (argumentList[argumentList.length - 1].type === 'MemberAccess') {
        controllerAction = astUtil.prettyPrintAST(argumentList[argumentList.length - 1])
      } else if (argumentList[argumentList.length - 1].type.includes('Literal')) {
        if (argumentList[argumentList.length - 1].type === 'Literal') {
          controllerAction = argumentList[argumentList.length - 1].value
        }
      }
      // 检查 controllerAction 是否包含 '.'
      if (controllerAction && typeof controllerAction.includes === 'function' && controllerAction.includes('.')) {
        // 使用 split 分割字符串，并获取最后一个部分作为方法名
        const parts = controllerAction.split('.')
        uastUrlInfo.methodName = parts[parts.length - 1]
      } else {
        // 如果不包含 '.'，直接使用 methodName
        uastUrlInfo.methodName = methodName
      }
      uastUrlInfo.controllerAction = controllerAction
      if (controllerAction) {
        this.routerList.push(uastUrlInfo)
      }
    }
  },
}

let EggMethodVisitor = {
  uastUrlInfo: null,
  FunctionDefinition(node) {
    if (node == null) {
      return false
    }
    let targetMethodName = ''
    if (node.id?.type === 'Identifier') {
      targetMethodName = node.id.name
    }
    if (targetMethodName === '') {
      if (node.parent === null) {
        return false
      }
      if (node.parent.type !== 'AssignmentExpression') {
        return false
      }
      if (node.parent.left === null) {
        return false
      }
      if (
        astUtil.prettyPrintAST(node.parent.left) === '' ||
        !astUtil.prettyPrintAST(node.parent.left).includes(this.uastUrlInfo.methodName)
      ) {
        return false
      }
    } else {
      // 如果不等于目标函数
      if (targetMethodName !== this.uastUrlInfo.methodName) {
        return false
      }
      const paramList = []
      for (const uastBaseNode of node.parameters) {
        if (uastBaseNode.type === 'VariableDeclaration') {
          if (uastBaseNode.id.type === 'Identifier') {
            paramList.push({
              paramName: uastBaseNode.id.name,
              locStart: uastBaseNode.loc?.start.line,
              locEnd: uastBaseNode.loc?.end.line,
              locColumnStart: uastBaseNode.loc?.start.column,
              locColumnEnd: uastBaseNode.loc?.end.column,
            })
          }
        }
      }
      this.uastUrlInfo.paramList = paramList
    }
  },
}

module.exports = {
  getEggHttpEntryPointsAndSources,
}
