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
const { normalizeAndJoin, assembleFullPath } = require('../../../../util/file-util')
const path = require('path')
const fs = require('fs-extra')
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
    this.totalParseTime = 0
    this.totalProcessTime = 0
  }

  /**
   *
   * @param dir
   */
  async preProcess(dir: any) {
    try {
      ;(this as any).thisIterationTime = 0
      ;(this as any).prevIterationTime = new Date().getTime()

      this.scanModules(dir)
      this.astManager = {}
      logger.info(`ParseCode time: ${this.totalParseTime}ms`)
      logger.info(`ProcessModule time: ${this.totalProcessTime}ms`)
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

    if (fclos.vtype === 'class' && fclos.field && Object.prototype.hasOwnProperty.call(fclos.field, '_CTOR_')) {
      return this.buildNewObject(fclos.cdef, argvalues, fclos, state, node, scope)
    }

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
   */
  processIdentifier(scope: any, node: any, state: any) {
    const res = super.processIdentifier(scope, node, state)
    this.checkerManager.checkAtIdentifier(this, scope, node, state, { res })
    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processImportDirect(scope: any, node: any, state: any) {
    const { options } = this
    let { from, imported } = node
    let sourcefile
    while (imported) {
      sourcefile = imported.loc.sourcefile
      if (sourcefile) break
      imported = from.parent
    }
    if (!sourcefile) {
      handleException(
        null,
        'Error occurred in PythonAnalyzer.processImportDirect: failed to sourcefile in ast',
        'Error occurred in PythonAnalyzer.processImportDirect: failed to sourcefile in ast'
      )
      return
    }
    const importName = imported.value?.replaceAll('.', '/') || imported.name?.replaceAll('.', '/')
    const parts = Config.maindir.split('/')
    const appName = parts[parts.length - 1]
    if (!from) {
      let pathname = normalizeAndJoin(path.dirname(sourcefile.toString()), importName)
      if (this.fileList.includes(`${pathname}.py`)) {
        pathname = `${pathname}.py`
        const m = this.moduleManager.field[pathname]
        if (m) return m
        try {
          const ast = this.astManager[pathname]
          if (ast) return this.processModule(ast, pathname, false as any)
        } catch (e) {
          handleException(
            e,
            `Error: PythonAnalyzer.processImportDirect: failed to loading: ${pathname}`,
            `Error: PythonAnalyzer.processImportDirect: failed to loading: ${pathname}`
          )
        }
      } else if (fs.existsSync(pathname) && fs.statSync(pathname) && fs.statSync(pathname).isDirectory()) {
        const index = pathname?.indexOf(appName)
        const packageNames = pathname.substring(index).split('/')
        let packageValue = this.packageManager
        let packageName
        for (packageName of packageNames) {
          packageValue = packageValue?.field[packageName]
        }
        if (packageValue) return packageValue
        const initFilePath = `${pathname}/__init__.py`
        if (this.fileList.includes(initFilePath)) {
          try {
            const ast = this.astManager[initFilePath]
            if (ast) return this.processModule(ast, initFilePath, false as any)
          } catch (e) {
            handleException(
              e,
              `Error: PythonAnalyzer.processImportDirect: failed to loading: ${initFilePath}`,
              `Error: PythonAnalyzer.processImportDirect: failed to loading: ${initFilePath}`
            )
          }
        }
      } else {
        return this.loadPredefinedModule(scope, importName, 'syslib_from')
      }
      return UndefinedValue()
    }
    const fname = from?.value.replace(/(?<=[^.])\./g, '/')
    let pathname = normalizeAndJoin(path.dirname(sourcefile.toString()), fname)
    if (this.fileList.includes(`${pathname}.py`)) {
      pathname = `${pathname}.py`
      let m = this.moduleManager.field[pathname]
      if (m) {
        if (imported && imported.name !== '*') {
          const field = m.field[imported.name]
          if (field) return field
        }
        return m
      }
      try {
        const ast = this.astManager[pathname]
        if (ast) {
          m = this.processModule(ast, pathname, false as any)
          if (m) {
            if (imported && imported.name !== '*') {
              const field = m.field[imported.name]
              if (field) return field
            }
            return m
          }
        }
      } catch (e) {
        handleException(
          e,
          `Error: PythonAnalyzer.processImportDirect: failed to loading: ${pathname}`,
          `Error: PythonAnalyzer.processImportDirect: failed to loading: ${pathname}`
        )
      }
    } else if (fs.existsSync(pathname) && fs.statSync(pathname) && fs.statSync(pathname).isDirectory()) {
      const importPath = `${pathname}/${importName}.py`
      if (this.fileList.includes(importPath)) {
        const m = this.moduleManager.field[importPath]
        if (m) return m
        try {
          const ast = this.astManager[importPath]
          if (ast) return this.processModule(ast, importPath, false as any)
        } catch (e) {
          handleException(
            e,
            `Error: PythonAnalyzer.processImportDirect: failed to loading: ${importPath}`,
            `Error: PythonAnalyzer.processImportDirect: failed to loading: ${importPath}`
          )
        }
      } else {
        const index = pathname?.indexOf(appName)
        const packageNames = pathname.substring(index).split('/')
        let packageValue = this.packageManager
        let packageName
        for (packageName of packageNames) {
          packageValue = packageValue?.field[packageName]
        }
        if (packageValue) {
          if (imported && imported.name !== '*') {
            const field = packageValue.field[imported.name]
            if (field) return field
          }
          return packageValue
        }
        for (const file of this.fileList) {
          if (file.startsWith(pathname) && path.basename(file) === '__init__.py') {
            try {
              const ast = this.astManager[file]
              if (ast) {
                packageValue = this.processModule(ast, file, false as any)
                if (imported && imported.name !== '*') {
                  const field = packageValue.field[imported.name]
                  if (field) return field
                }
                return packageValue
              }
            } catch (e) {
              handleException(
                e,
                `Error: PythonAnalyzer.processImportDirect: failed to loading: ${file}`,
                `Error: PythonAnalyzer.processImportDirect: failed to loading: ${file}`
              )
            }
          }
        }
      }
    } else {
      // 三方库
      return this.loadPredefinedModule(scope, imported?.name, from?.value)
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
      const block_scope = Scope.createSubScope(scopeName, scope, 'scope')
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
    } else if (id.type === 'TupleExpression') {
      if (initVal.vtype === 'union') {
        const pairs = floor(initVal.field.length / id.elements.length)
        const scopes = new Array(id.elements.length)
        for (let i = 0; i < id.elements.length; i++) scopes[i] = new Array(pairs)
        for (let i = 0; i < pairs; i++) {
          for (let j = 0; j < id.elements.length; j++) {
            scopes[j][i] = initVal.field[i * id.elements.length + j]
          }
        }
        for (let i = 0; i < id.elements.length; i++) {
          const union = unionAllValues(scopes[i], state)
          this.saveVarInCurrentScope(scope, id.elements[i], union, state)
        }
      } else if (Array.isArray(initVal.field) && initVal.field.length >= 1) {
        const minLen = Math.min(id.elements.length, initVal.field.length)
        for (let i = 0; i < minLen; i++) {
          this.saveVarInCurrentScope(scope, id.elements[i], initVal.field[i], state)
        }
      } else if (isSequentialNumericKeysField(initVal)) {
        const minLen = Math.min(id.elements.length, Object.keys(initVal.field).length)
        for (let i = 0; i < minLen; i++) {
          this.saveVarInCurrentScope(scope, id.elements[i], initVal.field[i], state)
        }
      } else {
        for (const i in id.elements) this.saveVarInCurrentScope(scope, id.elements[i], initVal, state)
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
   *
   * @param dir
   * @param isReScan
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
      Errors.NoCompileUnitError('no python file found in source path')
      process.exit(1)
    }

    // 记录parsePackages耗时
    const parseStart = Date.now()
    PythonParser.parsePackages(this.astManager, dir, options)
    const parseTime = Date.now() - parseStart
    this.totalParseTime += parseTime

    for (const mod of modules) {
      const filename = mod.file
      const ast = this.astManager[filename]
      if (ast) {
        SourceLine.storeCode(mod.file, mod.content)
        this.addASTInfo(ast, mod.content, mod.file, isReScan as any)
      }
    }

    // 记录processModule耗时
    const processStart = Date.now()
    for (const mod of modules) {
      const filename = mod.file
      const ast = this.astManager[filename]
      if (ast) {
        this.processModule(ast, filename, isReScan as any)
      }
    }
    const processTime = Date.now() - processStart
    this.totalProcessTime += processTime
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
