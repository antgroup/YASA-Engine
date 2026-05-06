/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('path')
const fs = require('fs-extra')
const Analyzer: typeof import('../../common/analyzer').Analyzer = require('../../common/analyzer')
const CheckerManager = require('../../common/checker-manager')
const BasicRuleHandler = require('../../../../checker/common/rules-basic-handler')
const Parser = require('../../../parser/parser')
const PhpAstBuilder = require('../../../parser/php/php-ast-builder')
const FileUtil = require('../../../../util/file-util')
const AstUtil = require('../../../../util/ast-util')
const logger: import('../../../../util/logger').Logger = require('../../../../util/logger')(__filename)
const { ErrorCode } = require('../../../../util/error-code')
const Statistics = require('../../../../util/statistics')
const config = require('../../../../config')
const ScopeClass = require('../../common/scope')
const constValue = require('../../../../util/constant')
const EntryPointConfig = require('../../common/current-entrypoint')
const { handleException } = require('../../common/exception-handler')

const {
  valueUtil: {
    ValueUtil: { Scoped, ObjectValue, PrimitiveValue, UndefinedValue, VoidValue },
  },
} = require('../../common')

const MemState = require('../../common/memState')
const Scope = require('../../common/scope')
const StateUtil = require('../../../util/state-util')
const Uuid = require('node-uuid')
const Config = require('../../../../config')
const { filterDataFromScope } = require('../../../../util/common-util')
const _ = require('lodash')

/**
 * PHP 语言分析器
 * 参照 JsAnalyzer 最小实现，支持单文件和项目分析
 */
class PhpAnalyzer extends Analyzer {
  /** 跨文件模块 scope 缓存：filename → modClos，用于 symbolInterpret 阶段查找跨文件函数/类定义 */
  private moduleScopes = new Map<string, any>()

  /** 函数静态变量持久化存储：函数全限定名 → (变量名 → 值) */
  private staticVarMap = new Map<string, Map<string, any>>()

  /** $GLOBALS 超全局数组共享存储：key → 值 */
  private globalsMap = new Map<string, any>()

  /** 引用传参绑定栈：函数调用期间暂存 by-ref 参数 → 调用方变量的映射 */
  private _byRefBindings: Array<{ paramName: string; callerArgNode: any; callerScope: any }> = []

  /**
   * @param options - 分析选项
   */
  constructor(options: any) {
    const checkerManager = new CheckerManager(
      options,
      options.checkerIds,
      options.checkerPackIds,
      options.printers,
      BasicRuleHandler
    )
    super(checkerManager, options)
    this.options = options
    this.mainEntryPoints = []
    this.sourceScope = {
      complete: false,
      value: [],
    }
  }

  /**
   * 单文件预处理：解析并处理单个 PHP 文件
   * @param source - 源代码内容
   * @param fileName - 文件名
   */
  async preProcess4SingleFile(source: any, fileName: any) {
    this.initTopScope()
    this.state = this.initState(this.topScope)

    // 确保 PHP parser 异步初始化完成
    await PhpAstBuilder.ensureInitialized()

    // 解析源代码为 AST
    this.performanceTracker.start('preProcess.parseCode')
    const { options } = this
    options.sourcefile = fileName
    this.sourceCodeCache.set(fileName, source.split(/\n/))
    this.uast = Parser.parseSingleFile(fileName, options, this.sourceCodeCache)
    this.performanceTracker.end('preProcess.parseCode')

    if (this.uast) {
      this.initModuleScope(this.uast, fileName)

      // 处理已解析的 AST
      this.performanceTracker.start('preProcess.processModule')
      this.processModule(this.uast, fileName)
      this.performanceTracker.end('preProcess.processModule')
    }
  }

  /**
   * 预处理阶段：扫描模块并解析代码
   * @param dir - 项目目录
   */
  async preProcess(dir: any) {
    await this.scanModules(dir)
  }

  /**
   * 扫描模块：使用统一的 parseProject 接口
   * @param dir - 项目目录
   */
  async scanModules(dir: any) {
    const PARSE_CODE_STAGE = 'preProcess.parseCode'
    const PROCESS_MODULE_STAGE = 'preProcess.processModule'

    // 确保 PHP parser 异步初始化完成
    await PhpAstBuilder.ensureInitialized()

    this.performanceTracker.start(PARSE_CODE_STAGE)
    const astMap = await Parser.parseProject(dir, this.options, this.sourceCodeCache)
    this.performanceTracker.end(PARSE_CODE_STAGE)

    if (!astMap) {
      handleException(
        null,
        'PhpAnalyzer.scanModules: parseProject 返回 null',
        'PhpAnalyzer.scanModules: parseProject returned null'
      )
      return
    }

    const fileCount = Object.keys(astMap).length
    if (fileCount === 0) {
      handleException(
        null,
        '未找到 PHP 源文件',
        'find no target compileUnit of the project: no php file found in source path'
      )
      process.exitCode = ErrorCode.no_valid_source_file
      return
    }

    this.performanceTracker.start(PROCESS_MODULE_STAGE)
    for (const filename in astMap) {
      const ast = astMap[filename]
      if (ast) {
        this.processModule(ast, filename)
      }
    }
    this.performanceTracker.end(PROCESS_MODULE_STAGE)
  }

  /**
   * 处理模块 AST
   * @param ast - AST 节点
   * @param filename - 文件名
   * @returns 模块导出值
   */
  processModule(ast: any, filename: any) {
    if (!ast) {
      Statistics.fileIssues[filename] = 'Parsing Error'
      handleException(
        null,
        `PhpAnalyzer.processModule: ${filename} 解析失败`,
        `Error occurred in PhpAnalyzer.processModule: ${filename} parse error`
      )
      return
    }
    let m = this.topScope.context.modules.members.get(filename)
    if (m && typeof m === 'object') return m

    // 初始化模块作用域
    const modClos = this.initModuleScope(ast, filename)
    this.topScope.context.modules.members.set(filename, modClos.getFieldValue('module.exports'))
    m = this.processModuleDirect(ast, filename, modClos)
    // 存储模块 scope，供 symbolInterpret 阶段跨文件查找函数/类定义
    this.moduleScopes.set(filename, modClos)
    if (m && typeof m !== 'undefined' && typeof m === 'object') {
      m.ast = ast
      this.topScope.context.modules.members.set(filename, m)
      this.fileManager[filename] = { uuid: m.uuid, astNode: m.ast.node }
    }
    return m
  }

  /**
   * 初始化模块作用域
   * @param node - AST 节点
   * @param file - 文件路径
   * @returns 模块闭包
   */
  override initModuleScope(node: any, file: any) {
    if (!file) return
    const prefix = file.substring(config.maindirPrefix?.length)
    const lastDotIndex = prefix.lastIndexOf('.')
    const result = lastDotIndex >= 0 ? prefix.substring(0, lastDotIndex) : prefix
    const modClos = new Scoped('<global>', {
      sid: result,
      parent: this.topScope,
      decls: {},
      ast: node,
    })
    modClos.ast.fdef = node
    ;(modClos as any)._this = modClos

    const mod = new ObjectValue(modClos.qid, { sid: 'module', parent: modClos })
    modClos.value.module = mod
    const exp = new ObjectValue(modClos.qid, { sid: 'module.exports', parent: modClos })
    mod.value.exports = exp
    modClos.value.exports = exp
    return modClos
  }

  /**
   * 直接处理模块
   * @param node - AST 节点
   * @param filename - 文件名
   * @param modClos - 模块闭包
   * @returns 模块导出值
   */
  processModuleDirect(node: any, filename: any, modClos: any) {
    if (!node || node.type !== 'CompileUnit') {
      handleException(
        null,
        `节点类型应为 CompileUnit，但实际为 ${node.type}`,
        `node type should be CompileUnit, but ${node.type}`
      )
      return undefined
    }
    modClos = modClos || this.initModuleScope(node, filename)

    this.entry_fclos = modClos
    this.thisFClos = modClos

    const state = this.initState(modClos)
    this.processInstruction(modClos, node, state)

    const moduleExports = modClos.getFieldValue('module.exports')
    if (this.checkerManager && this.checkerManager.checkAtEndOfCompileUnit) {
      this.checkerManager.checkAtEndOfCompileUnit(this, null, null, state, null)
    }
    return moduleExports
  }

  /**
   * 分析开始阶段：触发 checker 回调后，合并 mainEntryPoints 到 entryPoints
   * 参照 GoAnalyzer.startAnalyze：checker 在 checkAtStartOfAnalyze 中设置 mainEntryPoints，
   * 然后此处合并到 this.entryPoints 供 symbolInterpret 使用
   */
  override startAnalyze() {
    // 注册 PHP 内置函数 taint passthrough（json_decode/base64_decode 等）
    const { initPhpBuiltins } = require('./builtins/php-builtins')
    initPhpBuiltins(this.topScope)

    if (this.checkerManager && this.checkerManager.checkAtStartOfAnalyze) {
      this.checkerManager.checkAtStartOfAnalyze(this, null, null, null, null)
    }
    if (this.mainEntryPoints && Array.isArray(this.mainEntryPoints) && this.mainEntryPoints.length > 0) {
      this.entryPoints = [...this.mainEntryPoints, ...this.entryPoints]
    }
  }

  /**
   * 符号解释阶段
   */
  symbolInterpret() {
    const { entryPoints } = this
    const state = this.initState(this.topScope)
    if (!entryPoints || entryPoints.length === 0) {
      logger.info('[symbolInterpret]：EntryPoints are not found')
      return true
    }
    const hasAnalysised: string[] = []
    for (const entryPoint of entryPoints) {
      this.symbolTable.clear()
      if (entryPoint.type === constValue.ENGIN_START_FUNCALL) {
        const key = `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?.qid}#${entryPoint.entryPointSymVal.ast.node.parameters}.${entryPoint.attribute}`
        if (hasAnalysised.includes(key)) {
          continue
        }
        hasAnalysised.push(key)
        EntryPointConfig.setCurrentEntryPoint(entryPoint)
        logger.info('EntryPoint [%s.%s] is executing', entryPoint.filePath, entryPoint.functionName)

        const argValues: any[] = []
        for (const param of entryPoint.entryPointSymVal?.ast?.node?.parameters || []) {
          argValues.push(this.processInstruction(entryPoint.entryPointSymVal, param, state))
        }

        // 在参数值创建后再触发 Before hook，避免 taint 被后续 processInstruction 覆盖
        this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)

        try {
          this.executeCall(
            entryPoint.entryPointSymVal?.ast?.node,
            entryPoint.entryPointSymVal,
            state,
            entryPoint.scopeVal,
            { callArgs: this.buildCallArgs(entryPoint.entryPointSymVal?.ast?.node, argValues, entryPoint.entryPointSymVal) }
          )
        } catch (e) {
          handleException(
            e,
            `[${entryPoint.entryPointSymVal?.ast?.node?.id?.name} symbolInterpret 失败`,
            `[${entryPoint.entryPointSymVal?.ast?.node?.id?.name} symbolInterpret failed`
          )
        }
        this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
      } else if (entryPoint.type === constValue.ENGIN_START_FILE_BEGIN) {
        const key = `fileBegin:${entryPoint.filePath}.${entryPoint.attribute}`
        if (hasAnalysised.includes(key)) {
          continue
        }
        hasAnalysised.push(key)
        EntryPointConfig.setCurrentEntryPoint(entryPoint)
        logger.info('EntryPoint [%s] is executing', entryPoint.filePath)
        if (entryPoint.entryPointSymVal && entryPoint.scopeVal) {
          try {
            this.processCompileUnit(
              entryPoint.scopeVal,
              entryPoint.entryPointSymVal?.ast?.node,
              this.initState(this.topScope)
            )
          } catch (e) {
            handleException(
              e,
              `[${entryPoint.entryPointSymVal?.ast?.node?.loc?.sourcefile} symbolInterpret 失败`,
              `[${entryPoint.entryPointSymVal?.ast?.node?.loc?.sourcefile} symbolInterpret failed`
            )
          }
        } else {
          const { filePath } = entryPoint
          entryPoint.entryPointSymVal = this.symbolTable.get(this.fileManager[filePath].uuid)
          entryPoint.scopeVal = this.symbolTable.get(this.fileManager[filePath].uuid)
          try {
            this.processCompileUnit(
              entryPoint.scopeVal,
              entryPoint.entryPointSymVal?.ast?.node,
              this.initState(this.topScope)
            )
          } catch (e) {
            handleException(
              e,
              `[${entryPoint.entryPointSymVal?.ast?.node?.loc?.sourcefile} symbolInterpret 失败`,
              `[${entryPoint.entryPointSymVal?.ast?.node?.loc?.sourcefile} symbolInterpret failed`
            )
          }
        }
      }
    }
    return true
  }

  /**
   * 从 ImportExpression 节点解析 PHP 文件路径
   * 处理 __DIR__ . '/file.php'、相对路径、绝对路径等
   */
  private resolvePhpImportPath(node: any): string | null {
    const fromNode = node.from || node
    const fromValue = fromNode?.value

    // 静态路径：from.value 直接是文件路径
    if (fromValue && fromValue !== '') {
      return fromValue
    }

    // 动态路径：__DIR__ . '/file.php' 等，parser 将其存在 _meta.dynamicFrom
    const dynamicFrom = fromNode?._meta?.dynamicFrom
    if (!dynamicFrom) return null

    // 获取当前文件路径用于解析 __DIR__
    let sourcefile: string | undefined
    let current = node
    const maxDepth = 50
    let depth = 0
    while (current && depth < maxDepth) {
      sourcefile = current.sourcefile || current.loc?.sourcefile
      if (sourcefile) break
      current = current.parent
      depth++
    }

    if (!sourcefile) return null

    // 递归求值动态路径表达式
    const evalPathExpr = (expr: any): string | null => {
      if (!expr) return null
      if (expr.type === 'Literal') {
        return expr.value != null ? String(expr.value) : null
      }
      if (expr.type === 'Identifier' && expr.name === '__DIR__') {
        return path.dirname(path.resolve(sourcefile!))
      }
      // BinaryExpression：PHP 的 '.' 字符串拼接被 UAST 映射为 '+'
      if (expr.type === 'BinaryExpression' && (expr.operator === '+' || expr.operator === '.')) {
        const left = evalPathExpr(expr.left)
        const right = evalPathExpr(expr.right)
        if (left != null && right != null) return left + right
        return null
      }
      // prettyPrint 兜底
      const printed = AstUtil.prettyPrint(expr)
      return printed || null
    }

    return evalPathExpr(dynamicFrom)
  }

  /**
   * PHP include/require 跨文件导入处理
   * PHP 的 include/require 语义 = 将文件内容粘贴到当前位置，所有顶层定义自动可用
   */
  processImportDirect(scope: any, node: any, state: any): any {
    const resolvedPath = this.resolvePhpImportPath(node)
    if (!resolvedPath) {
      return new UndefinedValue()
    }

    // 规范化为绝对路径
    let pathname = resolvedPath
    if (!path.isAbsolute(pathname)) {
      let sourcefile: string | undefined
      let current = node
      const maxDepth = 50
      let depth = 0
      while (current && depth < maxDepth) {
        sourcefile = current.sourcefile || current.loc?.sourcefile
        if (sourcefile) break
        current = current.parent
        depth++
      }
      if (sourcefile) {
        pathname = path.resolve(path.dirname(sourcefile.toString()), pathname)
      }
    }

    // 补全 .php 扩展名
    if (!pathname.endsWith('.php') && !fs.existsSync(pathname)) {
      const withExt = pathname + '.php'
      if (fs.existsSync(withExt)) {
        pathname = withExt
      }
    }

    if (!fs.existsSync(pathname) || !fs.statSync(pathname).isFile()) {
      return new UndefinedValue()
    }

    pathname = path.resolve(pathname)

    // 检查模块缓存
    const cached = this.topScope.context.modules.members.get(pathname)
    if (cached && typeof cached === 'object') {
      this.registerImportedDefinitions(scope, cached)
      return cached
    }

    // 未缓存：解析并处理目标文件
    try {
      const prog = FileUtil.loadAllFileText(pathname, ['php'])[0]
      if (prog) {
        this.sourceCodeCache.set(prog.file, prog.content.split(/\n/))
        const ast = Parser.parseSingleFile(prog.file, { ...this.options, sourcefile: prog.file }, this.sourceCodeCache)
        if (ast) {
          const moduleExports = this.processModule(ast, pathname)
          if (moduleExports) {
            this.registerImportedDefinitions(scope, moduleExports)
            return moduleExports
          }
        }
      }
    } catch (e) {
      handleException(
        e,
        `PhpAnalyzer.processImportDirect: 加载失败: ${pathname}`,
        `Error in PhpAnalyzer.processImportDirect: failed to loading: ${pathname}`
      )
    }

    return new UndefinedValue()
  }

  /**
   * 将被导入模块的顶层函数/类定义注册到当前 scope
   * PHP 的 include 语义：所有顶层定义直接在全局可用
   */
  private registerImportedDefinitions(currentScope: any, moduleExports: any): void {
    const targetModClos = moduleExports?.parent
    if (!targetModClos?.value) return

    let registerTarget = currentScope
    while (registerTarget && registerTarget.parent && registerTarget.parent !== this.topScope) {
      registerTarget = registerTarget.parent
    }
    if (!registerTarget || registerTarget === this.topScope) {
      registerTarget = currentScope
    }

    // PHP include/require 语义：类(class)、函数(fclos)、变量(scoped/object) 均直接可用
    const importableVtypes = new Set(['scoped', 'object', 'class', 'fclos'])

    for (const key of Object.keys(targetModClos.value)) {
      if (key === 'module' || key === 'exports') continue
      const val = targetModClos.value[key]
      if (!val) continue
      if (importableVtypes.has(val.vtype)) {
        registerTarget.value[key] = val
      }
    }

    if (targetModClos.members) {
      const entries: Array<[string, any]> = targetModClos.members instanceof Map
        ? Array.from(targetModClos.members.entries())
        : Object.entries(targetModClos.members)
      for (const [key, val] of entries) {
        if (!val || key === 'module' || key === 'exports') continue
        if (importableVtypes.has((val as any)?.vtype)) {
          if (registerTarget.members instanceof Map) {
            registerTarget.members.set(key, val)
          } else {
            registerTarget.value[key] = val
          }
        }
      }
    }
  }

  /**
   * 从任意 scope 向上查找模块顶层 scope（parent 为 topScope 的 scope）
   */
  private findModuleScope(scope: any): any {
    let current = scope
    while (current) {
      if (current.parent === this.topScope) return current
      current = current.parent
    }
    return null
  }

  /**
   * 从任意 scope 向上查找封闭的类定义 scope
   * 类 scope 的标识：ast.cdef 存在（ClassDefinition 节点）
   */
  private findEnclosingClassScope(scope: any): any {
    let current = scope
    while (current) {
      if (current.ast?.cdef) return current
      current = current.parent
    }
    // 兜底：检查 thisFClos 的 parent 链
    const thisFClos = this.thisFClos
    if (thisFClos) {
      let s = thisFClos
      while (s) {
        if (s.ast?.cdef) return s
        s = s.parent
      }
    }
    return null
  }

  /**
   * 从任意 scope 向上查找封闭的函数 scope
   * 函数 scope 的标识：ast.fdef 存在（FunctionDefinition 节点）
   */
  private findFunctionScope(scope: any): any {
    let current = scope
    while (current) {
      if (current.ast?.fdef) return current
      current = current.parent
    }
    return null
  }

  // ─── global / static 变量声明处理 ───

  /**
   * 处理变量声明：拦截 global 和 static 存储修饰符
   * - global: 将变量绑定到模块顶层 scope
   * - static: 从持久化 map 恢复跨调用保留的值
   */
  override processVariableDeclaration(scope: any, node: any, state: any): any {
    const storage = node._meta?.storage
    const varName = node.id?.type === 'Identifier' ? node.id.name : undefined

    // global $var：将模块顶层 scope 的同名变量绑定到当前函数 scope
    if (storage === 'global' && varName) {
      const modScope = this.findModuleScope(scope)
      if (modScope) {
        // 如果模块 scope 中已有值，绑定到当前 scope
        const existing = modScope.value?.[varName]
        if (existing !== undefined && existing !== null) {
          scope.value[varName] = existing
        }
        // 标记该变量为 global，后续赋值时同步回模块 scope
        if (!scope._globalVars) scope._globalVars = new Set<string>()
        scope._globalVars.add(varName)
      }
      return scope.value[varName] || new UndefinedValue()
    }

    // static $var：从持久化 map 恢复之前的值
    if (storage === 'static' && varName) {
      // 用函数 scope 的 qid 作为持久化 key
      const funcKey = scope.qid || scope.sid || '<anonymous>'
      let funcVars = this.staticVarMap.get(funcKey)
      if (!funcVars) {
        funcVars = new Map<string, any>()
        this.staticVarMap.set(funcKey, funcVars)
      }
      // 首次声明时执行基类逻辑初始化
      const initVal = super.processVariableDeclaration(scope, node, state)
      // 如果持久化 map 中有之前保存的值，覆盖当前值
      const savedVal = funcVars.get(varName)
      if (savedVal !== undefined) {
        scope.value[varName] = savedVal
        return savedVal
      }
      // 首次：将初始值存入持久化 map
      funcVars.set(varName, initVal)
      // 标记该变量为 static，后续赋值时同步到持久化 map
      if (!scope._staticVars) scope._staticVars = new Map<string, string>()
      scope._staticVars.set(varName, funcKey)
      return initVal
    }

    return super.processVariableDeclaration(scope, node, state)
  }

  /**
   * 在 scope 链中查找变量值，不触发 processInstruction 避免副作用
   */
  private lookupVariableInScope(scope: any, name: string): any {
    let searchScope = scope
    while (searchScope) {
      const val = searchScope.value?.[name]
      if (val !== undefined && val !== null) return val
      searchScope = searchScope.parent
    }
    return null
  }

  /**
   * PHP 变量函数解析：当 fclos 是字符串（函数名），在 scope 中查找对应的函数定义
   */
  private resolveVariableFunction(scope: any, fclosValue: string, state: any): any {
    // 在当前 scope 及其父 scope 中查找函数名
    let searchScope = scope
    while (searchScope) {
      const val = searchScope.value?.[fclosValue]
      if (val?.vtype === 'fclos' && val.ast?.fdef) {
        return val
      }
      searchScope = searchScope.parent
    }
    // 在 topScope 中查找
    const topVal = this.topScope?.value?.[fclosValue]
    if (topVal?.vtype === 'fclos' && topVal.ast?.fdef) {
      return topVal
    }
    return null
  }

  /**
   * 静态分析函数体是否只返回常量值（字面量字符串/数字/布尔/null）
   * @param isEnumMethod - 当方法属于 enum 时为 true，允许 $this->value 视为常量
   */
  private functionBodyReturnsOnlyConstants(fdef: any, isEnumMethod: boolean = false): boolean {
    if (!fdef?.body) return false
    const returnNodes: any[] = []
    this.collectReturnStatements(fdef.body, returnNodes)
    if (returnNodes.length === 0) return false
    return returnNodes.every((ret: any) => this.isConstantExpression(ret.argument, isEnumMethod))
  }

  /** 递归收集所有 ReturnStatement */
  private collectReturnStatements(node: any, results: any[]): void {
    if (!node) return
    if (Array.isArray(node)) {
      for (const child of node) {
        this.collectReturnStatements(child, results)
      }
      return
    }
    if (node.type === 'ReturnStatement') {
      results.push(node)
      return
    }
    // 不进入嵌套函数/类定义
    if (node.type === 'FunctionDefinition' || node.type === 'ClassDefinition') return
    // 遍历 body 和常见子节点
    if (node.body) this.collectReturnStatements(node.body, results)
    if (node.consequent) this.collectReturnStatements(node.consequent, results)
    if (node.alternative) this.collectReturnStatements(node.alternative, results)
    if (node.cases) {
      for (const c of node.cases) {
        this.collectReturnStatements(c.body, results)
      }
    }
  }

  /** 判断表达式是否为常量（字面量或字面量拼接） */
  private isConstantExpression(expr: any, isEnumMethod: boolean = false): boolean {
    if (!expr) return false
    if (expr.type === 'Literal') return true
    // 字符串拼接："safe_" . $this->value（PHP parser 将 . 转换为 UAST 的 +）
    if (expr.type === 'BinaryExpression' && (expr.operator === '.' || expr.operator === '+')) {
      return this.isConstantExpression(expr.left, isEnumMethod) && this.isConstantExpression(expr.right, isEnumMethod)
    }
    // enum 方法中的 $this->value 是 backing value，视为常量
    if (isEnumMethod && expr.type === 'MemberAccess' && (expr.object?.type === 'ThisExpression' || (expr.object?.type === 'Identifier' && expr.object.name === 'this'))) {
      return true
    }
    return false
  }

  /**
   * 检查 MemberAccess 调用的对象是否为 enum 类型
   * PHP enum 在 UAST 中表示为 ClassDefinition，_meta.kind === 'enum'
   */
  private isCalleeObjectEnum(scope: any, node: any, state: any): boolean {
    if (node.callee?.type !== 'MemberAccess') return false
    const objectVal = this.processInstruction(scope, node.callee.object, state)
    if (!objectVal) return false
    // 检查对象自身或父 scope 的 class 定义的 _meta.kind
    if (objectVal.ast?.cdef?._meta?.kind === 'enum') return true
    if (objectVal.parent?.ast?.cdef?._meta?.kind === 'enum') return true
    if (objectVal.ast?.fdef?._meta?.kind === 'enum') return true
    // 通过标识符查找类定义
    const objectName = node.callee.object?.name || node.callee.object?.object?.name
    if (objectName) {
      let searchScope = scope
      while (searchScope) {
        const val = searchScope.value?.[objectName]
        if (val?.ast?.cdef?._meta?.kind === 'enum' || val?.ast?.fdef?._meta?.kind === 'enum') return true
        searchScope = searchScope.parent
      }
    }
    return false
  }

  /**
   * 无副作用地查找方法定义和 enum 标记
   * 不调用 processInstruction，只通过 scope 链静态查找
   */
  private findMethodDefStatic(scope: any, node: any): { fdef: any; isEnum: boolean } | null {
    if (node.callee?.type !== 'MemberAccess') return null
    const memberName = node.callee.member?.name || node.callee.member?.value || node.callee.property?.name || node.callee.property?.value
    if (!memberName) return null

    // 从 callee.object 的 AST 名称查找对象变量
    const objectName = node.callee.object?.name || node.callee.object?.object?.name
    if (!objectName) return null

    // 先在 scope 中查找对象变量值
    const objectVal = this.lookupVariableInScope(scope, objectName)
    if (objectVal) {
      // 在对象 scope 中查找方法
      const method = objectVal.value?.[memberName]
      if (method?.ast?.fdef?.type === 'FunctionDefinition') {
        const isEnum = objectVal.ast?.cdef?._meta?.kind === 'enum' || objectVal.ast?.fdef?._meta?.kind === 'enum'
        return { fdef: method.ast.fdef, isEnum }
      }

      // 在类定义 AST body 中查找方法
      const cdefBody = objectVal.ast?.cdef?.body || objectVal.ast?.fdef?.body
      if (cdefBody) {
        const isEnum = objectVal.ast?.cdef?._meta?.kind === 'enum' || objectVal.ast?.fdef?._meta?.kind === 'enum'
        const body = Array.isArray(cdefBody) ? cdefBody : cdefBody?.body
        if (body) {
          for (const member of body) {
            if (member.type === 'FunctionDefinition' && member.id?.name === memberName) {
              return { fdef: member, isEnum }
            }
          }
        }
      }

      // 对象的父 scope（类成员/enum 值）
      if (objectVal.parent?.ast?.cdef?.body) {
        const isEnum = objectVal.parent.ast.cdef._meta?.kind === 'enum'
        const body = Array.isArray(objectVal.parent.ast.cdef.body) ? objectVal.parent.ast.cdef.body : objectVal.parent.ast.cdef.body?.body
        if (body) {
          for (const member of body) {
            if (member.type === 'FunctionDefinition' && member.id?.name === memberName) {
              return { fdef: member, isEnum: !!isEnum }
            }
          }
        }
      }
    }

    // 在 scope 链中查找类定义（按变量名查找）
    const classDef = this.findClassDef(scope, objectName)
    if (classDef) {
      let isEnum = false
      let searchScope = scope
      while (searchScope) {
        const val = searchScope.value?.[objectName]
        if (val?.ast?.cdef?._meta?.kind === 'enum' || val?.ast?.fdef?._meta?.kind === 'enum') {
          isEnum = true
          break
        }
        searchScope = searchScope.parent
      }
      const body = Array.isArray(classDef) ? classDef : classDef?.body
      if (body) {
        const bodyArr = Array.isArray(body) ? body : body?.body
        if (bodyArr) {
          for (const member of bodyArr) {
            if (member.type === 'FunctionDefinition' && member.id?.name === memberName) {
              return { fdef: member, isEnum }
            }
          }
        }
      }
    }

    // 兜底：在所有类/enum 定义中搜索同名方法
    // 用于变量名与类名不同的场景（如 $color = Color::Red; $color->label()）
    const methodFromAll = this.findMethodInAllClassesWithEnum(scope, memberName)
    if (methodFromAll) return methodFromAll

    return null
  }

  /**
   * 在 scope 链中查找函数定义的 AST（fdef），用于返回值常量分析
   */
  private findFunctionDef(scope: any, funcName: string): any {
    let searchScope = scope
    while (searchScope) {
      const val = searchScope.value?.[funcName]
      if (val?.ast?.fdef?.type === 'FunctionDefinition') {
        return val.ast.fdef
      }
      searchScope = searchScope.parent
    }
    const topVal = this.topScope?.value?.[funcName]
    if (topVal?.ast?.fdef?.type === 'FunctionDefinition') {
      return topVal.ast.fdef
    }
    // 跨文件兜底：在所有模块 scope 中查找函数定义
    for (const [, modClos] of this.moduleScopes) {
      const val = modClos.value?.[funcName]
      if (val?.ast?.fdef?.type === 'FunctionDefinition') {
        return val.ast.fdef
      }
    }
    return null
  }

  /**
   * 从 MemberAccess 调用中查找方法的 fdef，支持对象方法、静态方法、enum 方法
   */
  private findMethodDef(scope: any, node: any, state: any): any {
    if (node.callee?.type !== 'MemberAccess') return null
    const memberName = node.callee.member?.name || node.callee.member?.value || node.callee.property?.name || node.callee.property?.value
    if (!memberName) return null

    // 尝试解析对象以获取类定义
    const objectVal = this.processInstruction(scope, node.callee.object, state)
    if (!objectVal) return null

    // 在对象 scope 中查找方法
    const method = objectVal.value?.[memberName]
    if (method?.ast?.fdef?.type === 'FunctionDefinition') {
      return method.ast.fdef
    }

    // 在类定义 AST body 中查找方法
    const classBody = objectVal.ast?.cdef?.body || objectVal.ast?.fdef?.body
    if (classBody) {
      const body = Array.isArray(classBody) ? classBody : classBody?.body
      if (body) {
        for (const member of body) {
          if (member.type === 'FunctionDefinition' && member.id?.name === memberName) {
            return member
          }
        }
      }
    }

    // 对象是 enum 值或类成员，通过父 scope 查找类定义
    if (objectVal.parent?.ast?.cdef?.body) {
      const body = Array.isArray(objectVal.parent.ast.cdef.body) ? objectVal.parent.ast.cdef.body : objectVal.parent.ast.cdef.body?.body
      if (body) {
        for (const member of body) {
          if (member.type === 'FunctionDefinition' && member.id?.name === memberName) {
            return member
          }
        }
      }
    }

    // 通过原始标识符名在 scope 中查找类定义（如 Color::Red → Color 是类）
    const objectName = node.callee.object?.name || node.callee.object?.object?.name
    if (objectName) {
      const classDef = this.findClassDef(scope, objectName)
      if (classDef) {
        const body = Array.isArray(classDef) ? classDef : classDef?.body
        if (body) {
          const bodyArr = Array.isArray(body) ? body : body?.body
          if (bodyArr) {
            for (const member of bodyArr) {
              if (member.type === 'FunctionDefinition' && member.id?.name === memberName) {
                return member
              }
            }
          }
        }
      }
    }

    // 兜底：在所有 scope 中扫描全部类/enum 定义，查找匹配的方法
    const methodFromAll = this.findMethodInAllClasses(scope, memberName)
    if (methodFromAll) return methodFromAll

    return null
  }

  /**
   * 在 scope 链的所有类/enum 定义中查找匹配的方法 fdef
   * 用于 enum 值丢失类上下文后的兜底查找
   * 保守策略：当存在多个同名方法定义时，全部返回常量才认为安全
   */
  private findMethodInAllClasses(scope: any, methodName: string): any {
    const allMatches: any[] = []
    let searchScope = scope
    while (searchScope) {
      if (searchScope.value) {
        for (const key of Object.keys(searchScope.value)) {
          const val = searchScope.value[key]
          // 检查类定义的 cdef body
          const cdefBody = val?.ast?.cdef?.body
          if (cdefBody) {
            const body = Array.isArray(cdefBody) ? cdefBody : cdefBody?.body
            if (body) {
              for (const member of body) {
                if (member.type === 'FunctionDefinition' && member.id?.name === methodName) {
                  allMatches.push(member)
                }
              }
            }
          }
        }
      }
      searchScope = searchScope.parent
    }
    // 跨文件兜底：在所有模块 scope 中查找类定义的方法
    for (const [, modClos] of this.moduleScopes) {
      if (modClos.value) {
        for (const key of Object.keys(modClos.value)) {
          const val = modClos.value[key]
          const cdefBody = val?.ast?.cdef?.body
          if (cdefBody) {
            const body = Array.isArray(cdefBody) ? cdefBody : cdefBody?.body
            if (body) {
              for (const member of body) {
                if (member.type === 'FunctionDefinition' && member.id?.name === methodName) {
                  allMatches.push(member)
                }
              }
            }
          }
        }
      }
    }
    // 无匹配
    if (allMatches.length === 0) return null
    // 仅有一个匹配，直接返回
    if (allMatches.length === 1) return allMatches[0]
    // 多个匹配：只有全部返回常量时才安全（返回第一个供常量分析检查）
    const allConstant = allMatches.every((m: any) => this.functionBodyReturnsOnlyConstants(m))
    return allConstant ? allMatches[0] : null
  }

  /**
   * 在所有类/enum 定义中查找方法，返回 { fdef, isEnum }
   * 保守策略：仅在所有同名方法都返回常量时才返回结果
   */
  private findMethodInAllClassesWithEnum(scope: any, methodName: string): { fdef: any; isEnum: boolean } | null {
    const allMatches: Array<{ fdef: any; isEnum: boolean }> = []
    let searchScope = scope
    while (searchScope) {
      if (searchScope.value) {
        for (const key of Object.keys(searchScope.value)) {
          const val = searchScope.value[key]
          const cdefBody = val?.ast?.cdef?.body
          if (cdefBody) {
            const isEnum = val.ast.cdef._meta?.kind === 'enum'
            const body = Array.isArray(cdefBody) ? cdefBody : cdefBody?.body
            if (body) {
              for (const member of body) {
                if (member.type === 'FunctionDefinition' && member.id?.name === methodName) {
                  allMatches.push({ fdef: member, isEnum: !!isEnum })
                }
              }
            }
          }
        }
      }
      searchScope = searchScope.parent
    }
    // 跨文件兜底：在所有模块 scope 中查找类/enum 定义的方法
    for (const [, modClos] of this.moduleScopes) {
      if (modClos.value) {
        for (const key of Object.keys(modClos.value)) {
          const val = modClos.value[key]
          const cdefBody = val?.ast?.cdef?.body
          if (cdefBody) {
            const isEnum = val.ast.cdef._meta?.kind === 'enum'
            const body = Array.isArray(cdefBody) ? cdefBody : cdefBody?.body
            if (body) {
              for (const member of body) {
                if (member.type === 'FunctionDefinition' && member.id?.name === methodName) {
                  allMatches.push({ fdef: member, isEnum: !!isEnum })
                }
              }
            }
          }
        }
      }
    }
    if (allMatches.length === 0) return null
    if (allMatches.length === 1) return allMatches[0]
    // 多个匹配：仅当所有方法体都返回常量时才认为安全
    const allConstant = allMatches.every((m) => this.functionBodyReturnsOnlyConstants(m.fdef, m.isEnum))
    return allConstant ? allMatches[0] : null
  }

  /**
   * 在 scope 链中查找类的 AST body
   */
  private findClassDef(scope: any, className: string): any {
    let searchScope = scope
    while (searchScope) {
      const val = searchScope.value?.[className]
      if (val?.ast?.cdef?.body) {
        return val.ast.cdef.body
      }
      if (val?.ast?.fdef?.type === 'ClassDefinition' && val.ast.fdef.body) {
        return val.ast.fdef.body
      }
      searchScope = searchScope.parent
    }
    const topVal = this.topScope?.value?.[className]
    if (topVal?.ast?.cdef?.body) {
      return topVal.ast.cdef.body
    }
    // 跨文件兜底：在所有模块 scope 中查找类定义
    for (const [, modClos] of this.moduleScopes) {
      const val = modClos.value?.[className]
      if (val?.ast?.cdef?.body) {
        return val.ast.cdef.body
      }
      if (val?.ast?.fdef?.type === 'ClassDefinition' && val.ast.fdef.body) {
        return val.ast.fdef.body
      }
    }
    return null
  }

  /**
   * PHP 跨文件类名解析：new ClassName() 时先在当前 scope 查找，找不到则搜索 moduleScopes
   * 模拟 PHP autoload 机制——项目内所有类定义在分析阶段全局可见
   */
  override processNewExpression(scope: any, node: any, state: any) {
    const className = node.callee?.name
    if (className && node.callee?.type === 'Identifier') {
      const existing = this.processInstruction(scope, node.callee, state)
      const isUnresolved = !existing || existing.vtype === 'undefine' || existing.vtype === 'symbol'
        || existing.vtype === 'uninitialized'
      if (isUnresolved) {
        for (const [, modClos] of this.moduleScopes) {
          const val = modClos.value?.[className]
          if (val?.vtype === 'class' && val.ast?.cdef) {
            // 将跨文件类定义注册到当前 scope，后续 base.processNewObject 可直接找到
            let registerScope = scope
            while (registerScope.parent && registerScope.parent !== this.topScope) {
              registerScope = registerScope.parent
            }
            registerScope.value[className] = val
            break
          }
        }
      }
    }
    return super.processNewExpression(scope, node, state)
  }

  /**
   * 处理调用表达式：增强基类逻辑，支持 PHP 变量函数、call_user_func、array_map、返回值常量分析
   * 核心原则：特殊 case 单独处理，其余调用委托给 super.processCallExpression 保持完整的污点传播
   */
  override processCallExpression(scope: any, node: any, state: any) {
    try {
      const calleeName = node.callee?.name

      // --- (string) 类型转换：调用 __toString 魔术方法 ---
      // 基类已处理数值类型转换，这里只增强 string 转换
      if (node._meta?.isCast && calleeName === 'string' && node.arguments.length > 0) {
        const objVal = this.processInstruction(scope, node.arguments[0], state)
        if (objVal && objVal.value) {
          const toStringMethod = objVal.value['__toString']
          if (toStringMethod?.vtype === 'fclos' && toStringMethod.ast?.fdef) {
            const callInfo = { callArgs: this.buildCallArgs(node, [], toStringMethod) }
            toStringMethod._this = objVal
            return this.executeCall(node, toStringMethod, state, scope, callInfo)
          }
        }
        return objVal
      }

      // --- first-class callable 语法：func(...) 返回函数引用 ---
      // AST 特征：CallExpression 参数列表仅包含一个 Noop 节点
      if (node.arguments.length === 1 && node.arguments[0]?.type === 'Noop' && calleeName) {
        const fclos = this.resolveVariableFunction(scope, calleeName, state)
        if (fclos) return fclos
      }

      // --- call_user_func / call_user_func_array 特殊处理 ---
      if (calleeName === 'call_user_func' || calleeName === 'call_user_func_array') {
        if (node.arguments.length > 0) {
          const firstArg = this.processInstruction(scope, node.arguments[0], state)
          let targetFclos: any = null
          if (firstArg?.vtype === 'primitive' && typeof firstArg.value === 'string') {
            targetFclos = this.resolveVariableFunction(scope, firstArg.value, state)
          }
          if (firstArg?.vtype === 'fclos') {
            targetFclos = firstArg
          }
          if (targetFclos) {
            const restArgs = node.arguments.slice(1)
            const argvalues: any[] = []
            for (const arg of restArgs) {
              const argv = this.processInstruction(scope, arg, state)
              if (Array.isArray(argv)) {
                argvalues.push(...argv)
              } else {
                argvalues.push(argv)
              }
            }
            const callInfo = { callArgs: this.buildCallArgs(node, argvalues, targetFclos) }
            const res = this.executeCall(node, targetFclos, state, scope, callInfo)
            if (res && this.checkerManager?.checkAtFunctionCallAfter) {
              this.checkerManager.checkAtFunctionCallAfter(this, scope, node, state, {
                callInfo,
                fclos: targetFclos,
                ret: res,
                pcond: state.pcond,
                einfo: state.einfo,
                callstack: state.callstack,
              })
            }
            return res
          }
        }
      }

      // --- array_map 特殊处理：调用回调并使用返回值 ---
      if (calleeName === 'array_map' && node.arguments.length >= 2) {
        const callbackArg = node.arguments[0]
        const arrayArg = node.arguments[1]
        const callbackVal = this.processInstruction(scope, callbackArg, state)
        const arrayVal = this.processInstruction(scope, arrayArg, state)

        let resolvedCallback: any = null
        if (callbackVal?.vtype === 'fclos' && callbackVal.ast?.fdef) {
          resolvedCallback = callbackVal
        } else if (callbackVal?.vtype === 'primitive' && typeof callbackVal.value === 'string') {
          resolvedCallback = this.resolveVariableFunction(scope, callbackVal.value, state)
        }
        if (resolvedCallback) {
          const dummyArgs = [arrayVal]
          const callInfo = { callArgs: this.buildCallArgs(callbackArg, dummyArgs, resolvedCallback) }
          const cbResult = this.executeCall(callbackArg, resolvedCallback, state, scope, callInfo)
          const resultObj = new ObjectValue(scope.qid, { sid: '<array_map_result>' })
          resultObj.value['0'] = cbResult
          return resultObj
        }
      }

      // --- PHP 变量函数解析 ---
      // 不调用 processInstruction，直接在 scope 中查找变量值，避免副作用
      if (node.callee?.type === 'Identifier' && calleeName) {
        const varVal = this.lookupVariableInScope(scope, calleeName)
        if (varVal?.vtype === 'primitive' && typeof varVal.value === 'string') {
          const realFclos = this.resolveVariableFunction(scope, varVal.value, state)
          if (realFclos?.ast?.fdef) {
            // 触发基类的 checkAtFuncCallSyntax
            if (this.checkerManager?.checkAtFuncCallSyntax) {
              this.checkerManager.checkAtFuncCallSyntax(this, scope, node, state, {
                pcond: state.pcond,
                einfo: state.einfo,
              })
            }
            // 处理参数
            let argvalues: any[] = []
            let same_args = true
            for (const arg of node.arguments) {
              let argv = this.processInstruction(scope, arg, state)
              if (arg.type === 'FunctionDefinition' && !realFclos.runtime?.execute) {
                const funcDef = arg
                if (funcDef.name?.includes('<anonymous')) {
                  argv = this.processAndCallFuncDef(scope, funcDef, argv, state)
                }
              }
              if (argv !== arg) same_args = false
              if (Array.isArray(argv)) {
                argvalues.push(...argv)
              } else {
                argvalues.push(argv)
              }
            }
            if (same_args) argvalues = node.arguments
            // 执行调用
            const callInfo = { callArgs: this.buildCallArgs(node, argvalues, realFclos) }
            const res = this.executeCall(node, realFclos, state, scope, callInfo)
            // 触发 checkAtFunctionCallAfter
            if (res && this.checkerManager?.checkAtFunctionCallAfter) {
              this.checkerManager.checkAtFunctionCallAfter(this, scope, node, state, {
                callInfo,
                fclos: realFclos,
                ret: res,
                pcond: state.pcond,
                einfo: state.einfo,
                callstack: state.callstack,
              })
            }
            // 变量函数的返回值常量分析
            if (res?.taint?.isTaintedRec) {
              const fdef = realFclos.ast?.fdef
              if (fdef && this.functionBodyReturnsOnlyConstants(fdef)) {
                return new PrimitiveValue(scope.qid, '<constant_return>', 'constant', null, 'Literal', node.loc)
              }
            }
            return res
          }
        }
      }

      // --- __invoke 魔术方法：$obj() 调用调度到 __invoke ---
      if (node.callee?.type === 'Identifier' && calleeName) {
        const objVal = this.lookupVariableInScope(scope, calleeName)
        if (objVal && objVal.vtype !== 'fclos' && objVal.vtype !== 'primitive' && objVal.value) {
          const invokeMethod = objVal.value['__invoke']
          if (invokeMethod?.vtype === 'fclos' && invokeMethod.ast?.fdef) {
            const argvalues: any[] = []
            for (const arg of node.arguments) {
              argvalues.push(this.processInstruction(scope, arg, state))
            }
            const callInfo = { callArgs: this.buildCallArgs(node, argvalues, invokeMethod) }
            invokeMethod._this = objVal
            return this.executeCall(node, invokeMethod, state, scope, callInfo)
          }
        }
      }

      // --- array_push：将值添加到数组并修改原始引用 ---
      if (calleeName === 'array_push' && node.arguments.length >= 2) {
        const arrVal = this.processInstruction(scope, node.arguments[0], state)
        for (let i = 1; i < node.arguments.length; i++) {
          const elemVal = this.processInstruction(scope, node.arguments[i], state)
          if (arrVal && arrVal.vtype === 'object' && arrVal.value) {
            // 找到下一个数字索引
            let nextIdx = 0
            for (const k of Object.keys(arrVal.value)) {
              const n = parseInt(k, 10)
              if (!isNaN(n) && n >= nextIdx) nextIdx = n + 1
            }
            arrVal.value[String(nextIdx)] = elemVal
            // 传播污点
            if (elemVal?.taint?.isTaintedRec && arrVal.taint) {
              arrVal.taint.propagateFrom(elemVal)
            }
          }
        }
        return arrVal
      }

      // --- array_pop：从数组末尾取出值 ---
      if (calleeName === 'array_pop' && node.arguments.length >= 1) {
        const arrVal = this.processInstruction(scope, node.arguments[0], state)
        if (arrVal && arrVal.vtype === 'object' && arrVal.value) {
          // 找到最大数字索引的值
          let maxIdx = -1
          for (const k of Object.keys(arrVal.value)) {
            const n = parseInt(k, 10)
            if (!isNaN(n) && n > maxIdx) maxIdx = n
          }
          if (maxIdx >= 0) {
            const popped = arrVal.value[String(maxIdx)]
            delete arrVal.value[String(maxIdx)]
            if (popped) return popped
          }
          // 兜底：返回数组本身的污点状态
          return arrVal
        }
      }

      // --- static::method() 后期静态绑定：将 static 解析为实际调用类 ---
      if (node.callee?.type === 'MemberAccess' && node.callee.object?.name === 'static'
          && node.callee._meta?.isStatic) {
        const methodName = node.callee.property?.name
        if (methodName) {
          // thisFClos 在静态方法继承调用时指向实际调用类（如 TaintedProvider::process() 中 thisFClos = TaintedProvider）
          const lateStaticClass = this.thisFClos?.ast?.cdef ? this.thisFClos : this.findEnclosingClassScope(scope)
          if (lateStaticClass) {
            const method = lateStaticClass.value?.[methodName]
            if (method?.vtype === 'fclos' && method.ast?.fdef) {
              const argvalues: any[] = []
              for (const arg of node.arguments) {
                argvalues.push(this.processInstruction(scope, arg, state))
              }
              const callInfo = { callArgs: this.buildCallArgs(node, argvalues, method) }
              return this.executeCall(node, method, state, scope, callInfo)
            }
          }
        }
      }

      // --- 非特殊调用：委托给基类 ---
      // 包含完整的 checkAtFuncCallSyntax、参数处理、executeCall、checkAtFunctionCallAfter

      // 引用传参绑定：建立 by-ref 参数到调用方变量的映射
      const savedByRefBindings = this._byRefBindings
      this._byRefBindings = []
      if (node.callee?.type === 'Identifier' && calleeName && node.arguments?.length > 0) {
        const fdef = this.findFunctionDef(scope, calleeName)
        if (fdef?.parameters) {
          for (let i = 0; i < fdef.parameters.length && i < node.arguments.length; i++) {
            const param = fdef.parameters[i]
            if (param._meta?.byref && node.arguments[i]?.type === 'Identifier') {
              this._byRefBindings.push({
                paramName: param.id?.name || param.name,
                callerArgNode: node.arguments[i],
                callerScope: scope,
              })
            }
          }
        }
      }

      const res = super.processCallExpression(scope, node, state)
      this._byRefBindings = savedByRefBindings

      // --- 返回值常量分析（post-check）---
      // 如果调用结果被污染，但函数体只返回字面量常量，则切断污点
      if (res?.taint?.isTaintedRec) {
        if (node.callee?.type === 'MemberAccess') {
          // 方法调用：通过 scope 静态查找方法定义，无 processInstruction 副作用
          const methodInfo = this.findMethodDefStatic(scope, node)
          if (methodInfo?.fdef && this.functionBodyReturnsOnlyConstants(methodInfo.fdef, methodInfo.isEnum)) {
            return new PrimitiveValue(scope.qid, '<constant_return>', 'constant', null, 'Literal', node.loc)
          }
          // __call 魔术方法回退：方法未找到时，检查对象的 __call 方法
          if (!methodInfo) {
            const objVal = this.lookupVariableInScope(scope, node.callee.object?.name || '')
            const callMethod = objVal?.value?.['__call']
            if (callMethod?.ast?.fdef && this.functionBodyReturnsOnlyConstants(callMethod.ast.fdef)) {
              return new PrimitiveValue(scope.qid, '<constant_return>', 'constant', null, 'Literal', node.loc)
            }
          }
        } else if (node.callee?.type === 'Identifier' && calleeName) {
          // 普通函数调用：在 scope 中查找函数定义
          const fdef = this.findFunctionDef(scope, calleeName)
          if (fdef && this.functionBodyReturnsOnlyConstants(fdef)) {
            return new PrimitiveValue(scope.qid, '<constant_return>', 'constant', null, 'Literal', node.loc)
          }
        }
      }

      return res
    } catch (e) {
      return new UndefinedValue()
    }
  }

  // ─── PHP 魔术方法支持 + $_SERVER 白名单 ───

  /** $_SERVER 安全字段：值由服务器控制，不可被用户注入 */
  private static readonly SERVER_SAFE_FIELDS = new Set([
    'REQUEST_METHOD', 'SERVER_NAME', 'SERVER_PORT', 'SERVER_PROTOCOL',
    'SERVER_SOFTWARE', 'SERVER_ADDR', 'DOCUMENT_ROOT', 'SCRIPT_FILENAME',
    'SCRIPT_NAME', 'PHP_SELF', 'GATEWAY_INTERFACE', 'REQUEST_TIME',
    'REQUEST_TIME_FLOAT', 'HTTPS', 'REMOTE_PORT', 'SERVER_ADMIN',
  ])

  /**
   * 属性读取：$_SERVER 安全字段白名单 + __get 魔术方法
   */
  override processMemberAccess(scope: any, node: any, state: any): any {
    // $_SERVER 安全字段白名单
    const objectName = node.object?.name
    if (objectName === '_SERVER' && node.computed) {
      const fieldName = node.property?.value || node.property?.name
      if (fieldName && PhpAnalyzer.SERVER_SAFE_FIELDS.has(fieldName)) {
        return new PrimitiveValue(scope.qid, `<$_SERVER_${fieldName}>`, fieldName, null, 'Literal', node.loc)
      }
    }

    // $GLOBALS['key'] 读取：从全局共享存储获取值
    if (objectName === 'GLOBALS' && node.computed) {
      const key = node.property?.value ?? node.property?.name
      if (key !== undefined && key !== null) {
        const val = this.globalsMap.get(String(key))
        if (val !== undefined && val !== null) return val
        // 兜底：从模块顶层 scope 查找
        const modScope = this.findModuleScope(scope)
        if (modScope) {
          const modVal = modScope.value?.[String(key)]
          if (modVal !== undefined && modVal !== null) return modVal
        }
      }
    }

    // self::$prop 读取：从类定义 scope 获取静态属性值
    if (objectName === 'self' && node._meta?.isStatic) {
      const propName = node.property?.name || node.property?.value
      if (propName) {
        const classScope = this.findEnclosingClassScope(scope)
        if (classScope) {
          const val = classScope.value?.[propName]
          if (val !== undefined && val !== null) return val
        }
      }
    }

    const defscope = this.processInstruction(scope, node.object, state)
    const prop = node.property
    let resolved_prop = prop
    if (node.computed) {
      resolved_prop = this.processInstruction(scope, prop, state)
    } else {
      if (prop.type !== 'Identifier' && prop.type !== 'Literal') {
        resolved_prop = this.processInstruction(scope, prop, state)
      }
    }
    const res = this.getMemberValue(defscope, resolved_prop, state)

    // 数组索引精度：如果计算属性访问得到了从父对象传播的污点，
    // 检查原始索引值是否为未污染的原始值（如字面量 "safe"）
    if (node.computed && res?.taint?.isTaintedRec && defscope?.vtype === 'object') {
      const indexKey = resolved_prop?.value ?? resolved_prop?.name
      if (indexKey !== undefined && indexKey !== null) {
        const rawVal = defscope._members?.get(String(indexKey))
        if (rawVal && rawVal.vtype === 'primitive' && !rawVal.taint?.isTaintedRec) {
          return rawVal
        }
      }
    }

    // __get 魔术方法：属性不存在时调用
    if (defscope?.value && (res.vtype === 'undefine' || res.vtype === 'uninitialized' || res.vtype === 'symbol')) {
      const getMethod = defscope.value['__get']
      if (getMethod?.vtype === 'fclos' && getMethod.ast?.fdef) {
        const propName = resolved_prop?.name || resolved_prop?.value || ''
        const propArg = new PrimitiveValue(scope.qid, propName, propName, null, 'Literal', node.loc)
        const callInfo = { callArgs: this.buildCallArgs(node, [propArg], getMethod) }
        getMethod._this = defscope
        const magicResult = this.executeCall(node, getMethod, state, scope, callInfo)
        if (magicResult) {
          if (node.object.type !== 'SuperExpression') {
            magicResult._this = defscope
          }
          return magicResult
        }
      }
    }

    if (node.object.type !== 'SuperExpression' && (res.vtype !== 'union' || !Array.isArray(res.value))) {
      res._this = defscope
    }
    if (this.checkerManager && this.checkerManager.checkAtMemberAccess) {
      this.checkerManager.checkAtMemberAccess(this, defscope, node, state, { res })
    }
    return res
  }

  /**
   * 赋值：global/static 同步 + $GLOBALS 写入 + self:: 静态属性 + TupleExpression 解构 + __set 魔术方法
   */
  override processAssignmentExpression(scope: any, node: any, state: any): any {
    // --- 引用赋值 $b = &$a：建立别名关系 ---
    if (node.operator === '=' && node._meta?.byref
        && node.left?.type === 'Identifier' && node.right?.type === 'Identifier') {
      const leftName = node.left.name
      const rightName = node.right.name
      // 在函数作用域上记录双向别名
      const funcScope = this.findFunctionScope(scope)
      if (funcScope) {
        if (!funcScope._refAliases) funcScope._refAliases = new Map<string, Set<string>>()
        if (!funcScope._refAliases.has(leftName)) funcScope._refAliases.set(leftName, new Set<string>())
        if (!funcScope._refAliases.has(rightName)) funcScope._refAliases.set(rightName, new Set<string>())
        funcScope._refAliases.get(leftName)!.add(rightName)
        funcScope._refAliases.get(rightName)!.add(leftName)
      }
    }

    // --- $GLOBALS['key'] = expr：写入全局共享存储 + 模块顶层 scope ---
    if (node.left?.type === 'MemberAccess' && node.left.object?.name === 'GLOBALS' && node.left.computed) {
      const keyNode = node.left.property
      const key = keyNode?.value ?? keyNode?.name
      if (key !== undefined && key !== null) {
        const rhs = this.processInstruction(scope, node.right, state)
        this.globalsMap.set(String(key), rhs)
        const modScope = this.findModuleScope(scope)
        if (modScope) {
          modScope.value[String(key)] = rhs
        }
        return rhs
      }
    }

    // --- self::$prop = expr：写入类定义 scope 的静态属性 ---
    if (node.left?.type === 'MemberAccess' && node.left.object?.name === 'self' && node.left._meta?.isStatic) {
      const propName = node.left.property?.name || node.left.property?.value
      if (propName) {
        const rhs = this.processInstruction(scope, node.right, state)
        // 查找封闭类的 scope（thisFClos 在类方法执行时指向类 scope）
        const classScope = this.findEnclosingClassScope(scope)
        if (classScope) {
          classScope.value[propName] = rhs
        }
        return rhs
      }
    }

    // 检查是否是对象属性赋值：$obj->prop = $value
    if (node.left?.type === 'MemberAccess') {
      const defscope = this.processInstruction(scope, node.left.object, state)
      if (defscope?.value) {
        const setMethod = defscope.value['__set']
        if (setMethod?.vtype === 'fclos' && setMethod.ast?.fdef) {
          const rhs = this.processInstruction(scope, node.right, state)
          const propName = node.left.property?.name || node.left.property?.value || ''
          const propArg = new PrimitiveValue(scope.qid, propName, propName, null, 'Literal', node.loc)
          const callInfo = { callArgs: this.buildCallArgs(node, [propArg, rhs], setMethod) }
          setMethod._this = defscope
          this.executeCall(node, setMethod, state, scope, callInfo)
          return rhs
        }
      }
    }

    // TupleExpression 解构：从 ObjectValue 中按数字索引提取元素，避免整体污点扩散
    if (node.operator === '=' && node.left?.type === 'TupleExpression') {
      const tmpVal = this.processInstruction(scope, node.right, state)
      const oldVal = this.processInstruction(scope, node.left, state)
      const hasNumericKeys = tmpVal && tmpVal.vtype === 'object' && tmpVal.value
      for (let k = 0; k < node.left.elements.length; k++) {
        const x = node.left.elements[k]
        if (!x) continue
        const xName = x.type === 'Identifier' ? x.name : undefined
        if (xName === '_') continue

        let val: any
        if (tmpVal && tmpVal.type === 'TupleExpression') {
          val = tmpVal.elements[k]
        } else if (hasNumericKeys) {
          // 从 ObjectValue 中按数字索引提取，实现 field-sensitive 解构
          const indexed = tmpVal.value[String(k)]
          val = indexed || tmpVal
          // 嵌套 TupleExpression（如 [[$a,$b], $rest] = $arr）：递归处理
          if (x.type === 'TupleExpression' && indexed && indexed.vtype === 'object') {
            for (let j = 0; j < x.elements.length; j++) {
              const innerElem = x.elements[j]
              if (!innerElem) continue
              const innerName = innerElem.type === 'Identifier' ? innerElem.name : undefined
              if (innerName === '_') continue
              const innerVal = indexed.value[String(j)] || indexed
              this.saveVarInScope(scope, innerElem, innerVal, state, null)
              if (this.checkerManager?.checkAtAssignment) {
                const lscope = this.getDefScope(scope, innerElem)
                this.checkerManager.checkAtAssignment(this, scope, node, state, {
                  lscope,
                  lvalue: oldVal,
                  rvalue: innerVal,
                  pcond: state.pcond,
                  binfo: state.binfo,
                  entry_fclos: this.entry_fclos,
                  einfo: state.einfo,
                  state,
                })
              }
            }
            continue
          }
        } else {
          val = tmpVal
        }
        const oldV = oldVal && oldVal.type === 'TupleExpression' ? oldVal.elements[k] : oldVal
        this.saveVarInScope(scope, x, val, state, oldV)
        if (this.checkerManager?.checkAtAssignment) {
          const lscope = this.getDefScope(scope, x)
          this.checkerManager.checkAtAssignment(this, scope, node, state, {
            lscope,
            lvalue: oldVal,
            rvalue: val,
            pcond: state.pcond,
            binfo: state.binfo,
            entry_fclos: this.entry_fclos,
            einfo: state.einfo,
            state,
          })
        }
      }
      return tmpVal
    }

    const result = super.processAssignmentExpression(scope, node, state)

    // --- 引用别名传播：写入变量时同步到所有别名 ---
    if (node.operator === '=' && node.left?.type === 'Identifier') {
      const varName = node.left.name
      const funcScope = this.findFunctionScope(scope)
      const aliases = funcScope?._refAliases?.get(varName) as Set<string> | undefined
      if (aliases && aliases.size > 0) {
        const val = this.lookupVariableInScope(scope, varName)
        if (val) {
          for (const alias of aliases) {
            this.saveVarInScope(scope, { type: 'Identifier', name: alias }, val, state)
          }
        }
      }
      // 引用传参回写：函数内写入 by-ref 参数时同步到调用方变量
      if (this._byRefBindings?.length > 0) {
        const binding = this._byRefBindings.find((b: any) => b.paramName === varName)
        if (binding) {
          const val = this.lookupVariableInScope(scope, varName)
          if (val) {
            this.saveVarInScope(binding.callerScope, binding.callerArgNode, val, state)
          }
        }
      }
    }

    // --- global 变量赋值后同步到模块顶层 scope ---
    if (node.left?.type === 'Identifier' && node.left.name) {
      const varName = node.left.name
      // 在 scope 链中查找是否有 _globalVars 标记
      let searchScope = scope
      while (searchScope) {
        if (searchScope._globalVars?.has(varName)) {
          const modScope = this.findModuleScope(searchScope)
          if (modScope) {
            const val = this.lookupVariableInScope(scope, varName)
            if (val) modScope.value[varName] = val
          }
          break
        }
        searchScope = searchScope.parent
      }
      // --- static 变量赋值后同步到持久化 map ---
      searchScope = scope
      while (searchScope) {
        if (searchScope._staticVars?.has(varName)) {
          const funcKey = searchScope._staticVars.get(varName)
          if (funcKey) {
            const funcVars = this.staticVarMap.get(funcKey)
            const val = this.lookupVariableInScope(scope, varName)
            if (funcVars && val) funcVars.set(varName, val)
          }
          break
        }
        searchScope = searchScope.parent
      }
    }

    return result
  }

  /**
   * 数组字面量：PHP parser 将 SpreadElement 包装在 ObjectProperty 中，
   * 需要跳过对 spread 结果的覆写赋值，保持按索引展开的精度
   */
  override processObjectExpression(scope: any, node: any, state: any): any {
    const objSid = `<object_${node.loc?.start?.line}_${node.loc?.end?.line}>`
    let res = new Scoped(scope.qid, {
      sid: objSid,
      parent: scope,
      ast: node,
      _skipRegister: true,
    })
    if (node.properties) {
      for (const property of node.properties) {
        let name: any
        let fvalue: any
        const propertyType = property.type
        switch (propertyType) {
          case 'ObjectMethod': {
            name = property.key?.name
            fvalue = this.createFuncScope(property, scope)
            fvalue.ast.fdef = _.clone(fvalue.ast.fdef)
            if (fvalue.ast.fdef) fvalue.ast.fdef.type = 'FunctionDefinition'
            if (fvalue.ast?.node) fvalue.ast.node.type = 'FunctionDefinition'
            break
          }
          case 'SpreadElement': {
            this.processInstruction(res, property, state)
            continue
          }
          case 'ObjectProperty':
          default: {
            if (property.type !== 'ObjectProperty') continue
            let { key } = property
            switch (key.type) {
              case 'Literal':
                name = key.value
                break
              case 'Identifier':
                name = key.name
                break
              default:
                key = this.processInstruction(res, key, state)
                name = key.type === 'Literal' ? key.value : key.type === 'Identifier' ? key.name : undefined
                break
            }
            // PHP 中 SpreadElement 被包装在 ObjectProperty.value 中
            // 直接展开数组元素到结果对象中，保持按索引的精度
            if (property.value?.type === 'SpreadElement') {
              const spreadVal = this.processInstruction(scope, property.value.argument, state)
              if (spreadVal && spreadVal.vtype === 'object' && spreadVal.value) {
                // 获取当前结果中已有的最大数字索引
                let nextIdx = 0
                for (const existingKey of Object.keys(typeof res.value === 'object' ? res.value : {})) {
                  const n = parseInt(existingKey, 10)
                  if (!isNaN(n) && n >= nextIdx) nextIdx = n + 1
                }
                // 从源数组中按数字索引提取元素并追加到结果
                const srcKeys = Object.keys(typeof spreadVal.value === 'object' ? spreadVal.value : {})
                  .filter((k: string) => /^\d+$/.test(k))
                  .sort((a: string, b: string) => parseInt(a) - parseInt(b))
                for (const srcKey of srcKeys) {
                  const elemVal = spreadVal.value[srcKey]
                  if (elemVal && elemVal.vtype !== 'undefine') {
                    res.value[String(nextIdx)] = elemVal
                    if (elemVal.taint?.isTaintedRec) res.taint?.propagateFrom(elemVal)
                    nextIdx++
                  }
                }
              }
              continue
            }
            fvalue = this.processInstruction(res, property.value, state)
            if (fvalue?.taint?.isTaintedRec) res.taint?.propagateFrom(fvalue)
            if (property.value?.type === 'FunctionDefinition') fvalue.parent = res
            break
          }
        }
        res.value[name] = fvalue
      }
      res.length = node.properties.length
    }
    res = new ObjectValue(scope.qid, { ...res, sid: objSid })
    res.vtype = 'object'
    res._this = res
    return res
  }

  // ─── PHP 控制流信号：break + throw + continue ───

  /** 三信号属性 */
  _breakSignal = false
  _throwSignal = false
  _continueSignal = false

  override processBreakStatement(scope: any, node: any, state: any): any {
    this._breakSignal = true
    return new UndefinedValue()
  }

  override processContinueStatement(scope: any, node: any, state: any): any {
    this._continueSignal = true
    return new UndefinedValue()
  }

  override processThrowStatement(scope: any, node: any, state: any): any {
    const result = super.processThrowStatement(scope, node, state)
    this._throwSignal = true
    return result
  }

  /** 块语句：信号后跳过剩余语句 */
  override processScopedStatement(scope: any, node: any, state: any): any {
    const { loc } = node
    let scopeName
    if (loc) {
      if (!scope.qid) {
        const prefix = loc.sourcefile?.substring(Config.maindirPrefix.length)
        const lastDotIndex = prefix?.lastIndexOf('.') ?? -1
        const relateFileName = lastDotIndex >= 0 ? prefix?.substring(0, lastDotIndex) : prefix
        scopeName = `${relateFileName}<block_${loc.start?.line}_${loc.start?.column}_${loc.end?.line}_${loc.end?.column}>`
      } else {
        scopeName = `<block_${loc.start?.line}_${loc.start?.column}_${loc.end?.line}_${loc.end?.column}>`
      }
    } else {
      scopeName = `<block_${Uuid.v4()}>`
    }
    const block_scope = Scope.createSubScope(scopeName, scope, 'scope')
    node.body
      .filter((n: any) => needCompileFirst(n.type))
      .forEach((s: any) => this.processInstruction(block_scope, s, state))
    node.body
      .filter((n: any) => !needCompileFirst(n.type))
      .forEach((s: any) => {
        if (this._breakSignal || this._throwSignal || this._continueSignal) return
        this.processInstruction(block_scope, s, state)
      })

    if (this.checkerManager && this.checkerManager.checkAtEndOfBlock) {
      this.checkerManager.checkAtEndOfBlock(this, scope, node, state, {})
    }
    return new VoidValue()
  }

  /** switch 语句：break 消费，throw 退出 */
  override processSwitchStatement(scope: any, node: any, state: any): any {
    const test = this.processInstruction(scope, node.discriminant, state)
    if (test && test.type === 'Literal') {
      const testValue = test.value
      for (const caseClause of node.cases) {
        if (
          !caseClause.test ||
          (caseClause.test.type === 'Literal' && caseClause.test.value === testValue)
        ) {
          const result = this.processInstruction(scope, caseClause.body, state)
          this._breakSignal = false
          return result
        }
      }
      return new UndefinedValue()
    }

    const scopes: any[] = []
    const n = node.cases.length
    const substates = MemState.forkStates(state, n)
    let i = 0
    for (const caseClause of node.cases) {
      const scope1 = MemState.cloneScope(scope, state)
      scopes.push(scope1)
      const st = substates[i++] || substates[0]
      this.processInstruction(scope1, caseClause.body, st)
      this._breakSignal = false
      if (this._throwSignal) break
    }
    MemState.unionValues(scopes, substates, state.brs)
    return new UndefinedValue()
  }

  /** for 语句：三信号处理 */
  override processForStatement(scope: any, node: any, state: any): any {
    StateUtil.pushLoopInfo(state, node)
    if (node.init) {
      this.processInstruction(scope, node.init, state)
    }

    let test = node.test ? this.processInstruction(scope, node.test, state) : null
    if (test && test.type === 'Literal') {
      if (test.value) this.processInstruction(scope, node.body, state)
    } else {
      this.processInstruction(scope, node.body, state)
    }
    this._continueSignal = false
    if (this._breakSignal) {
      this._breakSignal = false
      StateUtil.popLoopInfo(state)
      return new UndefinedValue()
    }
    if (this._throwSignal) {
      StateUtil.popLoopInfo(state)
      return new UndefinedValue()
    }
    if (node.update) {
      this.processInstruction(scope, node.update, state)
    }
    test = this.processInstruction(scope, node.test, state)
    if (test && test.type === 'Literal') {
      if (test.value) this.processInstruction(scope, node.body, state)
    } else this.processInstruction(scope, node.body, state)
    this._continueSignal = false
    if (this._breakSignal) {
      this._breakSignal = false
    }

    StateUtil.popLoopInfo(state)
    return new UndefinedValue()
  }

  /** while 语句：三信号处理 */
  override processWhileStatement(scope: any, node: any, state: any): any {
    StateUtil.pushLoopInfo(state, node)
    let test = this.processInstruction(scope, node.test, state)
    if (test && test.type === 'Literal') {
      if (test.value) this.processInstruction(scope, node.body, state)
    } else this.processInstruction(scope, node.body, state)
    this._continueSignal = false
    if (this._breakSignal) {
      this._breakSignal = false
      StateUtil.popLoopInfo(state)
      return new UndefinedValue()
    }
    if (this._throwSignal) {
      StateUtil.popLoopInfo(state)
      return new UndefinedValue()
    }

    test = this.processInstruction(scope, node.test, state)
    if (test && test.type === 'Literal') {
      if (test.value) this.processInstruction(scope, node.body, state)
    } else this.processInstruction(scope, node.body, state)
    this._continueSignal = false
    if (this._breakSignal) {
      this._breakSignal = false
    }

    StateUtil.popLoopInfo(state)
    return new UndefinedValue()
  }

  /** range/foreach 语句：三信号处理 */
  override processRangeStatement(scope: any, node: any, state: any): any {
    const { key, value, right, body } = node
    scope = Scope.createSubScope(
      `<block_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}>`,
      scope
    )
    const rightVal = this.processInstruction(scope, right, state)
    if (
      !Array.isArray(rightVal) &&
      (this.inRange ||
        rightVal?.vtype === 'primitive' ||
        Object.keys(rightVal.getRawValue()).filter((k: string) => !k.startsWith('__yasa')).length === 0 ||
        rightVal?.vtype === 'union')
    ) {
      if (value) {
        if (value.type === 'VariableDeclaration') {
          this.saveVarInCurrentScope(scope, value.id, rightVal, state)
        } else if (value.type === 'TupleExpression') {
          for (const ele of value.elements) {
            this.saveVarInCurrentScope(scope, ele.name, rightVal, state)
          }
        } else {
          this.saveVarInScope(scope, value, rightVal, state)
        }
      }
      if (key) {
        this.saveVarInScope(scope, key, rightVal, state)
      }
      this.processInstruction(scope, body, state)
    } else {
      this.inRange = true
      if (this.isNullLiteral(rightVal)) {
        this.inRange = false
        return undefined as any
      }
      const itr = this.getValueIterator(rightVal, filterDataFromScope)
      let countLimit = 30
      for (let { value: field, done } = itr.next(); !done; { value: field, done } = itr.next()) {
        if (countLimit-- === 0) {
          break
        }
        if (!field) continue
        let { k, v } = field
        if (key) {
          if (key.type === 'VariableDeclaration') {
            this.saveVarInCurrentScope(scope, key.id, k, state)
          } else {
            if (typeof k === 'string') k = new PrimitiveValue(scope.qid, k, k, null, key.type, key.loc, key)
            this.saveVarInScope(scope, key, k, state)
          }
        }
        if (value) {
          if (value.type === 'VariableDeclaration') {
            this.saveVarInCurrentScope(scope, value.id, v, state)
          } else if (value.type === 'TupleExpression') {
            for (let i = 0; i < value.elements.length; i++) {
              const eleVal = v?.members?.get(String(i)) ?? v
              this.saveVarInCurrentScope(scope, value.elements[i].name, eleVal, state)
            }
          } else {
            this.saveVarInScope(scope, value, v, state)
          }
        }
        this.processInstruction(scope, body, state)
        this._continueSignal = false
        if (this._breakSignal) {
          this._breakSignal = false
          break
        }
        if (this._throwSignal) break
      }
      this.inRange = false
    }
    return new VoidValue()
  }

  /** 序列表达式：信号后跳过剩余 */
  override processSequence(scope: any, node: any, state: any) {
    let val
    for (const i in node.expressions) {
      if (this._breakSignal || this._throwSignal || this._continueSignal) break
      const expr = node.expressions[i]
      val = this.processInstruction(scope, expr, state)
    }
    return val
  }

  /** try 语句：消费 throw 信号 */
  override processTryStatement(scope: any, node: any, state: any): any {
    state.throwstack = state.throwstack ?? []
    this.processInstruction(scope, node.body, state)
    this._throwSignal = false
    const { handlers } = node
    if (handlers) {
      for (const clause of handlers) {
        if (!clause.parameter) {
          this.processInstruction(scope, clause.body, state)
          continue
        }
        // PHP catch 参数绑定：从 throwstack 取出抛出值赋给 catch 变量
        for (const param of clause.parameter) {
          if (param?.type === 'VariableDeclaration' && param._meta?.catchTypes && state.throwstack?.length > 0) {
            const thrownVal = state.throwstack.shift()
            const varName = param.id?.name
            if (varName && thrownVal) {
              this.saveVarInCurrentScope(scope, param.id, thrownVal, state)
              continue
            }
          }
          this.processInstruction(scope, param, state)
        }
        this.processInstruction(scope, clause.body, state)
      }
      // catch handler 内的 re-throw 不传播到 try 外部
      this._throwSignal = false
    }
    if (node.finalizer) this.processInstruction(scope, node.finalizer, state)
    return new UndefinedValue()
  }

  /** if 语句：信号隔离——break/throw 传播，continue 不传播（单分支） */
  override processIfStatement(scope: any, node: any, state: any): any {
    const test = this.processInstruction(scope, node.test, state)
    if (!node.consequent || node.consequent.type === 'Noop') return new VoidValue()

    switch (test?.type) {
      case 'Literal': {
        if (test.value) {
          return this.processInstruction(scope, node.consequent, state)
        } else if (node.alternative && node.alternative.type !== 'Noop') {
          return this.processInstruction(scope, node.alternative, state)
        }
        return new VoidValue()
      }
      default: {
        if (node.alternative && node.alternative.type !== 'Noop') {
          const rscope = MemState.cloneScope(scope, state)
          const substates = MemState.forkStates(state)
          const lstate = substates[0]
          const rstate = substates[1]
          this.processLRScopeInternal(lstate, rstate, state, test)

          // 保存信号，分别处理两个分支
          const savedBreak = this._breakSignal
          const savedThrow = this._throwSignal
          const savedContinue = this._continueSignal
          this._breakSignal = false
          this._throwSignal = false
          this._continueSignal = false
          this.processInstruction(scope, node.consequent, lstate)
          const leftBreak = this._breakSignal
          const leftThrow = this._throwSignal
          const leftContinue = this._continueSignal
          this._breakSignal = false
          this._throwSignal = false
          this._continueSignal = false
          this.processInstruction(rscope, node.alternative, rstate)
          const rightBreak = this._breakSignal
          const rightThrow = this._throwSignal
          const rightContinue = this._continueSignal
          // 两个分支都设置了信号才传播
          this._breakSignal = savedBreak || (leftBreak && rightBreak)
          this._throwSignal = savedThrow || (leftThrow && rightThrow)
          this._continueSignal = savedContinue || (leftContinue && rightContinue)

          MemState.unionValues([scope, rscope], substates, state.brs)
          this.postBranchProcessing(node, test, state, lstate, rstate)
        } else {
          // 单分支：break/throw 传播，continue 不传播
          const substates = MemState.forkStates(state, 1)
          const lstate = substates[0]
          const { pcond } = state
          lstate.pcond = pcond.slice(0)
          lstate.parent = state
          if (test) lstate.pcond.push(test)
          lstate.binfo = _.clone(state.binfo)

          const savedBreak = this._breakSignal
          const savedThrow = this._throwSignal
          const savedContinue = this._continueSignal
          this._breakSignal = false
          this._throwSignal = false
          this._continueSignal = false
          this.processInstruction(scope, node.consequent, lstate)
          this._breakSignal = savedBreak || this._breakSignal
          this._throwSignal = savedThrow || this._throwSignal
          this._continueSignal = savedContinue

          MemState.unionValues([scope, scope], substates, lstate.brs)
          this.postBranchProcessing(node, test, state, lstate)
        }
      }
    }
    return new VoidValue()
  }

  /** 函数调用边界：保存/恢复信号，防止泄漏到调用方 */
  override executeFdeclOrExecute(fclos: any, state: any, node: any, scope: any, fdecl: any, fname: any, execute_builtin: any, callInfo: any): any {
    const savedThrow = this._throwSignal
    const savedBreak = this._breakSignal
    const savedContinue = this._continueSignal
    this._throwSignal = false
    this._breakSignal = false
    this._continueSignal = false
    const result = super.executeFdeclOrExecute(fclos, state, node, scope, fdecl, fname, execute_builtin, callInfo)
    this._throwSignal = savedThrow
    this._breakSignal = savedBreak
    this._continueSignal = savedContinue
    return result
  }
}

/** 判断 AST 节点是否需要优先编译（函数/类定义 hoisting） */
function needCompileFirst(type: any) {
  return ['FunctionDefinition', 'ClassDefinition'].indexOf(type) !== -1
}

export = PhpAnalyzer
