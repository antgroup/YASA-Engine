const PythonTaintAbstractChecker = require('./python-taint-abstract-checker')
const completeEntryPoint = require('../common-kit/entry-points-util')
const { extractRelativePath } = require('../../../util/file-util')

const AstUtil = require('../../../util/ast-util')
const Config = require('../../../config')

interface ASTObject {
  body?: any[]

  [key: string]: any
}

const registerFile = new Set<string>()

/**
 * Django entrypoint采集以及框架source添加
 */
class DjangoTaintChecker extends PythonTaintAbstractChecker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_python_django_input')
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtCompileUnit(analyzer: any, scope: any, node: any, state: any, info: any): boolean | undefined {
    const fileName = node.loc?.sourcefile
    if (!fileName) return
    if (!fileName.endsWith('/urls.py')) return
    node.body.forEach((exp: any) => {
      if (exp.type === 'VariableDeclaration') {
        if (exp.init.type !== 'ImportExpression') return
        const str = AstUtil.prettyPrint(exp)
        if (str.includes('django') && str.includes('urls') && (str.includes('re_path') || str.includes('path'))) {
          registerFile.add(fileName)
        } else if (str.includes('django') && str.includes('conf') && str.includes('urls') && str.includes('url')) {
          registerFile.add(fileName)
        }
      }
    })
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtPreDeclaration(analyzer: any, scope: any, node: any, state: any, info: any): boolean | undefined {
    const fileName = node.loc?.sourcefile
    if (!fileName) return
    if (registerFile.size === 0 || !registerFile.has(fileName)) {
      return
    }

    const varName = node.id.name
    const initValue = node.init
    if (varName === 'urlpatterns' && initValue) {
      this.collectDjangoEntrypointAndSource(analyzer, scope, state, initValue)
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
  triggerAtAssignment(analyzer: any, scope: any, node: any, state: any, info: any): boolean | undefined {
    const fileName = node.loc?.sourcefile
    if (!fileName) return
    if (registerFile.size === 0 || !registerFile.has(fileName)) {
      return
    }
    // 处理urlpatterns += []
    if (node.left.name === 'urlpatterns' && node.right.type === 'BinaryExpression') {
      const { right } = node
      this.collectDjangoEntrypointAndSource(analyzer, scope, state, right)
    }
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param state
   * @param value
   */
  collectDjangoEntrypointAndSource(analyzer: any, scope: any, state: any, value: any) {
    const elementGroups: any[] = []
    this.extractElementsFromNode(elementGroups, value)

    for (const element of elementGroups) {
      if (element.type === 'CallExpression' && element.callee) {
        const { callee } = element
        // 处理 MemberAccess (如 django.urls.path) 和 Identifier (如直接导入的 path)
        let methodName: string | null = null
        if (callee.type === 'MemberAccess' && callee.property?.name) {
          methodName = callee.property.name
        } else if (callee.type === 'Identifier') {
          methodName = callee.name || null
        }
        if (methodName !== 'path' && methodName !== 're_path' && methodName !== 'url') {
          continue
        }
        // 获取path调用的参数
        if (element.arguments && element.arguments.length >= 2) {
          const targetSrcName = this.extractParamNames(element.arguments[0].value)
          const viewFunction = element.arguments[1]
          if (viewFunction.type === 'Identifier' || viewFunction.type === 'MemberAccess') {
            this.collectFuncViewEntrypointAndSource(analyzer, scope, state, viewFunction, targetSrcName)
          } else if (viewFunction.type === 'CallExpression' && viewFunction.callee) {
            // include的情况暂时不用支持，因为最终路由的entrypoint最终也会在另一个文件中完成采集
            if (viewFunction.callee.type === 'MemberAccess' && viewFunction.callee.property.name === 'as_view') {
              this.collectClassViewEntrypointAndSource(analyzer, scope, state, viewFunction, targetSrcName)
            }
          }
        }
      }
    }
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param state
   * @param viewFunction
   * @param targetSrcName
   */
  collectFuncViewEntrypointAndSource(
    analyzer: any,
    scope: any,
    state: any,
    viewFunction: ASTObject,
    targetSrcName: string[]
  ) {
    const ep = analyzer.processInstruction(scope, viewFunction, state)
    if (ep.vtype === 'fclos') {
      analyzer.entryPoints.push(completeEntryPoint(ep))
      if (targetSrcName.length > 0) {
        const targetName = targetSrcName[0]
        for (const param of ep.fdef.parameters) {
          if (param.id.name === targetName) {
            this.sourceScope.value.push({
              path: param.id.name,
              kind: 'PYTHON_INPUT',
              scopeFile: extractRelativePath(param?.loc?.sourcefile, Config.maindir),
              scopeFunc: ep.fdef?.id?.name,
              locStart: param.loc.start.line,
              locEnd: param.loc.end.line,
            })
          }
        }
      }
    }
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param state
   * @param viewFunction
   * @param targetSrcName
   */
  collectClassViewEntrypointAndSource(
    analyzer: any,
    scope: any,
    state: any,
    viewFunction: ASTObject,
    targetSrcName: string[]
  ) {
    // 提取类名
    const clsObj = viewFunction.callee.object
    const clsSymVal = analyzer.processInstruction(scope, clsObj, state)
    const httpMethods = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options'])
    const entrypoints = Object.entries(clsSymVal.value)
      .filter(([key, value]: [string, any]) => httpMethods.has(key) && value.vtype === 'fclos')
      .map(([, value]: [string, any]) => value)
    if (targetSrcName.length > 0) {
      const targetName = targetSrcName[0]
      for (const ep of entrypoints as any[]) {
        for (const param of ep.fdef.parameters) {
          if (param.id.name === targetName) {
            this.sourceScope.value.push({
              path: param.id.name,
              kind: 'PYTHON_INPUT',
              scopeFile: extractRelativePath(param?.loc?.sourcefile, Config.maindir),
              scopeFunc: ep.fdef?.id?.name,
              locStart: param.loc.start.line,
              locEnd: param.loc.end.line,
            })
          }
        }
        analyzer.entryPoints.push(completeEntryPoint(ep))
      }
    } else {
      for (const ep of entrypoints as any[]) {
        analyzer.entryPoints.push(completeEntryPoint(ep))
      }
    }
  }

  /**
   *
   * @param elementGroups
   * @param node
   */
  extractElementsFromNode(elementGroups: any[], node: ASTObject | null): void {
    if (!node) return
    if (node.type === 'ObjectExpression' && node.properties) {
      elementGroups.push(...(node.properties.map((prop: any) => prop.value).filter(Boolean) as ASTObject[]))
    } else if (node.type === 'BinaryExpression') {
      // 处理 urlpatterns = [] + [...]
      this.extractElementsFromNode(elementGroups, node.left || null)
      this.extractElementsFromNode(elementGroups, node.right || null)
    }
  }

  /**
   *
   * @param routeStr
   * @param route
   */
  extractParamNames(route: string): string[] {
    // 匹配 <type:param> 或 <param>
    const regex = /<(?:(?:\w+):)?(\w+)>/g
    const params: string[] = []
    let match: RegExpExecArray | null
    while ((match = regex.exec(route)) !== null) {
      params.push(match[1])
    }
    return params
  }
}

module.exports = DjangoTaintChecker
