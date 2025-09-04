const path = require('path')
const fs = require('fs-extra')
const globby = require('fast-glob')
const _ = require('lodash')
const UastSpec = require('@ant-yasa/uast-spec')
const logger = require('../../../../util/logger')(__filename)
const FileUtil = require('../../../../util/file-util')
const Stat = require('../../../../util/statistics')
const { ErrorCode, Errors } = require('../../../../util/error-code')
const Parsing = require('../../../parser/parsing')
const Initializer = require('./js-initializer')
const Rules = require('../../../../checker/common/rules-basic-handler')
const { AstUtil } = require('../../../../checker/common/checker-kit')
const entryPointConfig = require('../../common/current-entrypoint')
const { processBinaryOperator } = require('./builtins/operator-builtins')
const Scope = require('../../common/scope')
const { Analyzer } = require('../../common')
const CheckerManager = require('../../common/checker-manager')

const {
  valueUtil: {
    ValueUtil: { FunctionValue, ObjectValue, Scoped, PrimitiveValue, UndefinedValue },
  },
} = require('../../common')
const { handleException } = require('../../common/exception-handler')
const constValue = require('../../../../util/constant')
const config = require('../../../../config')

/**
 *
 */
class JsAnalyzer extends Analyzer {
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

    this.options = options
    this.sourceScope = {
      complete: false,
      value: [],
    }
  }

  /**
   *
   * @param source
   * @param fileName
   */
  preProcess4SingleFile(source, fileName) {
    this.initTopScope()
    this.state = this.initState()
    this.uast = this.parseUast(source, fileName)
    if (this.uast) {
      this.initModuleScope(this.uast, fileName)
      this.processModuleSrc(source, fileName)
    }
  }

  /**
   *
   * @param dir
   */
  preProcess(dir) {
    Initializer.initGlobalScope(this.topScope)

    // just scan and execute every module
    this.scanModules(dir)
  }

  /**
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
    // 自定义source入口方式，并根据入口自主加载source
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
        const argValues = []
        for (const key in entryPoint.entryPointSymVal?.ast?.parameters) {
          argValues.push(
            this.processInstruction(
              entryPoint.entryPointSymVal,
              entryPoint.entryPointSymVal?.ast?.parameters[key]?.id,
              state
            )
          )
        }
        this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)
        try {
          this.executeCall(
            entryPoint.entryPointSymVal?.ast,
            entryPoint.entryPointSymVal,
            argValues,
            state,
            entryPoint.scopeVal
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
        if (entryPoint.entryPointSymVal && entryPoint.scopeVal) {
          try {
            this.processCompileUnit(
              entryPoint.scopeVal,
              entryPoint.entryPointSymVal?.ast,
              this.initState(this.topScope)
            )
          } catch (e) {
            handleException(
              e,
              `[${entryPoint.entryPointSymVal?.ast?.loc?.sourcefile} symbolInterpret failed. Exception message saved in error log file`,
              `[${entryPoint.entryPointSymVal?.ast?.loc?.sourcefile} symbolInterpret failed. Exception message saved in error log file`
            )
          }
        } else {
          const { filePath } = entryPoint
          entryPoint.entryPointSymVal = this.fileManager[filePath]
          entryPoint.scopeVal = this.fileManager[filePath]
          try {
            this.processCompileUnit(
              entryPoint.scopeVal,
              entryPoint.entryPointSymVal?.ast,
              this.initState(this.topScope)
            )
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
   * @param dir
   */
  scanModules(dir) {
    const modules = FileUtil.loadAllFileTextGlobby(
      [
        '**/*.(js|ts|mjs|cjs)',
        '!**/*.test.(js|ts|mjs|cjs|jsx)',
        '!**/node_modules',
        '!web',
        '!**/public/**',
        '!**/*.d.ts',
        '!**/*.d.js',
      ],
      dir
    )
    if (modules.length === 0) {
      Errors.NoCompileUnitError('no javascript file found in source path')
      process.exit(1)
    }
    for (const mod of modules) {
      this.processModuleSrc(mod.content, mod.file)
    }
  }

  /**
   * parse src and process module
   * @param source
   * @param filename
   * @returns {*}
   */
  processModuleSrc(source, filename) {
    const { options } = this
    options.sourcefile = filename
    const ast = Parsing.parseCode(source, options)
    this.sourceCodeCache[filename] = source
    if (ast) {
      return this.processModule(ast, filename)
    }
  }

  /**
   *
   * @param source
   * @param filename
   */
  parseUast(source, filename) {
    const { options } = this
    options.sourcefile = filename
    this.sourceCodeCache[filename] = source
    return Parsing.parseCode(source, options)
  }

  /**
   * process module with cache
   * @param ast
   * @param filename
   * @returns {*}
   */
  processModule(ast, filename) {
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
    let m = this.moduleManager.field[filename]
    if (m) return m

    // set this.importedModules before processModuleDirect for handling cyclic dependencies properly
    // module scope init
    // value specifies what module exports, closure specifies module closure
    const modClos = this.initModuleScope(ast, filename)
    this.moduleManager.field[filename] = modClos.getFieldValue('module.exports')
    m = this.processModuleDirect(ast, filename, modClos)
    if (m && typeof m !== 'undefined') {
      m.ast = ast
      this.moduleManager.field[filename] = m
      this.fileManager[filename] = m
    }
    return m
  }

  /**
   * builtin variables and constant for module
   * @param node
   * @param file
   * @returns Unit
   */
  initModuleScope(node, file) {
    // init for module
    // const modScope = {id:file, vtype: 'modScope', value:{}, closure:{}, decls:node, parent : this.topScope, fdef:node};
    if (!file) return
    const relateFileName = file.startsWith(config.maindirPrefix)
      ? file.substring(config.maindirPrefix.length).split('.')[0]
      : file.split('.')[0]
    const modClos = Scoped({ sid: relateFileName, parent: this.topScope, decls: {}, fdef: node, ast: node })
    modClos._this = modClos

    const mod = ObjectValue({ id: 'module', parent: modClos })
    modClos.value.module = mod
    const exp = ObjectValue({ sid: 'module.exports', parent: modClos })
    mod.value.exports = exp
    modClos.value.exports = exp
    return modClos
  }

  // explore individual module
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
    // module scope init
    // value specifies what module exports, closure specifies module closure
    modClos = modClos || this.initModuleScope(node, filename)

    this.entry_fclos = modClos
    this.thisFClos = modClos

    const state = this.initState(modClos)
    this.processInstruction(modClos, node, state) // process compile unit

    // post handle module for module export
    const moduleExports = modClos.getFieldValue('module.exports')

    // 处理export是function类型的场景
    if (moduleExports?.field?.default && moduleExports?.field?.default?.vtype === 'fclos') {
      this.executeCall(moduleExports.field?.default?.ast, moduleExports.field?.default, [], state, modClos)
      Object.assign(moduleExports.field, this.entry_fclos.field)
    }
    if (this.checkerManager && this.checkerManager.checkAtEndOfCompileUnit) {
      this.checkerManager.checkAtEndOfCompileUnit(this, null, null, state, null)
    }
    // 获取file中export出来的部分
    return moduleExports
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processCallExpression(scope, node, state) {
    let res
    try {
      res = super.processCallExpression(scope, node, state)
      return res
    } catch (e) {
      // const errorMsg = `YASA Simulation Execution Error in processCallExpression.Loc is ${node.loc.sourcefile} line:${node.loc.start.line}`
      // handleException(e, errorMsg)
      return UndefinedValue()
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   * @returns {UndefinedValue}
   */
  processTryStatement(scope, node, state) {
    // 往state中创建throwstack
    state.throwstack = state.throwstack ?? []
    // 处理try的body
    this.processInstruction(scope, node.body, state)
    // 抛出了异常，且catch不为空 处理catch
    // try嵌套时 state.throwstack可能被提前删除，因此需要用可选链操作符？
    if (node.handlers && node.handlers.length > 0) {
      // nodejs 一个try只有一个catch 因此只取第一个
      const handler = node.handlers[0]
      const subScope = JsAnalyzer.createSubScope('<catchBlock>', scope)
      // 如果有异常则初始化异常的init
      if (state?.throwstack?.length > 0) {
        const throw_value = state.throwstack[0]
        for (const param of handler.parameter) {
          if (param && param.type === 'VariableDeclaration' && param.init === null) {
            param._meta.isCatchParam = true
            // 尽管throwvalue在state中
            // 但还是要设置init,如果init为空会优先进入默认的初始化逻辑
            // 则无法从state.throwstack取值
            param.init = {
              type: 'Identifier',
              // 此处替换成 最近一个throw的值即可
              name: throw_value.sid,
              callee: param.varType.id,
              arguments: [],
              _meta: param._meta,
              loc: param.loc,
              parent: param.parent,
            }
          }
        }
      }
      // 先处理catch的参数 为e赋值
      handler.parameter.forEach((param) => this.processInstruction(subScope, param, state))
      // 赋值后的e再处理body
      this.processInstruction(subScope, handler.body, state)
    }
    // 最后处理finally
    if (node.finalizer) this.processInstruction(scope, node.finalizer, state)
    // 当throwstack为空时删除throwstack
    // try嵌套时 state.throwstack可能被提前删除，因此需要用可选链操作符？
    if (state?.throwstack?.length === 0) {
      delete state.throwstack
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processAssignmentExpression(scope, node, state) {
    let res
    try {
      res = super.processAssignmentExpression(scope, node, state)
    } catch (e) {
      return UndefinedValue()
    }

    // 如果是解构赋值，且处理最后的rest的赋值，需要对rest的下标进行重整
    // [r1,r2,...rest] = [1,2,3,4]
    // rest <=> [3,4] rest[0]=3 rest[1]=4
    if (res?.ast?._meta?.isArray) {
      const rawRestIndexs = Object.keys(res.field)
        .map((keyStr) => parseInt(keyStr))
        .filter((keyNum) => Number.isInteger(keyNum))
        .sort()
      // 找到第一个vtype不是undefine的下标
      const offset = rawRestIndexs.findIndex((index) => res.field[index]?.vtype !== 'undefine')
      if (offset > 0) {
        // 将数组划分为2部分 第一部分全是undefined数据，第二部分为有效数据
        // 将第二部分数据往左平移，并删除多余索引
        // arr = [undefinevalue,undefinevalue,objectvalue,objectvalue,objectvalue]
        // 平移以后 arr=[objectvalue,objectvalue,objectvalue]
        for (let i = 0; i < rawRestIndexs.length; i++) {
          if (i < rawRestIndexs.length - offset) {
            res.field[i.toString()] = res.field[(offset + i).toString()]
          } else {
            delete res.field[i.toString()]
          }
        }
        this.saveVarInScope(scope, node.left, res, state)
      }
    }
    // Assignment brings trace back，sometimes in obj (if ObjExpression)
    if (res && res?.hasTagRec && node?.operator !== '=' && typeof res?.trace === 'undefined') {
      // 添加trace
      const trace = {
        file: node.loc.sourcefile || node.sourcefile,
        line: node.loc.start.line,
        node,
        tag: 'Var Pass:',
        affectedNodeName: res.left._sid,
      }
      // this.processAssignmentToBinary(res)
      res.trace = undefined
    }
    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processMemberAccess(scope, node, state) {
    let res
    try {
      res = super.processMemberAccess(scope, node, state)
    } catch (e) {
      return UndefinedValue()
    }
    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processUnaryExpression(scope, node, state) {
    const nodeValue = super.processUnaryExpression(scope, node, state)
    if (node.operator === 'delete') {
      // 根据delete的arguments获取对应 scope的field存储的值
      // 注意这里传入的是node.argument.object 获取到field中node.argument.object的值
      // 这样才能进一步通过target?.field[node.argument.property.name]访问到目标property 并进行删除操作
      // 否则直接delete target操作无效 delete只能作用在变量的属性，不能直接作用在变量上
      const target = this.getDeleteTargetInScopeField(scope, node.argument?.object)
      if (target != null) {
        const index = node.argument?.computed ? node.argument?.property.value : node.argument?.property.name
        if (index != null && target?.field[index] != null) {
          // link:uast引入的delete操作的删除语义在 Analyzer.processAssignmentExpression实现
          // 如果是解构赋值，且处理最后的rest的赋值，需要对rest的下标进行重整
          // [r1,r2,...rest] = [1,2,3,4]
          // rest <=> [3,4] rest[0]=3 rest[1]=4
          target.setFieldValue(
            index,
            UndefinedValue({
              sid: target?.field[index].sid,
              qid: target?.field[index].qid,
              parent: target,
            })
          )
        }
      }
      return target ?? nodeValue
    }
    return nodeValue
  }

  /**
   *
   * @param scope
   * @param argNode
   */
  getDeleteTargetInScopeField(scope, argNode) {
    if (!argNode || (argNode.type !== 'MemberAccess' && argNode.type !== 'Identifier')) return

    const propName = argNode?.property?.name
    if (argNode.type === 'Identifier' || argNode?.object?.type === 'Identifier') {
      // 单层访问 a.b的情况
      const defScope = Scope.getDefScope(scope, argNode)
      if (!propName) {
        // 当前argnode本身就是object了
        return defScope?.getFieldValue(argNode.name)
        // return field[argNode.name]
      }
      const objName = argNode.object.name
      return defScope?.getFieldValue(objName)?.getFieldValue(propName)
      // return field[objName].field[propName]
    }
    // 多层访问 a.b.c
    if (argNode?.object?.type === 'MemberAccess') {
      const objField = this.getDeleteTargetInScopeField(scope, argNode.object)
      return objField?.field[propName]
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processBinaryExpression(scope, node, state) {
    let res = super.processBinaryExpression(scope, node, state)
    res = processBinaryOperator(res, scope, node, state)
    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processConditionalExpression(scope, node, state) {
    const res = super.processConditionalExpression(scope, node, state)
    if (
      typeof res.field !== 'undefined' &&
      (Array.isArray(res.field) || Object.getOwnPropertyNames(res.field).length !== 0) &&
      res.hasTagRec !== true
    ) {
      try {
        res.field.forEach((arg) => {
          if (arg.hasTagRec) {
            res.hasTagRec = true
            throw new Error('LoopInterrupt')
          }
        })
      } catch (e) {}
    }
    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processVariableDeclaration(scope, node, state) {
    const res = super.processVariableDeclaration(scope, node, state)

    // Array内置函数适配，由于array的构造不需要构造方法，因此无法像promise、map、set一样在初始化的时候填充内置函数
    // 只能在数组初始化以后往proto里填充内置的函数和方法
    if (node?.varType?.type === 'ArrayType') {
      Initializer.initArrayBuiltin(res)
    }

    // VariableDeclaration brings traces back
    // 处理重复trace情况，本质是由于语法糖拆解多个节点引起的
    if (res?.trace) {
      if (Array.isArray(res.trace)) {
        const traceDeduplication = []
        let flag = 0
        for (const argT in res.trace) {
          if (argT === '0') {
            traceDeduplication[flag] = res.trace[argT]
            flag++
          } else {
            if (res.trace[argT].tag === 'Field: ') {
              continue
            }
            const tem = traceDeduplication[flag - 1]
            if (
              tem.file === res.trace[argT].file &&
              tem.tag === res.trace[argT].tag &&
              JSON.stringify(tem.line) === JSON.stringify(res.trace[argT].line)
            ) {
              if (tem.affectedNodeName === res.trace[argT].affectedNodeName) {
                continue
              } else if (tem.affectedNodeName.includes('__tmp')) {
                traceDeduplication.pop()
                flag--
              } else continue
            }
            traceDeduplication[flag] = res.trace[argT]
            flag++
          }
        }
        res.trace = traceDeduplication
      }
    }

    if (res?.vtype === 'union') {
      if (res.field[0]?.hasTagRec || res.field[1]?.hasTagRec) {
        res.hasTagRec = true
      }
    }
    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processSpreadElement(scope, node, state) {
    let res = super.processSpreadElement(scope, node, state)
    if (res) {
      if (res.length === 0) {
        res = this.processInstruction(scope, node.argument, state)
      }
      if (Array.isArray(res)) {
        const anyHasTag = res.some((item) => {
          return item.hasTagRec
        })
        // 如果每一个元素都没有污点才return
        if (!anyHasTag) {
          return res
        }
      }

      if (scope?.ast?.type === 'ObjectExpression') {
        if (scope.hasTagRec !== true) {
          scope.hasTagRec = res.hasTagRec
        }
        if (scope.hasTagRec) {
          if (Array.isArray(scope.field)) {
            scope.field.push(res)
          } else {
            let flag = 0
            let tmp = `YASATmp${flag}`
            while (scope.field[tmp]) {
              flag++
              tmp = `YASATmp${flag}`
            }
            scope.field[tmp] = res
          }
        }
      }
    }
    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processObjectExpression(scope, node, state) {
    const res = super.processObjectExpression(scope, node, state)
    if (res.value && res.value !== {}) {
      for (const val in res.value) {
        if (
          (val.includes('CallBack') || val.includes('callback') || val.includes('callBacks')) &&
          res.value[val].vtype === 'fclos' &&
          res.value[val].fdef
        ) {
          const argvalues = []
          if (res.value[val].fdef?.parameters && res.value[val].fdef.parameters.length > 0) {
            for (const para of res.value[val].fdef.parameters) {
              const argv = this.processInstruction(scope, para, state)
              if (Array.isArray(argv)) {
                argvalues.push(...argv)
              } else {
                argvalues.push(argv)
              }
            }
          }
          // execute call callback
          this.executeCall(res.value[val].fdef, res.value[val], argvalues, state, scope)
        }
      }
    }
    return res
  }

  /**
   *
   * @param fclos
   * @param node
   * @param scope
   * @param state
   */
  postProcessFunctionDefinition(fclos, node, scope, state) {
    super.postProcessFunctionDefinition(fclos, node, scope, state)

    /** add function builtin * */
    // FIXME check builtin override
    const builtins = [
      FunctionValue({
        sid: 'apply',
        _this: this.thisFClos,
        parent: null,
        execute: Initializer.builtin['function.apply'],
      }),
      FunctionValue({
        sid: 'call',
        _this: this.thisFClos,
        parent: null,
        execute: Initializer.builtin['function.call'],
      }),
      //  TODO  function.bind
    ]

    for (const builtin of builtins) {
      this.saveVarInCurrentScope(fclos, PrimitiveValue({ type: 'Literal', value: builtin.sid }), builtin, state)
      builtin.parent = fclos
    }
  }

  /**
   * handle module imports: import "module"
   * @param scope
   * @param node
   * @param state
   * @returns {*}
   */
  processImportDirect(scope, node, state) {
    if (node?.from) {
      node = node.from
    }
    // if (DEBUG) logger.info('require: ' + formatNode(node));
    const fname =
      node?.value || AstUtil.prettyPrint(node) || `<unkonwn_module>${node.loc.start.line}_${node.loc.start.column}`

    if (fname[0] !== '.' || fname.endsWith('.less')) {
      // load predefined builtin models
      return this.loadPredefinedModule(scope, fname, node, state)
    }

    let sourcefile
    while (node) {
      sourcefile = node.sourcefile
      if (sourcefile) break
      node = node.parent
    }
    if (!sourcefile) {
      handleException(
        null,
        'Error occurred in JsAnalyzer.processImportDirect: failed to sourcefile in ast',
        'Error occurred in JsAnalyzer.processImportDirect: failed to sourcefile in ast'
      )
      return
    }

    let pathname = path.resolve(path.dirname(sourcefile.toString()), fname)
    // handle ext
    if (!fs.existsSync(pathname) || !fs.statSync(pathname).isFile()) {
      let isExist = false
      let cwd
      let filename

      cwd = path.join(pathname, '../')
      filename = pathname.split('/').pop()
      const files = [`${filename}.(js|ts|mjs|cjs)`]
      const filepaths = globby.sync(files, { cwd, caseSensitiveMatch: false })
      if (filepaths && filepaths.length !== 0) {
        pathname = path.join(cwd, filepaths[0])
        isExist = true
      } else if (fs.existsSync(pathname)) {
        cwd = pathname
        filename = '(i|I)ndex'
        const files = [`${filename}.(js|ts|mjs|cjs)`]
        const filepaths = globby.sync(files, { cwd, caseSensitiveMatch: false })
        if (filepaths && filepaths.length !== 0) {
          pathname = path.join(pathname, filepaths[0])
          isExist = true
        }
      }

      if (!isExist) {
        return this.loadPredefinedModule(scope, pathname, node, state)
      }
    }

    // check cached imports first
    const m = this.moduleManager.field[pathname]
    if (m) return m

    let res
    try {
      const prog = FileUtil.loadAllFileText(pathname, ['js', 'ts', 'mjs', 'cjs', 'json'])[0]
      if (prog) {
        if (pathname.endsWith('json')) {
          prog.content = `module.exports = ${prog.content}`
        }
        const ast = Parsing.parseCode(prog.content, { sourcefile: prog.file, language: 'js' })
        if (ast) {
          this.sourceCodeCache[prog.file] = prog.content
          res = this.processModule(ast, pathname)
        }
      }
    } catch (e) {
      handleException(
        e,
        `Error in JsAnalyzer.processImportDirect: failed to loading: ${pathname}`,
        `Error in JsAnalyzer.processImportDirect: failed to loading: ${pathname}`
      )
    }
    if (!res) {
      return this.loadPredefinedModule(scope, pathname, node, state)
    }

    return res
  }

  // load predefined module
  /**
   *
   * @param scope
   * @param fname
   * @param node
   * @param state
   */
  loadPredefinedModule(scope, fname, node, state) {
    // TODO modeling module more precisely
    // considering two aspect:
    // 1. built-in module
    // 2. importing from third party package in node_modules

    let m = this.moduleManager.field[fname]
    if (m) return m
    m = ObjectValue({
      sid: fname,
      parent: this.moduleManager,
      fdef: undefined,
      node_module: true,
    })
    // v.parent = m;
    this.moduleManager.field[fname] = m
    return m
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processForStatement(scope, node, state) {
    // If ForStatement is aim at iterating over target, tweak node to RangeStatement for better evaluation
    const { test, update } = node
    // matching iteration over pattern
    if (
      test?.type === 'BinaryExpression' &&
      test?.right?.type === 'MemberAccess' &&
      test?.right?.property?.name === 'length' &&
      update?.type === 'UnaryExpression' &&
      update?.operator === '++'
    ) {
      const right = test.right.object
      const key = UastSpec.variableDeclaration(update.argument, null, false, UastSpec.dynamicType())
      key.loc = node?.init?.loc
      const rangeStatement = UastSpec.rangeStatement(key, null, right, node.body)
      rangeStatement.loc = node.loc
      return this.processInstruction(scope, rangeStatement, state)
    }
    if (node.init === null && node.test === null && node.update === null) {
      // for(;;)
      return this.processScopedStatement(scope, node.body, state)
    }
    return super.processForStatement(scope, node, state)
  }

  /**
   *
   */
  initTopScope() {
    Initializer.initGlobalScope(this.topScope)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processReturnStatement(scope, node, state) {
    let retVal
    try {
      retVal = super.processReturnStatement(scope, node, state)
    } catch (e) {
      return UndefinedValue()
    }

    if (node.isYield && retVal._sid === 'Promise') {
      const promiseMisc = retVal.getMisc('promise')
      if (!promiseMisc) return retVal
      const { resolve, reject } = promiseMisc
      return resolve || retVal
    }
    return retVal
  }
}

/**
 * get module exports scope from modClos
 * @param scope
 * @returns {*}
 */
function getExportsScope(scope) {
  if (scope.vtype !== 'scope' && scope._sid !== 'file') {
    Errors.UnexpectedValue('export scope is not module')
  }
  return scope.getFieldValue('module.exports')
}

module.exports = JsAnalyzer
