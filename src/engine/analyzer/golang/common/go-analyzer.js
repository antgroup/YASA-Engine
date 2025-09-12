const logger = require('../../../../util/logger')(__filename)
const Scope = require('../../common/scope')
const { Analyzer } = require('../../common')
const Rules = require('../../../../checker/common/rules-basic-handler')
const _ = require('lodash')
const gomodParser = require('../../../parser/golang/go-ast-builder')
const { cloneWithDepth } = require('../../../../util/clone-util')
const {
  ValueUtil: { FunctionValue },
} = require('../../../util/value-util')

const {
  valueUtil: {
    ValueUtil: { Scoped, PackageValue, PrimitiveValue, UndefinedValue, SymbolValue, UnionValue },
  },
} = require('../../common')
const config = require('../../../../config')
const SourceLine = require('../../common/source-line')
const FileUtil = require('../../../../util/file-util')
const { Errors } = require('../../../../util/error-code')
const AstUtil = require('../../../../util/ast-util')
const MemState = require('../../common/memState')
const CheckerManager = require('../../common/checker-manager')
const entryPointConfig = require('../../common/current-entrypoint')
const { unionAllValues } = require('../../common/memStateBVT')
const path = require('path')
const { floor } = require('lodash')
const constValue = require('../../../../util/constant')
const { handleException } = require('../../common/exception-handler')

/**
 *
 */
class GoAnalyzer extends Analyzer {
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
    this.mainEntryPoints = []
    this.ruleEntrypoints = []
  }

  /**
   *
   * @param dir
   */
  scanModules(dir) {
    const modules = FileUtil.loadAllFileTextGlobby(['**/*.(go)'], dir)
    if (modules.length === 0) {
      Errors.NoCompileUnitError('no go file found in source path')
      process.exit(1)
    }
    for (const mod of modules) {
      SourceLine.storeCode(mod.file, mod.content)
    }
  }

  /**
   * scan project dir
   * parse go files
   * prebuild package scope
   * @param dir dir is the main directory of the project
   * @param state
   * @param defaultScope
   */
  async scanPackages(dir, state, defaultScope) {
    this.scanModules(dir)
    this.moduleManager = await gomodParser.parsePackage(dir, this.options)
    const { packageInfo, moduleName } = this.moduleManager
    if (Object.entries(packageInfo.files).length === 0 && Object.entries(packageInfo.subs).length === 0) {
      return
    }
    let { goModPath } = this.moduleManager
    if (!goModPath) goModPath = ''
    // TODO 如果模块名叫code.alipay.com/antjail/antdpa，进去会截断
    const modulePackageManager = defaultScope || this.packageManager.getSubPackage(moduleName, true)

    // 计算项目模块根路径(go.mod所在目录)
    const moduleRootPath = this.getModuleRootPath(goModPath, config.maindir)
    const rootDirOffset = moduleRootPath === '' ? [] : moduleRootPath.split('/')
    let rootDir = packageInfo.subs['/']
    let dirName = config.maindir.replace(/\/$/, '').split('/').at(-1)
    for (dirName of rootDirOffset) {
      if (dirName in rootDir?.subs) {
        rootDir = rootDir.subs[dirName]
      }
    }
    this.moduleManager.rootDir = rootDir
    this.moduleManager.rootDirName = dirName
    this._scanPackages(modulePackageManager, dirName, rootDir, state)
  }

  /**
   *
   * @param goModPath
   * @param mainDir
   */
  getModuleRootPath(goModPath, mainDir) {
    const commonPathPrefix = _getCommonPrefix(goModPath, mainDir)
    let modulePath = goModPath.slice(commonPathPrefix.length).replace(/^\/+/, '')
    modulePath = modulePath.substring(0, modulePath.lastIndexOf('/'))
    return modulePath

    // 计算两个路径的公共前缀
    /**
     *
     * @param path1
     * @param path2
     */
    function _getCommonPrefix(path1, path2) {
      const parts1 = path.normalize(path1).split(path.sep)
      const parts2 = path.normalize(path2).split(path.sep)

      const commonParts = []
      for (let i = 0; i < Math.min(parts1.length, parts2.length); i++) {
        if (parts1[i] === parts2[i]) {
          commonParts.push(parts1[i])
        } else {
          break // 不相等则停止
        }
      }
      return commonParts.join(path.sep)
    }
  }

  /**
   *
   * @param parentPackageValue
   * @param dirName
   * @param currentDir
   * @param state
   */
  _scanPackages(parentPackageValue, dirName, currentDir, state) {
    const that = this
    const currentPackageValue = parentPackageValue.getSubPackage(`%dir_${dirName}`, true)

    // 处理当前目录下的文件
    _handlePackageFiles((scope, node, state) => {
      if (node.type === 'CompileUnit') {
        node.body.forEach((n) => {
          if (n.type === 'ClassDefinition') {
            this.preProcessClassDefinition(scope, n, state)
          }
        })
      }
    })
    _handlePackageFiles((scope, node, state) => {
      this.processInstruction(scope, node, state)
    })

    currentPackageValue.packageProcessed = true

    // 处理当前目录下的子目录
    const subDirs = currentDir?.subs || {}
    for (const dirName in subDirs) {
      if (subDirs.hasOwnProperty(dirName)) {
        this._scanPackages(currentPackageValue, dirName, subDirs[dirName], state)
      }
    }

    /**
     *
     * @param handler
     */
    function _handlePackageFiles(handler) {
      Object.values(currentDir.files).forEach((nodeInfo) => {
        const { node, packageName } = nodeInfo
        let scope
        if (packageName === '__global__') {
          scope = that.topScope
        } else {
          scope = currentPackageValue
        }
        if (!scope.name && packageName) scope.name = packageName
        if (scope.packageProcessed) return
        // if (packageName.indexOf('_test') === -1) {
        //     thisPackageScope = scope
        // }
        handler(scope, node, state)
      })
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processCallExpression(scope, node, state) {
    if (node._meta.defer) {
      const encloseFclos = this.getEncloseFclos(scope)
      if (encloseFclos) {
        encloseFclos._defers = encloseFclos._defers || []
        const deferNode = _.clone(node) // 浅拷贝即可
        delete deferNode._meta.defer
        encloseFclos._defers.push(deferNode)
      }
    }

    const fclos = this.processInstruction(scope, node.callee, state)
    let ret
    if (fclos?.vtype === 'class' && node.arguments.length === 1) {
      const val = this.processInstruction(scope, node.arguments[0], state)
      if (val) {
        val.sort = fclos.id
      }
      ret = val
    } else {
      const argvalues = []
      for (const arg of node.arguments) {
        const argv = this.processInstruction(scope, arg, state)
        if (logger.isTraceEnabled()) logger.trace(`arg: ${this.formatScope(argv)}`)
        if (Array.isArray(argv)) {
          argvalues.push(...argv)
        } else {
          argvalues.push(argv)
        }
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
      ret = super.processCallExpression(scope, node, state)
      if (ret && this.checkerManager) {
        this.checkerManager.checkAtFunctionCallAfter(this, scope, node, state, {
          fclos,
          ret,
          argvalues,
          pcond: state.pcond,
          einfo: state.einfo,
          callstack: state.callstack,
        })
      }
    }
    if (fclos?._defers) {
      for (let i = fclos._defers.length - 1; i >= 0; i--) {
        this.processCallExpression(scope, fclos._defers[i], state)
      }
    }

    return ret
  }

  /**
   * 针对包的init函数做特殊处理
   * @param node
   * @param scope
   * @returns {{vtype: string, fdef: *, id: (*|string), value: {}, decls: {}, parent: *}|*}
   */
  createFuncScope(node, scope) {
    if (node?.id?.name === 'init') {
      const startLoc = node?.loc?.start?.line
      const endLoc = node?.loc?.end?.line
      const targetQid = `${scope.qid}.init#(${startLoc}-${endLoc})`

      // 检查当前init方法是否已被添加
      let globalScope = scope
      while (globalScope) {
        if (globalScope.sid === '<global>') break
        globalScope = globalScope.parent
      }
      if (Object.prototype.hasOwnProperty.call(globalScope.funcSymbolTable, targetQid)) {
        return globalScope.funcSymbolTable[targetQid]
      }

      let initFunctionValue = Object.prototype.hasOwnProperty.call(scope.value, 'init') ? scope.value.init : undefined
      if (!initFunctionValue) {
        initFunctionValue = []
        scope.value.init = initFunctionValue
      }

      const fclos = FunctionValue({
        fdef: node, // record the function definition including its type and prototype information
        sid: 'init',
        qid: targetQid,
        decls: {},
        parent: scope,
        ast: node,
      })
      globalScope.funcSymbolTable[targetQid] = fclos

      if (Array.isArray(initFunctionValue)) {
        initFunctionValue.push(fclos)
        return fclos
      }
    } else {
      return super.createFuncScope(node, scope)
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processImportDirect(scope, node, state) {
    const { moduleName } = this.moduleManager
    const { rootDirName } = this.moduleManager
    const fromPath = node?.from?.value?.replace(/"/g, '')

    // 外部包返回空packageValue
    if (!fromPath.startsWith(`${moduleName}/`)) {
      return PackageValue({
        vtype: 'package',
        sid: fromPath,
        qid: fromPath,
        exports: Scoped({
          sid: 'exports',
          id: 'exports',
          parent: null,
        }),
        parent: this.packageManager,
      })
    }
    const relativeFromPath = fromPath.slice(`${moduleName}/`.length)
    const dirs = relativeFromPath.split('/')

    // 取该项目根目录的PackageValue：rootPackageValue(顶层Scope，即go.mod所在目录的packageValue)
    const modulePackageValue = this.packageManager.getSubPackage(moduleName, false)
    const rootPackageValue = modulePackageValue.getSubPackage(`%dir_${rootDirName}`, false)
    let parentScope = rootPackageValue

    // packageManager按照import路径(即目录结构)存储。每个目录(不管是否是包)都视作一个PackageValue，其下可能有PackageValue、ClassScope、FuncScope等。
    for (const dir of dirs) {
      const currentScope = parentScope.getSubPackage(`%dir_${dir}`, true)
      parentScope.exports.value[dir] = currentScope
      currentScope.sort = currentScope.qid = Scope.joinQualifiedName(parentScope.qid, dir)
      parentScope = currentScope
    }
    const targetScope = parentScope
    if (!targetScope.packageProcessed) {
      this.addFdef(targetScope, dirs, state)
      this.callInitWhenImported(targetScope, state)
      targetScope.packageProcessed = true
    }
    return targetScope
  }

  /**
   *
   * @param targetScope
   * @param dirs
   * @param state
   */
  addFdef(targetScope, dirs, state) {
    const { rootDir } = this.moduleManager
    if (!rootDir) {
      return
    }
    // 根据import结构找到包所在目录
    let currentPackage = rootDir
    for (const dir of dirs) {
      currentPackage = currentPackage?.subs?.[dir]
      if (!currentPackage) {
        return
      }
    }

    let file
    for (file of Object.getOwnPropertyNames(currentPackage?.files)) {
      this.processInstruction(targetScope, currentPackage.files[file].node, state)
    }

    // 获取实际包名
    if (file) {
      const { packageName } = currentPackage.files[file]
      targetScope.name = packageName
    }
    return targetScope
  }

  /**
   * 在导入一个包的时候调用其init方法
   * @param ImportedScope
   * @param state
   */
  callInitWhenImported(ImportedScope, state) {
    const initFCloses =
      AstUtil.satisfy(
        ImportedScope,
        (n) => n.ast?.id?.name === 'init' && n.vtype === 'fclos',
        (node, prop, from) => node === from, // 只找当前包下的field
        null,
        true
      ) || []
    for (const initFClos of initFCloses) {
      this.executeCall(initFClos.ast, initFClos, [], state, ImportedScope)
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
    if (!id || id?.name === '_') return UndefinedValue() // e.g. in Go

    let initVal
    if (!initialNode) {
      let cscope
      if (node.varType) {
        cscope = this.processInstruction(scope, node.varType, state)
        // if (cscope && cscope.vtype !== 'undefine')
        if (cscope) {
          initVal = this.buildNewObject(cscope?.fdef, undefined, cscope, state, node, scope)
        } else {
          initVal = this.createVarDeclarationScope(id, scope)
        }
      }
      initVal.uninit = !initialNode
      initVal = SourceLine.addSrcLineInfo(initVal, id, id.loc && id.loc.sourcefile, 'Var Pass: ', id.name)
    } else {
      initVal = this.processInstruction(scope, initialNode, state)
      if (initVal?.rtype && initVal.rtype !== 'DynamicType') {
        const cscope = this.processInstruction(scope, initVal.rtype, state)
        if (cscope?.vtype === 'class' && initVal.vtype !== 'primitive') {
          initVal = this.buildTypeObject(initVal, cscope)
        }
      }
      initVal = SourceLine.addSrcLineInfo(initVal, node, node.loc && node.loc.sourcefile, 'Var Pass: ', id.name)
    }

    if (this.checkerManager && this.checkerManager.checkAtPreDeclaration)
      this.checkerManager.checkAtPreDeclaration(this, scope, node, state, {
        lnode: id,
        rvalue: null,
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
        fdef: state.callstack && state.callstack[state.callstack.length - 1],
      })
    if (id.type === 'TupleExpression') {
      // 解构Tuple赋值，分别分发到Tuple里的每个元素
      if (initVal.vtype === 'union') {
        const substates = MemState.forkStates(state, 1)
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
      } else {
        for (const i in id.elements) {
          this.saveVarInCurrentScope(scope, id.elements[i], initVal, state)
        }
      }
    } else {
      // 如果是import，则定义真正的包名而非目录名
      if (
        initialNode?.type === 'ImportExpression' &&
        initVal?.vtype === 'package' &&
        initVal.name &&
        id.name === initialNode.from?.value?.split('/').at(-1)
      ) {
        id.name = initVal.name
      }
      this.saveVarInCurrentScope(scope, id, initVal, state)
    }

    // set alias name if val itself has no identifier
    if (initVal && !(initVal.name || (initVal.id && initVal.id !== '<anonymous>') || initVal.sid)) {
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

    if (this.checkerManager && this.checkerManager.checkAtVariableDeclaration) {
      this.checkerManager.checkAtVariableDeclaration(this, scope, node, scope, state, { initVal })
    }

    return initVal
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processNewExpression(scope, node, state) {
    return this.processNewObject(scope, node, state)
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
    // const native = libraryAPIResolver.processNewObject(fclos, argvalues);
    // if (native) return native;

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
   * @param cdef
   * @param state
   */
  preProcessClassDefinition(scope, cdef, state) {
    if (!(cdef && cdef.body)) return UndefinedValue() // Should not happen

    // pre-processing
    const fname = cdef.id?.name

    const cscope = Scope.createSubScope(fname, scope, 'class') // class scope
    cscope.cdef = cdef
    // cscope.fdef = cdef
    cscope.ast = cdef
    cscope.__preprocess = true
    return cscope
  }

  /**
   *
   * @param scope
   * @param cdef
   * @param state
   */
  processClassDefinition(scope, cdef, state) {
    if (!(cdef && cdef.body)) return UndefinedValue() // Should not happen

    // pre-processing
    const fname = cdef.id?.name

    const cscope = Scope.createSubScope(fname, scope, 'class') // class scope
    cscope.cdef = cdef
    if (cdef._meta?.isInterface) cscope.misc_.isInterface = true
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

    return cscope
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
        const v_copy = cloneWithDepth(v)
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
   * @param scope
   * @param node
   * @param state
   */
  processThisExpression(scope, node, state) {
    this.thisFClos.misc_.pointer_reference = true
    if (node._meta.type?.type === 'PointerType') {
      // 引用
      return this.thisFClos
    }
    // 值传递
    // TODO: 只深拷贝this.thisFClos.value即可，疑似循环依赖，待查
    return cloneWithDepth(this.thisFClos, 5)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   * @param prePostFlag
   */
  processInstruction(scope, node, state, prePostFlag) {
    if (node?.name === 'error' || node?.name === 'err') {
      return SymbolValue(node)
    }
    return super.processInstruction(scope, node, state, prePostFlag)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   * @param prePostFlag
   */
  processPointerType(scope, node, state, prePostFlag) {
    return this.processInstruction(scope, node.element, state)
  }

  /**
   * 将返回值转换成方法声明的返回值类型
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @param retVal
   */
  convertRetValToObjectType(fclos, argvalues, state, node, scope, retVal) {
    if (retVal.vtype === 'union') {
      const declRetType = fclos.ast.returnType
      if (declRetType.type === 'TupleType') {
        const retNum = declRetType.elements.length
        for (const i in retVal.value) {
          const eachRetVal = retVal.value[i]
          eachRetVal.rtype = declRetType.elements[i % retNum]
          // 尝试将每个 retVal 转换成 返回值声明的类型
          if (eachRetVal.rtype !== 'DynamicType') {
            const cscope = this.processInstruction(scope, eachRetVal.rtype, state)
            // 当且仅当 retVal 非空时，才尝试转换对应类型。(250813 否则会出现将nil转换成一个对象，得到一个primitiveType的、ast是nil的、field有对象属性的错误符号值。致使后续报错)
            if (cscope.vtype === 'class' && !(eachRetVal.type === 'Identifier' && eachRetVal.name === 'nil')) {
              retVal.value[i] = this.buildTypeObject(eachRetVal, cscope)
            }
          }
        }
      } else {
        // declRetType.type !== 'TupleType'
        for (let rawValue of retVal.value) {
          rawValue.rtype = fclos.ast.returnType
          if (rawValue.rtype !== 'DynamicType') {
            const cscope = this.processInstruction(scope, rawValue.rtype, state)
            if (cscope.vtype === 'class' && !(rawValue.type === 'Identifier' && rawValue.name === 'nil')) {
              rawValue = this.buildTypeObject(rawValue, cscope)
            }
          }
        }
      }
    } else if (_.isArray(retVal) && fclos.ast.returnType.type !== 'VoidType') {
      // TODO 这里YASA有bug，暂时先改为对VoidType特判
      for (const i in retVal) {
        retVal[i].rtype = fclos.ast.returnType.elements[i]
        if (retVal[i].rtype !== 'DynamicType') {
          let cscope
          if (retVal[i].rtype.type === 'PointerType') {
            cscope = this.processInstruction(scope, retVal[i].rtype.element, state)
          } else {
            cscope = this.processInstruction(scope, retVal[i].rtype, state)
          }
          if (cscope.vtype === 'class') {
            retVal[i] = this.buildTypeObject(retVal[i], cscope)
          }
        }
      }
    } else {
      retVal.rtype = fclos.ast.returnType
      if (retVal.rtype !== 'DynamicType') {
        const cscope = this.processInstruction(scope, retVal.rtype, state)
        if (cscope.vtype === 'class') {
          retVal = this.buildTypeObject(retVal, cscope)
        }
      }
    }
    return retVal
  }

  /**
   *
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  executeSingleCall(fclos, argvalues, state, node, scope) {
    const retVal = super.executeSingleCall(fclos, argvalues, state, node, scope)
    return this.convertRetValToObjectType(fclos, argvalues, state, node, scope, retVal)
  }

  /**
   * build a type object. Record the fields and initialize their values to oldScope
   * @param oldScope
   * @param fclos
   * @returns {*}
   */
  buildTypeObject(oldScope, fclos) {
    // clone the basic class object
    const obj = _.clone(oldScope) // 浅拷贝即可
    for (const x in fclos.value) {
      const v = fclos.value[x]
      if (!v) continue
      const v_copy = cloneWithDepth(v)
      if (obj.field.hasOwnProperty(x)) continue
      obj.field[x] = v_copy
      v_copy._this = obj
      v_copy.parent = obj
    }
    return obj
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processCompileUnit(scope, node, state) {
    // 避免同一compileUnit被重复处理(例如，已被init的全局变量会被覆盖定义)
    if (node._meta.compileUnitProcessed) return
    node._meta.compileUnitProcessed = true
    if (this.checkerManager && this.checkerManager.checkAtCompileUnit) {
      const interruptFlag = this.checkerManager.checkAtCompileUnit(this, node, scope, state, {
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
      })
      // 插件返回状态为：中断后续分析
      if (interruptFlag) return
    }
    return super.processCompileUnit(scope, node, state)
  }

  /**
   *
   */
  startAnalyze() {
    if (this.checkerManager && this.checkerManager.checkAtStartOfAnalyze) {
      this.checkerManager.checkAtStartOfAnalyze(this, null, null, null, null)
    }
    // 将main放在其他入口前执行
    this.entryPoints = [...this.mainEntryPoints, ...this.entryPoints]
  }

  /**
   *
   * @param dir
   */
  async preProcess(dir) {
    const state = this.initState(this.topScope)
    await this.scanPackages(dir, state)
  }

  /**
   *
   * @returns {boolean}
   */
  symbolInterpret() {
    const { entryPoints } = this
    const state = this.initState(this.topScope)
    let isFromRule = false
    if (entryPoints.length === 0) {
      this.entryPoints.push(...this.ruleEntrypoints)
      isFromRule = true
    }
    if (_.isEmpty(entryPoints)) {
      logger.info('[symbolInterpret]：EntryPoints are not found')
      return true
    }
    const hasAnalysised = []
    // 自定义source入口方式，并根据入口自主加载source
    let index = 0
    while (index < entryPoints.length) {
      const entryPoint = entryPoints[index++]
      if (entryPoint.type === constValue.ENGIN_START_FILE_BEGIN) continue
      entryPointConfig.setCurrentEntryPoint(entryPoint)
      if (
        (isFromRule || entryPoint.functionName === 'main') &&
        hasAnalysised.includes(
          `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?._qid}#${entryPoint.entryPointSymVal.ast.parameters}`
        )
      ) {
        continue
      }

      hasAnalysised.push(
        `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?._qid}#${entryPoint.entryPointSymVal.ast.parameters}`
      )

      logger.info(
        'EntryPoint [%s.%s] is executing',
        entryPoint.filePath?.substring(0, entryPoint?.filePath.lastIndexOf('.')),
        entryPoint.functionName ||
          `<anonymousFunc_${entryPoint.entryPointSymVal?.ast.loc.start.line}_${
            entryPoint.entryPointSymVal?.ast.loc.end.line
          }>`
      )
      const argValues = []

      for (const key in entryPoint.entryPointSymVal?.ast?.parameters) {
        argValues.push(
          this.processInstruction(
            entryPoint.entryPointSymVal,
            entryPoint.entryPointSymVal?.ast?.parameters[key].id,
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
          `[${entryPoint.entryPointSymVal?.ast?.id?.name} symbolInterpret failed. Exception message saved in error log`,
          `[${entryPoint.entryPointSymVal?.ast?.id?.name} symbolInterpret failed. Exception message saved in error log`
        )
      }
      if (index === entryPoints.length && !isFromRule) {
        this.entryPoints.push(...this.ruleEntrypoints)
        isFromRule = true
      }
      this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, { entryPoint })
    }
    return true
  }

  /**
   *
   * @param source
   * @param fileName
   */
  preProcess4SingleFile(source, fileName) {
    // 需要将source导入缓存，否则找不到trace
    SourceLine.storeCode(fileName, source)
    this.moduleManager = gomodParser.parseSingleFile(fileName, this.options)
    const { packageInfo, moduleName } = this.moduleManager
    const pkgValue = this.packageManager.getSubPackage(moduleName, true)
    const state = this.initState(this.topScope)
    this._scanPackages(pkgValue, '__single_file__', packageInfo, state)
    this.pkgValue = pkgValue
  }

  /**
   *
   * @param scope
   * @param caller
   * @param callsiteNode
   * @param argvalues
   * @param state
   */
  executeFunctionInArguments(scope, caller, callsiteNode, argvalues, state) {
    const needInvoke = config.invokeCallbackOnUnknownFunction
    if (needInvoke !== 1 && needInvoke !== 2) return

    for (let i = 0; i < argvalues.length; i++) {
      const arg = argvalues[i]
      if (arg && arg.vtype === 'object') {
        const obj = _.clone(arg) // 浅拷贝即可
        const newState = _.clone(state)
        newState.parent = state
        newState.callstack = state.callstack ? state.callstack.concat([caller]) : [caller]
        Object.values(obj.value).forEach((field) => {
          if (field?.vtype === 'fclos') {
            // only override methods will be concerned
            if (!field.ast) return
            if (!field?.ast?._meta?.modifiers?.includes('@Override')) return
            this.executeCall(callsiteNode, field, [], newState, scope)
          }
        })
      }
    }
  }

  /**
   *
   * @param scope
   */
  getEncloseFclos(scope) {
    if (!scope) return null
    let fclos = scope
    while (fclos) {
      if (fclos.vtype === 'fclos') {
        return fclos
      }
      fclos = fclos.parent
    }
    return null
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
    const newNode = _.clone(node)
    newNode.ast = node
    const newLeft = (newNode.left = this.processInstruction(scope, node.left, state))
    const newRight = (newNode.right = this.processInstruction(scope, node.right, state))

    if (node.operator === 'push') {
      this.processOperator(newLeft, node.left, newRight, node.operator, state)
    }
    if (node.operator === 'instanceof') {
      newNode._meta.type = node.right
      // TODO 250805 用.value修改
      newNode.field = newLeft.field
    }

    const hasTag = (newLeft && newLeft.hasTagRec) || (newRight && newRight.hasTagRec)
    if (hasTag) {
      newNode.hasTagRec = hasTag
    }

    if (this.checkerManager && this.checkerManager.checkAtBinaryOperation)
      this.checkerManager.checkAtBinaryOperation(this, scope, node, state, { newNode })

    return SymbolValue(newNode)
  }

  /**
   *
   * @param scope
   * @param node
   * @param argvalues
   * @param right
   * @param operator
   * @param state
   */
  processOperator(scope, node, right, operator, state) {
    switch (operator) {
      case 'push': {
        this.saveVarInCurrentScope(scope, node, right, state)
        const hasTag = (scope && scope.hasTagRec) || (right && right.hasTagRec)
        if (hasTag) {
          scope.hasTagRec = hasTag
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
  processMemberAccess(scope, node, state) {
    const defscope = this.processInstruction(scope, node.object, state)
    if (defscope.vtype === 'union' && Array.isArray(defscope.value)) {
      const ret = UnionValue()
      defscope.value.forEach((defScp) => {
        ret.appendValue(this.accessValueFromDefScope(scope, node, state, defScp))
      })
      return ret
    }
    return this.accessValueFromDefScope(scope, node, state, defscope)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   * @param defscope
   */
  accessValueFromDefScope(scope, node, state, defscope) {
    const prop = node.property
    let resolvedProp = prop
    if (node.computed) {
      resolvedProp = this.processInstruction(scope, prop, state) // important, prop should be eval by scope rather than defscope
    } else {
      // non-computed indicates node.property must be identifier
      if (prop.type !== 'Identifier' && prop.type !== 'Literal') {
        // try to solve prop in this case though
        resolvedProp = this.processInstruction(scope, prop, state)
      }
    }
    // 模糊类型补充
    if (resolvedProp) {
      const res = this.getMemberValue(defscope, resolvedProp, state)
      if (defscope.rtype && defscope.rtype !== 'DynamicType' && res && res.rtype === undefined) {
        res.rtype = { type: undefined }
        res.rtype.definiteType = defscope.rtype.type ? defscope.rtype : defscope.rtype.definiteType
        res.rtype.vagueType = defscope.rtype.vagueType
          ? `${defscope.rtype.vagueType}.${resolvedProp.name}`
          : resolvedProp.name
      }

      if (this.checkerManager) {
        this.checkerManager.checkAtMemberAccess(this, defscope, node, state, { res })
      }
      return res
    }
    return defscope
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  getMemberValue(scope, node, state) {
    // 不允许对nil值进行memberAccess
    const filter = (scp) => scp.type === 'Identifier' && scp.name === 'nil'
    return super.getMemberValue(scope, node, state, filter)
  }

  /**
   *
   * @param node
   * @param fclos
   * @param argvalues
   * @param scope
   * @param state
   */
  processLibArgToRet(node, fclos, argvalues, scope, state) {
    const ret = super.processLibArgToRet(node, fclos, argvalues, scope, state)
    // 将fclos的rtype信息保留给返回值
    if (fclos.rtype) ret.rtype = fclos.rtype
    return ret
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processIdentifier(scope, node, state) {
    if (node.name === 'nil') return PrimitiveValue({ ...node, ast: node, value: undefined })
    const res = super.processIdentifier(scope, node, state)
    if (res && this.checkerManager) {
      this.checkerManager.checkAtIdentifier(this, scope, node, state, { res })
    }
    return res
  }
}
module.exports = GoAnalyzer
