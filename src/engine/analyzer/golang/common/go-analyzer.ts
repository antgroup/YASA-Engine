import GoTypeRelatedInfoResolver from '../../../../resolver/go/go-type-related-info-resolver'
import { buildNewCopiedWithTag } from '../../../../util/clone-util'
import { AstRefList } from '../../common/value/ast-ref-list'
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
    ValueUtil: { Scoped, PackageValue, PrimitiveValue, UndefinedValue, SymbolValue, UnionValue, ObjectValue },
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
const { ErrorCode } = require('../../../../util/error-code')

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
    this._isSymbolInterpretPhase = false
    this._methodResolveCache = {}
    this.classMap = new Map()
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
      process.exitCode = ErrorCode.no_valid_source_file
      return
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
            fileManager[key] = { astNode: v.node }
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
   * Go 嵌入结构体方法延迟解析：实例上找不到方法时，通过 ClassDefinition 的 SpreadElement 找嵌入类型的方法。
   * 解决文件按字母序处理时，SpreadElement 阶段嵌入类型方法尚未注册导致继承失败的问题。
   */
  _resolveEmbeddedMethod(defscope: any, methodName: string): any {
    // 从实例的 sid 提取类名
    const className = defscope.sid?.split('<')?.[0]?.split('.')?.[0]
    if (!className) return null

    const classDefs = this._findAllClassDefsByName(className)
    for (const classDef of classDefs) {
      const bodyStmts = this._getClassDefBodyStmts(classDef)
      if (!bodyStmts) continue

      for (const stmt of bodyStmts) {
        if (stmt.type !== 'SpreadElement') continue
        const embeddedTypeName = this._extractTypeName(stmt.argument)
        if (!embeddedTypeName) continue

        // 在已解析的 packages 中查找嵌入类型的 ClassDefinition
        const embeddedClasses = this._findAllClassDefsByName(embeddedTypeName)
        for (const embeddedClass of embeddedClasses) {
          if (embeddedClass.value?.[methodName]?.ast?.fdef) {
            return embeddedClass.value[methodName]
          }
        }
      }
    }
    return null
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

    // 拦截 make(MapType, ...) 调用，返回空 map ObjectValue，避免生成 <unknownProcessTypeNode> symbol
    // Go UAST 中 make() 的类型参数可能是 MapType（不在 Expr union 内），用 any 绕过类型检查
    if (node.callee?.type === 'Identifier' && (node.callee as Identifier).name === 'make') {
      const typeArg = node.arguments?.[0] as any
      if (typeArg?.type === 'MapType') {
        const line = node.loc?.start?.line ?? 'unknown'
        const mapSid = `<make_map_${line}>`
        const mapObj = new ObjectValue(scope.qid, { sid: mapSid })
        mapObj.rtype = typeArg
        return mapObj
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

      // 构建 callInfo，携带调用参数信息供 checker 做 sink 匹配
      // 仅在外部库方法（无可执行函数体）时传递 callInfo，有函数体的调用由
      // super.processCallExpression 内部 executeFdeclOrExecute 统一处理 sink 匹配，避免重复 finding
      const fclosBody = fclos?.ast?.fdef?.body
      const isUnresolvableCall = !fclos || fclos.vtype !== 'fclos' || !fclosBody || fclosBody.type === 'Noop'
      const callInfo: CallInfo | undefined = isUnresolvableCall
        ? { callArgs: this.buildCallArgs(node, argvalues, fclos) }
        : undefined
      if (argvalues && this.checkerManager) {
        this.checkerManager.checkAtFunctionCallBefore(this, scope, node, state, {
          argvalues,
          fclos,
          callInfo,
          pcond: state.pcond,
          entry_fclos: this.entry_fclos,
          einfo: state.einfo,
          state,
          analyzer: this,
          ainfo: this.ainfo,
        })
      }
      ret = super.processCallExpression(scope, node, state)

      // CHA fallback：正常 dispatch 未生效时，通过 ClassHierarchy 查找接口实现并执行
      if (
        (this as any).classHierarchyMap &&
        (fclos?.vtype !== 'fclos' || this.checkFclosInInterface(fclos)) &&
        (!ret || ret.vtype === 'symbol')
      ) {
        let implementations = this.findCHAImplementations(fclos)

        // rtype fallback：fclos.parent 不是接口时，通过 receiver 的 rtype 查找接口
        if (implementations.length === 0 && node.callee?.type === 'MemberAccess') {
          const methodName = node.callee.property?.name || (node.callee.property as any)?.value
          if (methodName) {
            // 获取 receiver 的 rtype（优先 fclos.parent.rtype，其次从 callee.object 获取）
            let rtype = fclos?.parent?.rtype || fclos?._object?.rtype
            if (!rtype && node.callee.object) {
              const receiver = this.processInstruction(scope, node.callee.object, state)
              rtype = receiver?.rtype
            }
            if (rtype) {
              const rtypeName = rtype.type === 'Identifier' ? rtype.name
                : rtype.type === 'PointerType' ? rtype.element?.name
                : null
              if (rtypeName) {
                implementations = this.findCHAImplementationsByTypeName(rtypeName, methodName)
              }
            }
          }
        }

        if (implementations.length > 0) {
          const results: any[] = []
          const executed = new Set<string>()

          for (const implFclos of implementations) {
            // 剪枝：dedup（同一 call site 不重复执行同一实现）
            const implKey = implFclos.qid || implFclos.uuid
            if (executed.has(implKey)) continue
            executed.add(implKey)

            // 剪枝：callstack depth 超限
            if (state?.callstack?.length >= Config.maxCallstackDepth) break

            // 剪枝：Noop body 跳过
            if (implFclos.ast?.fdef?.body?.type === 'Noop') continue

            // 绑定 this 并执行
            const oldThis = implFclos._this
            if (fclos?._this) implFclos._this = fclos._this
            else if (typeof fclos?.getThisObj === 'function') implFclos._this = fclos.getThisObj()

            const r = this.executeCall(node, implFclos, state, scope, {
              callArgs: this.buildCallArgs(node, argvalues, implFclos),
            })
            implFclos._this = oldThis

            if (r && r.vtype !== 'symbol') results.push(r)
          }

          // 返回值合并：单个直接返回，多个用 UnionValue
          if (results.length === 1) {
            ret = results[0]
          } else if (results.length > 1) {
            ret = new UnionValue(results)
          }
        }
      }

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
          // 全局变量类型推导：将声明类型写入 rtype，使 sink 匹配时能获取 calleeType
          if (node.varType && initVal) {
            initVal.rtype = node.varType
          }
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
          const savedRtype = initVal.rtype
          initVal = this.buildTypeObject(initVal, cscope)
          if (savedRtype && !initVal.rtype) initVal.rtype = savedRtype
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
        if (initVal.isTuple) {
          // 直接 tuple：按索引 1-to-1 映射
          const minLen = Math.min(tupleId.elements.length, initVal.value.length)
          for (let i = 0; i < minLen; i++) {
            this.saveVarInCurrentScope(scope, tupleId.elements[i], initVal.getFieldValue(String(i)), state)
          }
        } else {
          // union-of-returns：每个元素可能是 isTuple union 或单值，按位置提取后合并
          const leftCount = tupleId.elements.length
          const perPos: any[][] = Array.from({ length: leftCount }, () => [])
          for (let idx = 0; idx < initVal.value.length; idx++) {
            const elem = initVal.value[idx]
            if (elem && elem.isTuple && elem.vtype === 'union') {
              // 某个 return 分支的 tuple，按位置提取
              for (let j = 0; j < leftCount; j++) {
                perPos[j].push(j < elem.value.length ? elem.value[j] : elem)
              }
            } else {
              // 非 tuple 值，保守分配到所有位置
              for (let j = 0; j < leftCount; j++) {
                perPos[j].push(elem)
              }
            }
          }
          for (let i = 0; i < leftCount; i++) {
            const union = unionAllValues(perPos[i], state)
            this.saveVarInCurrentScope(scope, tupleId.elements[i], union, state)
          }
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

    // 注册到 classMap，供 CHA 构建 ClassHierarchy
    const logicalQid = cscope.logicalQid || cscope.qid
    if (logicalQid && cscope.uuid) {
      this.classMap.set(logicalQid, cscope.uuid)
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
          if (!superValue.overloaded) {
            superValue.overloaded = new AstRefList(() => superValue.getASTManager())
          }
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
        if (!retVal.value || !retVal.value[Symbol.iterator]) return retVal
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
   * 检查 fclos 是否属于 interface（Go 没有 abstract class）
   */
  checkFclosInInterface(fclos: any): boolean {
    return !!(
      fclos?.parent?.isInterface ||
      fclos?.ast?.fdef?.parent?._meta?.isInterface
    )
  }

  /**
   * 从 classHierarchyMap 查找接口方法的所有具体实现
   * 递归遍历 implementedBy 链（包含间接实现）
   */
  findCHAImplementations(fclos: any): any[] {
    if (!this.classHierarchyMap) return []

    const interfaceQid = fclos.parent?.logicalQid || fclos.parent?.qid
    if (!interfaceQid) return []

    const hierarchy = this.classHierarchyMap.get(interfaceQid)
    if (!hierarchy || hierarchy.implementedBy.length === 0) return []

    const methodName = fclos.sid || fclos.name
    if (!methodName) return []

    const results: any[] = []
    const visited = new Set<string>()

    // 递归收集所有实现类（包括间接实现）
    const collectImplementors = (h: any) => {
      for (const impl of h.implementedBy) {
        if (visited.has(impl.type)) continue
        visited.add(impl.type)

        const implMethod = impl.value?.value?.[methodName]
        if (implMethod?.vtype === 'fclos' && implMethod.ast?.fdef?.body?.type !== 'Noop') {
          results.push(implMethod)
        }

        // 递归：实现类可能也被其他类继承
        if (impl.extendedBy?.length > 0) {
          collectImplementors(impl)
        }
      }
    }

    collectImplementors(hierarchy)
    return results
  }

  /**
   * 通过类型名和方法名在 classHierarchyMap 中查找接口实现
   * 用于 rtype fallback：当 fclos.parent 不是接口时，通过 receiver 声明类型查找
   */
  findCHAImplementationsByTypeName(typeName: string, methodName: string): any[] {
    if (!this.classHierarchyMap || !typeName || !methodName) return []

    // 在 classHierarchyMap 中查找匹配的接口（qid 以 .typeName 结尾或等于 typeName）
    for (const [qid, hierarchy] of this.classHierarchyMap as Map<string, any>) {
      if (hierarchy.typeDeclaration !== 'interface') continue
      // 匹配：qid 末尾是 typeName（考虑包名前缀）
      if (qid !== typeName && !qid.endsWith('.' + typeName)) continue
      if (!hierarchy.implementedBy || hierarchy.implementedBy.length === 0) continue

      const results: any[] = []
      const visited = new Set<string>()

      const collectImplementors = (h: any) => {
        for (const impl of h.implementedBy) {
          if (visited.has(impl.type)) continue
          visited.add(impl.type)
          const implMethod = impl.value?.value?.[methodName]
          if (implMethod?.vtype === 'fclos' && implMethod.ast?.fdef?.body?.type !== 'Noop') {
            results.push(implMethod)
          }
          if (impl.extendedBy?.length > 0) {
            collectImplementors(impl)
          }
        }
      }

      collectImplementors(hierarchy)
      if (results.length > 0) return results
    }
    return []
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
    this._isSymbolInterpretPhase = true
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
   * 防止已 resolved 的符号值被 resolveIndices 二次处理导致 qid 损坏
   */
  saveVarInCurrentScope(scope: any, node: any, value: any, state: any): any {
    if (node?.vtype && node.vtype !== 'undefine' && node?.sid?.startsWith('<indice_')) {
      return this.saveVarInScopeRec(scope, node, value, state)
    }
    return super.saveVarInCurrentScope(scope, node, value, state)
  }

  /**
   * Go map computed index 归一化 + UAST 扁平化修复
   * 1. 先修复 UAST 扁平化的 map[obj.field] 模式
   * 2. 再将求值结果为 primitive 字符串的 index 转为 Identifier 格式的 SymbolValue
   */
  resolveIndices(scope: any, node: any, state: any): any {
    // UAST 扁平化修复：map[obj.field] → (map[obj]).field
    let inputNode = node
    if (node?.type === 'MemberAccess' && node?.computed) {
      const fixed = this._tryUnflattenMapIndex(node as MemberAccess)
      if (fixed) {
        inputNode = fixed
      }
    }
    const resolved = super.resolveIndices(scope, inputNode, state)
    if (!resolved || resolved.type !== 'MemberAccess' || !resolved.computed) return resolved
    // key 归一化
    const prop = resolved.property
    if (prop?.vtype === 'primitive' && typeof prop.value === 'string') {
      const normalized = new SymbolValue(prop.qid, { sid: `<indice_${prop.value}>`, name: prop.value, type: 'Identifier', loc: prop.loc })
      resolved.property = normalized
    } else if (prop?.vtype === 'symbol' && !prop.sid?.startsWith('<indice_') && prop.name && typeof prop.name === 'string') {
      const normalized = new SymbolValue(prop.qid, { sid: `<indice_${prop.name}>`, name: prop.name, type: 'Identifier', loc: prop.loc })
      resolved.property = normalized
    }
    return resolved
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processMemberAccess(scope: Scope, node: MemberAccess, state: State): SymbolValueType {
    // 修复 Go UAST 扁平化问题：map[obj.field] 被解析为 (map[obj]).field
    // 检测：外层 computed=true，object 也是 computed=true MemberAccess，且外层 property 是 Identifier，
    // 并且内层 property（也是 Identifier）的 end 列紧邻外层 property 的 start 列（.分隔符）
    const effectiveNode = this._tryUnflattenMapIndex(node) ?? node
    const defscope = this.processInstruction(scope, effectiveNode.object, state)
    if (defscope.vtype === 'union' && Array.isArray(defscope.value)) {
      const ret = new UnionValue(undefined, undefined, `${scope.qid}.<union@go_mem:${node.loc?.start?.line}:${node.loc?.start?.column}>`, node)
      defscope.value.forEach((defScp: any) => {
        ret.appendValue(this.accessValueFromDefScope(scope, effectiveNode, state, defScp))
      })
      return ret
    }
    return this.accessValueFromDefScope(scope, effectiveNode, state, defscope)
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

      // Go struct 实例方法解析：实例 _field 为空时，通过 rtype 链查找 ClassDefinition 方法
      if (this._isSymbolInterpretPhase && defscope.vtype === 'symbol' && defscope.rtype && defscope.rtype !== 'DynamicType') {
        const methodFclos = this.resolveGoMethod(defscope, resolvedProp?.name)
        if (methodFclos) {
          return methodFclos
        }
      }

      // Go 嵌入结构体方法解析：实例方法未找到时，通过 ClassDefinition 的 SpreadElement 查找嵌入类型的方法
      if (this._isSymbolInterpretPhase && defscope.vtype === 'object' && resolvedProp?.name
          && (!res || !res.ast?.fdef)) {
        const embeddedMethod = this._resolveEmbeddedMethod(defscope, resolvedProp.name)
        if (embeddedMethod) {
          return embeddedMethod
        }
      }

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
   * 检测并修复 Go UAST 扁平化问题：map[obj.field] → (map[obj]).field。
   * uast4go 将 IndexExpr(X, SelectorExpr(Y, Z)) 错误解析为：
   *   MemberAccess(computed=true, MemberAccess(computed=true, X, Y), Z)
   * 正确语义应为：
   *   MemberAccess(computed=true, X, MemberAccess(computed=false, Y, Z))
   * 返回重构后的临时节点，或 null 表示不需要修复。
   */
  private _tryUnflattenMapIndex(node: MemberAccess): MemberAccess | null {
    // 条件1：外层 computed=true
    if (!node.computed) return null
    // 条件2：外层 property 是简单 Identifier
    const outerProp = node.property as any
    if (!outerProp || outerProp.type !== 'Identifier') return null
    // 条件3：外层 object 也是 computed=true MemberAccess
    const innerNode = node.object as any
    if (!innerNode || innerNode.type !== 'MemberAccess' || !innerNode.computed) return null
    // 条件4：内层 property 也是简单 Identifier（不是字面量或表达式）
    const innerProp = innerNode.property as any
    if (!innerProp || innerProp.type !== 'Identifier') return null
    // 条件5：列号验证——内层 property end 列 + 1（.分隔符）= 外层 property start 列
    const innerPropEnd = innerProp.loc?.end?.column
    const outerPropStart = outerProp.loc?.start?.column
    if (innerPropEnd == null || outerPropStart == null) return null
    if (innerPropEnd + 1 !== outerPropStart) return null

    // 重构：MemberAccess(computed=true, X, MemberAccess(computed=false, Y, Z))
    const newInnerProp: any = {
      type: 'MemberAccess',
      computed: false,
      object: innerNode.property,  // Y（mc）
      property: node.property,     // Z（name）
      loc: {
        start: innerNode.property.loc?.start,
        end: node.property.loc?.end,
      },
    }
    const rewritten: any = {
      type: 'MemberAccess',
      computed: true,
      object: innerNode.object,    // X（startModules）
      property: newInnerProp,      // mc.name
      loc: node.loc,
    }
    return rewritten as MemberAccess
  }

  /**
   * 策略1：从 rtype 链中提取父 ClassDefinition，再从其字段的类型找到目标 ClassDefinition 的方法
   * 策略2：遍历 packages 查找包含该方法的非接口 ClassDefinition
   * 注意：不调用 processInstruction（symbolInterpret 阶段有副作用），只做数据结构遍历
   */
  resolveGoMethod(defscope: any, methodName: string): any {
    const rtype = defscope.rtype
    if (!rtype || typeof rtype !== 'object') return null

    // 策略1：从 rtype 链提取字段名和父类型名，然后在 packages 中精确查找
    const fieldName = rtype.vagueType?.split('.').pop()
    const parentTypeNode = rtype.definiteType
    if (fieldName && parentTypeNode) {
      const cacheKey = `type:${fieldName}:${methodName}`
      if (cacheKey in this._methodResolveCache) return this._methodResolveCache[cacheKey]

      const resolved = this._resolveMethodViaTypeChain(parentTypeNode, fieldName, methodName)
      if (resolved) {
        this._methodResolveCache[cacheKey] = resolved
        return resolved
      }
    }

    // 策略2：全局搜索兜底
    const fallbackKey = `global:${methodName}`
    if (fallbackKey in this._methodResolveCache) return this._methodResolveCache[fallbackKey]

    const found = this._searchMethodInPackages(methodName)
    this._methodResolveCache[fallbackKey] = found
    return found
  }

  /**
   * 策略1（纯数据遍历，无副作用）：
   * 从 PointerType/Identifier AST 节点提取父类型名 → 在 packages 中找到所有同名 ClassDefinition
   * → 遍历每个候选，从 body 中查找目标字段 → 提取字段的 varType → 找到目标 ClassDefinition 的方法
   * 解决同名类型歧义：多个包定义同名 struct 时，通过字段名精确匹配正确的 ClassDefinition
   */
  _resolveMethodViaTypeChain(parentTypeNode: any, fieldName: string, methodName: string): any {
    const parentTypeName = this._extractTypeName(parentTypeNode)
    if (!parentTypeName) return null

    const parentClassDefs = this._findAllClassDefsByName(parentTypeName)
    if (parentClassDefs.length === 0) return null

    // 遍历所有同名 ClassDefinition，找到包含目标字段的那个
    for (const parentClassDef of parentClassDefs) {
      const bodyStmts = this._getClassDefBodyStmts(parentClassDef)
      if (!bodyStmts) continue

      let fieldTypeName: string | null = null
      for (const stmt of bodyStmts) {
        if (stmt.type === 'VariableDeclaration' && stmt.id?.type === 'Identifier'
          && stmt.id.name === fieldName && stmt.varType) {
          fieldTypeName = this._extractTypeName(stmt.varType)
          break
        }
      }
      if (!fieldTypeName) continue

      // 在 packages 中找字段类型的所有 ClassDefinition
      const fieldClassDefs = this._findAllClassDefsByName(fieldTypeName)
      for (const fieldClassDef of fieldClassDefs) {
        // 具体类型：直接取方法
        if (!fieldClassDef.isInterface && fieldClassDef.value?.[methodName]?.ast?.fdef) {
          return fieldClassDef.value[methodName]
        }

        // 接口类型：提取接口方法签名，搜索匹配的具体实现
        if (fieldClassDef.isInterface) {
          const implMethod = this._findInterfaceImplMethod(fieldClassDef, methodName)
          if (implMethod) return implMethod
        }
      }
    }

    // 所有候选都不满足时，全局兜底
    return this._searchMethodInPackages(methodName)
  }

  /**
   * 接口实现查找：从接口的 body 提取方法名列表，
   * 在 packages 树中搜索具备所有这些方法（带 fdef）的非接口 ClassDefinition，返回目标方法
   */
  _findInterfaceImplMethod(interfaceClassDef: any, methodName: string): any {
    const bodyStmts = this._getClassDefBodyStmts(interfaceClassDef)
    if (!bodyStmts || bodyStmts.length === 0) return null

    // 提取接口声明的所有方法名
    const interfaceMethodNames: string[] = []
    for (const stmt of bodyStmts) {
      const name = stmt.id?.name
      if (name) interfaceMethodNames.push(name)
    }
    if (interfaceMethodNames.length === 0 || !interfaceMethodNames.includes(methodName)) return null

    // 在 packages 树中搜索实现了该接口全部方法的非接口 ClassDefinition
    const packages = this.topScope?.context?.packages
    if (!packages) return null

    let found: any = null
    const visited = new Set<any>()

    const search = (node: any, depth: number): void => {
      if (depth > 15 || !node || visited.has(node) || found) return
      visited.add(node)
      if (!node.value || typeof node.value !== 'object' || Array.isArray(node.value)) return

      for (const key of Object.keys(node.value)) {
        if (found) return
        const child = node.value[key]
        if (!child) continue

        // 非接口 ClassDefinition，且具备目标方法
        if (child.ast?.cdef && !child.isInterface && child.value?.[methodName]?.ast?.fdef) {
          // 验证该 ClassDef 实现了接口的所有方法
          const hasAll = interfaceMethodNames.every(
            (m: string) => child.value?.[m]?.ast?.fdef
          )
          if (hasAll) {
            found = child.value[methodName]
            return
          }
        }

        if (child.vtype === 'object' || child.vtype === 'package' || child.vtype === 'module' || child.vtype === 'class') {
          search(child, depth + 1)
        }
      }
    }

    search(packages, 0)
    return found
  }

  /**
   * 从 AST 类型节点提取类型名（不调用 processInstruction）
   * 支持：Identifier、MemberAccess、PointerType
   */
  _extractTypeName(node: any): string | null {
    if (!node) return null
    if (node.type === 'Identifier') return node.name
    if (node.type === 'PointerType' || node.type === 'StarExpression') return this._extractTypeName(node.element || node.argument)
    if (node.type === 'MemberAccess' && node.property?.name) return node.property.name
    // 嵌套结构化 rtype
    if (node.name) return node.name
    if (node.id?.name) return node.id.name
    return null
  }

  /**
   * 从 ClassDefinition scope 提取字段声明列表。
   * Go struct 的 cdef.body 结构不固定：
   * - BlockStatement：body.body 是数组
   * - ObjectExpression：body.properties 是数组
   * - 直接数组：body 本身是数组
   */
  _getClassDefBodyStmts(classDef: any): any[] | null {
    const cdef = classDef?.ast?.cdef
    if (!cdef?.body) return null

    const body = cdef.body
    if (Array.isArray(body)) return body
    if (Array.isArray(body.body)) return body.body
    if (Array.isArray(body.properties)) return body.properties
    return null
  }

  /**
   * 在 packages 树中按类型名查找所有同名 ClassDefinition（解决同名歧义）
   */
  _findAllClassDefsByName(name: string): any[] {
    const cacheKey = `classDefs:${name}`
    if (cacheKey in this._methodResolveCache) return this._methodResolveCache[cacheKey]

    const packages = this.topScope?.context?.packages
    if (!packages) return []

    const results: any[] = []
    const visited = new Set<any>()

    const search = (node: any, depth: number): void => {
      if (depth > 15 || !node || visited.has(node)) return
      visited.add(node)
      if (!node.value || typeof node.value !== 'object' || Array.isArray(node.value)) return

      for (const key of Object.keys(node.value)) {
        const child = node.value[key]
        if (!child) continue

        if (child.ast?.cdef && child.sid === name) {
          results.push(child)
        }

        if (child.vtype === 'object' || child.vtype === 'package' || child.vtype === 'module' || child.vtype === 'class') {
          search(child, depth + 1)
        }
      }
    }

    search(packages, 0)
    this._methodResolveCache[cacheKey] = results
    return results
  }

  /**
   * 遍历 packages 树查找包含目标方法（带 fdef）的非接口 ClassDefinition
   */
  _searchMethodInPackages(methodName: string): any {
    const packages = this.topScope?.context?.packages
    if (!packages) return null

    let found: any = null
    const visited = new Set<any>()

    const search = (node: any, depth: number): void => {
      if (depth > 15 || !node || visited.has(node) || found) return
      visited.add(node)
      if (!node.value || typeof node.value !== 'object' || Array.isArray(node.value)) return

      for (const key of Object.keys(node.value)) {
        if (found) return
        const child = node.value[key]
        if (!child) continue

        if (child.ast?.cdef && !child.isInterface && child.value?.[methodName]?.ast?.fdef) {
          found = child.value[methodName]
          return
        }

        if (child.vtype === 'object' || child.vtype === 'package' || child.vtype === 'module') {
          search(child, depth + 1)
        }
      }
    }

    search(packages, 0)
    return found
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
