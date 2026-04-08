import GoTypeRelatedInfoResolver from '../../../../resolver/go/go-type-related-info-resolver'
import { buildNewCopiedWithTag } from '../../../../util/clone-util'
import { BinaryExprValue } from '../../common/value/binary-expr'
import type { Scope, State, Value, SymbolValue as SymbolValueType } from '../../../../types/analyzer'
import type { CallExpression, VariableDeclaration, NewExpression, ThisExpression, CompileUnit, BinaryExpression, MemberAccess, Identifier, TupleExpression } from '../../../../types/uast'

const path = require('path')
const _ = require('lodash')
const QidUnifyUtil = require('../../../../util/qid-unify-util')

const logger = require('../../../../util/logger')(__filename)
const ScopeClass = require('../../common/scope')
const Analyzer: typeof import('../../common/analyzer').Analyzer = require('../../common/analyzer')
const BasicRuleHandler = require('../../../../checker/common/rules-basic-handler')
const Parser = require('../../../parser/parser')
const {
  ValueUtil: { FunctionValue },
} = require('../../../util/value-util')
const { shallowCopyValue, buildNewValueInstance, lodashCloneWithTag } = require('../../../../util/clone-util')

const {
  valueUtil: {
    ValueUtil: { Scoped, PackageValue, PrimitiveValue, UndefinedValue, SymbolValue, UnionValue },
  },
} = require('../../common')
import type { CallInfo } from '../../common/call-args'
import { INTERNAL_CALL } from '../../common/call-args'
const { getLegacyArgValues } = require('../../common/call-args')
const Config = require('../../../../config')
const SourceLine = require('../../common/source-line')
const FileUtil = require('../../../../util/file-util')
const AstUtil = require('../../../../util/ast-util')
const MemState = require('../../common/memState')
const CheckerManager = require('../../common/checker-manager')
const entryPointConfig = require('../../common/current-entrypoint')
const { unionAllValues } = require('../../common/memStateBVT')
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
    this.ruleEntrypoints = []
    this.typeResolver = new GoTypeRelatedInfoResolver()
  }

  /**
   *
   * @param dir
   */
  scanModules(dir: any) {
    const modules = FileUtil.loadAllFileTextGlobby(['**/*.(go)'], dir)
    if (modules.length === 0) {
      handleException(
        null,
        'find no target compileUnit of the project : no go file found in source path',
        'find no target compileUnit of the project : no go file found in source path'
      )
      process.exit(1)
    }
  }

  /**
   * 扫描并解析 Go 包
   *
   * @param dir - 项目目录
   * @param state - 分析状态
   * @param defaultScope - 默认作用域
   */
  async scanPackages(dir: any, state: any, defaultScope?: any): Promise<any> {
    // 开始 parseCode 阶段：扫描模块并解析包结构
    this.performanceTracker.start('preProcess.parseCode')
    let parseCodeEnded = false
    try {
      this.scanModules(dir)
      this.topScope.context.modules = await Parser.parseProject(dir, this.options, this.sourceCodeCache)

      // 防御性检查：确保 moduleManager 不为 null
      if (!this.topScope.context.modules) {
        handleException(
          null,
          '[go-analyzer] parseProject returned null, Go AST parsing failed',
          '[go-analyzer] parseProject returned null, Go AST parsing failed'
        )
        return
      }
      const { numOfGoMod } = this.topScope.context.modules
      if (numOfGoMod > 1) {
        logger.info(`[go-analyzer] found more than one go.mod files. The num of go.mod files is ${numOfGoMod}`)
      }
      this.makeGoFileManager(this.topScope.context.modules)
      const { packageInfo, moduleName } = this.topScope.context.modules
      if (Object.entries(packageInfo.files).length === 0 && Object.entries(packageInfo.subs).length === 0) {
        // 提前返回：没有文件需要处理，在 finally 中结束 parseCode
        return
      }
      let { goModPath } = this.topScope.context.modules
      if (!goModPath) goModPath = ''
      // TODO 如果模块名叫code.alipay.com/antjail/antdpa，进去会截断
      const modulePackageManager = defaultScope || this.topScope.context.packages.getSubPackage(moduleName, true)

      // 计算项目模块根路径(go.mod所在目录)
      const moduleRootPath = this.getModuleRootPath(goModPath, Config.maindir)
      const rootDirOffset = moduleRootPath === '' ? [] : moduleRootPath.split('/')
      let rootDir = packageInfo.subs['/']
      let dirName = Config.maindir.replace(/\/$/, '').split('/').at(-1)
      for (dirName of rootDirOffset) {
        if (dirName in rootDir?.subs) {
          rootDir = rootDir.subs[dirName]
        }
      }
      this.topScope.context.modules.rootDir = rootDir
      this.topScope.context.modules.rootDirName = dirName

      // 正常流程：结束 parseCode 阶段
      this.performanceTracker.end('preProcess.parseCode')
      parseCodeEnded = true

      // 开始 ProcessModule 阶段：处理模块（分析 AST）
      this.performanceTracker.start('preProcess.processModule')
      this._scanPackages(modulePackageManager, dirName, rootDir, state, true)
      this.performanceTracker.end('preProcess.processModule')
    } finally {
      // 确保 parseCode 阶段总是被正确结束（如果之前没有结束，如提前返回的情况）
      if (!parseCodeEnded) {
        this.performanceTracker.end('preProcess.parseCode')
      }
    }
  }

  /**
   * make go filemanager
   * @param goUast
   */
  makeGoFileManager(goUast: any) {
    if (!goUast || typeof goUast !== 'object') {
      return
    }

    /**
     * 深度优先搜索对象
     * @param obj
     * @param fileManager
     * @param parentPath
     */
    function deepSearch(obj: any, fileManager: any, parentPath: string = '') {
      if (!obj || typeof obj !== 'object') {
        return
      }

      // 处理数组
      if (Array.isArray(obj)) {
        obj.forEach((item, index) => {
          deepSearch(item, fileManager, `${parentPath}[${index}]`)
        })
        return
      }

      // 处理对象的每个键值对
      for (const [key, value] of Object.entries(obj)) {
        const currentPath = parentPath ? `${parentPath}.${key}` : key

        // 检查key是否以.go结尾
        if (typeof key === 'string' && key.endsWith('.go') && value && typeof value === 'object') {
          // 在value中查找包含'node'且node.type为'CompileUnit'的节点
          const v = value as any
          if (v.node && typeof v.node === 'object' && v.node.type === 'CompileUnit') {
            fileManager[key] = { ast: v.node }
            continue
          }
        }

        // 递归搜索子对象
        deepSearch(value, fileManager, currentPath)
      }
    }

    // 开始深度搜索
    deepSearch(goUast, this.fileManager)
  }

  /**
   *
   * @param goModPath
   * @param mainDir
   */
  getModuleRootPath(goModPath: any, mainDir: any) {
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
    function _getCommonPrefix(path1: any, path2: any) {
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
   * @param isTop
   */
  _scanPackages(parentPackageValue: any, dirName: any, currentDir: any, state: any, isTop: boolean) {
    const that = this
    let currentPackageValue = parentPackageValue
    if (!isTop) {
      currentPackageValue = parentPackageValue.getSubPackage(`%dir_${dirName}`, true)
    }

    // 处理当前目录下的文件
    _handlePackageFiles((scope: any, node: any, state: any) => {
      if (node.type === 'CompileUnit') {
        node.body.forEach((n: any) => {
          if (n.type === 'ClassDefinition') {
            this.preProcessClassDefinition(scope, n, state)
          }
        })
      }
    })
    _handlePackageFiles((scope: any, node: any, state: any) => {
      this.processInstruction(scope, node, state)
    })

    currentPackageValue.packageProcessed = true

    // 处理当前目录下的子目录
    const subDirs = currentDir?.subs || {}
    for (const dirName in subDirs) {
      if (subDirs.hasOwnProperty(dirName)) {
        this._scanPackages(currentPackageValue, dirName, subDirs[dirName], state, false)
      }
    }

    /**
     *
     * @param handler
     */
    function _handlePackageFiles(handler: any) {
      Object.values(currentDir.files).forEach((nodeInfo: any) => {
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
  override processCallExpression(scope: Scope, node: CallExpression, state: State): SymbolValueType {
    if (node._meta.defer) {
      const encloseFclos = this.getEncloseFclos(scope)
      if (encloseFclos) {
        encloseFclos._defers = encloseFclos._defers || []
        const deferNode = _.clone(node)
        delete deferNode._meta.defer
        encloseFclos._defers.push(deferNode)
      }
    }

    const fclos = this.processInstruction(scope, node.callee, state)
    let ret
    if (fclos?.vtype === 'class' && node.arguments.length === 1) {
      ret = this.processInstruction(scope, node.arguments[0], state)
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
  createFuncScope(node: any, scope: any) {
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
      if (Object.prototype.hasOwnProperty.call(globalScope.context.funcs, targetQid)) {
        return globalScope.context.funcs[QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(targetQid)]
      }

      let initFunctionValue = Object.prototype.hasOwnProperty.call(scope.value, 'init') ? scope.value.init : undefined
      if (!initFunctionValue) {
        initFunctionValue = []
        scope.value.init = initFunctionValue
      }

      const fclos = new FunctionValue('', {
        sid: 'init',
        qid: targetQid,
        decls: {},
        parent: scope,
        ast: node,
      })
      fclos.ast.fdef = node
      globalScope.context.funcs[QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(targetQid)] = fclos

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
  processImportDirect(scope: any, node: any, state: any) {
    const { moduleName } = this.topScope.context.modules
    const { rootDirName } = this.topScope.context.modules
    const fromPath = node?.from?.value?.replace(/"/g, '')

    // 外部包返回空packageValue
    if (!fromPath.startsWith(`${moduleName}/`)) {
      const packageVal = new PackageValue(this.topScope.context.packages.qid, {
        vtype: 'package',
        sid: fromPath,
        parent: this.topScope.context.packages,
      })
      const exports = new Scoped(`${this.topScope.context.packages.qid}.${fromPath}`, {
        sid: 'exports',
        parent: packageVal,
      })
      packageVal.scope.exports = exports
      return packageVal
    }
    const relativeFromPath = fromPath.slice(`${moduleName}/`.length)
    const dirs = relativeFromPath.split('/')

    // 取该项目根目录的PackageValue：rootnew PackageValue(顶层Scope，即go.mod所在目录的packageValue)
    const modulePackageValue = this.topScope.context.packages.getSubPackage(moduleName, false)
    const rootPackageValue = modulePackageValue.getSubPackage(`%dir_${rootDirName}`, false)
    let parentScope = modulePackageValue

    // packageManager按照import路径(即目录结构)存储。每个目录(不管是否是包)都视作一个PackageValue，其下可能有PackageValue、ClassScope、FuncScope等。
    for (const dir of dirs) {
      const targetQid = ScopeClass.joinQualifiedName(parentScope.qid, dir)
      const currentScope = parentScope.getSubPackage(`%dir_${dir}`, true)
      parentScope.scope.exports.value[dir] = currentScope
      currentScope._qid = targetQid
      currentScope.uuid = null
      currentScope.calculateAndRegisterUUID()
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
  addFdef(targetScope: any, dirs: any, state: any) {
    const { rootDir } = this.topScope.context.modules
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
  callInitWhenImported(ImportedScope: any, state: any) {
    const initFCloses =
      AstUtil.satisfy(
        ImportedScope,
        (n: any) => n.ast?.node?.id?.name === 'init' && n.vtype === 'fclos',
        (node: any, prop: any, from: any) => node === from, // 只找当前包下的field
        null,
        true
      ) || []
    for (const initFClos of initFCloses) {
      this.executeCall(initFClos.ast?.node, initFClos, state, ImportedScope, INTERNAL_CALL)
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processVariableDeclaration(scope: Scope, node: VariableDeclaration, state: State): SymbolValueType {
    const initialNode = node.init
    const id = node.id  // LVal: Identifier | MemberAccess | TupleExpression
    if (!id || (id.type === 'Identifier' && id.name === '_')) return new UndefinedValue() // e.g. in Go

    let initVal
    if (!initialNode) {
      let cscope
      if (node.varType) {
        cscope = this.processInstruction(scope, node.varType, state)
        // if (cscope && cscope.vtype !== 'undefine')
        if (cscope) {
          initVal = this.buildNewObject(cscope?.ast.fdef, cscope, state, node, scope, INTERNAL_CALL)
        } else {
          initVal = this.createVarDeclarationScope(id, scope)
        }
      }
      initVal.uninit = !initialNode
      initVal = SourceLine.addSrcLineInfo(
        initVal,
        id,
        id.loc && id.loc.sourcefile,
        'Var Pass: ',
        id.type === 'Identifier' ? id.name : undefined
      )
    } else {
      initVal = this.processInstruction(scope, initialNode, state)
      if (node.cloned && !initVal?.runtime?.refCount) {
        initVal = shallowCopyValue(initVal)
        initVal.value = shallowCopyValue(initVal.value)
      }
      if (initVal?.rtype && initVal.rtype !== 'DynamicType') {
        const cscope = this.processInstruction(scope, initVal.rtype, state)
        if (cscope?.vtype === 'class' && initVal.vtype !== 'primitive') {
          initVal = this.buildTypeObject(initVal, cscope)
        }
      }
      initVal = SourceLine.addSrcLineInfo(
        initVal,
        node,
        node.loc && node.loc.sourcefile,
        'Var Pass: ',
        id.type === 'Identifier' ? id.name : undefined
      )
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
      const tupleId = id as TupleExpression
      if (initVal.vtype === 'union') {
        const substates = MemState.forkStates(state, 1)
        const pairs = _.floor(initVal.value.length / tupleId.elements.length)
        const scopes = new Array(tupleId.elements.length)
        for (let i = 0; i < tupleId.elements.length; i++) {
          scopes[i] = new Array(pairs)
        }
        for (let i = 0; i < pairs; i++) {
          for (let j = 0; j < tupleId.elements.length; j++) {
            scopes[j][i] = initVal.getFieldValue(String(i * tupleId.elements.length + j))
          }
        }
        for (let i = 0; i < tupleId.elements.length; i++) {
          const union = unionAllValues(scopes[i], state)
          this.saveVarInCurrentScope(scope, tupleId.elements[i], union, state)
        }
      } else if (Array.isArray(initVal.value) && initVal.value.length >= 1) {
        const minLen = Math.min(tupleId.elements.length, initVal.value.length)
        for (let i = 0; i < minLen; i++) {
          this.saveVarInCurrentScope(scope, tupleId.elements[i], initVal.getFieldValue(String(i)), state)
        }
      } else {
        for (const i in tupleId.elements) {
          this.saveVarInCurrentScope(scope, tupleId.elements[i], initVal, state)
        }
      }
    } else {
      // 如果是import，则定义真正的包名而非目录名
      if (
        initialNode?.type === 'ImportExpression' &&
        initVal?.vtype === 'package' &&
        initVal.name &&
        id.type === 'Identifier' &&
        id.name === (initialNode as any).from?.value?.split('/').at(-1)
      ) {
        id.name = initVal.name
      }
      this.saveVarInCurrentScope(scope, id, initVal, state)
    }

    // set alias name if val itself has no identifier
    if (initVal && !(initVal.name || initVal.sid)) {
      initVal.sid = id.type === 'Identifier' ? id.name : ''
    }

    if (id.type === 'Identifier') {
      scope.ast.setDecl(id.name, id)
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
  override processNewExpression(scope: Scope, node: NewExpression, state: State): SymbolValueType {
    return this.processNewObject(scope, node, state)
  }

  /**
   * process object creation. Retrieve the function definition
   * @param scope
   * @param node
   * @param state
   * @returns {*}
   */
  override processNewObject(scope: any, node: any, state: any) {
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

    const obj = this.buildNewObject(fdef, fclos, state, node, scope, { callArgs: this.buildCallArgs(node, argvalues, fclos) })
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
  override preProcessClassDefinition(scope: any, cdef: any, state: any) {
    if (!(cdef && cdef.body)) return new UndefinedValue() // Should not happen

    // pre-processing
    const fname = cdef.id?.name

    const cscope = ScopeClass.createSubScope(fname, scope, 'class') // class scope
    cscope.ast = cdef
    cscope.ast.cdef = cdef
    cscope.__preprocess = true
    return cscope
  }

  /**
   *
   * @param scope
   * @param cdef
   * @param state
   */
  override processClassDefinition(scope: any, cdef: any, state: any) {
    if (!(cdef && cdef.body)) return new UndefinedValue() // Should not happen

    // pre-processing
    const fname = cdef.id?.name

    const cscope = ScopeClass.createSubScope(fname, scope, 'class') // class scope
    cscope.ast = cdef
    cscope.ast.cdef = cdef
    if (cdef._meta?.isInterface) cscope.isInterface = true
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
  override resolveClassInheritance(fclos: any, state: any) {
    const fdef = fclos.ast.cdef
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
      if (fclos?.sid === superId?.name) {
        // to avoid self-referencing
        return
      }
      const superClos = this.processInstruction(scope, superId, state)
      // const superClos = this.getMemberValue(scope, superId, state);
      if (!superClos) return new UndefinedValue()
      fclos.super = superClos

      // inherit definitions
      // superValue is used to record values of super class, so that we can handle cases like super.xxx() or super()
      const superValue = fclos.value.super || ScopeClass.createSubScope('super', fclos, 'fclos')
      // super's parent should be assigned to base, _this will track on fclos
      superValue.parent = superClos
      for (const fieldName in superClos.value) {
        if (fieldName === 'super') continue
        const v = superClos.value[fieldName]
        if (v.runtime?.readonly) continue
        const v_copy = shallowCopyValue(v)
        if (!v_copy.func) v_copy.func = {}
        v_copy.func.inherited = true
        v_copy._this = fclos
        v_copy._base = superClos
        fclos.value[fieldName] = v_copy

        superValue.value[fieldName] = v_copy
        // super fclos should fill its fdef with ctor definition
        if (fieldName === '_CTOR_') {
          superValue.ast.node = v_copy.ast.fdef
          superValue.ast.fdef = v_copy.ast.fdef
          superValue.overloaded.push(fdef)
        }

        // v_copy.parent = fclos;  // Important!
      }

      // inherit declarations
      for (const x of superClos.ast.declKeys) {
        const v = superClos.ast.getDecl(x)
        fclos.ast.setDecl(x, v)
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
  override processThisExpression(scope: Scope, node: ThisExpression, state: State): SymbolValueType {
    this.thisFClos.pointerReference = true
    if (node._meta.type?.type === 'PointerType') {
      // 引用
      return this.thisFClos
    }
    // 值传递
    // TODO: 只深拷贝this.thisFClos.value即可，疑似循环依赖，待查
    return buildNewValueInstance(
      this,
      this.thisFClos,
      null,
      this.thisFClos.parent,
      (x: any) => {
        return false
      },
      (v: any) => {
        return !v
      }
    )
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   * @param prePostFlag
   */
  override processInstruction(scope: any, node: any, state: any, prePostFlag?: any): any {
    if (node?.name === 'error' || node?.name === 'err') {
      return new SymbolValue('', { sid: node.name, qid: `${scope.qid}.${node.name}`, ...node })
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
  processPointerType(scope: any, node: any, state: any, prePostFlag: any) {
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
  convertRetValToObjectType(fclos: any, argvalues: any, state: any, node: any, scope: any, retVal: any) {
    if (retVal.vtype === 'union') {
      const declRetType = fclos.ast.node.returnType
      if (declRetType.type === 'TupleType') {
        const retNum = declRetType.elements.length
        for (const i in retVal.value) {
          const eachRetVal = retVal.value[i]
          eachRetVal.rtype = declRetType.elements[Number(i) % retNum]
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
          rawValue.rtype = fclos.ast.node.returnType
          if (rawValue.rtype !== 'DynamicType') {
            const cscope = this.processInstruction(scope, rawValue.rtype, state)
            if (cscope.vtype === 'class' && !(rawValue.type === 'Identifier' && rawValue.name === 'nil')) {
              rawValue = this.buildTypeObject(rawValue, cscope)
            }
          }
        }
      }
    } else if (_.isArray(retVal) && fclos.ast.node.returnType.type !== 'VoidType') {
      // TODO 这里YASA有bug，暂时先改为对VoidType特判
      for (const i in retVal) {
        retVal[i].rtype = fclos.ast.node.returnType.elements[i]
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
      retVal.rtype = fclos.ast.node.returnType
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
  override executeSingleCall(fclos: any, state: any, node: any, scope: any, callInfo: CallInfo) {
    const retVal = super.executeSingleCall(fclos, state, node, scope, callInfo)
    const argvalues = getLegacyArgValues(callInfo)
    return this.convertRetValToObjectType(fclos, argvalues, state, node, scope, retVal)
  }

  /**
   * build a type object. Record the fields and initialize their values to oldScope
   * @param oldScope
   * @param fclos
   * @returns {*}
   */
  buildTypeObject(oldScope: any, fclos: any) {
    // clone the basic class object
    const obj = lodashCloneWithTag(oldScope) // 浅拷贝即可
    for (const x in fclos.value) {
      const v = fclos.value[x]
      if (!v) continue
      const v_copy = buildNewValueInstance(
        this,
        v,
        null,
        v.parent,
        (x: any) => {
          return false
        },
        (v: any) => {
          return !v
        }
      )
      if (obj.members?.has(x)) continue
      if (!obj.members) continue  // Guard: skip if members is undefined
      obj.members.set(x, v_copy)
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
  override processCompileUnit(scope: Scope, node: CompileUnit, state: State): Value {
    // 避免同一compileUnit被重复处理(例如，已被init的全局变量会被覆盖定义)
    if (node._meta.compileUnitProcessed) return this.topScope.members.get('UndefinedValue')?.() as Value
    node._meta.compileUnitProcessed = true
    if (this.checkerManager && this.checkerManager.checkAtCompileUnit) {
      const interruptFlag = this.checkerManager.checkAtCompileUnit(this, scope, node, state, {
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
      })
      // 插件返回状态为：中断后续分析
      if (interruptFlag) return this.topScope.members.get('UndefinedValue')?.() as Value
    }
    return super.processCompileUnit(scope, node, state)
  }

  /**
   *
   */
  override startAnalyze() {
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
  async preProcess(dir: any) {
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
    const hasAnalysised: string[] = []
    // 自定义source入口方式，并根据入口自主加载source
    let index = 0
    while (index < entryPoints.length) {
      const entryPoint = entryPoints[index++]
      if (entryPoint.isPreProcess && this.isTmpSymbolTableOpen) {
        this.restoreSymbolTable()
      } else if (this.isTmpSymbolTableOpen) {
        this.symbolTable.clear()
      }

      if (!entryPoint.isPreProcess && !this.isTmpSymbolTableOpen) {
        this.switchToTemporarySymbolTable()
      }

      if (entryPoint.type === constValue.ENGIN_START_FILE_BEGIN) continue
      entryPointConfig.setCurrentEntryPoint(entryPoint)
      if (
        (isFromRule || entryPoint.functionName === 'main') &&
        hasAnalysised.includes(
          `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?.qid}#${entryPoint.entryPointSymVal.ast.node.parameters}.${entryPoint.attribute}`
        )
      ) {
        continue
      }

      hasAnalysised.push(
        `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?.qid}#${entryPoint.entryPointSymVal.ast.node.parameters}.${entryPoint.attribute}`
      )

      logger.info(
        'EntryPoint [%s.%s] is executing',
        entryPoint.filePath?.substring(0, entryPoint?.filePath.lastIndexOf('.')),
        entryPoint.functionName ||
          `<anonymousFunc_${entryPoint.entryPointSymVal?.ast?.node?.loc.start?.line}_${
            entryPoint.entryPointSymVal?.ast?.node?.loc.end?.line
          }>`
      )

      this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, { entryPoint })

      const argValues = []

      for (const key in entryPoint.entryPointSymVal?.ast?.node?.parameters) {
        argValues.push(
          this.processInstruction(
            entryPoint.entryPointSymVal,
            entryPoint.entryPointSymVal?.ast?.node?.parameters[key].id,
            state
          )
        )
      }

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
          `[${entryPoint.entryPointSymVal?.ast?.node?.id?.name} symbolInterpret failed. Exception message saved in error log`,
          `[${entryPoint.entryPointSymVal?.ast?.node?.id?.name} symbolInterpret failed. Exception message saved in error log`
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
  preProcess4SingleFile(source: any, fileName: any) {
    // 先填充 sourceCodeCache，parser 会优先使用
    this.sourceCodeCache.set(fileName, source.split(/\n/))
    this.topScope.context.modules = Parser.parseSingleFile(fileName, this.options, this.sourceCodeCache)
    const { packageInfo, moduleName } = this.topScope.context.modules
    const pkgValue = this.topScope.context.packages.getSubPackage(moduleName, true)
    const state = this.initState(this.topScope)
    this._scanPackages(pkgValue, '__single_file__', packageInfo, state, true)
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
  override executeFunctionInArguments(scope: any, caller: any, callsiteNode: any, argvalues: any, state: any) {
    const needInvoke = Config.invokeCallbackOnUnknownFunction
    if (needInvoke !== 1 && needInvoke !== 2) return

    for (let i = 0; i < argvalues.length; i++) {
      const arg = argvalues[i]
      if (arg && arg.vtype === 'object') {
        const obj = lodashCloneWithTag(arg) // 浅拷贝即可
        const newState = _.clone(state)
        newState.parent = state
        newState.callstack = state.callstack ? state.callstack.concat([caller]) : [caller]
        newState.callsites = state.callsites
          ? state.callsites.concat([
              {
                code: AstUtil.getRawCode(callsiteNode).slice(0, 100),
                nodeHash: callsiteNode._meta?.nodehash,
                loc: callsiteNode.loc,
              },
            ])
          : [
              {
                code: AstUtil.prettyPrintAST(callsiteNode).slice(0, 100),
                nodeHash: callsiteNode._meta?.nodehash,
                loc: callsiteNode.loc,
              },
            ]
        Object.values(obj.value).forEach((field: any) => {
          if (field?.vtype === 'fclos') {
            // only override methods will be concerned
            if (!field.ast.node) return
            if (!field?.ast?.node?._meta?.modifiers?.includes('@Override')) return
            this.executeCall(callsiteNode, field, newState, scope, INTERNAL_CALL)
          }
        })
      }
    }
  }

  /**
   *
   * @param scope
   */
  getEncloseFclos(scope: any) {
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
  override processBinaryExpression(scope: Scope, node: BinaryExpression, state: State): BinaryExprValue {
    const newLeft = this.processInstruction(scope, node.left, state)
    const newRight = this.processInstruction(scope, node.right, state)

    if (node.operator === 'push') {
      this.processOperator(newLeft, node.left, newRight, node.operator, state)
    }

    const hasTag = (newLeft && newLeft.taint?.isTaintedRec) || (newRight && newRight.taint?.isTaintedRec)

    // checkerManager 需要 newNode 兼容对象
    const newNode: any = { ...node, ast: node, left: newLeft, right: newRight, isTainted: hasTag || null }
    if (node.operator === 'instanceof') {
      newNode._meta = { ...node._meta, type: node.right }
      newNode.value = newLeft.value
    }
    if (this.checkerManager && this.checkerManager.checkAtBinaryOperation)
      this.checkerManager.checkAtBinaryOperation(this, scope, node, state, { newNode })

      const result = new BinaryExprValue(scope.qid, node.operator, newLeft, newRight, node, node.loc) as any
    if (hasTag) {
      result.taint?.mergeFrom([newLeft, newRight])
    }
    if (node.operator === 'instanceof') {
      result.value = newLeft.value
    }
    return result
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
  processOperator(scope: any, node: any, right: any, operator: any, state: any) {
    switch (operator) {
      case 'push': {
        this.saveVarInCurrentScope(scope, node, right, state)
        const hasTag = (scope && scope.taint?.isTaintedRec) || (right && right.taint?.isTaintedRec)
        if (hasTag) {
          scope.taint?.mergeFrom([scope, right])
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
  override processMemberAccess(scope: Scope, node: MemberAccess, state: State): SymbolValueType {
    const defscope = this.processInstruction(scope, node.object, state)
    if (defscope.vtype === 'union' && Array.isArray(defscope.value)) {
      const ret = new UnionValue(undefined, undefined, `${scope.qid}.<union@go_mem:${node.loc?.start?.line}:${node.loc?.start?.column}>`, node)
      defscope.value.forEach((defScp: any) => {
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
  accessValueFromDefScope(scope: any, node: any, state: any, defscope: any) {
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
      if (!defscope || typeof defscope !== 'object' || !defscope.vtype) {
        return new UndefinedValue()
      }
      const res = this.getMemberValue(defscope, resolvedProp, state)
      if (node.object.type !== 'SuperExpression' && (res.vtype !== 'union' || !Array.isArray(res.value))) {
        res._this = defscope
      }
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
  getMemberValue(scope: any, node: any, state: any) {
    // 不允许对nil值进行memberAccess
    const filter = (scp: any) => scp.type === 'Identifier' && scp.name === 'nil'
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
  override processLibArgToRet(node: any, fclos: any, argvalues: any, scope: any, state: any, callInfo: CallInfo) {
    const ret = super.processLibArgToRet(node, fclos, argvalues, scope, state, callInfo)
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
  override processIdentifier(scope: Scope, node: Identifier, state: State): SymbolValueType {
    if (node.name === 'nil') return new PrimitiveValue(scope.qid, 'nil', undefined, null, node.type, node.loc, node)
    const res = super.processIdentifier(scope, node, state)
    if (res && this.checkerManager) {
      this.checkerManager.checkAtIdentifier(this, scope, node, state, { res })
    }
    return res
  }
}

module.exports = GoAnalyzer
