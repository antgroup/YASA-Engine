const { Analyzer } = require('../../common')
const CheckerManager = require('../../common/checker-manager')
const Rules = require('../../../../checker/common/rules-basic-handler')
const pythonParser = require('../../../parser/python/python-ast-builder')
const {
  ValueUtil: { ObjectValue, Scoped, PrimitiveValue, UndefinedValue, UnionValue, SymbolValue, PackageValue },
} = require('../../../util/value-util')
const logger = require('../../../../util/logger')(__filename)
const config = require('../../../../config')
const { ErrorCode, Errors } = require('../../../../util/error-code')
const { normalizeAndJoin, assembleFullPath } = require('../../../../util/file-util')
const path = require('path')
const fs = require('fs-extra')
const SourceLine = require('../../common/source-line')
const uuid = require('node-uuid')
const Scope = require('../../common/scope')
const MemState = require('../../common/memState')
const { unionAllValues } = require('../../common/memStateBVT')
const AstUtil = require('../../../../util/ast-util')
const { floor } = require('lodash')
const Stat = require('../../../../util/statistics')
const constValue = require('../../../../util/constant')
const entryPointConfig = require('../../common/current-entrypoint')
const FileUtil = require('../../../../util/file-util')
const globby = require('fast-glob')
const _ = require('lodash')
const { initRulesMap } = require('../../../../checker/common/rules-basic-handler')
const { getSourceNameList } = require('./entrypoint-collector/python-entrypoint')
const { handleException } = require('../../common/exception-handler')

/**
 *
 */
class PythonAnalyzer extends Analyzer {
  /**
   *
   * @param options
   */
  constructor(options) {
    const checkerManager = new CheckerManager(
      options,
      options.checkerIds,
      options.checkerPackIds,
      options.printers,
      Rules
    )
    super(checkerManager, options)
    initRulesMap(options.ruleConfigFile)

    this.fileList = []
    this.astManager = {}
  }

  /**
   *
   * @param dir
   * @returns {Promise<void>}
   */
  async preProcess(dir) {
    try {
      this.thisIterationTime = 0
      this.prevIterationTime = new Date().getTime()

      this.scanModules(dir)
      this.astManager = {}
    } catch (e) {
      handleException(
        e,
        `Error in PythonAnalyzer:preProcess \n${this.traceNodeInfo(this.lastProcessedNode)}`,
        `Error in PythonAnalyzer:preProcess \n${this.traceNodeInfo(this.lastProcessedNode)}`
      )
    }
  }

  /**
   *
   * @param source
   * @param fileName
   */
  preProcess4SingleFile(source, fileName) {
    this.thisIterationTime = 0
    this.prevIterationTime = new Date().getTime()
    this.fileList = [fileName]
    const { options } = this
    const ast = pythonParser.parseSingleFile(fileName, options)
    this.astManager[fileName] = ast
    this.addASTInfo(source, fileName, false)
    if (ast) {
      this.processModule(ast, fileName, false)
    }
    SourceLine.storeCode(fileName, source)
  }

  /**
   *
   *
   */
  symbolInterpret() {
    const { entryPoints } = this
    const state = this.initState(this.topScope)

    if (_.isEmpty(entryPoints)) {
      logger.info('[symbolInterpret]：EntryPoints are not found')
      return true
    }
    const hasAnalysised = []
    for (const entryPoint of entryPoints) {
      if (entryPoint.type === constValue.ENGIN_START_FUNCALL) {
        if (hasAnalysised.includes(`${entryPoint.filePath}.${entryPoint.functionName}`)) {
          continue
        }

        hasAnalysised.push(`${entryPoint.filePath}.${entryPoint.functionName}`)
        entryPointConfig.setCurrentEntryPoint(entryPoint)
        logger.info(
          'EntryPoint [%s.%s] is executing',
          entryPoint.filePath?.substring(0, entryPoint.filePath?.lastIndexOf('.')),
          entryPoint.functionName
        )

        const fileFullPath = assembleFullPath(entryPoint.filePath, config.maindir)
        const sourceNameList = getSourceNameList()
        this.refreshCtx(this.moduleManager.field[fileFullPath]?.field, sourceNameList)
        this.refreshCtx(this.fileManager[fileFullPath]?.field, sourceNameList)
        this.refreshCtx(this.packageManager.field[fileFullPath], sourceNameList)

        const argValues = []
        try {
          for (const key in entryPoint.entryPointSymVal?.ast?.parameters) {
            argValues.push(
              this.processInstruction(
                entryPoint.entryPointSymVal,
                entryPoint.entryPointSymVal?.ast?.parameters[key]?.id,
                this.state
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

        this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)
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
        if (hasAnalysised.includes(`fileBegin:${entryPoint.filePath}`)) {
          continue
        }
        hasAnalysised.push(`fileBegin:${entryPoint.filePath}`)
        entryPointConfig.setCurrentEntryPoint(entryPoint)
        logger.info('EntryPoint [%s] is executing ', entryPoint.filePath)
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
  processBinaryExpression(scope, node, state) {
    /*
   { operator,
     left,
     right
    }
    */
    const new_node = _.clone(node)
    new_node.ast = node
    const new_left = (new_node.left = this.processInstruction(scope, node.left, state))
    const new_right = (new_node.right = this.processInstruction(scope, node.right, state))
    // return nativeResolver.simplifyBinaryExpression(new_node);

    if (node.operator === 'push') {
      this.processOperator(new_left.parent ? new_left.parent : new_left, node.left, new_right, node.operator, state)
    }
    if (node.operator === 'instanceof') {
      new_node._meta.type = node.right
    }
    // const taint = CommonUtil.mergeSets(new_node.left && new_node.left.taint, new_node.right && new_node.right.taint);
    // if (taint) new_node.taint = taint;
    const has_tag = (new_left && new_left.hasTagRec) || (new_right && new_right.hasTagRec)
    if (has_tag) {
      new_node.hasTagRec = has_tag
      // new_node.taint = new_left.taint || new_right.taint;
      // new_node.trace = new_left.trace || new_right.trace;
    }

    if (this.checkerManager && this.checkerManager.checkAtBinaryOperation)
      this.checkerManager.checkAtBinaryOperation(this, scope, node, state, { newNode: new_node })

    return SymbolValue(new_node)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processCallExpression(scope, node, state) {
    /* { callee,
        arguments,
      }
   */
    if (this.checkerManager && this.checkerManager.checkAtFuncCallSyntax)
      this.checkerManager.checkAtFuncCallSyntax(this, scope, node, state, {
        pcond: state.pcond,
        einfo: state.einfo,
      })

    const fclos = this.processInstruction(scope, node.callee, state)
    if (node?.callee?.type === 'MemberAccess' && fclos.fdef && node.callee?.object?.type !== 'SuperExpression') {
      fclos._this = this.processInstruction(scope, node.callee.object, state)
    }
    // if (DEBUG)
    //     logger.info("fclos: " + Scope.formatScope(fclos));
    if (!fclos) return UndefinedValue()

    // prepare the function arguments
    const argvalues = []
    const same_args = true // minor optimization to save memory

    /**
     *
     * @param paramAST
     * @param positionalArgs
     * @param keywordArgs
     * @param len
     */
    function collectArgsFromArray(paramAST, positionalArgs, keywordArgs, len) {
      // 提取形参名称列表（按形参顺序）
      const paramNames = paramAST.map((node) => node.id.name)

      // 初始化结果数组，长度与形参相同，默认填充为 undefined
      const collectedArgs = new Array(len).fill(undefined)

      // 1. 处理位置参数（按顺序填充）
      positionalArgs.forEach((arg, index) => {
        if (index < collectedArgs.length) {
          collectedArgs[index] = arg
        }
      })

      // 2. 处理命名参数（通过名字填充）
      for (const [key, value] of Object.entries(keywordArgs)) {
        const paramIndex = paramNames.indexOf(key)
        if (paramIndex !== -1) {
          collectedArgs[paramIndex] = value
        }
      }

      // 返回结果数组，按形参顺序排列
      return collectedArgs
    }

    const positionalArgs = []
    const keywordArgs = {}
    for (const arg of node.arguments) {
      if (arg.type === 'VariableDeclaration') {
        keywordArgs[arg.id.name] = arg
      } else {
        positionalArgs.push(arg)
      }
    }
    let collectedArgs
    if (fclos.fdef && fclos.fdef.type === 'FunctionDefinition') {
      collectedArgs = collectArgsFromArray(fclos.ast.parameters, positionalArgs, keywordArgs, node.arguments.length)
    } else {
      collectedArgs = node.arguments
    }

    for (const arg of collectedArgs) {
      const argv = this.processInstruction(scope, arg, state)
      if (logger.isTraceEnabled()) logger.trace(`arg: ${this.formatScope(argv)}`)
      if (Array.isArray(argv)) {
        argvalues.push(...argv)
      } else {
        argvalues.push(argv)
      }
    }

    if (fclos.vtype === 'class' && fclos.field && fclos.field.hasOwnProperty('_CTOR_')) {
      return this.buildNewObject(fclos.cdef, argvalues, fclos, state, node, scope)
      // const new_fclos = _.clone(fclos)
      // fclos = new_fclos.field._CTOR_
    }

    // todo 迁移到builtin中去
    if (node.callee.type === 'MemberAccess' && node.callee.property.name === 'append' && fclos?.object?.parent) {
      this.saveVarInCurrentScope(fclos.object.parent, fclos.object, argvalues[0], state)
      return
    }
    // analyze the resolved function closure and the function arguments
    const res = this.executeCall(node, fclos, argvalues, state, scope)
    // if (DEBUG) logger.info("aftercall: " + Scope.formatScope(res));

    // function definition not found, examine possible call-back functions in the arguments
    if (fclos.vtype !== 'fclos' && config.invokeCallbackOnUnknownFunction) {
      this.executeFunctionInArguments(scope, fclos, node, argvalues, state)
    }

    if (res && this.checkerManager?.checkAtFunctionCallAfter) {
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
  processIdentifier(scope, node, state) {
    const res = super.processIdentifier(scope, node, state)
    this.checkerManager.checkAtIdentifier(this, scope, node, state, { res })
    return res
  }

  /**
   * handle module imports: import "module"
   * @param scope
   * @param node
   * @param state
   * @returns {*}
   */
  processImportDirect(scope, node, state) {
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
    const parts = config.maindir.split('/')
    const appName = parts[parts.length - 1]
    // 处理import xxx
    if (!from) {
      let pathname = normalizeAndJoin(path.dirname(sourcefile.toString()), importName)
      // import的路径是用户定义的文件
      if (this.fileList.includes(`${pathname}.py`)) {
        pathname = `${pathname}.py`
        // 如果已经处理过，直接从modulemanager中取出
        const m = this.moduleManager.field[pathname]
        if (m) {
          return m
        }
        // 如果还没有被处理，先处理import的内容
        try {
          const ast = this.astManager[pathname]
          if (ast) {
            return this.processModule(ast, pathname, false)
          }
        } catch (e) {
          handleException(
            e,
            `Error: PythonAnalyzer.processImportDirect: failed to loading: ${pathname}`,
            `Error: PythonAnalyzer.processImportDirect: failed to loading: ${pathname}`
          )
        }
      } else if (fs.existsSync(pathname) && fs.statSync(pathname) && fs.statSync(pathname).isDirectory()) {
        // import package
        const index = pathname?.indexOf(appName)
        const packageNames = pathname.substring(index).split('/')
        let packageValue = this.packageManager
        let packageName
        for (packageName of packageNames) {
          packageValue = packageValue?.field[packageName]
        }
        if (packageValue) {
          return packageValue
        }
        const initFilePath = `${pathname}/__init__.py`
        if (this.fileList.includes(initFilePath)) {
          try {
            const ast = this.astManager[initFilePath]
            if (ast) {
              return this.processModule(ast, initFilePath, false)
            }
          } catch (e) {
            handleException(
              e,
              `Error: PythonAnalyzer.processImportDirect: failed to loading: ${initFilePath}`,
              `Error: PythonAnalyzer.processImportDirect: failed to loading: ${initFilePath}`
            )
          }
        }
      } else {
        // 三方库
        return this.loadPredefinedModule(scope, importName, 'syslib_from', state)
      }
      return UndefinedValue()
    }
    // 处理from xxx import xxx
    const fname = from?.value.replace(/(?<=[^.])\./g, '/')
    let pathname = normalizeAndJoin(path.dirname(sourcefile.toString()), fname)
    if (this.fileList.includes(`${pathname}.py`)) {
      pathname = `${pathname}.py`
      // 如果已经处理过，直接从modulemanager中取出
      let m = this.moduleManager.field[pathname]
      if (m) {
        if (imported && imported.name !== '*') {
          const field = m.field[imported.name]
          if (field) {
            return field
          }
        }
        return m
      }
      // 如果还没有被处理，先处理import的内容
      try {
        const ast = this.astManager[pathname]
        if (ast) {
          m = this.processModule(ast, pathname, false)
          if (m) {
            if (imported && imported.name !== '*') {
              const field = m.field[imported.name]
              if (field) {
                return field
              }
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
      // from package import module
      const importPath = `${pathname}/${importName}.py`
      if (this.fileList.includes(importPath)) {
        // 如果已经处理过，直接从modulemanager中取出
        const m = this.moduleManager.field[importPath]
        if (m) {
          return m
        }
        // 如果还没有被处理，先处理import的内容
        try {
          const ast = this.astManager[importPath]
          if (ast) {
            return this.processModule(ast, importPath, false)
          }
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
            if (field) {
              return field
            }
          }
          return packageValue
        }
        for (const file of this.fileList) {
          if (file.startsWith(pathname) && path.basename(file) === '__init__.py') {
            try {
              const ast = this.astManager[file]
              if (ast) {
                packageValue = this.processModule(ast, file, false)
                if (imported && imported.name !== '*') {
                  const field = packageValue.field[imported.name]
                  if (field) {
                    return field
                  }
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
      return this.loadPredefinedModule(scope, imported?.name, from?.value, state)
    }
    return UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processMemberAccess(scope, node, state) {
    /**
     object,
     property,
     computed
     */
    const defscope = this.processInstruction(scope, node.object, state)
    const prop = node.property
    let resolved_prop = prop
    if (node.computed) {
      resolved_prop = this.processInstruction(scope, prop, state) // important, prop should be eval by scope rather than defscope
    } else {
      // non-computed indicates node.property must be identifier
      if (prop.type !== 'Identifier' && prop.type !== 'Literal') {
        // Errors.UnexpectedValue('type should be Identifier when property is non computed', { no_throw: true })
        // try to solve prop in this case though
        resolved_prop = this.processInstruction(scope, prop, state)
      }
    }
    if (prop.type === 'Identifier' && prop.name === '__init__' && prop.parent?.parent?.type === 'CallExpression') {
      resolved_prop.name = '_CTOR_'
    }
    if (!resolved_prop) {
      return defscope
    }
    return this.getMemberValue(defscope, resolved_prop, state)
  }

  /**
   * process module with cache
   * @param ast
   * @param filename
   * @param isReScan
   * @returns {*}
   */
  processModule(ast, filename, isReScan) {
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
      relateFileName = ast.loc?.sourcefile?.startsWith(config.maindirPrefix)
        ? ast.loc.sourcefile?.substring(config.maindirPrefix.length).split('.')[0]
        : ast.loc.sourcefile.split('.')[0]
    }
    const modClos = Scoped({ sid: relateFileName, parent: this.topScope, decls: {}, fdef: ast, ast })
    this.moduleManager.field[filename] = modClos
    this.fileManager[filename] = modClos
    m = this.processModuleDirect(ast, filename, modClos)
    m.ast = ast
    return m
  }

  /**
   *
   * @param node
   * @param filename
   * @param modClos
   */
  processModuleDirect(node, filename, modClos) {
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
    this.processInstruction(modClos, node, state) // process compile unit
    return modClos
  }

  /**
   * process object creation. Retrieve the function definition
   * @param scope
   * @param node
   * @param state
   * @returns {*}
   */
  processNewObject(scope, node, state) {
    // if (DEBUG) logger.info("processInstruction: NewExpression " + formatNode(node));
    const call = node

    // try obtaining the class/function definition in the current scope
    let fclos = this.processInstruction(scope, node.callee, state)
    if (!fclos) {
      return
    }
    if (fclos.vtype === 'union') {
      fclos = fclos.value[0] // FIXME
    }

    let argvalues = []
    if (call.arguments) {
      let same_args = true // minor optimization to save memory
      for (const arg of call.arguments) {
        const argv = this.processInstruction(scope, arg, state)
        if (argv !== arg) same_args = false
        argvalues.push(argv)
      }
      if (same_args) argvalues = call.arguments
    }

    const { fdef } = fclos
    // if (analysisutil.isInCallStack(fdef, state.callstack)) return;

    const obj = this.buildNewObject(fdef, argvalues, fclos, state, node, scope)
    if (logger.isTraceEnabled()) logger.trace(`new expression: ${this.formatScope(obj)}`)

    if (obj && this.checkerManager?.checkAtNewExprAfter) {
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
  processOperator(scope, node, argvalues, operator, state) {
    switch (operator) {
      case 'push': {
        // scope.setFieldValue(argvalues.sid, argvalues)
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
  processReturnStatement(scope, node, state) {
    // { expression }
    // if (DEBUG) logger.info('return ' + JSON.stringify(node));
    // lastReturnValue should be treated as union since there are multi return points in one func
    if (node.argument) {
      const return_value = this.processInstruction(scope, node.argument, state)
      if (!node.isYield) {
        if (!this.lastReturnValue) {
          this.lastReturnValue = return_value
        } else if (this.lastReturnValue.vtype === 'union') {
          this.lastReturnValue.appendValue(return_value)
        } else {
          const tmp = UnionValue()
          tmp.appendValue(this.lastReturnValue)
          tmp.appendValue(return_value)
          this.lastReturnValue = tmp
        }
        if (!(node.argument.type === 'Identifier' && node.argument.name === 'self')) {
          if (node.loc && this.lastReturnValue)
            this.lastReturnValue = SourceLine.addSrcLineInfo(
              this.lastReturnValue,
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
  processScopedStatement(scope, node, state) {
    /*
    { statements }
    */
    if (node.parent?.type === 'TryStatement') {
      node.body.filter((n) => needCompileFirst(n.type)).forEach((s) => this.processInstruction(scope, s, state))
      node.body.filter((n) => !needCompileFirst(n.type)).forEach((s) => this.processInstruction(scope, s, state))
    } else {
      const { loc } = node
      let scopeName
      if (loc) {
        scopeName = `<block_${loc.start?.line}_${loc.start?.column}_${loc.end?.line}_${loc.end?.column}>`
      } else {
        scopeName = `<block_${uuid.v4()}>`
      }
      const block_scope = Scope.createSubScope(scopeName, scope, 'scope')
      // definition hoisting handle definion first
      node.body.filter((n) => needCompileFirst(n.type)).forEach((s) => this.processInstruction(block_scope, s, state))
      node.body.filter((n) => !needCompileFirst(n.type)).forEach((s) => this.processInstruction(block_scope, s, state))
    }

    if (this.checkerManager && this.checkerManager.checkAtEndOfBlock) {
      this.checkerManager.checkAtEndOfBlock(this, scope, node, state, {})
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processVariableDeclaration(scope, node, state) {
    const initialNode = node.init
    const { id } = node
    if (!id || id?.name === '_') return UndefinedValue()

    let initVal
    if (!initialNode) {
      initVal = this.createVarDeclarationScope(id, scope)
      initVal.uninit = !initialNode
      initVal = SourceLine.addSrcLineInfo(initVal, id, id.loc && id.loc.sourcefile, 'Var Pass: ', id.name)
    } else if (node?.parent?.type === 'CatchClause' && node?._meta?.isCatchParam && state?.throwstack?.length > 0) {
      // 处理throw传递到catch的情况
      initVal = state?.throwstack && state?.throwstack.shift()
      initVal = SourceLine.addSrcLineInfo(initVal, node, node.loc && node.loc.sourcefile, 'Var Pass: ', id.name)
      delete node._meta.isCatchParm
    } else {
      initVal = this.processInstruction(scope, initialNode, state)
      if (!(id.type === 'Identifier' && id.name === 'self' && initialNode.type === 'ThisExpression')) {
        initVal = SourceLine.addSrcLineInfo(initVal, node, node.loc && node.loc.sourcefile, 'Var Pass: ', id.name)
      }
    }

    if (this.checkerManager && this.checkerManager.checkAtPreDeclaration)
      this.checkerManager.checkAtPreDeclaration(this, scope, node, state, {
        lnode: id,
        rvalue: null,
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
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
      // 解构Tuple赋值，分别分发到Tuple里的每个元素
      if (initVal.vtype === 'union') {
        const pairs = floor(initVal.field.length / id.elements.length)
        const scopes = new Array(id.elements.length)
        for (let i = 0; i < id.elements.length; i++) {
          scopes[i] = new Array(pairs)
        }
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
        for (const i in id.elements) {
          this.saveVarInCurrentScope(scope, id.elements[i], initVal, state)
        }
      }
    } else {
      this.saveVarInCurrentScope(scope, id, initVal, state)
    }

    // set alias name if val itself has no identifier
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
      // initVal.sort = (!id.typeName || id.typeName.name === 'var') ?
      //     TypeUtil.inferType(initVal) : id.typeName;
      initVal.sort = declTypeVal.sort
    }
    return initVal

    /**
     *
     * @param obj
     */
    function isSequentialNumericKeysField(obj) {
      // 首先判断 field 是否存在且是对象（且不是数组或null）
      if (!obj || typeof obj.field !== 'object' || Array.isArray(obj.field) || obj.field === null) {
        return false
      }
      const keys = Object.keys(obj.field)
      if (keys.length === 0) return false // 没有条目不算
      // 检查所有key都是数字且无空缺
      // keys需要排序，因为对象属性顺序不保证
      const numericKeys = keys.map((k) => Number(k))
      if (numericKeys.some(isNaN)) return false // 有不是数字的key
      numericKeys.sort((a, b) => a - b)
      // 检查是否都是从0递增
      for (let i = 0; i < numericKeys.length; i++) {
        if (numericKeys[i] !== i) {
          return false
        }
      }
      return true
    }
  }

  /**
   * parse src and process module
   * @param ast
   * @param source
   * @param filename
   * @param isReScan
   */
  addASTInfo(ast, source, filename, isReScan) {
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
  loadPredefinedModule(scope, importName, fname) {
    // considering two aspect:
    // 1. built-in module
    // 2. importing from third party package in node_modules

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
    // v.parent = m;
    this.moduleManager.field[fname] = m
    return objval
  }

  /**
   * parse file src and preload package
   * @param ast
   * @param filename
   * @returns {*}
   */
  preloadFileToPackage(ast, filename) {
    const fullString = path.dirname(filename)
    const parts = config.maindir.split('/')
    const appName = parts[parts.length - 1]
    let packageName = appName
    if (fullString) {
      if (fullString !== config.maindir) {
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
      m.ast = ast
      return m
    }
  }

  /**
   *
   * @param scope
   * @param cdef
   * @param state
   */
  preProcessClassDefinition(scope, cdef, state) {
    if (!(cdef && cdef.body)) return UndefinedValue() // Should not happen

    // pre-processing
    const fname = cdef.id?.name

    const cscope = Scope.createSubScope(fname, scope, 'class') // class scope
    cscope.cdef = cdef
    cscope.modifier = {}
    cscope.inits = new Set() // for storing the variables initialized in the constructor
    this.resolveClassInheritance(cscope, state) // inherit base classes

    if (!cscope.fdata) cscope.fdata = {} // for class-level analysis data

    if (cdef) {
      const oldThisFClos = this.thisFClos
      this.entry_fclos = this.thisFClos = cscope
      // process variable/method declarations and so forth
      this.processInstruction(cscope, cdef.body, state)
      for (const x in cscope.value) {
        const v = cscope.value[x]
        v._this = cscope
      }
      cscope._this = cscope
      this.thisFClos = oldThisFClos
    }

    // post-processing
    // logger.log('Done with class: ', fname);
    return cscope
  }

  /**
   *
   * @param obj
   * @param blacklist
   */
  refreshCtx(obj, blacklist) {
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
  resolveClassInheritance(fclos, state) {
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
    function _resolveClassInheritance(fclos, superId) {
      if (fclos?.id === superId?.name) {
        // to avoid self-referencing
        return
      }
      const superClos = this.processInstruction(scope, superId, state)
      // const superClos = this.getMemberValue(scope, superId, state);
      if (!superClos) return UndefinedValue()
      fclos.super = superClos

      // inherit definitions
      // superValue is used to record values of super class, so that we can handle cases like super.xxx() or super()
      const superValue = fclos.value.super || Scope.createSubScope('super', fclos, 'fclos')
      // super's parent should be assigned to base, _this will track on fclos
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
        // super fclos should fill its fdef with ctor definition
        if (fieldName === '_CTOR_') {
          superValue.fdef = v_copy.fdef
          superValue.overloaded = superValue.overloaded || []
          superValue.overloaded.push(fdef)
        }

        // v_copy.parent = fclos;  // Important!
      }

      // inherit declarations
      for (const x in superClos.decls) {
        const v = superClos.decls[x]
        fclos.decls[x] = v
      }
      // inherit modifiers
      for (const x in superClos.modifier) {
        const v = superClos.modifier[x]
        fclos.modifier[x] = v
      }
      // inherit initialized variables
      if (superClos.inits) {
        for (const x of superClos.inits) {
          fclos.inits.add(x)
        }
      }
      // inherit the fdata
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
  scanModules(dir, isReScan = false) {
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
      .map((relativePath) => path.resolve(dir, relativePath))
    if (modules.length === 0) {
      Errors.NoCompileUnitError('no python file found in source path')
    }
    pythonParser.parsePackages(this.astManager, dir, options)
    for (const mod of modules) {
      const filename = mod.file
      const ast = this.astManager[filename]
      if (ast) {
        SourceLine.storeCode(mod.file, mod.content)
        this.addASTInfo(ast, mod.content, mod.file, isReScan)
      }
    }
    for (const mod of modules) {
      const filename = mod.file
      const ast = this.astManager[filename]
      if (ast) {
        this.processModule(ast, filename, isReScan)
      }
    }
  }
}

/**
 *
 * @param type
 */
function needCompileFirst(type) {
  return ['FunctionDefinition', 'ClassDefinition'].indexOf(type) !== -1
}

module.exports = PythonAnalyzer
