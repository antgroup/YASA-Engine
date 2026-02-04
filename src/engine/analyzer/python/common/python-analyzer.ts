const SymAddress = require('../../common/sym-address')

const { Analyzer } = require('../../common')
const CheckerManager = require('../../common/checker-manager')
const BasicRuleHandler = require('../../../../checker/common/rules-basic-handler')
const PythonParser = require('../../../parser/python/python-ast-builder')
const {
  ValueUtil: { ObjectValue, Scoped, PrimitiveValue, UndefinedValue, UnionValue, SymbolValue, PackageValue },
} = require('../../../util/value-util')
const logger = require('../../../../util/logger')(__filename)
const Config = require('../../../../config')
const { ErrorCode, Errors } = require('../../../../util/error-code')
const { assembleFullPath } = require('../../../../util/file-util')
const path = require('path')
const SourceLine = require('../../common/source-line')
const Uuid = require('node-uuid')
const Scope = require('../../common/scope')
const { unionAllValues } = require('../../common/memStateBVT')
const AstUtil = require('../../../../util/ast-util')
const { floor } = require('lodash')
const Stat = require('../../../../util/statistics')
const constValue = require('../../../../util/constant')
const entryPointConfig = require('../../common/current-entrypoint')
const FileUtil = require('../../../../util/file-util')
const globby = require('fast-glob')
const _ = require('lodash')
const { getSourceNameList } = require('./entrypoint-collector/python-entrypoint')
const { handleException } = require('../../common/exception-handler')
const { resolveImportPath } = require('./python-import-resolver')

/**
 *
 */
class PythonAnalyzer extends (Analyzer as any) {
  /**
   *
   * @param options
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

    this.fileList = []
    this.astManager = {}
    // 搜索路径列表（类似 Python 的 sys.path）
    // 用于解析绝对导入，按优先级排序
    this.searchPaths = []
  }

  /**
   * 预处理阶段：扫描模块并解析代码
   *
   * @param dir - 项目目录
   */
  async preProcess(dir: any) {
    try {
      ;(this as any).thisIterationTime = 0
      ;(this as any).prevIterationTime = new Date().getTime()

      this.scanModules(dir)
      this.astManager = {}
    } catch (e) {
      handleException(
        e,
        `Error in PythonAnalyzer:preProcess \n${this.traceNodeInfo((this as any).lastProcessedNode)}`,
        `Error in PythonAnalyzer:preProcess \n${this.traceNodeInfo((this as any).lastProcessedNode)}`
      )
    }
  }

  /**
   *
   * @param source
   * @param fileName
   */
  preProcess4SingleFile(source: any, fileName: any) {
    ;(this as any).thisIterationTime = 0
    ;(this as any).prevIterationTime = new Date().getTime()
    this.fileList = [fileName]
    const { options } = this
    const ast = PythonParser.parseSingleFile(fileName, options)
    this.astManager[fileName] = ast
    this.addASTInfo(ast, source, fileName, false as any)
    if (ast) {
      this.processModule(ast, fileName, false as any)
    }
    SourceLine.storeCode(fileName, source)
  }

  /**
   *
   */
  symbolInterpret() {
    const { entryPoints } = this as any
    const state = this.initState(this.topScope)

    if (_.isEmpty(entryPoints)) {
      logger.info('[symbolInterpret]：EntryPoints are not found')
      return true
    }
    const hasAnalysised: any[] = []
    for (const entryPoint of entryPoints) {
      if (entryPoint.type === constValue.ENGIN_START_FUNCALL) {
        if (
          hasAnalysised.includes(
            `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?._qid}#${entryPoint.entryPointSymVal.ast.parameters}.${entryPoint.attribute}`
          )
        ) {
          continue
        }

        hasAnalysised.push(
          `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?._qid}#${entryPoint.entryPointSymVal.ast.parameters}.${entryPoint.attribute}`
        )
        entryPointConfig.setCurrentEntryPoint(entryPoint)
        logger.info(
          'EntryPoint [%s.%s] is executing',
          entryPoint.filePath?.substring(0, entryPoint.filePath?.lastIndexOf('.')),
          entryPoint.functionName ||
            `<anonymousFunc_${entryPoint.entryPointSymVal?.ast.loc.start.line}_$${
              entryPoint.entryPointSymVal?.ast.loc.end.line
            }>`
        )

        const fileFullPath = assembleFullPath(entryPoint.filePath, Config.maindir)
        const sourceNameList = getSourceNameList()
        this.refreshCtx(this.moduleManager.field[fileFullPath]?.field, sourceNameList)
        this.refreshCtx(this.fileManager[fileFullPath]?.field, sourceNameList)
        this.refreshCtx(this.packageManager.field[fileFullPath], sourceNameList)

        this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)

        const argValues: any[] = []
        try {
          for (const key in entryPoint.entryPointSymVal?.ast?.parameters) {
            argValues.push(
              this.processInstruction(
                entryPoint.entryPointSymVal,
                entryPoint.entryPointSymVal?.ast?.parameters[key]?.id,
                state
              )
            )
          }
        } catch (e) {
          handleException(
            e,
            'Error occurred in PythonAnalyzer.symbolInterpret: process argValue err',
            'Error occurred in PythonAnalyzer.symbolInterpret: process argValue err'
          )
        }

        if (
          entryPoint?.entryPointSymVal?.parent?.vtype === 'class' &&
          entryPoint?.entryPointSymVal?.parent?.field._CTOR_
        ) {
          this.executeCall(
            entryPoint.entryPointSymVal?.parent?.field?._CTOR_?.ast,
            entryPoint.entryPointSymVal?.parent?.field?._CTOR_,
            [],
            state,
            entryPoint.entryPointSymVal?.parent?.field?._CTOR_?.ast?.parent
          )
        }
        try {
          this.executeCall(
            entryPoint.entryPointSymVal?.ast,
            entryPoint.entryPointSymVal,
            argValues,
            state,
            entryPoint.entryPointSymVal?.parent
          )
        } catch (e) {
          handleException(
            e,
            `[${entryPoint.entryPointSymVal?.ast?.id?.name} symbolInterpret failed. Exception message saved in error log file`,
            `[${entryPoint.entryPointSymVal?.ast?.id?.name} symbolInterpret failed. Exception message saved in error log file`
          )
        }
        this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
      } else if (entryPoint.type === constValue.ENGIN_START_FILE_BEGIN) {
        if (hasAnalysised.includes(`fileBegin:${entryPoint.filePath}.${entryPoint.attribute}`)) {
          continue
        }
        hasAnalysised.push(`fileBegin:${entryPoint.filePath}.${entryPoint.attribute}`)
        entryPointConfig.setCurrentEntryPoint(entryPoint)
        logger.info('EntryPoint [%s] is executing ', entryPoint.filePath)

        const fileFullPath = assembleFullPath(entryPoint.filePath, Config.maindir)
        const sourceNameList = getSourceNameList()
        this.refreshCtx(this.moduleManager.field[fileFullPath]?.field, sourceNameList)
        this.refreshCtx(this.fileManager[fileFullPath]?.field, sourceNameList)
        this.refreshCtx(this.packageManager.field[fileFullPath], sourceNameList)

        const { filePath } = entryPoint
        const scope = this.moduleManager.field[filePath]
        if (scope) {
          try {
            this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)
            this.processCompileUnit(scope, entryPoint.entryPointSymVal?.ast, state)
            this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
          } catch (e) {
            handleException(
              e,
              `[${entryPoint.entryPointSymVal?.ast?.loc?.sourcefile} symbolInterpret failed. Exception message saved in error log file`,
              `[${entryPoint.entryPointSymVal?.ast?.loc?.sourcefile} symbolInterpret failed. Exception message saved in error log file`
            )
          }
        }
      }
    }
    return true
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processBinaryExpression(scope: any, node: any, state: any) {
    const new_node: any = _.clone(node)
    new_node.ast = node
    const new_left = (new_node.left = this.processInstruction(scope, node.left, state))
    const new_right = (new_node.right = this.processInstruction(scope, node.right, state))

    if (node.operator === 'push') {
      this.processOperator(new_left.parent ? new_left.parent : new_left, node.left, new_right, node.operator, state)
    }
    if (node.operator === 'instanceof') {
      new_node._meta.type = node.right
    }
    const has_tag = (new_left && new_left.hasTagRec) || (new_right && new_right.hasTagRec)
    if (has_tag) {
      new_node.hasTagRec = has_tag
    }

    if (this.checkerManager && (this.checkerManager as any).checkAtBinaryOperation)
      this.checkerManager.checkAtBinaryOperation(this, scope, node, state, { newNode: new_node })

    return SymbolValue(new_node)
  }

  /**
   *
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  executeSingleCall(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    if (fclos.decorators?.some((d: any) => d.name === 'classmethod') && argvalues[0]?.vtype === 'undefine') {
      argvalues[0] = fclos._this
    }
    return super.executeSingleCall(fclos, argvalues, state, node, scope)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processCallExpression(scope: any, node: any, state: any) {
    if (this.checkerManager && (this.checkerManager as any).checkAtFuncCallSyntax)
      this.checkerManager.checkAtFuncCallSyntax(this, scope, node, state, {
        pcond: state.pcond,
        einfo: state.einfo,
      })

    const fclos = this.processInstruction(scope, node.callee, state)
    if (node?.callee?.type === 'MemberAccess' && fclos.fdef && node.callee?.object?.type !== 'SuperExpression') {
      fclos._this = this.processInstruction(scope, node.callee.object, state)
    }
    if (!fclos) return UndefinedValue()

    const argvalues: any[] = []
    /**
     *
     * @param paramAST
     * @param positionalArgs
     * @param keywordArgs
     * @param len
     */
    function collectArgsFromArray(
      paramAST: any[],
      positionalArgs: any[],
      keywordArgs: Record<string, any>,
      len: number
    ) {
      const paramNames = paramAST.map((n: any) => n.id.name)
      const collectedArgs = new Array(len).fill(undefined)
      positionalArgs.forEach((arg, index) => {
        if (index < collectedArgs.length) collectedArgs[index] = arg
      })
      for (const [key, value] of Object.entries(keywordArgs)) {
        const paramIndex = paramNames.indexOf(key)
        if (paramIndex !== -1) collectedArgs[paramIndex] = value
      }
      return collectedArgs
    }

    const positionalArgs: any[] = []
    const keywordArgs: Record<string, any> = {}
    for (const arg of node.arguments) {
      if (arg.type === 'VariableDeclaration') {
        keywordArgs[arg.id.name] = arg
      } else {
        positionalArgs.push(arg)
      }
    }
    let collectedArgs: any[]
    if (fclos.fdef && fclos.fdef.type === 'FunctionDefinition') {
      collectedArgs = collectArgsFromArray(fclos.ast.parameters, positionalArgs, keywordArgs, node.arguments.length)
    } else {
      collectedArgs = node.arguments
    }

    for (const arg of collectedArgs) {
      const argv = this.processInstruction(scope, arg, state)
      if ((logger as any).isTraceEnabled()) logger.trace(`arg: ${this.formatScope(argv)}`)
      if (Array.isArray(argv)) argvalues.push(...argv)
      else argvalues.push(argv)
    }

    if (argvalues && this.checkerManager) {
      this.checkerManager.checkAtFunctionCallBefore(this, scope, node, state, {
        argvalues,
        fclos,
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
        einfo: state.einfo,
        state,
        analyzer: this,
        ainfo: this.ainfo,
      })
    }

    if (fclos.vtype === 'class') {
      return this.propagateNewObject(scope, node, state, fclos, argvalues)
    }
    // todo 待迁移到库函数建模中
    if (node.callee.type === 'MemberAccess' && node.callee.property.name === 'append' && fclos?.object?.parent) {
      this.saveVarInCurrentScope(fclos.object.parent, fclos.object, argvalues[0], state)
      return
    }
    const res = this.executeCall(node, fclos, argvalues, state, scope)

    if (fclos.vtype !== 'fclos' && Config.invokeCallbackOnUnknownFunction) {
      this.executeFunctionInArguments(scope, fclos, node, argvalues, state)
    }

    if (res && (this.checkerManager as any)?.checkAtFunctionCallAfter) {
      this.checkerManager.checkAtFunctionCallAfter(this, scope, node, state, {
        fclos,
        ret: res,
        argvalues,
        pcond: state.pcond,
        einfo: state.einfo,
        callstack: state.callstack,
      })
    }

    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   * @param fclos
   * @param argvalues
   */
  propagateNewObject(scope: any, node: any, state: any, fclos: any, argvalues: any) {
    if (fclos.field && Object.prototype.hasOwnProperty.call(fclos.field, '_CTOR_')) {
      const res = this.buildNewObject(fclos.cdef, argvalues, fclos, state, node, scope)
      if (res && (this.checkerManager as any)?.checkAtFunctionCallAfter) {
        this.checkerManager.checkAtFunctionCallAfter(this, scope, node, state, {
          fclos,
          ret: res,
          argvalues,
          pcond: state.pcond,
          einfo: state.einfo,
          callstack: state.callstack,
        })
      }
      return res
    }
    const res = this.processLibArgToRet(node, fclos, argvalues, scope, state)
    if (res && (this.checkerManager as any)?.checkAtFunctionCallAfter) {
      this.checkerManager.checkAtFunctionCallAfter(this, scope, node, state, {
        fclos,
        ret: res,
        argvalues,
        pcond: state.pcond,
        einfo: state.einfo,
        callstack: state.callstack,
      })
    }
    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processIdentifier(scope: any, node: any, state: any) {
    const res = super.processIdentifier(scope, node, state)
    this.checkerManager.checkAtIdentifier(this, scope, node, state, { res })
    return res
  }

  /**
   * 处理 Python import 语句
   *
   * @param scope
   * @param node
   * @param state
   */
  processImportDirect(scope: any, node: any, state: any) {
    let { from, imported } = node
    let sourcefile
    while (imported) {
      sourcefile = imported.loc.sourcefile
      if (sourcefile) break
      imported = from?.parent
    }
    if (!sourcefile) {
      handleException(
        null,
        'Error occurred in PythonAnalyzer.processImportDirect: failed to sourcefile in ast',
        'Error occurred in PythonAnalyzer.processImportDirect: failed to sourcefile in ast'
      )
      return UndefinedValue()
    }
    const sourceFileAbs = path.resolve(sourcefile.toString())
    const projectRoot = Config.maindir?.replace(/\/$/, '') || path.dirname(sourceFileAbs)

    let importPath: string | null = null
    let modulePath: string | null = null

    if (!from) {
      // 处理 "import module" 形式的导入
      const importName = imported.value || imported.name
      if (importName) {
        importPath = resolveImportPath(importName, sourceFileAbs, this.fileList, projectRoot)
      }
    } else {
      // 处理 "from module import ..." 形式的导入
      const fromValue = from.value
      if (fromValue) {
        if (fromValue.startsWith('.')) {
          // 相对导入，需要区分两种情况：
          // 1. "from .. import moduleName" - 导入整个模块，fromValue 只有点号（如 ".."）
          // 2. "from ..moduleName import fieldName" - 从模块中导入字段，fromValue 包含点号和模块名（如 "..moduleName"）
          const onlyDots = /^\.+$/.test(fromValue)
          if (onlyDots) {
            const moduleName = imported?.name && imported.name !== '*' ? imported.name : null
            const { resolveRelativeImport } = require('./python-import-resolver')
            importPath = resolveRelativeImport(fromValue, sourceFileAbs, this.fileList, moduleName || undefined)
            // 不设置 modulePath，因为这是导入整个模块，应该返回整个模块对象
          } else {
            importPath = resolveImportPath(fromValue, sourceFileAbs, this.fileList, projectRoot)
            if (imported && imported.name && imported.name !== '*') {
              modulePath = imported.name
            }
          }
        } else {
          // 绝对导入
          importPath = resolveImportPath(fromValue, sourceFileAbs, this.fileList, projectRoot)
          if (imported && imported.name && imported.name !== '*') {
            modulePath = imported.name
          }
        }
      }
    }

    // 如果 resolver 找到了路径，加载模块
    if (importPath) {
      const normalizedPath = path.normalize(importPath)

      let targetPath = normalizedPath
      if (!targetPath.endsWith('.py')) {
        // 可能是包目录，检查是否有 __init__.py
        const initFile = path.join(targetPath, '__init__.py')
        if (this.fileList.some((f: string) => path.normalize(f) === path.normalize(initFile))) {
          targetPath = initFile
        } else {
          // 尝试添加 .py 扩展名
          const pyFile = `${targetPath}.py`
          if (this.fileList.some((f: string) => path.normalize(f) === path.normalize(pyFile))) {
            targetPath = pyFile
          }
        }
      }

      const cachedModule = this.moduleManager.field[targetPath]
      if (cachedModule) {
        if (modulePath) {
          const field = cachedModule.field?.[modulePath]
          if (field) return field
        }
        return cachedModule
      }

      // 加载并处理模块
      // 检查是否已经在处理中，防止循环导入导致的无限递归
      const processingKey = `processing_${targetPath}`
      if ((this as any)[processingKey]) {
        logger.warn(`Circular import detected for: ${targetPath}`)
        return UndefinedValue()
      }

      try {
        ;(this as any)[processingKey] = true
        const ast = this.astManager[targetPath]
        if (ast) {
          const module = this.processModule(ast, targetPath, false as any)
          if (module) {
            if (modulePath) {
              const field = module.field?.[modulePath]
              if (field) {
                delete (this as any)[processingKey]
                return field
              }
            }
            delete (this as any)[processingKey]
            return module
          }
        }
        delete (this as any)[processingKey]
      } catch (e) {
        delete (this as any)[processingKey]
        handleException(
          e,
          `Error: PythonAnalyzer.processImportDirect: failed to loading: ${targetPath}`,
          `Error: PythonAnalyzer.processImportDirect: failed to loading: ${targetPath}`
        )
      }
    }

    // 如果找不到，尝试作为三方库处理
    const importName = from?.value || imported?.value || imported?.name
    if (importName) {
      return this.loadPredefinedModule(scope, imported?.name || importName, from?.value || 'syslib_from')
    }

    return UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processMemberAccess(scope: any, node: any, state: any) {
    const defscope = this.processInstruction(scope, node.object, state)
    const prop = node.property
    let resolved_prop = prop
    if (node.computed) {
      resolved_prop = this.processInstruction(scope, prop, state)
    } else if (prop.type !== 'Identifier' && prop.type !== 'Literal') {
      resolved_prop = this.processInstruction(scope, prop, state)
    }
    if (prop.type === 'Identifier' && prop.name === '__init__' && prop.parent?.parent?.type === 'CallExpression') {
      resolved_prop.name = '_CTOR_'
    }
    if (!resolved_prop) return defscope
    return this.getMemberValue(defscope, resolved_prop, state)
  }

  /**
   *
   * @param ast
   * @param filename
   * @param isReScan
   */
  processModule(ast: any, filename: any, isReScan: any) {
    if (!ast) {
      process.exitCode = ErrorCode.fail_to_parse
      const sourceFile = filename
      Stat.fileIssues[sourceFile] = 'Parsing Error'
      handleException(
        null,
        `Error occurred in JsAnalyzer.processModule: ${sourceFile} parse error`,
        `Error occurred in JsAnalyzer.processModule: ${sourceFile} parse error`
      )
      return
    }
    this.preloadFileToPackage(ast, filename)
    let m = this.moduleManager.field[filename]
    if (m && !isReScan) return m
    let relateFileName = 'file'
    if (ast.loc?.sourcefile) {
      relateFileName = ast.loc?.sourcefile?.startsWith(Config.maindirPrefix)
        ? ast.loc.sourcefile?.substring(Config.maindirPrefix.length).split('.')[0]
        : ast.loc.sourcefile.split('.')[0]
    }
    const modClos = Scoped({ sid: relateFileName, parent: this.topScope, decls: {}, fdef: ast, ast })
    this.moduleManager.field[filename] = modClos
    this.fileManager[filename] = modClos
    m = this.processModuleDirect(ast, filename, modClos)
    ;(m as any).ast = ast
    return m
  }

  /**
   *
   * @param node
   * @param filename
   * @param modClos
   */
  processModuleDirect(node: any, filename: any, modClos: any) {
    if (!node || node.type !== 'CompileUnit') {
      handleException(
        null,
        `node type should be CompileUnit, but ${node.type}`,
        `node type should be CompileUnit, but ${node.type}`
      )
      return undefined
    }

    this.entry_fclos = modClos
    this.thisFClos = modClos

    const state = this.initState(modClos)
    this.processInstruction(modClos, node, state)
    return modClos
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processNewObject(scope: any, node: any, state: any) {
    const call = node
    let fclos = this.processInstruction(scope, node.callee, state)
    if (!fclos) return
    if (fclos.vtype === 'union') {
      fclos = fclos.value[0]
    }

    let argvalues: any[] = []
    if (call.arguments) {
      let same_args = true
      for (const arg of call.arguments) {
        const argv = this.processInstruction(scope, arg, state)
        if (argv !== arg) same_args = false
        argvalues.push(argv)
      }
      if (same_args) argvalues = call.arguments
    }

    const { fdef } = fclos
    const obj = this.buildNewObject(fdef, argvalues, fclos, state, node, scope)
    if ((logger as any).isTraceEnabled()) logger.trace(`new expression: ${this.formatScope(obj)}`)

    if (obj && (this.checkerManager as any)?.checkAtNewExprAfter) {
      this.checkerManager.checkAtNewExprAfter(this, scope, node, state, {
        argvalues,
        fclos,
        ret: obj,
        pcond: state.pcond,
        einfo: state.einfo,
        callstack: state.callstack,
      })
    }

    return obj
  }

  /**
   *
   * @param scope
   * @param node
   * @param argvalues
   * @param operator
   * @param state
   */
  processOperator(scope: any, node: any, argvalues: any, operator: any, state: any) {
    switch (operator) {
      case 'push': {
        this.saveVarInCurrentScope(scope, node, argvalues, state)
        const has_tag = (scope && scope.hasTagRec) || (argvalues && argvalues.hasTagRec)
        if (has_tag) {
          scope.hasTagRec = has_tag
        }
      }
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processReturnStatement(scope: any, node: any, state: any) {
    if (node.argument) {
      const return_value = this.processInstruction(scope, node.argument, state)
      if (!node.isYield) {
        if (!(this as any).lastReturnValue) {
          ;(this as any).lastReturnValue = return_value
        } else if ((this as any).lastReturnValue.vtype === 'union') {
          ;(this as any).lastReturnValue.appendValue(return_value)
        } else {
          const tmp = UnionValue()
          tmp.appendValue((this as any).lastReturnValue)
          tmp.appendValue(return_value)
          ;(this as any).lastReturnValue = tmp
        }
        if (!(node.argument.type === 'Identifier' && node.argument.name === 'self')) {
          if (node.loc && (this as any).lastReturnValue)
            (this as any).lastReturnValue = SourceLine.addSrcLineInfo(
              (this as any).lastReturnValue,
              node,
              node.loc.sourcefile,
              'Return Value: ',
              '[return value]'
            )
        }
      }
      return return_value
    }
    return PrimitiveValue({ type: 'Literal', value: null, loc: node.loc })
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processScopedStatement(scope: any, node: any, state: any) {
    if (node.parent?.type === 'TryStatement') {
      node.body
        .filter((n: any) => needCompileFirst(n.type))
        .forEach((s: any) => this.processInstruction(scope, s, state))
      node.body
        .filter((n: any) => !needCompileFirst(n.type))
        .forEach((s: any) => this.processInstruction(scope, s, state))
    } else {
      const { loc } = node
      let scopeName
      if (loc) {
        scopeName = `<block_${loc.start?.line}_${loc.start?.column}_${loc.end?.line}_${loc.end?.column}>`
      } else {
        scopeName = `<block_${Uuid.v4()}>`
      }
      let block_scope = scope
      if (node.parent?.type === 'FunctionDefinition') {
        // 只对函数体内的块语句创建子作用域，python的其他块语句不创建子作用域
        block_scope = Scope.createSubScope(scopeName, scope, 'scope')
      }
      node.body
        .filter((n: any) => needCompileFirst(n.type))
        .forEach((s: any) => this.processInstruction(block_scope, s, state))
      node.body
        .filter((n: any) => !needCompileFirst(n.type))
        .forEach((s: any) => this.processInstruction(block_scope, s, state))
    }

    if (this.checkerManager && (this.checkerManager as any).checkAtEndOfBlock) {
      this.checkerManager.checkAtEndOfBlock(this, scope, node, state, {})
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processVariableDeclaration(scope: any, node: any, state: any) {
    const initialNode = node.init
    const { id } = node
    if (!id || id?.name === '_') return UndefinedValue()

    let initVal: any
    if (!initialNode) {
      initVal = this.createVarDeclarationScope(id, scope)
      initVal.uninit = !initialNode
      initVal = SourceLine.addSrcLineInfo(initVal, id, id.loc && id.loc.sourcefile, 'Var Pass: ', id.name)
    } else if (node?.parent?.type === 'CatchClause' && node?._meta?.isCatchParam && state?.throwstack?.length > 0) {
      initVal = state?.throwstack && state?.throwstack.shift()
      initVal = SourceLine.addSrcLineInfo(initVal, node, node.loc && node.loc.sourcefile, 'Var Pass: ', id.name)
      delete node._meta.isCatchParm
    } else {
      initVal = this.processInstruction(scope, initialNode, state)
      if (!(id.type === 'Identifier' && id.name === 'self' && initialNode.type === 'ThisExpression')) {
        initVal = SourceLine.addSrcLineInfo(initVal, node, node.loc && node.loc.sourcefile, 'Var Pass: ', id.name)
      }
    }

    if (this.checkerManager && (this.checkerManager as any).checkAtPreDeclaration)
      this.checkerManager.checkAtPreDeclaration(this, scope, node, state, {
        lnode: id,
        rvalue: null,
        pcond: state.pcond,
        entry_fclos: (this as any).entry_fclos,
        fdef: state.callstack && state.callstack[state.callstack.length - 1],
      })
    if (id.name === '*') {
      for (const x in initVal.value) {
        const v = initVal.value[x]
        if (!v) continue
        const v_copy = _.clone(v)
        scope.value[x] = v_copy
        v_copy._this = scope
        v_copy.parent = scope
      }
    } else {
      this.saveVarInCurrentScope(scope, id, initVal, state)
    }

    if (
      initVal &&
      !Array.isArray(initVal) &&
      !(initVal.name || (initVal.id && initVal.id !== '<anonymous>') || initVal.sid)
    ) {
      initVal.sid = id.name
      delete initVal.id
    }

    scope.decls[id.name] = id

    const typeQualifiedName = AstUtil.typeToQualifiedName(node.varType)
    let declTypeVal
    if (typeQualifiedName) {
      declTypeVal = this.getMemberValue(scope, typeQualifiedName, state)
    }

    if (initVal && declTypeVal) {
      initVal.sort = declTypeVal.sort
    }
    return initVal
  }

  /**
   * "left = right", "left *= right", etc.
   * @param scope
   * @param node
   * @param state
   */
  processAssignmentExpression(scope: any, node: any, state: any) {
    /*
    { operator,
      left,
      right,
      cloned
    }
    */
    switch (node.operator) {
      case '=': {
        const { left } = node
        const { right } = node
        let tmpVal = this.processInstruction(scope, right, state)
        if (node.cloned && !tmpVal?.refCount) {
          tmpVal = _.clone(tmpVal)
          tmpVal.value = _.clone(tmpVal.value)
        }
        const oldVal = this.processInstruction(scope, left, state)
        tmpVal = SourceLine.addSrcLineInfo(
          tmpVal,
          node,
          node.loc && node.loc.sourcefile,
          'Var Pass: ',
          left.type === 'TupleExpression' ? left.elements : left.name
        )

        if (left.type === 'TupleExpression') {
          this.handleTupleAssign(scope, left, tmpVal, state)
        } else {
          if (!tmpVal)
            // explicit null value
            tmpVal = PrimitiveValue({ type: 'Literal', value: null, loc: right.loc })
          const sid = SymAddress.toStringID(node.left)
          tmpVal.sid = !tmpVal.id || tmpVal.id === '<anonymous>' ? sid : tmpVal.id
          if (this.checkerManager && this.checkerManager.checkAtAssignment) {
            const lscope = this.getDefScope(scope, left)
            const mindex = this.resolveIndices(scope, left, state)
            this.checkerManager.checkAtAssignment(this, scope, node, state, {
              lscope,
              lvalue: oldVal,
              rvalue: tmpVal,
              pcond: state.pcond,
              binfo: state.binfo,
              entry_fclos: this.entry_fclos,
              mindex,
              einfo: state.einfo,
              state,
              ainfo: this.ainfo,
            })
          }
          if (left.name === undefined && left.sid !== undefined) {
            left.name = left.sid
          }
          this.saveVarInScope(scope, left, tmpVal, state, oldVal)
        }
        return tmpVal
      }
      case '&=':
      case '^=':
      case '<<=':
      case '>>=':
      case '+=':
      case '-=':
      case '*=':
      case '/=':
      case '%=': {
        const val = SymbolValue(node)
        val.type = 'BinaryOperation'
        val.operator = node.operator.substring(0, node.operator.length - 1)
        val.arith_assign = true
        val.left = this.processInstruction(scope, node.left, state)
        val.right = this.processInstruction(scope, node.right, state)
        if (node.cloned) {
          const clonedValue = _.clone(val.right.value)
          val.right = _.clone(val.right)
          val.right.value = clonedValue
        }
        const { left } = node
        const oldVal = this.getMemberValueNoCreate(scope, left, state)

        const hasTags = (val.left && val.left.hasTagRec) || (val.right && val.right.hasTagRec)
        if (hasTags) val.hasTagRec = hasTags

        this.saveVarInScope(scope, node.left, val, state)

        if (this.checkerManager && this.checkerManager.checkAtAssignment) {
          const lscope = this.getDefScope(scope, node.left)
          const mindex = this.resolveIndices(scope, node.left, state)
          this.checkerManager.checkAtAssignment(this, scope, node, state, {
            lscope,
            lvalue: oldVal,
            rvalue: val,
            pcond: state.pcond,
            binfo: state.binfo,
            entry_fclos: this.entry_fclos,
            mindex,
            einfo: state.einfo,
            state,
            ainfo: this.ainfo,
          })
          // this.recordSideEffect(lscope, node.left, val.left);
        }
        return val
      }
    }
  }

  /**
   *
   * @param scope
   * @param left
   * @param rightVal
   * @param state
   */
  handleTupleAssign(scope: any, left: any, rightVal: any, state: any) {
    if (rightVal.vtype === 'union') {
      const pairs = floor(rightVal.field.length / left.elements.length)
      const scopes = new Array(left.elements.length)
      for (let i = 0; i < left.elements.length; i++) scopes[i] = new Array(pairs)
      for (let i = 0; i < pairs; i++) {
        for (let j = 0; j < left.elements.length; j++) {
          scopes[j][i] = rightVal.field[i * left.elements.length + j]
        }
      }
      for (let i = 0; i < left.elements.length; i++) {
        const union = unionAllValues(scopes[i], state)
        this.saveVarInScope(scope, left.elements[i], union, state)
      }
    } else if (Array.isArray(rightVal.field) && rightVal.field.length >= 1) {
      const minLen = Math.min(left.elements.length, rightVal.field.length)
      for (let i = 0; i < minLen; i++) {
        this.saveVarInScope(scope, left.elements[i], rightVal.field[i], state)
      }
    } else if (isSequentialNumericKeysField(rightVal)) {
      const minLen = Math.min(left.elements.length, Object.keys(rightVal.field).length)
      for (let i = 0; i < minLen; i++) {
        this.saveVarInScope(scope, left.elements[i], rightVal.field[i], state)
      }
    } else {
      for (const i in left.elements) this.saveVarInScope(scope, left.elements[i], rightVal, state)
    }

    /**
     *
     * @param obj
     */
    function isSequentialNumericKeysField(obj: any) {
      if (!obj || typeof obj.field !== 'object' || Array.isArray(obj.field) || obj.field === null) return false
      const keys = Object.keys(obj.field)
      if (keys.length === 0) return false
      const numericKeys = keys.map((k) => Number(k))
      if (numericKeys.some(isNaN)) return false
      numericKeys.sort((a, b) => a - b)
      for (let i = 0; i < numericKeys.length; i++) {
        if (numericKeys[i] !== i) return false
      }
      return true
    }
  }

  /**
   *
   * @param ast
   * @param source
   * @param filename
   * @param isReScan
   */
  addASTInfo(ast: any, source: any, filename: any, isReScan: any) {
    const { options } = this
    options.sourcefile = filename
    AstUtil.annotateAST(ast, options ? { sourcefile: filename } : null)
    this.sourceCodeCache[filename] = source
  }

  /**
   *
   * @param scope
   * @param importName
   * @param fname
   */
  loadPredefinedModule(scope: any, importName: any, fname: any) {
    let m = this.moduleManager.field[fname]
    if (m) {
      const fields = m.value
      if (_.has(fields, importName)) {
        return fields[importName]
      }
    } else {
      m = SymbolValue({ id: fname, sid: fname, qid: fname, parent: this.topScope })
    }
    const objval = SymbolValue({
      id: `${importName}`,
      sid: `${importName}`,
      qid: `${fname}.${importName}`,
      parent: m,
      fdef: undefined,
      node_module: true,
    })
    m.setFieldValue(importName, objval)
    this.moduleManager.field[fname] = m
    return objval
  }

  /**
   *
   * @param ast
   * @param filename
   */
  preloadFileToPackage(ast: any, filename: any) {
    const fullString = path.dirname(filename)
    const parts = Config.maindir.split('/')
    const appName = parts[parts.length - 1]
    let packageName = appName
    if (fullString) {
      if (fullString !== Config.maindir) {
        const index = fullString?.indexOf(appName)
        if (index === -1) {
          return ''
        }
        packageName = fullString.substring(index).replaceAll('/', '.')
      }
    }
    const packageScope = this.packageManager.getSubPackage(packageName, true)
    if (path.basename(filename) === '__init__.py') {
      const m = this.processModuleDirect(ast, filename, packageScope)
      this.fileManager[filename] = m
      this.moduleManager[filename] = m
      ;(m as any).ast = ast
      return m
    }
  }

  /**
   *
   * @param scope
   * @param cdef
   * @param state
   */
  preProcessClassDefinition(scope: any, cdef: any, state: any) {
    if (!(cdef && cdef.body)) return UndefinedValue()

    const fname = cdef.id?.name

    const cscope = Scope.createSubScope(fname, scope, 'class')
    cscope.cdef = cdef
    cscope.modifier = {}
    cscope.inits = new Set()
    this.resolveClassInheritance(cscope, state)

    if (!cscope.fdata) cscope.fdata = {}

    if (cdef) {
      const oldThisFClos = (this as any).thisFClos
      ;(this as any).entry_fclos = (this as any).thisFClos = cscope
      this.processInstruction(cscope, cdef.body, state)
      for (const x in cscope.value) {
        const v = cscope.value[x]
        v._this = cscope
      }
      cscope._this = cscope
      ;(this as any).thisFClos = oldThisFClos
    }

    return cscope
  }

  /**
   *
   * @param obj
   * @param blacklist
   */
  refreshCtx(obj: any, blacklist: any) {
    if (!obj || !blacklist) {
      return
    }
    for (const key in obj) {
      if (blacklist.includes(obj[key]._qid)) {
        obj[key].hasTagRec = undefined
        obj[key]._tags = undefined
        obj[key].trace = undefined
        obj[key].value = {}
      }
    }
  }

  /**
   *
   * @param fclos
   * @param state
   */
  resolveClassInheritance(fclos: any, state: any) {
    const fdef = fclos.cdef
    const { supers } = fdef
    if (!supers || supers.length === 0) return

    const scope = fclos.parent

    for (const i in supers) {
      if (supers[i]) {
        _resolveClassInheritance.bind(this)(fclos, supers[i])
      }
    }

    /**
     *
     * @param fclos
     * @param superId
     */
    function _resolveClassInheritance(this: any, fclos: any, superId: any) {
      if (fclos?.id === superId?.name) {
        return
      }
      const superClos = this.processInstruction(scope, superId, state)
      if (!superClos) return UndefinedValue()
      fclos.super = superClos

      const superValue = fclos.value.super || Scope.createSubScope('super', fclos, 'fclos')
      superValue.parent = superClos
      for (const fieldName in superClos.value) {
        if (fieldName === 'super') continue
        const v = superClos.value[fieldName]
        if (v.readonly) continue
        const v_copy = _.clone(v)
        v_copy.inherited = true
        v_copy._this = fclos
        v_copy._base = superClos
        fclos.value[fieldName] = v_copy

        superValue.value[fieldName] = v_copy
        if (fieldName === '_CTOR_') {
          superValue.fdef = v_copy.fdef
          superValue.overloaded = superValue.overloaded || []
          superValue.overloaded.push(fdef)
        }
      }

      for (const x in superClos.decls) {
        const v = superClos.decls[x]
        fclos.decls[x] = v
      }
      for (const x in superClos.modifier) {
        const v = superClos.modifier[x]
        fclos.modifier[x] = v
      }
      if (superClos.inits) {
        for (const x of superClos.inits) {
          fclos.inits.add(x)
        }
      }
      if (superClos.fdata) {
        if (!fclos.fdata) fclos.fdata = {}
        for (const x in superClos.fdata) {
          fclos.fdata[x] = superClos.fdata[x]
        }
      }
    }
  }

  /**
   * 扫描并解析 Python 模块
   *
   * 注意：Python Analyzer 使用批量解析方式，流程如下：
   * 1. 先批量解析所有文件为 AST（parseCode）
   * 2. 然后逐个预加载模块信息（preload）
   * 3. 最后逐个处理模块（processModule）
   *
   * @param dir - 项目目录
   * @param isReScan - 是否为重新扫描
   */
  scanModules(dir: any, isReScan: boolean = false) {
    const { options } = this
    const modules = FileUtil.loadAllFileTextGlobby(
      ['**/*.(py)', '!**/.venv/**', '!**/vendor/**', '!**/node_modules/**', '!**/site-packages/**'],
      dir
    )
    this.fileList = globby
      .sync(['**/*.(py)', '!**/.venv/**', '!**/vendor/**', '!**/node_modules/**', '!**/site-packages/**'], {
        cwd: dir,
        caseSensitiveMatch: false,
      })
      .map((relativePath: string) => path.resolve(dir, relativePath))
    if (modules.length === 0) {
      handleException(
        null,
        'find no target compileUnit of the project : no python file found in source path',
        'find no target compileUnit of the project : no python file found in source path'
      )
      process.exit(1)
    }

    // 开始 parseCode 阶段：批量解析所有 Python 包为 AST
    this.performanceTracker.start('preProcess.parseCode')
    PythonParser.parsePackages(this.astManager, dir, options)
    this.performanceTracker.end('preProcess.parseCode')

    this.performanceTracker.start('preProcess.preload')
    for (const mod of modules) {
      const filename = mod.file
      const ast = this.astManager[filename]
      if (ast) {
        SourceLine.storeCode(mod.file, mod.content)
        this.addASTInfo(ast, mod.content, mod.file, isReScan as any)
      }
    }
    this.performanceTracker.end('preProcess.preload')

    // 开始 ProcessModule 阶段：处理所有模块（分析 AST）
    this.performanceTracker.start('preProcess.processModule')
    for (const mod of modules) {
      const filename = mod.file
      const ast = this.astManager[filename]
      if (ast) {
        this.processModule(ast, filename, isReScan as any)
      }
    }
    this.performanceTracker.end('preProcess.processModule')
  }
}

/**
 *
 * @param type
 */
function needCompileFirst(type: any) {
  return ['FunctionDefinition', 'ClassDefinition'].indexOf(type) !== -1
}

export = PythonAnalyzer
