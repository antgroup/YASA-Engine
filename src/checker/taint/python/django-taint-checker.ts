const { PythonTaintAbstractChecker } = require('./python-taint-abstract-checker')
const completeEntryPoint = require('../common-kit/entry-points-util')
const { extractRelativePath } = require('../../../util/file-util')

const AstUtil = require('../../../util/ast-util')
const Config = require('../../../config')
const path = require('path')
const { resolveImportPath } = require('../../../engine/analyzer/python/common/python-import-resolver')

interface ASTObject {
  body?: any[]

  [key: string]: any
}

/** 待延迟处理的 include() 调用信息 */
interface PendingInclude {
  includeCall: ASTObject
  analyzer: ASTObject
  state: ASTObject
}

/** 待延迟处理的视图函数（processInstruction 返回 symbol 而非 fclos） */
interface PendingView {
  analyzer: any
  scope: any
  state: any
  viewFunction: ASTObject
  targetSrcName: string[]
}

/** ValueRefMap 的接口子集，用于 modules.members */
interface ModuleMembers {
  get(key: string): ASTObject | null
  keys(): IterableIterator<string>
  entries(): [string, ASTObject][]
  size: number
}

const registerFile = new Set<string>()

/**
 * Django entrypoint采集以及框架source添加
 */
class DjangoTaintChecker extends PythonTaintAbstractChecker {
  /** 延迟处理的 include() 调用列表，随文件逐个加载逐步清空 */
  private pendingIncludes: PendingInclude[] = []

  /** 延迟处理的视图函数列表，等待模块加载后重新解析 */
  private pendingViews: PendingView[] = []

  /** 循环引用防护：已访问的 include 文件路径集合 */
  private visitedFiles: Set<string> = new Set<string>()

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
  triggerAtAssignment(analyzer: any, scope: any, node: any, state: any, info: any): boolean | undefined {
    const fileName = node.loc?.sourcefile
    if (!fileName) return
    if (registerFile.size === 0 || !registerFile.has(fileName)) {
      return
    }

    if (node.left.name === 'urlpatterns') {
      const { right } = node
      this.collectDjangoEntrypointAndSource(analyzer, scope, state, right)
    }
  }

  /**
   * 每个文件处理完后尝试解析待处理的 include() 和未解析的视图函数
   * 随着文件逐个加载，目标模块的 scope 逐渐可用，pending 队列逐步清空
   * 确保 entrypoints 在 symbolInterpret 之前全部注册
   */
  triggerAtEndOfCompileUnit(analyzer: any, scope: any, node: any, state: any, info: any): void {
    // 处理待解析的 include()
    if (this.pendingIncludes.length > 0) {
      const stillPendingIncludes: PendingInclude[] = []

      for (const pending of this.pendingIncludes) {
        const resolved = this.tryResolveInclude(
          pending.analyzer as any,
          pending.state as any,
          pending.includeCall
        )
        if (!resolved) {
          stillPendingIncludes.push(pending)
        }
      }

      this.pendingIncludes = stillPendingIncludes
    }

    // 处理待解析的视图函数（模块加载后重新解析 MemberAccess 引用）
    if (this.pendingViews.length > 0) {
      const stillPendingViews: PendingView[] = []

      for (const pending of this.pendingViews) {
        const resolved = this.tryResolvePendingView(pending)
        if (!resolved) {
          stillPendingViews.push(pending)
        }
      }

      this.pendingViews = stillPendingViews
    }
  }

  /**
   * 尝试解析待处理的视图函数
   * 重新调用 processInstruction，若目标模块已加载则返回 fclos
   */
  private tryResolvePendingView(pending: PendingView): boolean {
    const { analyzer, scope, state, viewFunction, targetSrcName } = pending
    const ep = analyzer.processInstruction(scope, viewFunction, state)
    if (ep.vtype === 'fclos') {
      this.registerFuncViewEntrypoint(analyzer, ep, targetSrcName)
      return true
    }
    // processInstruction 仍返回 symbol，尝试从已加载模块中直接查找函数定义
    if (ep.vtype === 'symbol' && viewFunction.type === 'MemberAccess') {
      const funcName: string | undefined = viewFunction.property?.name
      const moduleName: string | undefined = viewFunction.object?.name
      if (!funcName || !moduleName) return false

      const resolved = this.resolveViewFromModules(analyzer, scope, state, moduleName, funcName)
      if (resolved) {
        this.registerFuncViewEntrypoint(analyzer, resolved, targetSrcName)
        return true
      }
    }
    return false
  }

  /**
   * 从已加载的模块 scope 中查找视图函数的 fclos 值
   * 处理 MemberAccess 形式（如 views.api_pipeline_detail）在模块尚未完全解析时的情况
   */
  private resolveViewFromModules(
    analyzer: any,
    scope: any,
    state: any,
    moduleName: string,
    funcName: string
  ): any | null {
    // 从 scope 中获取模块引用
    const moduleVal = scope?.value?.[moduleName]
    if (!moduleVal) return null

    // 如果模块已解析，直接从 value 中获取函数
    const funcVal = moduleVal.value?.[funcName]
    if (funcVal?.vtype === 'fclos') return funcVal

    // 回退：遍历已加载模块的 members，查找匹配文件中的函数定义
    const members: ModuleMembers | undefined =
      analyzer.topScope?.context?.modules?.members
    if (!members) return null

    for (const [filePath, moduleScope] of members.entries()) {
      // 匹配模块名：import views from demoapp → 查找 demoapp 目录下的 views.py
      if (!filePath.endsWith('/views.py') && !filePath.endsWith('/' + moduleName + '.py')) continue

      const scopeValue = (moduleScope as any)?.value
      if (!scopeValue) continue

      const targetFunc = scopeValue[funcName]
      if (targetFunc?.vtype === 'fclos') return targetFunc
    }

    return null
  }

  /**
   * 尝试解析单个 include()，成功返回 true，目标模块尚未加载时返回 false
   * 目录级 include 会在每轮 endOfCompileUnit 重新扫描，捕获新加载的文件
   */
  private tryResolveInclude(
    analyzer: any,
    state: any,
    includeCall: ASTObject
  ): boolean {
    if (!includeCall.arguments || includeCall.arguments.length < 1) return true

    const firstArg = includeCall.arguments[0]
    if (firstArg.type !== 'Literal' || typeof firstArg.value !== 'string') return true

    const modulePath: string = firstArg.value
    const currentFile: string | undefined = includeCall.loc?.sourcefile
    if (!currentFile || !analyzer.fileList) return true

    const resolvedPath: string | null = resolveImportPath(
      modulePath,
      currentFile,
      analyzer.fileList,
      Config.maindir
    )
    if (!resolvedPath) return true

    const isDirectFile: boolean = resolvedPath.endsWith('.py')

    // 单文件 include：已处理则跳过
    if (isDirectFile && this.visitedFiles.has(resolvedPath)) return true

    const members: ModuleMembers | undefined =
      analyzer.topScope?.context?.modules?.members
    if (!members) return false

    const moduleScopes: Array<{ scope: ASTObject; filePath: string }> =
      this.resolveModuleScopes(resolvedPath, members)

    // 目标模块尚未加载，保留在 pending 列表
    if (moduleScopes.length === 0) return false

    // 过滤出尚未处理的新文件
    const newScopes: Array<{ scope: ASTObject; filePath: string }> =
      moduleScopes.filter(s => !this.visitedFiles.has(s.filePath))

    // 处理新文件
    for (const { scope, filePath } of newScopes) {
      this.visitedFiles.add(filePath)
      this.collectUrlpatternsFromScope(analyzer, scope, state, this.visitedFiles)
    }

    // 单文件 include：标记并完成
    if (isDirectFile) {
      this.visitedFiles.add(resolvedPath)
      return true
    }

    // 目录级 include：始终保持 pending，因为后续可能有更多文件加载
    // 开销极低：每轮只做 members 遍历 + visitedFiles 过滤
    return false
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param state
   * @param value
   * @param visitedFiles - 已访问的 include 文件路径集合，用于防止循环引用
   */
  collectDjangoEntrypointAndSource(
    analyzer: any,
    scope: any,
    state: any,
    value: any,
    visitedFiles?: Set<string>
  ) {
    const visited = visitedFiles || new Set<string>()
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
        // 获取 path() 调用的参数，支持位置参数和关键字参数
        const args: ASTObject[] = element.arguments || []
        if (args.length < 2) continue

        const { routeArg, viewArg } = this.extractPathArgs(args)
        if (!viewArg) continue

        const routeValue: string = routeArg?.value ?? routeArg?.init?.value ?? ''
        const targetSrcName = this.extractParamNames(routeValue)
        const viewFunction: ASTObject = viewArg

        if (viewFunction.type === 'Identifier' || viewFunction.type === 'MemberAccess') {
          this.collectFuncViewEntrypointAndSource(analyzer, scope, state, viewFunction, targetSrcName)
        } else if (viewFunction.type === 'CallExpression' && viewFunction.callee) {
          const viewCallName = this.extractCallName(viewFunction.callee)
          if (viewCallName === 'as_view') {
            this.collectClassViewEntrypointAndSource(analyzer, scope, state, viewFunction, targetSrcName)
          } else if (viewCallName === 'include') {
            // include() 延迟到 endOfCompileUnit 逐步处理，等待目标模块加载
            this.pendingIncludes.push({
              includeCall: viewFunction,
              analyzer: analyzer,
              state: state,
            })
          }
        }
      }
    }
  }

  /**
   * 从 path()/re_path()/url() 调用中提取 route 和 view 参数
   * 支持位置参数和关键字参数（VariableDeclaration）两种形式
   */
  extractPathArgs(args: ASTObject[]): { routeArg: ASTObject | null; viewArg: ASTObject | null } {
    const isKeywordArg = (arg: ASTObject): boolean =>
      arg.type === 'VariableDeclaration' && !!arg.id?.name

    if (args.length >= 2 && !isKeywordArg(args[0])) {
      // 位置参数形式：path('route/', view_func)
      return { routeArg: args[0], viewArg: args[1] }
    }

    // 关键字参数形式：path(route='...', view=view_func)
    let routeArg: ASTObject | null = null
    let viewArg: ASTObject | null = null
    for (const arg of args) {
      if (!isKeywordArg(arg)) continue
      const keyName: string = arg.id.name
      if (keyName === 'route' || keyName === 'regex' || keyName === 'pattern') {
        routeArg = arg.init || null
      } else if (keyName === 'view') {
        viewArg = arg.init || null
      }
    }
    return { routeArg, viewArg }
  }

  /**
   * 从 CallExpression 的 callee 节点中提取方法名
   */
  extractCallName(callee: ASTObject): string | null {
    if (callee.type === 'MemberAccess' && callee.property?.name) {
      return callee.property.name
    }
    if (callee.type === 'Identifier') {
      return callee.name || null
    }
    return null
  }

  /**
   * 根据解析路径查找所有相关的模块 scope
   * 处理两种情况：直接文件匹配 和 包目录（含 __init__.py）
   * 当 __init__.py 无有效 urlpatterns 时，回退扫描同目录 *_urls.py 文件
   */
  resolveModuleScopes(
    resolvedPath: string,
    members: ModuleMembers
  ): Array<{ scope: ASTObject; filePath: string }> {
    const results: Array<{ scope: ASTObject; filePath: string }> = []
    const normalizedResolved: string = path.normalize(resolvedPath)

    // 直接匹配：resolvedPath 本身（.py 文件的情况）
    const directScope: ASTObject | null = members.get(normalizedResolved)
    if (directScope) {
      results.push({ scope: directScope, filePath: normalizedResolved })
      return results
    }

    // 包目录匹配：resolvedPath 是目录时，查找 __init__.py
    const initFilePath: string = path.normalize(
      path.join(normalizedResolved, '__init__.py')
    )
    const initScope: ASTObject | null = members.get(initFilePath)
    if (initScope) {
      const hasUrlpatterns: boolean = this.scopeHasUrlpatterns(initScope)
      if (hasUrlpatterns) {
        results.push({ scope: initScope, filePath: initFilePath })
        return results
      }
    }

    // exec() 动态加载的 fallback：__init__.py 无有效 urlpatterns，扫描同目录 *_urls.py 文件
    const dirPrefix: string = normalizedResolved + path.sep
    for (const [filePath, scope] of members.entries()) {
      const normalizedFilePath: string = path.normalize(filePath)
      const baseName: string = path.basename(normalizedFilePath)
      if (
        normalizedFilePath.startsWith(dirPrefix) &&
        baseName.endsWith('_urls.py')
      ) {
        results.push({ scope: scope as ASTObject, filePath: normalizedFilePath })
      }
    }

    return results
  }

  /**
   * 判断 scope 中是否包含非空的 urlpatterns 赋值
   */
  private scopeHasUrlpatterns(scope: ASTObject): boolean {
    const urlpatternsVal = scope.value?.urlpatterns
    if (!urlpatternsVal) return false

    const ast = urlpatternsVal.ast?.node
    if (!ast) return false

    // 仅列表字面量且包含元素时视为有效 urlpatterns
    // exec() 动态加载产生的 BinaryExpression（如 urlpatterns += frontend_urls）无法静态分析
    if (ast.type !== 'ObjectExpression') return false
    if (!ast.properties || ast.properties.length === 0) return false

    return true
  }

  /**
   * 从模块 scope 中查找 urlpatterns 并递归采集 entrypoint
   */
  collectUrlpatternsFromScope(
    analyzer: any,
    scope: ASTObject,
    state: any,
    visitedFiles: Set<string>
  ): void {
    const urlpatternsVal = scope.value?.urlpatterns
    if (!urlpatternsVal) return

    const urlpatternsAst = urlpatternsVal.ast?.node
    if (urlpatternsAst) {
      this.collectDjangoEntrypointAndSource(
        analyzer, scope, state, urlpatternsAst, visitedFiles
      )
    }
  }

  /**
   * 采集函数视图的 entrypoint 和 source
   * 当 processInstruction 返回 symbol 而非 fclos 时，延迟到后续文件加载后重试
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
      this.registerFuncViewEntrypoint(analyzer, ep, targetSrcName)
    } else if (ep.vtype === 'symbol') {
      // 模块尚未加载，延迟处理
      this.pendingViews.push({ analyzer, scope, state, viewFunction, targetSrcName })
    }
  }

  /**
   * 注册函数视图 entrypoint 及其 source 参数
   */
  private registerFuncViewEntrypoint(
    analyzer: any,
    ep: any,
    targetSrcName: string[]
  ): void {
    analyzer.entryPoints.push(completeEntryPoint(ep))
    if (targetSrcName.length > 0) {
      const targetName = targetSrcName[0]
      for (const param of ep.ast.fdef.parameters) {
        if (param.id.name === targetName) {
          this.sourceScope.value.push({
            path: param.id.name,
            kind: 'PYTHON_INPUT',
            scopeFile: extractRelativePath(param?.loc?.sourcefile, Config.maindir),
            scopeFunc: ep.ast.fdef?.id?.name,
            locStart: param.loc.start?.line,
            locEnd: param.loc.end?.line,
          })
        }
      }
    }
    for (const param of ep.ast.fdef.parameters) {
      if (param.id.name === 'request') {
        this.sourceScope.value.push({
          path: param.id.name,
          kind: 'PYTHON_INPUT',
          scopeFile: extractRelativePath(param?.loc?.sourcefile, Config.maindir),
          scopeFunc: ep.ast.fdef?.id?.name,
          locStart: param.loc.start.line,
          locEnd: param.loc.end.line,
        })
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
        for (const param of ep.ast.fdef.parameters) {
          if (param.id.name === targetName) {
            this.sourceScope.value.push({
              path: param.id.name,
              kind: 'PYTHON_INPUT',
              scopeFile: extractRelativePath(param?.loc?.sourcefile, Config.maindir),
              scopeFunc: ep.ast.fdef?.id?.name,
              locStart: param.loc.start?.line,
              locEnd: param.loc.end?.line,
            })
          }
        }
        analyzer.entryPoints.push(completeEntryPoint(ep))
      }
    } else {
      for (const ep of entrypoints as any[]) {
        for (const param of ep.ast.fdef.parameters) {
          if (param.id.name === 'request') {
            this.sourceScope.value.push({
              path: param.id.name,
              kind: 'PYTHON_INPUT',
              scopeFile: extractRelativePath(param?.loc?.sourcefile, Config.maindir),
              scopeFunc: ep.ast.fdef?.id?.name,
              locStart: param.loc.start.line,
              locEnd: param.loc.end.line,
            })
          }
        }
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
