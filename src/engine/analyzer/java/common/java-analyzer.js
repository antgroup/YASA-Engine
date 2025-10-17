const _ = require('lodash')
const UastSpec = require('@ant-yasa/uast-spec')
const FileUtil = require('../../../../util/file-util')
const logger = require('../../../../util/logger')(__filename)
const { Errors } = require('../../../../util/error-code')
const Scope = require('../../common/scope')
const Parsing = require('../../../parser/parsing')
const JavaInitializer = require('./java-initializer')
const Rules = require('../../../../checker/common/rules-basic-handler')
const {
  ValueUtil: { FunctionValue, Scoped, PackageValue, PrimitiveValue },
} = require('../../../util/value-util')
const { Analyzer } = require('../../common')
const CheckerManager = require('../../common/checker-manager')
const entryPointConfig = require('../../common/current-entrypoint')
const constValue = require('../../../../util/constant')
const config = require('../../../../config')
const { handleException } = require('../../common/exception-handler')
const UndefinedValue = require('../../common/value/undefine')
/**
 *
 */
class JavaAnalyzer extends Analyzer {
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
    this.classMap = new Map()
  }

  /**
   * preprocess for single file
   * @param source
   * @param fileName
   */
  preProcess4SingleFile(source, fileName) {
    // init global scope
    JavaInitializer.initGlobalScope(this.topScope)

    // time-out control
    this.thisIterationTime = 0
    this.prevIterationTime = new Date().getTime()

    this.preloadFileToPackage(source, fileName)
    for (const unprocessedFileScope of this.unprocessedFileScopes) {
      if (unprocessedFileScope.isProcessed) continue
      const state = this.initState(unprocessedFileScope)
      this.processInstruction(unprocessedFileScope, unprocessedFileScope.ast, state)
    }
    this.unprocessedFileScopes.clear()
    delete this.unprocessedFileScopes

    JavaInitializer.initPackageScope(this.topScope.packageManager)

    this.assembleClassMap(this.topScope.packageManager)
  }

  /**
   * scan project dir
   * parse java files
   * prebuild package scope
   * @param dir dir is the main directory of the project
   */
  scanPackages(dir) {
    const time1 = Date.now()
    const packageFiles = FileUtil.loadAllFileTextGlobby(['**/*.java', '!target/**', '!src/test/**'], dir)
    if (packageFiles.length === 0) {
      Errors.NoCompileUnitError('no java file found in source path')
      process.exit(1)
    }
    this.unprocessedFileScopes = new Set()
    for (const packageFile of packageFiles) {
      this.preloadFileToPackage(packageFile.content, packageFile.file)
    }
    const time2 = Date.now()
    logger.info(`preLoadFileToPackage: ${time2 - time1}`)
    for (const unprocessedFileScope of this.unprocessedFileScopes) {
      if (unprocessedFileScope.isProcessed) continue
      // unprocessedFileScope.isProcessed = true;
      const state = this.initState(unprocessedFileScope)
      this.processInstruction(unprocessedFileScope, unprocessedFileScope.ast, state)
    }
    this.unprocessedFileScopes.clear()
    delete this.unprocessedFileScopes
    const time3 = Date.now()
    logger.info(`processPackageScope: ${time3 - time2}`)
  }

  /**
   * preload built-in packages
   */
  preloadBuiltinToPackage() {
    this._preloadBuiltinToPackage('java.util', 'ArrayList', arrayList)
  }

  /**
   *
   * @param packageName
   * @param className
   * @param methods
   */
  _preloadBuiltinToPackage(packageName, className, methods) {
    const packageScope = this.packageManager.getSubPackage(packageName, true)
    const classScope = Scope.createSubScope(className, packageScope, 'class')
    if (!packageScope.exports) {
      packageScope.exports = Scoped({
        sid: 'exports',
        id: 'exports',
        parent: packageScope,
      })
    }
    packageScope.exports.value[className] = classScope
    classScope.sort = classScope.qid = Scope.joinQualifiedName(packageScope.qid, className)
    for (const prop in methods) {
      const method = methods[prop]
      const targetQid = `${classScope.qid}.${prop}`
      classScope.value[prop] = FunctionValue({
        sid: prop,
        qid: targetQid,
        parent: classScope,
        execute: method.bind(this),
        _this: classScope,
      })
      this.funcSymbolTable[targetQid] = classScope.value[prop]
    }
  }

  /**
   * parse file src and preload package
   * @param source
   * @param filename
   * @returns {*}
   */
  preloadFileToPackage(source, filename) {
    const { options } = this
    options.sourcefile = filename
    options.language = 'java'
    const ast = Parsing.parseCode(source, options)
    this.fileManager[filename] = ast
    this.sourceCodeCache[filename] = source
    if (!ast) {
      handleException(
        null,
        `JavaAnalyzer.preloadFileToPackage: parse failed: ${filename}`,
        `JavaAnalyzer.preloadFileToPackage: parse failed: ${filename}`
      )
      return
    }
    if (!ast || ast.type !== 'CompileUnit') {
      handleException(
        null,
        `JavaAnalyzer.preloadFileToPackage: node type should be CompileUnit, but ${ast?.type}`,
        `JavaAnalyzer.preloadFileToPackage: node type should be CompileUnit, but ${ast?.type}`
      )
      return undefined
    }
    const packageName = ast._meta.qualifiedName ?? ''

    const packageScope = this.packageManager.getSubPackage(packageName, true)

    // file scope init
    // value specifies what module exports, closure specifies file closure
    const fileScope = this.initFileScope(ast, filename, packageScope)
    this.unprocessedFileScopes = this.unprocessedFileScopes ?? new Set()
    this.unprocessedFileScopes.add(fileScope)

    const { body } = ast
    this.entry_fclos = fileScope
    this.thisFClos = fileScope

    const state = this.initState(fileScope)
    // prebuild
    body.forEach((childNode) => {
      if (childNode.type === 'ExportStatement') {
        // the argument of ExportStatement is must be a ClassDefinition
        const classDef = childNode.argument
        if (classDef?.type !== 'ClassDefinition') {
          logger.fatal(`the argument of ExportStatement must be a ClassDefinition, check violation in ${filename}`)
        }
        const { className, classClos } = this.preprocessClassDefinitionRec(classDef, fileScope, fileScope, packageScope)
        if (classDef._meta.isPublic) {
          packageScope.exports =
            packageScope.exports ??
            Scoped({
              id: 'exports',
              sid: 'export',
              parent: null,
            })
          packageScope.exports.setFieldValue(className, classClos)
        }
        packageScope.setFieldValue(className, classClos)
      } else if (childNode.type === 'ClassDefinition') {
        const { className, classClos } = this.preprocessClassDefinitionRec(childNode, fileScope, fileScope)
        packageScope.setFieldValue(className, classClos)
      }
    })

    // post handle module for module export
    // const moduleExports = modClos.getFieldValue('module.exports');
    // if (moduleExports !== {}) {
    //     modScope.value = moduleExports;
    // }

    if (this.checkerManager && this.checkerManager.checkAtEndOfCompileUnit) {
      this.checkerManager.checkAtEndOfCompileUnit(this, null, null, state, null)
    }
    return { packageScope, fileScope }
  }

  /**
   *
   * @param node
   * @param scope
   * @param fileScope
   * @param packageScope
   */
  preprocessClassDefinitionRec(node, scope, fileScope, packageScope) {
    const className = node.id?.name

    const classClos = Scope.createSubScope(className, scope, 'class')
    classClos.sort = classClos.qid = Scope.joinQualifiedName(scope.qid, className)
    classClos.exports = Scoped({
      id: 'exports',
      sid: 'exports',
      parent: null,
    })
    if (node._meta.isPublic) {
      scope.exports =
        scope.exports ??
        Scoped({
          id: 'exports',
          sid: 'exports',
          parent: null,
        })
      scope.exports.setFieldValue(className, classClos)
    }
    classClos.fdef = classClos.ast = node
    classClos.fileScope = fileScope
    classClos.packageScope = packageScope
    const { body } = node
    if (!body) {
      return { className, classClos }
    }
    body.forEach((child) => {
      if (child.type === 'ClassDefinition') {
        this.preprocessClassDefinitionRec(child, classClos, fileScope, packageScope)
      }
    })
    return { className, classClos }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processCompileUnit(scope, node, state) {
    scope.isProcessed = true
    return super.processCompileUnit(scope, node, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processVariableDeclaration(scope, node, state) {
    const initVal = super.processVariableDeclaration(scope, node, state)
    if (initVal && typeof initVal?.rtype === 'undefined') {
      if (node.varType !== null && node.varType !== undefined) {
        initVal.rtype = { type: undefined }
        initVal.rtype.definiteType = node.varType.id
        initVal.rtype.val = this.getMemberValueNoCreate(scope, node.varType.id, state)
      }
    }
    return initVal
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processIdentifier(scope, node, state) {
    const res = super.processIdentifier(scope, node, state)
    const { fileScope } = res
    if (fileScope && !fileScope.isProcessed) {
      this.processInstruction(fileScope, fileScope.ast, this.initState(fileScope))
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
    let res = this.getMemberValue(defscope, resolved_prop, state)
    if (this.checkerManager && this.checkerManager.checkAtMemberAccess) {
      this.checkerManager.checkAtMemberAccess(this, defscope, node, state, { res })
    }

    if (node.property.type === 'ThisExpression' && defscope.vtype === 'class' && defscope._qid) {
      const ancestorInstance = this.getAncestorScopeByQid(scope, `${defscope._qid}<instance>`)
      if (ancestorInstance) {
        res = ancestorInstance
      }
    }
    if (defscope.vtype === 'fclos' && defscope._sid?.includes('anonymous') && res.vtype === 'symbol') {
      res = defscope
    }
    if (defscope.rtype && defscope.rtype !== 'DynamicType' && res.rtype === undefined) {
      res.rtype = { type: undefined }
      res.rtype.definiteType = defscope.rtype.type ? defscope.rtype : defscope.rtype.definiteType
      res.rtype.vagueType = defscope.rtype.vagueType ? `${defscope.rtype.vagueType}.${res.name}` : res.name
    }
    const { fileScope } = res
    if (fileScope && !fileScope.isProcessed) {
      this.processInstruction(fileScope, fileScope.ast, this.initState(fileScope))
    }
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
    node = node.from
    const fname = node?.value

    // check cached imports first
    let packageName = ''
    const classNames = []
    if (fname) {
      if (fname.includes('.')) {
        const lastDotIndex = fname.lastIndexOf('.')
        packageName = fname.substring(0, lastDotIndex)
        classNames.push(fname.substring(lastDotIndex + 1))
      } else {
        classNames.push(fname)
      }
    }

    let packageScope = this.packageManager.getSubPackage(packageName, true)
    // if package is not created from import statement, but from full qualified name access
    if (packageScope.vtype !== 'package') {
      packageScope = PackageValue({
        vtype: 'package',
        sid: fname,
        qid: packageName,
        exports: Scoped({
          sid: 'exports',
          id: 'exports',
          parent: null,
        }),
        parent: this,
      })
    }
    let classScope = packageScope
    for (const className of classNames) {
      classScope = Scope.createSubScope(className, packageScope, 'class')
      packageScope.exports.value[className] = classScope
      classScope.sort = classScope.qid = Scope.joinQualifiedName(packageScope.qid, className)
    }

    classScope.sort = classScope.sort ?? fname
    return classScope
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processClassDefinition(scope, node, state) {
    const { annotations } = node._meta
    const annotationValues = []
    annotations?.forEach((annotation) => {
      annotationValues.push(this.processInstruction(scope, annotation, state))
    })

    // adjust the order of the class body, so that static field comes last
    const { body } = node
    let bodyStmt
    if (body?.type === 'ScopedStatement') {
      bodyStmt = body.body
    } else if (Array.isArray(body)) {
      bodyStmt = body
    }
    bodyStmt?.sort((a, b) => {
      return !!a._meta.isStatic - !!b._meta.isStatic
    })

    const res = super.processClassDefinition(scope, node, state)
    // TODO
    res.annotations = annotationValues
    for (const annotation of annotationValues) {
      if (annotation.sort === 'lombok.Data') {
        const value = res.getRawValue()
        for (const prop in value) {
          const fieldValue = value[prop]
          if (fieldValue.vtype !== 'fclos') {
            const getterName = `get${getUpperCase(prop)}`
            if (value[getterName] === undefined) {
              const targetQid = `${scope.qid}.${getterName}`
              value[getterName] = FunctionValue({
                sid: getterName,
                qid: targetQid,
                parent: scope,
                execute: JavaInitializer.builtin.lombok.processGetter(getterName, prop),
              })
              this.funcSymbolTable[targetQid] = value[getterName]
            }
            const setterName = `set${getUpperCase(prop)}`
            if (value[setterName] === undefined) {
              const targetQid = `${scope.qid}.${setterName}`
              value[setterName] = FunctionValue({
                sid: setterName,
                qid: targetQid,
                parent: scope,
                execute: JavaInitializer.builtin.lombok.processSetter(setterName, prop),
              })
              this.funcSymbolTable[targetQid] = value[getterName]
            }
          }
        }
      }
    }
    return res
  }

  /**
   * process assign expression
   * @param scope
   * @param node
   * @param state
   */
  processAssignmentExpression(scope, node, state) {
    const { left } = node
    const oldVal = this.processInstruction(scope, left, state)

    const res = super.processAssignmentExpression(scope, node, state)

    if (node.operator === '=') {
      if (
        oldVal?.parent === this.thisFClos &&
        this.thisFClos?.field?.super &&
        !this.checkFieldDefinedInClass(oldVal._id, this.thisFClos.sort)
      ) {
        this.saveVarInScopeRec(this.thisFClos.field.super, left.property, res, state)
      }
    }

    return res
  }

  /**
   * process binary expression
   * @param scope
   * @param node
   * @param state
   */
  processBinaryExpression(scope, node, state) {
    let res = super.processBinaryExpression(scope, node, state)

    if (res?.left?.vtype === 'primitive' && res?.right?.vtype === 'primitive') {
      if (['>', '<', '==', '!=', '>=', '<='].includes(res?.operator)) {
        const leftPrimitive = res.left.value
        const rightPrimitive = res.right.value
        const expr = leftPrimitive + res.operator + rightPrimitive
        try {
          const result = eval(expr)
          if (result != null) {
            res = PrimitiveValue({ type: 'Literal', value: result, loc: node.loc })
          }
        } catch (e) {}
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
  processCallExpression(scope, node, state) {
    /* { callee,
        arguments,
      }
   */
    if (this.checkerManager && this.checkerManager.checkAtFuncCallSyntax)
      this.checkerManager.checkAtFuncCallSyntax(node, {
        pcond: state.pcond,
        einfo: state.einfo,
      })

    const fclos = this.processInstruction(scope, node.callee, state)
    if (!fclos) return UndefinedValue()
    if (node?.callee?.type === 'MemberAccess' && node.callee?.object?.type !== 'SuperExpression') {
      if (fclos.vtype !== 'union') {
        fclos._this = this.processInstruction(scope, node.callee.object, state)
      } else {
        const _thisUnion = this.processInstruction(scope, node.callee.object, state)
        if (_thisUnion?.value) {
          for (const f of fclos.value) {
            for (const _thisObj of _thisUnion.value) {
              if (!f._sid || !_thisObj.value) {
                continue
              }
              if (f === _thisObj.value[f._sid]) {
                f._this = _thisObj
              }
            }
          }
        }
      }
    }

    // prepare the function arguments
    let argvalues = []
    let same_args = true // minor optimization to save memory
    for (const arg of node.arguments) {
      let argv = this.processInstruction(scope, arg, state)
      // 处理参数是 箭头函数或匿名函数
      // 参数类型必须是函数定义,且fclos找不到定义或未建模适配
      // 如果参数适配建模，则会进入相应的逻辑模拟执行，例如array.push
      if (arg?.type === 'FunctionDefinition' && arg?.name === '<anonymous>' && !fclos?.fdef && !fclos?.execute) {
        // let subscope = Scope.createSubScope(argv.sid + '_scope', scope,'scope')
        argv = this.processAndCallFuncDef(scope, arg, argv, state)
      }
      if (argv !== arg) same_args = false
      if (logger.isTraceEnabled()) logger.trace(`arg: ${this.formatScope(argv)}`)
      if (Array.isArray(argv)) {
        argvalues.push(...argv)
      } else {
        argvalues.push(argv)
      }
    }
    if (same_args) argvalues = node.arguments

    // analyze the resolved function closure and the function arguments
    let res = this.executeCall(node, fclos, argvalues, state, scope)

    if (res instanceof UndefinedValue && fclos._sid?.includes('<anonymous') && fclos.fdef?.body?.body?.length === 1) {
      const oldBodyExpr = fclos.fdef.body.body[0]
      try {
        fclos.fdef.body.body[0] = UastSpec.returnStatement(fclos.fdef.body.body[0])
        res = this.executeCall(node, fclos, argvalues, state, scope)
      } catch (e) {
      } finally {
        fclos.fdef.body.body[0] = oldBodyExpr
      }
    }

    // function definition not found
    if (fclos.vtype !== 'fclos') {
      // examine possible call-back functions in the arguments
      if (config.invokeCallbackOnUnknownFunction) {
        this.executeFunctionInArguments(scope, fclos, node, argvalues, state)
      }
      if (fclos._this?.field?._functionNotFoundCallback_?.vtype === 'fclos') {
        this.executeCall(node, fclos._this.field._functionNotFoundCallback_, argvalues, state, scope)
      }
    }

    if (fclos?._this?.vtype === 'fclos' && (fclos._sid === 'accept' || fclos._sid === 'apply')) {
      this.executeCall(node, fclos._this, argvalues, state, scope)
    }

    if (res && this.checkerManager?.checkAtFunctionCallAfter) {
      this.checkerManager.checkAtFunctionCallAfter(this, scope, node, state, {
        argvalues,
        fclos,
        ret: res,
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
  processNewExpression(scope, node, state) {
    if (node._meta && node._meta.isEnumImpl) {
      this.processInstruction(scope, node.callee, state)
    } else {
      return super.processNewExpression(scope, node, state)
    }
  }

  /**
   * process unary expr
   * @param scope
   * @param node
   * @param state
   */
  processUnaryExpression(scope, node, state) {
    let res = super.processUnaryExpression(scope, node, state)

    if (res.argument?.vtype === 'primitive' && res.argument?.literalType === 'number') {
      const argValueNum = Number(res.argument.value)
      if (node.operator === '++') {
        res = PrimitiveValue({ type: 'Literal', value: argValueNum + 1, loc: node.loc })
        this.saveVarInScope(scope, node.argument, res, state)
      } else if (node.operator === '--') {
        res = PrimitiveValue({ type: 'Literal', value: argValueNum - 1, loc: node.loc })
        this.saveVarInScope(scope, node.argument, res, state)
      }
    }

    return res
  }

  /**
   *
   * @param dir
   */
  preProcess(dir) {
    // init global scope
    JavaInitializer.initGlobalScope(this.topScope)

    // time-out control
    this.thisIterationTime = 0
    this.prevIterationTime = new Date().getTime()

    this.scanPackages(dir)

    JavaInitializer.initPackageScope(this.topScope.packageManager)

    this.assembleClassMap(this.topScope.packageManager)
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
            `<anonymousFunc_${entryPoint.entryPointSymVal?.ast.loc.start.line}_${
              entryPoint.entryPointSymVal?.ast.loc.end.line
            }>`
        )

        this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)

        const argValues = []
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
            'Error occurred in JavaAnalyzer.symbolInterpret: process argValue err',
            'Error occurred in JavaAnalyzer.symbolInterpret: process argValue err'
          )
        }

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
      }
    }
    return true
  }

  /**
   * judge if val is nullLiteral
   * @param val
   */
  isNullLiteral(val) {
    return val.getRawValue() === 'null' && val.type === 'Literal'
  }

  /**
   * get module exports scope from modClos
   * @param scope
   * @returns {*}
   */
  getExportsScope(scope) {
    return [scope.exports, scope]
  }

  /**
   * assemble class map
   * @param obj
   */
  assembleClassMap(obj) {
    if (!obj) {
      return
    }
    if (obj.sort && typeof obj.sort === 'string') {
      this.classMap.set(obj.sort, obj)
    } else if (obj.field) {
      for (const key in obj.field) {
        this.assembleClassMap(obj.field[key])
      }
    }
  }

  /**
   * check if field defined in class
   * @param fieldName
   * @param fullClassName
   * @returns {boolean}
   */
  checkFieldDefinedInClass(fieldName, fullClassName) {
    if (!fieldName || !fullClassName || !this.classMap.has(fullClassName)) {
      return false
    }

    const classObj = this.classMap.get(fullClassName)
    if (!classObj.ast || !classObj.ast.body) {
      return false
    }
    for (const bodyItem of classObj.ast.body) {
      if (bodyItem.type !== 'VariableDeclaration') {
        continue
      }
      if (bodyItem.id.name === fieldName) {
        return true
      }
    }

    return false
  }

  /**
   * get ancestor scope by id
   * @param scope
   * @param qid
   */
  getAncestorScopeByQid(scope, qid) {
    if (!qid) {
      return null
    }
    while (scope) {
      if (scope._qid === qid) {
        return scope
      }
      scope = scope.parent
    }
    return null
  }
}

JavaAnalyzer.prototype.initFileScope = JavaInitializer.initFileScope
JavaAnalyzer.prototype.initInPackageScope = JavaInitializer.initInPackageScope

module.exports = JavaAnalyzer

/**
 *
 * @param str
 */
function getUpperCase(str) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}
