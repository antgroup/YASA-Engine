import GoTypeRelatedInfoResolver from '../../../../resolver/go/go-type-related-info-resolver'
import SymAddress from '../../common/sym-address'
import { buildNewCopiedWithTag } from '../../../../util/clone-util'
import { AstRefList } from '../../common/value/ast-ref-list'
import { BinaryExprValue } from '../../common/value/binary-expr'
import type {
  FunctionValue as FunctionValueType,
  Scope,
  State,
  Value,
  SymbolValue as SymbolValueType,
} from '../../../../types/analyzer'
import type {
  AssignmentExpression,
  CallExpression,
  VariableDeclaration,
  NewExpression,
  ThisExpression,
  CompileUnit,
  BinaryExpression,
  MemberAccess,
  Identifier,
  TupleExpression,
  Node,
  UnaryExpression,
  ReturnStatement,
} from '../../../../types/uast'
import type { BoundCall, CallArgs, CallInfo } from '../../common/call-args'
import { processGoFrameworkCall } from '../framework-call-model'
import { goExternalReturnModelResolver, type GoExternalReturnModel, type GoTypeAstNode } from './go-external-return-model'
import { goCallSummaryPolicy } from '../../common/call-summary/language/golang'
import type { CallSummaryLanguagePolicy } from '../../common/call-summary/language/types'
import { INTERNAL_CALL } from '../../common/call-args'
import type { ClassHierarchy } from '../../../../resolver/common/value/class-hierarchy'
import { EntryPointMetricsCollector, type EntryPointMetric, type EntryPointMetricType } from '../../../../util/entrypoint-metrics'

const path = require('path')
const _ = require('lodash')
const QidUnifyUtil = require('../../../../util/qid-unify-util')

const logger = require('../../../../util/logger')(__filename)
const ScopeClass = require('../../common/scope')
const Analyzer: typeof import('../../common/analyzer').Analyzer = require('../../common/analyzer')
const BasicRuleHandler = require('../../../../checker/common/rules-basic-handler')
const Parser = require('../../../parser/parser')
const {
  ValueUtil: { FunctionValue, ObjectValue },
} = require('../../../util/value-util')
const { shallowCopyValue, buildNewValueInstance, lodashCloneWithTag } = require('../../../../util/clone-util')

const {
  valueUtil: {
    ValueUtil: { Scoped, PackageValue, PrimitiveValue, UndefinedValue, SymbolValue, UnionValue },
  },
} = require('../../common')
const { getLegacyArgValues } = require('../../common/call-args')
const Config = require('../../../../config')
const SourceLine = require('../../common/source-line')
const FileUtil = require('../../../../util/file-util')
const AstUtil = require('../../../../util/ast-util')
const MemState = require('../../common/memState')
const CheckerManager = require('../../common/checker-manager')
const entryPointConfig = require('../../common/entrypoint/current-entrypoint')
const { executeViaEntryPointExecutor } = require('../../common/entrypoint/entrypoint-executor') as typeof import('../../common/entrypoint/entrypoint-executor')
const { unionAllValues } = require('../../common/memStateBVT')
const constValue = require('../../../../util/constant')
const { handleException } = require('../../common/exception-handler')
const { ErrorCode } = require('../../../../util/error-code')

type CapturableValue = Value & {
  qid?: unknown
  logicalQid?: unknown
  argument?: CapturableValue
}

interface CapturingFclos {
  qid?: unknown
  ast?: {
    node?: Node
    fdef?: Node
  }
}

type CallbackCaller = Value | Scope | null | undefined

type GoRuntimeValue = Value & {
  sid?: unknown
  name?: unknown
  vtype?: string
  type?: string
  value?: unknown
  isTuple?: boolean
  ast?: {
    node?: Node
    fdef?: Node & { body?: Node }
  }
  getFieldValue?: (key: string) => unknown
}

type GoRuntimeRecord = Record<string, GoRuntimeValue | null | undefined>

type GoCallableValue = Value & {
  ast?: {
    fdef?: Node & { body?: Node }
  }
}

type GoClassDefinitionValue = Value & {
  sid?: string
  ast?: {
    cdef?: {
      body?: unknown
    }
  }
}

/**
 *
 * @param value
 */
function isTaintedValue(value: unknown): value is CapturableValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { taint?: { isTaintedRec?: boolean } }).taint?.isTaintedRec === true
  )
}

/**
 *
 * @param value
 */
function isCapturableValue(value: unknown): value is CapturableValue {
  return typeof value === 'object' && value !== null && 'taint' in value
}

/**
 *
 * @param node
 */
function isIdentifierNode(node: unknown): node is Identifier {
  return typeof node === 'object' && node !== null && (node as { type?: unknown }).type === 'Identifier'
}

/**
 *
 * @param node
 */
function isUnaryExpressionNode(node: unknown): node is UnaryExpression {
  return typeof node === 'object' && node !== null && (node as { type?: unknown }).type === 'UnaryExpression'
}

/**
 *
 * @param value
 */
function isGoRuntimeValue(value: unknown): value is GoRuntimeValue {
  return typeof value === 'object' && value !== null
}

/**
 *
 * @param value
 */
function isGoRuntimeRecord(value: unknown): value is GoRuntimeRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 *
 * @param value
 * @param key
 */
function getRuntimeFieldValue(value: GoRuntimeValue, key: string): unknown {
  return typeof value.getFieldValue === 'function' ? value.getFieldValue(key) : value
}

type GoNameNode = Node & {
  argument?: Node
  object?: Node
  property?: Node
  value?: unknown
  name?: unknown
}

/**
 *
 * @param node
 */
function getNodeName(node: Node): string {
  const goNode = node as GoNameNode
  if (node.type === 'Identifier') return node.name
  if (node.type === 'Literal') {
    const rawValue = String(goNode.value ?? '')
    const encodedValue = JSON.stringify(goNode.value)
    return typeof goNode.value === 'string' && /^["'`].*["'`]$/.test(rawValue) ? rawValue : (encodedValue ?? rawValue)
  }
  if (node.type === 'DereferenceExpression') return `*${goNode.argument ? getNodeName(goNode.argument) : ''}`
  if (node.type === 'MemberAccess') {
    const objectName = goNode.object ? getNodeName(goNode.object) : ''
    const propertyName = goNode.property ? getNodeName(goNode.property) : ''
    if (goNode.property?.type === 'Literal')
      return objectName && propertyName ? `${objectName}[${propertyName}]` : AstUtil.prettyPrintAST(node).trim()
    return objectName && propertyName ? `${objectName}.${propertyName}` : AstUtil.prettyPrintAST(node).trim()
  }
  if (typeof goNode.name === 'string') return goNode.name
  return AstUtil.prettyPrintAST(node).trim()
}

/**
 *
 * @param node
 */
function getNodeSourceFile(node: Node | undefined): string | null {
  const sourcefile = (node as { loc?: { sourcefile?: unknown } } | undefined)?.loc?.sourcefile
  return typeof sourcefile === 'string' ? sourcefile : null
}
const GO_CONTEXT_VALUE_FIELD = '__yasa_go_context_value'
const GO_CONTEXT_PARENT_FIELD = '__yasa_go_context_parent'
const GO_CONTEXT_KEY_FIELD = '__yasa_go_context_key'
const GO_COBRA_CONTEXT_FIELD = '__yasa_go_context'
const GO_CONTEXT_AND_COBRA_METHODS = new Set(['WithValue', 'SetContext', 'Context', 'Value'])
const GO_EXTERNAL_RETURN_MODEL_RESOLVER = goExternalReturnModelResolver

/**
 *
 */
class GoAnalyzer extends Analyzer {
  protected override readonly callSummaryLanguagePolicy: CallSummaryLanguagePolicy = goCallSummaryPolicy

  /** 由 Go checker triggerAtStartOfAnalyze 调 typeResolver.findClassHierarchy 后写入，CHA dispatch / sink 穿透读取 */
  classHierarchyMap?: Map<string, ClassHierarchy>

  /** Cobra 子命令执行上下文会共享根命令的 context。 */
  goCobraContextFallback?: SymbolValueType

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
      // 模块名包含多级路径时，解析结果不能被截断
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
      this.callSummarySessions[0].beginForLanguage('Go')
      try {
        this._scanPackages(modulePackageManager, dirName, rootDir, state, true)
      } finally {
        this.callSummarySessions[0].finish()
        this.performanceTracker.end('preProcess.processModule')
      }
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
   * @param defscope
   * @param methodName
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
  override processCallExpression(scope: Scope, node: CallExpression, state: State): Value {
    if (node._meta?.defer) {
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
    if (!fclos) {
      return new UndefinedValue()
    }
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
      const callInfo: CallInfo = { callArgs: this.buildCallArgs(node, argvalues, fclos) }
      const beforeCallInfo: CallInfo | undefined = isUnresolvableCall ? callInfo : undefined
      if (argvalues && this.checkerManager) {
        this.checkerManager.checkAtFunctionCallBefore(this, scope, node, state, {
          argvalues,
          fclos,
          callInfo: beforeCallInfo,
          pcond: state.pcond,
          entry_fclos: this.entry_fclos,
          einfo: state.einfo,
          state,
          analyzer: this,
          ainfo: this.ainfo,
        })
      }
      ret = this.processGoContextAndCobraCall(scope, node, state, fclos, argvalues)
      if (!ret) {
        ret = processGoFrameworkCall({
          analyzer: this,
          scope,
          node,
          state,
          fclos,
          argvalues,
        })
      }
      if (!ret) {
        ret = this.executeWithSummary(scope, fclos, callInfo, state, () =>
          super.processCallExpression(scope, node, state)
        )
      }
      this.applyGoExternalReturnTypeModel(scope, node, fclos, ret)
      const shouldForceGoShortVarCallback = node._meta?.goShortVarRhs && this.hasGoCallbackArgument(node, argvalues)
      if (!fclos?.ast?.fdef?.body || fclos.ast.fdef.body.type === 'Noop' || shouldForceGoShortVarCallback) {
        this.executeFunctionArgumentsForGo(scope, fclos, node, argvalues, state)
      }

      // 递归检查 UnionValue 内部元素的 taint（Go 多返回值赋值产生 UnionValue）
      const _hasDeepTaint = (v: any): boolean => {
        if (!v) return false
        if (v.taint?.hasTags?.()) return true
        if (v.vtype === 'union' && v.values) {
          return v.values.some((e: any) => _hasDeepTaint(e))
        }
        return false
      }

      // 只在有 taint 流入 + receiver 是接口时才强制 CHA
      const _hasTaintedArgs =
        argvalues?.some((a: any) => _hasDeepTaint(a)) || _hasDeepTaint(fclos?._this) || _hasDeepTaint(fclos?.object)

      // 接口方法强制 CHA：receiver 有接口 rtype 且在 classHierarchyMap 中有实现时，绕过普通 guard
      let _chaByReceiverRtype = false
      let _chaImplsByRtype: any[] = []
      if (this.classHierarchyMap && node.callee?.type === 'MemberAccess') {
        let _recvRtype = fclos?.parent?.rtype || fclos?.object?.rtype || fclos?._this?.rtype
        // fclos 解析失败时（如接口 stub），从 AST receiver 节点获取 rtype
        if (!_recvRtype && node.callee.object) {
          const _recvObj = this.processInstruction(scope, node.callee.object, state)
          _recvRtype = _recvObj?.rtype
        }
        if (_recvRtype) {
          // rtype 可能是 AST 节点（type='Identifier'/'PointerType'/'MemberAccess'）或 wrapper（type=undefined, definiteType=...）
          const _effectiveRtype =
            _recvRtype.type && _recvRtype.type !== undefined ? _recvRtype : (_recvRtype.definiteType ?? _recvRtype)
          const _recvTypeName =
            _effectiveRtype.type === 'Identifier'
              ? _effectiveRtype.name
              : _effectiveRtype.type === 'PointerType'
                ? _effectiveRtype.element?.name
                : _effectiveRtype.type === 'MemberAccess'
                  ? _effectiveRtype.property?.name || (_effectiveRtype.property as any)?.value
                  : null
          if (_recvTypeName) {
            const _methodName = node.callee.property?.name || (node.callee.property as any)?.value
            if (_methodName) {
              const _impls = this.findCHAImplementationsByTypeName(_recvTypeName, _methodName)
              if (_impls.length > 0) {
                _chaByReceiverRtype = true
                _chaImplsByRtype = _impls
              }
            }
          }
        }
      }

      // CHA fallback：正常 dispatch 未生效时，通过 ClassHierarchy 查找接口实现并执行
      if (
        this.classHierarchyMap &&
        (fclos?.vtype !== 'fclos' || this.checkFclosInInterface(fclos)) &&
        (!ret || ret.vtype === 'symbol')
      ) {
        let implementations = this.findCHAImplementations(fclos)
        if (_hasTaintedArgs && _chaByReceiverRtype) {
          implementations = _chaImplsByRtype
        }

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
              // rtype wrapper 解包：accessValueFromDefScope 产出的 wrapper 需取 definiteType
              const effectiveRtype = rtype.type && rtype.type !== undefined ? rtype : (rtype.definiteType ?? rtype)
              const rtypeName =
                effectiveRtype.type === 'Identifier'
                  ? effectiveRtype.name
                  : effectiveRtype.type === 'PointerType'
                    ? effectiveRtype.element?.name
                    : effectiveRtype.type === 'MemberAccess'
                      ? effectiveRtype.property?.name || (effectiveRtype.property as any)?.value
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

            // 绑定 this 并执行。caller 的 _this 指向接口 receiver（rtype=interface），
            // 直接共享会让 impl 函数体内的 receiver.field MemberAccess 继承错误 interface 类型。
            // Go method body 内的 receiver 变量从当前 receiver 对象继承 rtype。
            // 修复：进入 impl 前把 receiver 对象的 rtype 原地改为 impl struct 类型节点，
            // 执行完毕立刻恢复，避免污染全局 provider 的 rtype 跨 impl 迭代泄漏。
            const oldThis = implFclos._this
            const baseThis = fclos?._this ?? (typeof fclos?.getThisObj === 'function' ? fclos.getThisObj() : undefined)
            let savedBaseRtype: unknown
            let rtypeOverridden = false
            if (baseThis) {
              const implReceiverTypeNode = this._getImplReceiverTypeNode(implFclos)
              if (implReceiverTypeNode) {
                savedBaseRtype = baseThis.rtype
                try {
                  baseThis.rtype = implReceiverTypeNode
                  rtypeOverridden = true
                } catch (_e) {
                  rtypeOverridden = false
                }
              }
              implFclos._this = baseThis
            }

            const r = this.executeCall(node, implFclos, state, scope, {
              callArgs: this.buildCallArgs(node, argvalues, implFclos),
            })

            if (rtypeOverridden && baseThis) {
              try {
                baseThis.rtype = savedBaseRtype
              } catch (_e) {
                /* defensive：同上，恢复失败忽略 */
              }
            }
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
   * Go 外部库无函数体时，按已知签名补返回值类型，供后续 receiver calleeType 匹配。
   */
  applyGoExternalReturnTypeModel(scope: Scope, node: CallExpression, fclos: Value | null | undefined, ret: Value | null | undefined): void {
    const fclosBody = (fclos as GoCallableValue | null | undefined)?.ast?.fdef?.body
    if (!ret || (fclosBody && fclosBody.type !== 'Noop')) return
    const model = this.getGoExternalReturnTypeModel(fclos)
    if (!model) return
    if (model.returnTypes.length > 1) {
      this.applyGoTupleReturnTypes(scope, node, ret, model.returnTypes, model)
      return
    }
    this.applyGoValueReturnType(ret, model.returnTypes[0])
  }

  private getGoExternalReturnTypeModel(fclos: Value | null | undefined): GoExternalReturnModel | null {
    return GO_EXTERNAL_RETURN_MODEL_RESOLVER.findForFclos(fclos)
  }

  private getGoExternalReturnTypeModelForCallNode(node: CallExpression): GoExternalReturnModel | null {
    return GO_EXTERNAL_RETURN_MODEL_RESOLVER.findForCallNode(node)
  }

  private formatGoExternalReturnCallQid(node: CallExpression, model?: GoExternalReturnModel): string {
    return GO_EXTERNAL_RETURN_MODEL_RESOLVER.formatCallQid(node, model)
  }

  private applyGoExternalReturnTypeModelForCallNode(scope: Scope, node: CallExpression, ret: unknown): void {
    if (!isGoRuntimeValue(ret)) return
    const model = this.getGoExternalReturnTypeModelForCallNode(node)
    if (!model) return
    if (model.returnTypes.length > 1) {
      this.applyGoTupleReturnTypes(scope, node, ret, model.returnTypes, model)
      return
    }
    this.applyGoValueReturnType(ret, model.returnTypes[0])
  }

  private applyGoTupleReturnTypes(scope: Scope, node: CallExpression, ret: Value, returnTypes: GoTypeAstNode[], model?: GoExternalReturnModel): void {
    if (isGoRuntimeValue(ret) && ret.vtype === 'union' && Array.isArray(ret.value)) {
      ret.isTuple = true
      if (!ret.misc_) ret.misc_ = {}
      ret.misc_.goExternalReturnQid = this.formatGoExternalReturnCallQid(node, model)
      ret.rtype = { type: 'TupleType', elements: returnTypes }
      const minLen = Math.min(ret.value.length, returnTypes.length)
      for (let index = 0; index < minLen; index++) {
        this.applyGoValueReturnType(getRuntimeFieldValue(ret, String(index)), returnTypes[index])
      }
      return
    }

    const tupleValues = returnTypes.map((returnType: GoTypeAstNode, index: number) => {
      const value = index === 0 ? ret : new UndefinedValue()
      this.applyGoValueReturnType(value, returnType)
      return value
    })
    const tupleValue = new UnionValue(
      tupleValues,
      undefined,
      `${scope.qid}.<union@go_ext_ret:${node.loc?.start?.line}:${node.loc?.start?.column}>`,
      node
    )
    tupleValue.isTuple = true
    if (!tupleValue.misc_) tupleValue.misc_ = {}
    tupleValue.misc_.goExternalReturnQid = this.formatGoExternalReturnCallQid(node, model)
    tupleValue.rtype = { type: 'TupleType', elements: returnTypes }
    this.copyGoTupleReturnToValue(ret, tupleValue)
  }

  private applyGoValueReturnType(value: unknown, returnType: GoTypeAstNode | undefined): void {
    if (!returnType || !isGoRuntimeValue(value)) return
    value.rtype = returnType
  }

  private materializeGoExternalReturnValue(
    scope: Scope,
    target: Node,
    returnType: GoTypeAstNode | undefined,
    sourceValue?: unknown
  ): Value | undefined {
    if (!returnType) return undefined
    const targetName = isIdentifierNode(target) ? target.name : getNodeName(target)
    const sourceSid = isGoRuntimeValue(sourceValue) && typeof sourceValue.sid === 'string' ? sourceValue.sid : targetName
    const externalReturnQid = isGoRuntimeValue(sourceValue) && typeof sourceValue.misc_?.goExternalReturnQid === 'string'
      ? sourceValue.misc_.goExternalReturnQid
      : null
    const sourceQid = externalReturnQid ?? (isGoRuntimeValue(sourceValue) && typeof sourceValue.qid === 'string' ? sourceValue.qid : `${scope.qid}.${targetName}`)
    const retValue = new SymbolValue({
      sid: sourceSid,
      qid: sourceQid,
      type: 'Identifier',
      loc: target.loc,
      _skipRegister: true,
    })
    retValue.rtype = returnType
    return retValue
  }

  private copyGoTupleReturnToValue(target: Value, tupleValue: Value): void {
    Object.assign(target, tupleValue)
  }

  /**
   * Go context / Cobra 会把业务对象藏在运行时状态里；这里仅恢复这条状态边，不扩散字段别名。
   */
  processGoContextAndCobraCall(scope: Scope, node: CallExpression, state: State, fclos: Value | null | undefined, argvalues: Value[]): SymbolValueType | null {
    const callee = node.callee
    if (!callee || callee.type !== 'MemberAccess') return null
    const methodName = this.getGoMemberName(callee.property)
    if (!methodName || !GO_CONTEXT_AND_COBRA_METHODS.has(methodName)) return null
    const receiver = this.processInstruction(scope, callee.object, state)
    if (methodName === 'WithValue' && this.isGoContextPackage(receiver) && argvalues.length >= 3) {
      const ctx = new ObjectValue(scope.qid, {
        sid: `WithValue(${argvalues[0]?.sid ?? 'parent'}, ${argvalues[1]?.sid ?? 'key'}, ${argvalues[2]?.sid ?? 'value'})`,
        qid: `${scope.qid}.<go_context_with_value_${node.loc?.start?.line ?? 'x'}_${node.loc?.start?.column ?? 'x'}>`,
        parent: scope,
        loc: node.loc,
        ast: node,
      })
      this.setGoContextMember(ctx, GO_CONTEXT_PARENT_FIELD, argvalues[0])
      this.setGoContextMember(ctx, GO_CONTEXT_KEY_FIELD, argvalues[1])
      this.setGoContextMember(ctx, GO_CONTEXT_VALUE_FIELD, argvalues[2])
      return ctx
    }
    if (methodName === 'SetContext' && this.isCobraCommandContextReceiver(receiver) && argvalues[0]) {
      this.setGoContextMember(receiver, GO_COBRA_CONTEXT_FIELD, argvalues[0])
      this.goCobraContextFallback = argvalues[0] as SymbolValueType
      return fclos?.vtype === 'fclos' ? null : argvalues[0] as SymbolValueType
    }

    if (methodName === 'Context' && this.isCobraCommandContextReceiver(receiver)) {
      const stored = this.getGoContextMember(receiver, GO_COBRA_CONTEXT_FIELD) ?? this.goCobraContextFallback
      if (stored) return stored as SymbolValueType
      return null
    }

    if (methodName === 'Value') {
      const storedContext = this.findGoContextValueObject(receiver)
      if (storedContext) return this.resolveGoContextValue(storedContext, argvalues[0]) as SymbolValueType
    }

    return null
  }

  setGoContextMember(target: Value | null | undefined, fieldName: string, value: Value | null | undefined): void {
    if (!target || !value) return
    target.members?.set(fieldName, value)
    if (!target.misc_) target.misc_ = {}
    target.misc_[fieldName] = value
  }

  getGoContextMember(target: Value | null | undefined, fieldName: string): Value | undefined {
    return target?.misc_?.[fieldName] ?? target?.members?.get(fieldName)
  }

  findGoContextValueObject(value: Value | null | undefined): Value | null {
    if (!value) return null
    if (this.getGoContextMember(value, GO_CONTEXT_VALUE_FIELD)) return value
    if (value.vtype === 'union' && Array.isArray(value.value)) {
      return value.value.find((item: Value) => this.getGoContextMember(item, GO_CONTEXT_VALUE_FIELD)) ?? null
    }
    return null
  }

  getGoMemberName(property: { name?: unknown; value?: unknown; sid?: unknown } | null | undefined): string | null {
    if (!property) return null
    if (typeof property.name === 'string') return property.name
    if (typeof property.value === 'string') return property.value
    if (typeof property.sid === 'string') return property.sid
    return null
  }

  isGoContextPackage(value: Value | null | undefined): boolean {
    const id = `${value?.qid ?? ''}.${value?.sid ?? ''}.${value?.name ?? ''}`
    return value?.vtype === 'package' && /(^|\.)context(\.|$)/.test(id)
  }

  isCobraCommandContextReceiver(value: Value | null | undefined): boolean {
    if (!value || typeof value !== 'object') return false
    const id = `${value.qid ?? ''}.${value.sid ?? ''}`
    if (/github\.com\/spf13\/cobra\.Command|cobra\.Command/.test(id)) return true
    const rtypeName = this.extractGoContextKeyText(value.rtype?.definiteType ?? value.rtype)
    const normalizedType = this.normalizeGoContextKeyText(rtypeName).replace(/^\*+/, '')
    return normalizedType === 'Command' || normalizedType === 'cobra.Command' || normalizedType.endsWith('.cobra.Command')
  }

  resolveGoContextValue(ctx: Value, key: Value | undefined): Value {
    const storedKey = this.getGoContextMember(ctx, GO_CONTEXT_KEY_FIELD)
    const storedValue = this.getGoContextMember(ctx, GO_CONTEXT_VALUE_FIELD)
    if (storedValue && this.isSameGoContextKey(storedKey, key)) {
      return storedValue
    }
    const parent = this.getGoContextMember(ctx, GO_CONTEXT_PARENT_FIELD)
    if (parent && this.getGoContextMember(parent, GO_CONTEXT_VALUE_FIELD)) return this.resolveGoContextValue(parent, key)
    return new UndefinedValue()
  }

  isSameGoContextKey(left: Value | undefined, right: Value | undefined): boolean {
    if (!left || !right) return false
    if (left === right) return true
    const leftType = this.normalizeGoContextKeyType(left)
    const rightType = this.normalizeGoContextKeyType(right)
    if (leftType && rightType) return leftType === rightType
    const leftId = this.normalizeGoContextKeyId(left)
    const rightId = this.normalizeGoContextKeyId(right)
    return leftId !== '' && rightId !== '' && leftId === rightId
  }

  normalizeGoContextKeyType(value: Value | undefined): string {
    const rawType = value?.rtype?.definiteType ?? value?.rtype ?? value?._meta?.type ?? value?.definiteType
    const typeName = this.extractGoContextKeyText(rawType)
    return this.normalizeGoContextKeyText(typeName)
  }

  normalizeGoContextKeyId(value: Value | undefined): string {
    const idParts = [value?.qid, value?.sid, value?.name]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
    return this.normalizeGoContextKeyText(idParts.join('.'))
  }

  extractGoContextKeyText(value: unknown): string {
    if (!value) return ''
    if (typeof value === 'string') return value
    if (typeof value !== 'object') return AstUtil.prettyPrint(value)
    const namedValue = value as { name?: unknown; qid?: unknown; sid?: unknown }
    if (typeof namedValue.name === 'string') return namedValue.name
    if (typeof namedValue.qid === 'string') return namedValue.qid
    if (typeof namedValue.sid === 'string') return namedValue.sid
    return AstUtil.prettyPrint(value)
  }

  normalizeGoContextKeyText(value: string): string {
    return value
      .replace(/<instance_[^>]*>/g, '')
      .replace(/<copied_[^>]*>/g, '')
      .replace(/\.\d+(?=\.|$)/g, '')
      .replace(/\.+/g, '.')
      .replace(/^\.|\.$/g, '')
  }

  isGoNonNilObjectValue(value: Value | null | undefined): boolean {
    return value?.vtype === 'object'
  }

  /**
   *
   * @param value
   */
  isGoNilValue(value: Value | null | undefined): boolean {
    return value?.vtype === 'primitive' && value?.sid === 'nil'
  }

  /**
   *
   * @param value
   * @param scope
   * @param node
   */
  narrowGoInstanceofObject(value: Value | null | undefined, scope: Scope, node: BinaryExpression): Value | null {
    if (value?.vtype === 'object') return value
    if (value?.vtype !== 'union' || !Array.isArray(value.value)) return null
    const narrowed = new UnionValue(
      undefined,
      undefined,
      `${scope.qid}.<union@go_instanceof:${node.loc?.start?.line}:${node.loc?.start?.column}>`,
      node
    )
    value.value.forEach((item: Value) => {
      if (item?.vtype === 'object') narrowed.appendValue(item, false)
    })
    if (narrowed.value.length === 1) return narrowed.value[0]
    return narrowed.value.length > 0 ? narrowed : null
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
    const { id } = node // LVal: Identifier | MemberAccess | TupleExpression
    if (!id || (id.type === 'Identifier' && id.name === '_' && initialNode?.type !== 'ImportExpression'))
      return new UndefinedValue() // e.g. in Go: `_ = expr` 跳过；但 `_ "pkg"` 需走 import 处理

    let initVal
    if (!initialNode) {
      let cscope
      if (node.varType) {
        cscope = this.processInstruction(scope, node.varType, state)
        if (cscope) {
          initVal = this.buildNewObject(cscope?.ast.fdef, cscope, state, node, scope, INTERNAL_CALL)
          // 全局变量类型推导：将声明类型写入 rtype，使 sink 匹配时能获取 calleeType
          if (node.varType && initVal) {
            initVal.rtype = node.varType
          }
        } else {
          initVal = this.createVarDeclarationScope(id, scope)
          // 外部类型（如 *gin.Context）无源码时 cscope 为 null，仍需写入 varType 作为 rtype，
          // 使 processMemberAccess 能把类型传播到 c.Query 等 fclos，让 calleeType 匹配生效
          if (node.varType && initVal) {
            initVal.rtype = node.varType
          }
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
      if (initialNode.type === 'CallExpression') {
        initialNode._meta = { ...initialNode._meta, goShortVarRhs: true }
      }
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
    if (id.type === 'TupleExpression' && initialNode?.type === 'CallExpression') {
      this.applyGoExternalReturnTypeModelForCallNode(scope, initialNode, initVal)
    }

    if (id.type === 'TupleExpression') {
      // 解构Tuple赋值，分别分发到Tuple里的每个元素
      const tupleId = id as TupleExpression
      if (initVal.vtype === 'union') {
        const substates = MemState.forkStates(state, 1)
        if (initVal.isTuple) {
          // 直接 tuple：按索引 1-to-1 映射
          const externalReturnModel = initialNode?.type === 'CallExpression' ? this.getGoExternalReturnTypeModelForCallNode(initialNode) : null
          const minLen = Math.min(tupleId.elements.length, externalReturnModel?.returnTypes.length ?? initVal.value.length)
          for (let i = 0; i < minLen; i++) {
            const sourceValue = initVal.getFieldValue(String(i))
            const positionValue = this.materializeGoExternalReturnValue(
              scope,
              tupleId.elements[i],
              externalReturnModel?.returnTypes[i],
              sourceValue
            ) ?? sourceValue
            this.saveVarInCurrentScope(scope, tupleId.elements[i], positionValue, state)
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
        const externalReturnModel = initialNode?.type === 'CallExpression' ? this.getGoExternalReturnTypeModelForCallNode(initialNode) : null
        const minLen = Math.min(tupleId.elements.length, externalReturnModel?.returnTypes.length ?? initVal.value.length)
        for (let i = 0; i < minLen; i++) {
          const sourceValue = initVal.getFieldValue(String(i))
          const positionValue = this.materializeGoExternalReturnValue(
            scope,
            tupleId.elements[i],
            externalReturnModel?.returnTypes[i],
            sourceValue
          ) ?? sourceValue
          this.saveVarInCurrentScope(scope, tupleId.elements[i], positionValue, state)
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
   * @param state
   * @param caller
   * @param callsiteNode
   * @param traceNode
   */
  private buildCallbackState(
    state: State,
    caller: CallbackCaller,
    callsiteNode: CallExpression,
    traceNode: Node = callsiteNode
  ): State {
    const newState: State = _.clone(state)
    newState.parent = state
    newState.callstack = state.callstack ? state.callstack.concat([caller]) : [caller]
    const callsite = {
      code: AstUtil.getRawCode(traceNode).slice(0, 100),
      nodeHash: traceNode._meta?.nodehash,
      loc: traceNode.loc,
    }
    newState.callsites = state.callsites ? state.callsites.concat([callsite]) : [callsite]
    return newState
  }

  /**
   *
   * @param scope
   * @param caller
   * @param callsiteNode
   * @param argvalues
   * @param state
   */
  private executeFunctionArgumentsForGo(
    scope: Scope,
    caller: CallbackCaller,
    callsiteNode: CallExpression,
    argvalues: unknown[],
    state: State
  ): void {
    const needInvoke = Config.invokeCallbackOnUnknownFunction
    if (needInvoke !== 1 && needInvoke !== 2) return

    for (const arg of argvalues) {
      if (!isGoRuntimeValue(arg)) continue
      if (arg.vtype === 'fclos' && callsiteNode._meta?.goShortVarRhs) {
        const fclos = lodashCloneWithTag(arg)
        this.executeCall(
          callsiteNode,
          fclos,
          this.buildCallbackState(state, caller, callsiteNode, arg.ast?.node ?? callsiteNode),
          scope,
          INTERNAL_CALL
        )
      } else if (arg.vtype === 'object') {
        const obj = lodashCloneWithTag(arg)
        if (!isGoRuntimeRecord(obj.value)) continue
        Object.values(obj.value).forEach((field: unknown) => {
          if (!isGoRuntimeValue(field) || field.vtype !== 'fclos') return
          if (!field.ast?.node) return
          if (!field.ast.node._meta?.modifiers?.includes('@Override')) return
          this.executeCall(
            callsiteNode,
            field,
            this.buildCallbackState(state, caller, callsiteNode),
            scope,
            INTERNAL_CALL
          )
        })
      }
    }
  }

  /**
   *
   * @param callsiteNode
   * @param argvalues
   */
  private hasGoCallbackArgument(callsiteNode: CallExpression, argvalues: unknown[]): boolean {
    return (callsiteNode.arguments ?? []).some((argument: Node | null | undefined, index: number) => {
      if (this.isGoCallbackAstArgument(argument)) return true
      const value = argvalues[index]
      if (!isGoRuntimeValue(value)) return false
      if (value.vtype === 'fclos') return true
      if (value.vtype !== 'object' || !isGoRuntimeRecord(value.value)) return false
      return Object.values(value.value).some((field: unknown) => {
        if (!isGoRuntimeValue(field) || field.vtype !== 'fclos') return false
        return this.isGoCallbackAstArgument(field.ast?.node)
      })
    })
  }

  /**
   *
   * @param node
   */
  private isGoCallbackAstArgument(node: Node | null | undefined): boolean {
    if (!node) return false
    if (node.type === 'FunctionDefinition') return true
    if (node._meta?.modifiers?.includes('@Override')) return true
    return false
  }

  /**
   *
   * @param tmpVal
   * @param leftCount
   * @param state
   */
  private extractAssignmentValues(tmpVal: unknown, leftCount: number, state: State): unknown[] {
    const perPos: unknown[] = new Array(leftCount).fill(null)
    if (isGoRuntimeValue(tmpVal) && tmpVal.vtype === 'union' && tmpVal.type !== 'TupleExpression') {
      if (tmpVal.isTuple) {
        for (let k = 0; k < leftCount; k++) perPos[k] = getRuntimeFieldValue(tmpVal, String(k)) ?? tmpVal
      } else {
        const buckets: unknown[][] = Array.from({ length: leftCount }, () => [])
        const branches: unknown[] = Array.isArray(tmpVal.value) ? tmpVal.value : []
        for (const elem of branches) {
          if (isGoRuntimeValue(elem) && elem.isTuple && elem.vtype === 'union' && Array.isArray(elem.value)) {
            for (let j = 0; j < leftCount; j++) buckets[j].push(j < elem.value.length ? elem.value[j] : elem)
          } else {
            for (let j = 0; j < leftCount; j++) buckets[j].push(elem)
          }
        }
        for (let k = 0; k < leftCount; k++) perPos[k] = unionAllValues(buckets[k], state)
      }
    } else if (isGoRuntimeValue(tmpVal) && Array.isArray(tmpVal.value) && tmpVal.value.length >= 1) {
      for (let k = 0; k < leftCount; k++) perPos[k] = getRuntimeFieldValue(tmpVal, String(k)) ?? tmpVal
    } else {
      for (let k = 0; k < leftCount; k++) perPos[k] = tmpVal
    }
    return perPos
  }

  /**
   *
   * @param scope
   * @param node
   * @param target
   * @param val
   * @param oldV
   * @param state
   */
  private saveAssignmentValue(
    scope: Scope,
    node: AssignmentExpression,
    target: Node,
    val: unknown,
    oldV: unknown,
    state: State
  ): void {
    let savedVal: unknown = val
    if (!savedVal) savedVal = new UndefinedValue()
    if (typeof savedVal !== 'object') {
      savedVal = new PrimitiveValue(scope.qid, `<literal_${savedVal}>`, savedVal, null, 'Literal', node.right?.loc)
    }
    const runtimeSavedVal: GoRuntimeValue = isGoRuntimeValue(savedVal) ? savedVal : new UndefinedValue()
    const targetName = getNodeName(target)
    if (
      runtimeSavedVal.sid === undefined ||
      runtimeSavedVal.sid === null ||
      (typeof runtimeSavedVal.sid === 'string' && runtimeSavedVal.sid.includes('<object'))
    ) {
      runtimeSavedVal.sid = SymAddress.toStringID(target) ?? ''
    }
    savedVal = SourceLine.addSrcLineInfo(
      runtimeSavedVal,
      node,
      node.loc && node.loc.sourcefile,
      'Var Pass:',
      targetName
    )
    this.saveVarInScope(scope, target, savedVal, state, oldV)
    if (this.checkerManager?.checkAtAssignment) {
      this.checkerManager.checkAtAssignment(this, scope, node, state, {
        lscope: this.getDefScope(scope, target),
        lvalue: oldV,
        rvalue: savedVal,
        pcond: state.pcond,
        binfo: state.binfo,
        entry_fclos: this.entry_fclos,
        einfo: state.einfo,
        state,
        ainfo: this.ainfo,
      })
    }
  }

  /**
   * Go 赋值支持普通赋值和短变量声明：短声明同样需要执行 RHS，才能解释 callback helper 内的闭包。
   * @param scope
   * @param node
   * @param state
   */
  override processAssignmentExpression(scope: Scope, node: AssignmentExpression, state: State): any {
    const operator = node.operator as string
    if ((operator === '=' || operator === ':=') && node.left?.type === 'Identifier' && node.left.name === '_') {
      return this.processInstruction(scope, node.right, state)
    }
    if (operator !== '=' && operator !== ':=') {
      return super.processAssignmentExpression(scope, node, state)
    }

    if (operator === ':=' && node.right?.type === 'CallExpression') {
      node.right._meta = { ...node.right._meta, goShortVarRhs: true }
    }
    const tmpVal: unknown = this.processInstruction(scope, node.right, state)
    const oldVal: unknown = operator === ':=' ? null : this.processInstruction(scope, node.left, state)
    if (node.left?.type === 'TupleExpression' && node.right?.type === 'CallExpression') {
      this.applyGoExternalReturnTypeModelForCallNode(scope, node.right, tmpVal)
    }
    if (node.left?.type !== 'TupleExpression') {
      this.saveAssignmentValue(scope, node, node.left, tmpVal, oldVal, state)
      return tmpVal
    }

    const left = node.left as TupleExpression
    if (
      left.elements.every((element: Node | null | undefined) => element?.type === 'Identifier' && element.name === '_')
    )
      return tmpVal

    const isUnionTuple = isGoRuntimeValue(tmpVal) && tmpVal.vtype === 'union' && tmpVal.type !== 'TupleExpression'
    const tmpTainted = isGoRuntimeValue(tmpVal) && tmpVal.taint?.isTaintedRec
    if (operator === '=' && !isUnionTuple && !tmpTainted) return tmpVal
    if (operator === '=' && !isUnionTuple && tmpTainted) return super.processAssignmentExpression(scope, node, state)

    const perPos = this.extractAssignmentValues(tmpVal, left.elements.length, state)
    const externalReturnModel = node.right?.type === 'CallExpression' ? this.getGoExternalReturnTypeModelForCallNode(node.right) : null
    for (let k = 0; k < left.elements.length; k++) {
      const x = left.elements[k]
      if (!x) continue
      const xName = x.type === 'Identifier' ? (x as Identifier).name : undefined
      if (xName === '_') continue
      const oldV =
        isGoRuntimeValue(oldVal) &&
        oldVal.type === 'TupleExpression' &&
        Array.isArray((oldVal as { elements?: unknown[] }).elements)
          ? (oldVal as { elements: unknown[] }).elements[k]
          : oldVal
      const sourceValue = perPos[k] ?? tmpVal
      const positionValue = this.materializeGoExternalReturnValue(
        scope,
        x,
        externalReturnModel?.returnTypes[k],
        sourceValue
      ) ?? sourceValue
      this.saveAssignmentValue(scope, node, x, positionValue, oldV, state)
    }
    return tmpVal
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

    const obj = this.buildNewObject(fdef, fclos, state, node, scope, {
      callArgs: this.buildCallArgs(node, argvalues, fclos),
    })
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
        // 外层 union-of-returns 自身也携带 TupleType，供下游变量层兜底读取
        retVal.rtype = declRetType
        for (const i in retVal.value) {
          const eachRetVal = retVal.value[i]
          // 内层 isTuple union（多 return 各 tuple 分支）按位置展开 rtype 到各元素
          if (eachRetVal?.vtype === 'union' && eachRetVal?.isTuple && Array.isArray(eachRetVal.value)) {
            const innerLen = Math.min(eachRetVal.value.length, declRetType.elements.length)
            for (let j = 0; j < innerLen; j++) {
              const innerVal = eachRetVal.value[j]
              if (!innerVal || (innerVal.type === 'Identifier' && innerVal.name === 'nil')) continue
              innerVal.rtype = declRetType.elements[j]
              if (innerVal.rtype !== 'DynamicType') {
                const cscope = this.processInstruction(scope, innerVal.rtype, state)
                if (cscope?.vtype === 'class') {
                  eachRetVal.value[j] = this.buildTypeObject(innerVal, cscope)
                }
              }
            }
            continue
          }
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
        // 单返回值 callee 的 retVal 可能是 union-of-returns，
        // 外层 retVal.rtype 原本未设，导致 processVariableDeclaration 守卫失效，lhs 变量 rtype 丢失
        retVal.rtype = fclos.ast.node.returnType
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
   * @param callInfo
   */
  override executeSingleCall(fclos: any, state: any, node: any, scope: any, callInfo: CallInfo) {
    const retVal = super.executeSingleCall(fclos, state, node, scope, callInfo)
    const argvalues = getLegacyArgValues(callInfo)
    return this.convertRetValToObjectType(fclos, argvalues, state, node, scope, retVal)
  }

  /**
   *
   * @param value
   * @param node
   * @param sourcefile
   * @param tag
   * @param affectedNodeName
   */
  private _materializeGoCarrierTrace(
    value: Value,
    node: Node,
    sourcefile: string,
    tag: string,
    affectedNodeName: string
  ): Value {
    return SourceLine.addSrcLineInfo(value, node, sourcefile, tag, affectedNodeName) as Value
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processReturnStatement(scope: Scope, node: ReturnStatement, state: State): Value {
    const returnValue = super.processReturnStatement(scope, node, state)
    if (!node?.argument || !this.lastReturnValue?.taint?.isTaintedRec || !node.loc?.sourcefile) return returnValue
    const tracedValue = this.lastReturnValue as unknown as {
      taint?: { addTraceToAllTags?: (item: unknown, options?: unknown) => void }
    }
    tracedValue.taint?.addTraceToAllTags?.({
      file: node.loc.sourcefile,
      line: node.loc.start?.line,
      node,
      tag: 'Return Value: ',
      affectedNodeName: '[return value]',
    })
    return returnValue
  }

  /**
   *
   * @param fscope
   * @param params
   * @param state
   * @param _node
   */
  protected override onParamsBound(fscope: Scope, params: VariableDeclaration[], state: State, _node: Node): void {
    for (const param of params || []) {
      const paramId = param?.id
      if (paramId?.type !== 'Identifier') continue
      const value = this._getMemberValueDirect(fscope, paramId, state, false, 0, new Set()) as Value | undefined
      if (!value?.taint?.isTaintedRec || !param.loc?.sourcefile) continue
      const tracedValue = this._materializeGoCarrierTrace(
        value,
        param,
        param.loc.sourcefile,
        'ARG PASS: ',
        paramId.name
      )
      if (tracedValue && tracedValue !== value) this.saveVarInCurrentScope(fscope, paramId, tracedValue, state)
    }
  }

  /**
   *
   * @param node
   * @param argvalues
   * @param fclos
   */
  override buildCallArgs(node: CallExpression, argvalues: Value[], fclos: FunctionValueType): CallArgs {
    const callArgs = super.buildCallArgs(node, argvalues, fclos)
    if (node?.callee?.type === 'MemberAccess' && !callArgs.receiver) {
      callArgs.receiver = fclos?._this || fclos?.object || fclos?.getThisObj?.()
    }
    return callArgs
  }

  /**
   *
   * @param boundCall
   * @param params
   * @param callArgs
   * @param node
   */
  override bindReceiverParam(
    boundCall: BoundCall,
    params: Array<VariableDeclaration | { varType?: GoTypeAstNode }>,
    callArgs: CallArgs,
    node: CallExpression
  ): number {
    if (!callArgs.receiver || params.length === 0) return 0
    const firstParam = params[0]
    const firstParamType = firstParam?.varType?.type
    const firstParamName = (firstParam as { id?: { name?: string } })?.id?.name
    const receiverName = node?.callee?.type === 'MemberAccess' ? node.callee.object?.name : undefined
    const isGoReceiverParam =
      node?.callee?.type === 'MemberAccess' &&
      Boolean(firstParamName && receiverName && firstParamName === receiverName) &&
      (firstParamType === 'PointerType' || (firstParamType === 'Identifier' && firstParam?.varType?.name !== 'string'))
    if (!isGoReceiverParam) return super.bindReceiverParam(boundCall, params, callArgs, node)
    const bp = boundCall.params[0]
    if (bp) {
      bp.value = callArgs.receiver
      bp.provided = true
    }
    return 1
  }

  /**
   * 检查 fclos 是否属于 interface（Go 没有 abstract class）
   * @param fclos
   */
  checkFclosInInterface(fclos: any): boolean {
    return !!(fclos?.parent?.isInterface || fclos?.ast?.fdef?.parent?._meta?.isInterface)
  }

  /**
   * 从 CHA impl 的 method fclos 推回 impl struct 类型节点，供 CHA dispatch 时克隆 _this.rtype 用。
   * method fclos.parent 指向 struct ClassDefinition scope，其 sid / logicalQid 即 struct 类型名。
   * @param implFclos
   */
  _getImplReceiverTypeNode(implFclos: any): { type: 'Identifier'; name: string } | null {
    const parent = implFclos?.parent
    if (!parent) return null
    const typeName = parent.sid || parent.logicalQid || parent.qid
    if (!typeName || typeof typeName !== 'string') return null
    // 取短名（去包前缀），让 _extractTypeName / _findAllClassDefsByName 能按 sid 精确匹配
    const shortName = typeName.includes('.') ? typeName.split('.').pop() : typeName
    if (!shortName) return null
    return { type: 'Identifier', name: shortName }
  }

  /**
   * 从 classHierarchyMap 查找接口方法的所有具体实现
   * 递归遍历 implementedBy 链（包含间接实现）
   * @param fclos
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
   * @param typeName
   * @param methodName
   */
  findCHAImplementationsByTypeName(typeName: string, methodName: string): any[] {
    if (!this.classHierarchyMap || !typeName || !methodName) return []

    // 在 classHierarchyMap 中查找匹配的接口（qid 以 .typeName 结尾或等于 typeName）
    for (const [qid, hierarchy] of this.classHierarchyMap as Map<string, any>) {
      if (hierarchy.typeDeclaration !== 'interface') continue
      // 匹配：qid 末尾是 typeName（考虑包名前缀）
      if (qid !== typeName && !qid.endsWith(`.${typeName}`)) continue
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
      if (!obj.members) continue // Guard: skip if members is undefined
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
  async symbolInterpret(): Promise<boolean> {
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
    const hasAnalysised = new Set<string>()
    // 自定义source入口方式，并根据入口自主加载source
    let index = 0
    while (index < entryPoints.length) {
      const entryPoint = entryPoints[index++]
      const metricStartTime = Date.now()
      const findingsBefore = this.countFindings()
      let skipped = false
      let skipReason: string | undefined
      try {
        if (entryPoint.isPreProcess && this.isTmpSymbolTableOpen) {
          this.restoreSymbolTable()
        } else if (this.isTmpSymbolTableOpen) {
          this.symbolTable.clear()
        }

        if (!entryPoint.isPreProcess && !this.isTmpSymbolTableOpen) {
          this.switchToTemporarySymbolTable()
        }

        if (entryPoint.type === constValue.ENGIN_START_FILE_BEGIN) {
          skipped = true
          skipReason = 'unsupported'
          continue
        }
        entryPointConfig.setCurrentEntryPoint(entryPoint)
        const entryPointMark = this.markEntryPointForAnalysis(entryPoint, hasAnalysised)
        if (entryPointMark.skipped) {
          skipped = true
          skipReason = entryPointMark.skipReason
          continue
        }

        executeViaEntryPointExecutor(
          {
            analyzer: this,
            entryPoint,
            metricStartTime,
            findingsBefore,
            executionState: state,
            overloadCount: 1,
            epIndex: index,
            epTotal: entryPoints.length,
          },
          {
            language: 'go',
            classify: () => 'function',
            execute: () => {
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
                  {
                    callArgs: this.buildCallArgs(
                      entryPoint.entryPointSymVal?.ast?.node,
                      argValues,
                      entryPoint.entryPointSymVal
                    ),
                  }
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
            },
          },
          this.checkerManager?.resultManagerProxy,
        )
      } finally {
        this.recordEntryPointLoopMetric(entryPoint, metricStartTime, findingsBefore, skipped, skipReason, 1)
      }
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
  override executeFunctionInArguments(
    scope: Scope,
    caller: CallbackCaller,
    callsiteNode: CallExpression,
    argvalues: unknown[],
    state: State
  ): void {
    this.executeFunctionArgumentsForGo(scope, caller, callsiteNode, argvalues, state)
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

    if (node.operator === '!=' && this.isGoNonNilObjectValue(newLeft) && this.isGoNilValue(newRight)) {
      return new PrimitiveValue(scope.qid, 'true', true, null, 'Literal', node.loc) as BinaryExprValue
    }
    if (node.operator === '!=' && this.isGoNilValue(newLeft) && this.isGoNonNilObjectValue(newRight)) {
      return new PrimitiveValue(scope.qid, 'true', true, null, 'Literal', node.loc) as BinaryExprValue
    }
    if (node.operator === '==' && this.isGoNonNilObjectValue(newLeft) && this.isGoNilValue(newRight)) {
      return new PrimitiveValue(scope.qid, 'false', false, null, 'Literal', node.loc) as BinaryExprValue
    }
    if (node.operator === '==' && this.isGoNilValue(newLeft) && this.isGoNonNilObjectValue(newRight)) {
      return new PrimitiveValue(scope.qid, 'false', false, null, 'Literal', node.loc) as BinaryExprValue
    }

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
      if (node.right?.type === 'DereferenceExpression') {
        const narrowed = this.narrowGoInstanceofObject(newLeft, scope, node)
        if (narrowed) return narrowed as BinaryExprValue
      }
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
   * @param scope
   * @param node
   * @param value
   * @param state
   * @param evalScope
   */
  saveVarInCurrentScope(scope: any, node: any, value: any, state: any, evalScope?: any): any {
    if (node?.vtype && node.vtype !== 'undefine' && node?.sid?.startsWith('<indice_')) {
      return this.saveVarInScopeRec(scope, node, value, state)
    }
    return super.saveVarInCurrentScope(scope, node, value, state, evalScope)
  }

  /**
   * Go map computed index 归一化 + UAST 扁平化修复
   * 1. 先修复 UAST 扁平化的 map[obj.field] 模式
   * 2. 再将求值结果为 primitive 字符串的 index 转为 Identifier 格式的 SymbolValue
   * @param scope
   * @param node
   * @param state
   * @param evalScope
   */
  resolveIndices(scope: any, node: any, state: any, evalScope?: any): any {
    // UAST 扁平化修复：map[obj.field] → (map[obj]).field
    let inputNode = node
    if (node?.type === 'MemberAccess' && node?.computed) {
      const fixed = this._tryUnflattenMapIndex(node as MemberAccess)
      if (fixed) {
        inputNode = fixed
      }
    }
    const resolved = super.resolveIndices(scope, inputNode, state, evalScope)
    if (!resolved || resolved.type !== 'MemberAccess' || !resolved.computed) return resolved
    // key 归一化
    const prop = resolved.property
    if (prop?.vtype === 'primitive' && typeof prop.value === 'string') {
      const normalized = new SymbolValue(prop.qid, {
        sid: `<indice_${prop.value}>`,
        name: prop.value,
        type: 'Identifier',
        loc: prop.loc,
      })
      resolved.property = normalized
    } else if (
      prop?.vtype === 'symbol' &&
      !prop.sid?.startsWith('<indice_') &&
      prop.name &&
      typeof prop.name === 'string'
    ) {
      const normalized = new SymbolValue(prop.qid, {
        sid: `<indice_${prop.name}>`,
        name: prop.name,
        type: 'Identifier',
        loc: prop.loc,
      })
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
      const ret = new UnionValue(
        undefined,
        undefined,
        `${scope.qid}.<union@go_mem:${node.loc?.start?.line}:${node.loc?.start?.column}>`,
        node
      )
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
      if (
        this._isSymbolInterpretPhase &&
        ['symbol', 'object'].includes(defscope.vtype) &&
        defscope.rtype &&
        defscope.rtype !== 'DynamicType'
      ) {
        const methodFclos = this.resolveGoMethod(defscope, resolvedProp?.name)
        if (methodFclos) {
          // 与下方 getMemberValue 路径对齐：设置 _this + rtype，使 calleeType 匹配可用
          if (node.object.type !== 'SuperExpression') {
            methodFclos._this = defscope
          }
          methodFclos.object = defscope
          methodFclos.property = resolvedProp
          if (methodFclos.rtype === undefined) {
            methodFclos.rtype = { type: undefined }
            methodFclos.rtype.definiteType = defscope.rtype.type ? defscope.rtype : defscope.rtype.definiteType
            methodFclos.rtype.vagueType = defscope.rtype.vagueType
              ? `${defscope.rtype.vagueType}.${resolvedProp.name}`
              : resolvedProp.name
          }
          return methodFclos
        }
      }

      // Go 嵌入结构体方法解析：实例方法未找到时，通过 ClassDefinition 的 SpreadElement 查找嵌入类型的方法
      if (
        this._isSymbolInterpretPhase &&
        defscope.vtype === 'object' &&
        resolvedProp?.name &&
        (!res || !res.ast?.fdef)
      ) {
        const embeddedMethod = this._resolveEmbeddedMethod(defscope, resolvedProp.name)
        if (embeddedMethod) {
          return embeddedMethod
        }
      }

      if (node.object.type !== 'SuperExpression' && (res.vtype !== 'union' || !Array.isArray(res.value))) {
        res._this = defscope
      }
      if (
        defscope.rtype &&
        defscope.rtype !== 'DynamicType' &&
        res &&
        (res.rtype === undefined || (res.rtype && !res.rtype.definiteType)) &&
        resolvedProp?.name
      ) {
        const parentTypeNode = defscope.rtype.type ? defscope.rtype : defscope.rtype.definiteType
        const parentTypeName = this._extractTypeName(parentTypeNode)
        const fieldTypeNode = this._resolveFieldTypeViaTypeChain(parentTypeName || '', resolvedProp.name)
        const fallbackTypeNode = fieldTypeNode ?? this._resolveGoEmbeddedFieldType(parentTypeName || '', resolvedProp.name)
        const externalReceiverTypeNode =
          !fallbackTypeNode && res.rtype === undefined && !this._hasGoClassDef(parentTypeName || '') ? parentTypeNode : null
        const resolvedTypeNode = fallbackTypeNode ?? externalReceiverTypeNode
        if (resolvedTypeNode) {
          // 字段类型优先使用声明或嵌入类型；外部库方法保留 receiver 类型供 calleeType 匹配。
          res.rtype = { type: undefined }
          res.rtype.definiteType = resolvedTypeNode
          res.rtype.vagueType = defscope.rtype.vagueType
            ? `${defscope.rtype.vagueType}.${resolvedProp.name}`
            : resolvedProp.name
        }
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
   * @param node
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
      object: innerNode.property, // Y（mc）
      property: node.property, // Z（name）
      loc: {
        start: innerNode.property.loc?.start,
        end: node.property.loc?.end,
      },
    }
    const rewritten: any = {
      type: 'MemberAccess',
      computed: true,
      object: innerNode.object, // X（startModules）
      property: newInnerProp, // mc.name
      loc: node.loc,
    }
    return rewritten as MemberAccess
  }

  /**
   * 策略1：从 rtype 链中提取父 ClassDefinition，再从其字段的类型找到目标 ClassDefinition 的方法
   * 策略2：遍历 packages 查找包含该方法的非接口 ClassDefinition
   * 注意：不调用 processInstruction（symbolInterpret 阶段有副作用），只做数据结构遍历
   * @param defscope
   * @param methodName
   */
  resolveGoMethod(defscope: any, methodName: string): any {
    const { rtype } = defscope
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

    // 策略2：hint-based 查找（外部类型放弃 / 无父类型名放弃 / 严格 typeName 匹配）
    const hintParentTypeName = parentTypeNode ? this._extractTypeName(parentTypeNode) : null
    const hintIsExternal = !!rtype._isExternal
    // 缓存 key 必须包含 hint，否则不同 hint 的命中结果会互相污染
    const fallbackKey = `global:${methodName}:${hintIsExternal ? 'ext' : 'int'}:${hintParentTypeName ?? ''}`
    if (fallbackKey in this._methodResolveCache) return this._methodResolveCache[fallbackKey]

    const found = this._searchMethodInPackages(methodName, {
      parentTypeNode,
      parentTypeName: hintParentTypeName,
      isExternal: hintIsExternal,
    })
    this._methodResolveCache[fallbackKey] = found
    return found
  }

  /**
   * 策略1（纯数据遍历，无副作用）：
   * 从 PointerType/Identifier AST 节点提取父类型名 → 在 packages 中找到所有同名 ClassDefinition
   * → 遍历每个候选，从 body 中查找目标字段 → 提取字段的 varType → 找到目标 ClassDefinition 的方法
   * 解决同名类型歧义：多个包定义同名 struct 时，通过字段名精确匹配正确的 ClassDefinition
   * @param parentTypeNode
   * @param fieldName
   * @param methodName
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
        if (
          stmt.type === 'VariableDeclaration' &&
          stmt.id?.type === 'Identifier' &&
          stmt.id.name === fieldName &&
          stmt.varType
        ) {
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

    // 所有候选都不满足时，hint-based 兜底（用 parentTypeName 严格查，避免全局深搜误命中）
    return this._searchMethodInPackages(methodName, {
      parentTypeNode,
      parentTypeName,
      isExternal: false,
    })
  }

  /**
   * 纯数据遍历（无副作用）：在 packages 中找 parentTypeName 的所有同名 ClassDefinition
   * → 遍历 body 字段声明 → 命中 fieldName 返回字段声明类型 rtype（原始 AST 节点，形如 Identifier/PointerType）。
   *
   * 用于 accessValueFromDefScope 在 interface receiver 上做 field access 时，替代"把 receiver rtype 抄给字段"的 fallback：
   * interface 类型本身没有字段，直接查声明类型得到 undefined 即自然退回 fallback；
   * struct 类型字段命中 → 返回字段声明类型（如 `*ExternalClient`）修正 rtype 漂移。
   * @param parentTypeName
   * @param fieldName
   */
  _resolveFieldTypeViaTypeChain(parentTypeName: string, fieldName: string): GoTypeAstNode | null {
    if (!parentTypeName || !fieldName) return null
    const cacheKey = `fieldType:${parentTypeName}:${fieldName}`
    if (cacheKey in this._methodResolveCache) return this._methodResolveCache[cacheKey] as GoTypeAstNode | null

    const parentClassDefs = this._findAllClassDefsByName(parentTypeName)
    let resolved: GoTypeAstNode | null = null
    let sawInterface = false
    for (const parentClassDef of parentClassDefs) {
      if (parentClassDef.isInterface) {
        sawInterface = true
        continue
      }
      const bodyStmts = this._getClassDefBodyStmts(parentClassDef)
      if (!bodyStmts) continue
      for (const stmt of bodyStmts) {
        if (stmt.type !== 'VariableDeclaration' || !stmt.varType) continue
        if (stmt.id?.type === 'Identifier' && stmt.id.name === fieldName) {
          resolved = stmt.varType as GoTypeAstNode
          break
        }
      }
      if (resolved) break
    }

    // interface fallback：parentTypeName 是 interface 且自身无字段时，遍历 classHierarchyMap 中的 implementers，
    // 取第一个有该字段声明的 impl struct 的字段类型。用于修复 CHA dispatch 下 p.field 的 rtype 漂移：
    // `p` 实际指向全局 provider 对象（rtype=接口），字段访问需按 impl 字段类型反推。
    if (!resolved && sawInterface && this.classHierarchyMap) {
      const chMap: Map<string, ClassHierarchy> = this.classHierarchyMap
      let hierarchy: ClassHierarchy | undefined = chMap.get(parentTypeName)
      if (!hierarchy) {
        const suffix = `.${parentTypeName}`
        for (const [qid, h] of chMap) {
          if (qid === parentTypeName || qid.endsWith(suffix)) {
            hierarchy = h
            break
          }
        }
      }
      if (hierarchy?.typeDeclaration === 'interface' && Array.isArray(hierarchy.implementedBy)) {
        for (const impl of hierarchy.implementedBy) {
          // implementer 可能以 ClassHierarchy 形态存在，真实字段名见 go-type-related-info-resolver.ts：
          // impl.value?.sid 是 Go struct 的短名，impl.type 是 qid；两者择优
          const implName: string | undefined =
            impl?.value?.sid || (typeof impl?.type === 'string' ? impl.type.split('.').pop() : undefined)
          if (!implName) continue
          const implFieldType = this._resolveFieldTypeViaTypeChainInternal(implName, fieldName)
          if (implFieldType) {
            resolved = implFieldType
            break
          }
        }
      }
    }

    this._methodResolveCache[cacheKey] = resolved
    return resolved
  }

  /**
   * 仅走 struct 字段查询（不再递归到 interface implementers fallback），
   * 防止 _resolveFieldTypeViaTypeChain 的 interface fallback 递归回来。
   * @param parentTypeName
   * @param fieldName
   */
  _resolveFieldTypeViaTypeChainInternal(parentTypeName: string, fieldName: string): GoTypeAstNode | null {
    if (!parentTypeName || !fieldName) return null
    const parentClassDefs = this._findAllClassDefsByName(parentTypeName)
    for (const parentClassDef of parentClassDefs) {
      if (parentClassDef.isInterface) continue
      const bodyStmts = this._getClassDefBodyStmts(parentClassDef)
      if (!bodyStmts) continue
      for (const stmt of bodyStmts) {
        if (stmt.type !== 'VariableDeclaration' || !stmt.varType) continue
        if (stmt.id?.type === 'Identifier' && stmt.id.name === fieldName) {
          return stmt.varType as GoTypeAstNode
        }
      }
    }
    return null
  }

  _resolveGoEmbeddedFieldType(parentTypeName: string, fieldName: string): GoTypeAstNode | null {
    if (!parentTypeName || !fieldName) return null
    const cacheKey = `embeddedFieldType:${parentTypeName}:${fieldName}`
    if (cacheKey in this._methodResolveCache) return this._methodResolveCache[cacheKey] as GoTypeAstNode | null

    let resolved: GoTypeAstNode | null = null
    const parentClassDefs = this._findAllClassDefsByName(parentTypeName)
    for (const parentClassDef of parentClassDefs) {
      if (parentClassDef.isInterface) continue
      const bodyStmts = this._getClassDefBodyStmts(parentClassDef)
      if (!bodyStmts) continue
      for (const stmt of bodyStmts) {
        if (stmt.type !== 'SpreadElement') continue
        const embeddedTypeName = this._extractTypeName(stmt.argument)
        if (embeddedTypeName === fieldName) {
          resolved = stmt.argument as GoTypeAstNode
          break
        }
      }
      if (resolved) break
    }

    this._methodResolveCache[cacheKey] = resolved
    return resolved
  }

  _hasGoClassDef(typeName: string): boolean {
    if (!typeName) return false
    const cacheKey = `hasClassDef:${typeName}`
    if (cacheKey in this._methodResolveCache) return this._methodResolveCache[cacheKey] as boolean
    const hasClassDef = this._findAllClassDefsByName(typeName).length > 0
    this._methodResolveCache[cacheKey] = hasClassDef
    return hasClassDef
  }

  /**
   * 接口实现查找：从接口的 body 提取方法名列表，
   * 在 packages 树中搜索具备所有这些方法（带 fdef）的非接口 ClassDefinition，返回目标方法
   * @param interfaceClassDef
   * @param methodName
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
          const hasAll = interfaceMethodNames.every((m: string) => child.value?.[m]?.ast?.fdef)
          if (hasAll) {
            found = child.value[methodName]
            return
          }
        }

        if (
          child.vtype === 'object' ||
          child.vtype === 'package' ||
          child.vtype === 'module' ||
          child.vtype === 'class'
        ) {
          search(child, depth + 1)
        }
      }
    }

    search(packages, 0)
    return found
  }

  /**
   * 从 AST 类型节点提取类型名（不调用 processInstruction）
   * 支持：Identifier / PointerType / StarExpression / MemberAccess /
   *       ArrayType（取 element） / MapType（取 valueType） /
   *       DereferenceExpression / UnaryExpression(operator='*')（取 argument） /
   *       嵌套形态（如 *[]T / *map[K]V / []*T）通过递归处理
   * @param node
   */
  _extractTypeName(node: any): string | null {
    if (!node) return null
    if (node.type === 'Identifier') return node.name
    if (node.type === 'PointerType' || node.type === 'StarExpression')
      return this._extractTypeName(node.element || node.argument)
    // 解引用 / 一元 *：递归 argument
    if (node.type === 'DereferenceExpression') return this._extractTypeName(node.argument || node.element)
    if (node.type === 'UnaryExpression' && node.operator === '*') return this._extractTypeName(node.argument)
    // 容器：取元素 / value 类型（receiver 取自元素，key 类型不做 receiver）
    if (node.type === 'ArrayType') return this._extractTypeName(node.element)
    if (node.type === 'MapType') return this._extractTypeName(node.valueType)
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
   * @param classDef
   */
  _getClassDefBodyStmts(classDef: any): any[] | null {
    const cdef = classDef?.ast?.cdef
    if (!cdef?.body) return null

    const { body } = cdef
    if (Array.isArray(body)) return body
    if (Array.isArray(body.body)) return body.body
    if (Array.isArray(body.properties)) return body.properties
    return null
  }

  /**
   * 按调用点词法作用域解析类型名，找不到局部声明时再回退到包级唯一候选。
   * @param scope
   * @param typeName
   * @param state
   */
  _resolveClassDefByTypeNameInScope(scope: Scope, typeName: string, state: State): GoClassDefinitionValue | null {
    const typeIdent = { type: 'Identifier', name: typeName }
    const lexicalValue = this.getMemberValueNoCreate(scope, typeIdent as Identifier, state)
    if (lexicalValue?.ast?.cdef && lexicalValue.sid === typeName) return lexicalValue

    const packageCandidates = this._findAllClassDefsByName(typeName)
    return packageCandidates.length === 1 ? packageCandidates[0] : null
  }

  /**
   * 在 packages 树中按类型名查找所有同名 ClassDefinition（解决同名歧义）
   * @param name
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

        if (
          child.vtype === 'object' ||
          child.vtype === 'package' ||
          child.vtype === 'module' ||
          child.vtype === 'class'
        ) {
          search(child, depth + 1)
        }
      }
    }

    search(packages, 0)
    this._methodResolveCache[cacheKey] = results
    return results
  }

  /**
   * 策略 2 hint-based 查找：按父类型名严格匹配 ClassDef，再取目标方法（非接口、有 fdef）
   *
   * hint 字段：
   * - parentTypeNode：父类型 AST 节点（保留供后续调试 / 扩展）
   * - parentTypeName：父类型名（_extractTypeName 提取的结果）
   * - isExternal：源头打标信号，true 表示父类型来自外部 lib stub（processLibArgToRet 注入）
   *
   * 行为：
   * - hint.isExternal=true → 直接 return null（外部类型让 res.rtype 兜底接管）
   * - hint.parentTypeName 缺失 → return null（不做无父类型名的全局深搜）
   * - 严格匹配：通过 _findAllClassDefsByName 在 packages 中查 sid===parentTypeName 的 ClassDef，
   *   仅取非 interface 且方法带 fdef 的命中，避免全局深搜跨包同名方法误命中
   * @param methodName
   * @param hint
   * @param hint.parentTypeNode
   * @param hint.parentTypeName
   * @param hint.isExternal
   */
  _searchMethodInPackages(
    methodName: string,
    hint: {
      parentTypeNode?: any
      parentTypeName?: string | null
      isExternal?: boolean
    } = {}
  ): any {
    if (hint.isExternal) return null
    if (!hint.parentTypeName) return null

    const candidates = this._findAllClassDefsByName(hint.parentTypeName)
    for (const cdef of candidates) {
      if (cdef && !cdef.isInterface && cdef.value?.[methodName]?.ast?.fdef) {
        return cdef.value[methodName]
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
   * @param callInfo
   */
  override processLibArgToRet(node: any, fclos: any, argvalues: any, scope: any, state: any, callInfo: CallInfo) {
    const ret = super.processLibArgToRet(node, fclos, argvalues, scope, state, callInfo)
    // 将 fclos 的 rtype 信息保留给返回值，并源头打标外部 lib stub
    // 浅 clone 避免 fclos.rtype 跨调用共享引用被反复打标污染上游
    if (fclos.rtype) {
      const wrapper: any = typeof fclos.rtype === 'object' && fclos.rtype !== null ? { ...fclos.rtype } : fclos.rtype
      if (wrapper && typeof wrapper === 'object') {
        wrapper._isExternal = true
      }
      ret.rtype = wrapper
    }
    return ret
  }

  /**
   *
   * @param argNodes
   * @param argvalues
   * @param scope
   */
  private attachClosureCaptureTraceToArgs(
    argNodes: Node[] | undefined,
    argvalues: unknown[] | undefined,
    scope: Scope
  ): void {
    const currentFclos = this.getEncloseFclos(scope) as CapturingFclos | null | undefined
    const closureNode = currentFclos?.ast?.node ?? currentFclos?.ast?.fdef
    if (!currentFclos?.qid || !getNodeSourceFile(closureNode) || !Array.isArray(argNodes) || !Array.isArray(argvalues))
      return
    for (let i = 0; i < argNodes.length; i++) {
      if (closureNode) {
        argvalues[i] = this.attachClosureCaptureTraceToValue(argNodes[i], argvalues[i], currentFclos, closureNode)
      }
    }
  }

  /**
   *
   * @param node
   * @param value
   * @param currentFclos
   * @param closureNode
   */
  private attachClosureCaptureTraceToValue(
    node: Node | undefined,
    value: unknown,
    currentFclos: CapturingFclos,
    closureNode: Node
  ): unknown {
    if (!node || !value) return value
    if (isIdentifierNode(node)) {
      const sourcefile = getNodeSourceFile(closureNode)
      if (sourcefile && isTaintedValue(value) && this.isCapturedFromOuterScope(value, currentFclos)) {
        return SourceLine.addSrcLineInfo(value, closureNode, sourcefile, 'ARG PASS: ', node.name)
      }
      return value
    }
    if (isUnaryExpressionNode(node) && isCapturableValue(value)) {
      value.argument = this.attachClosureCaptureTraceToValue(
        node.argument,
        value.argument,
        currentFclos,
        closureNode
      ) as CapturableValue | undefined
      return value
    }
    return value
  }

  /**
   *
   * @param value
   * @param currentFclos
   */
  private isCapturedFromOuterScope(value: CapturableValue, currentFclos: CapturingFclos): boolean {
    const qid = typeof value.qid === 'string' ? value.qid : value.logicalQid
    return typeof qid === 'string' && typeof currentFclos.qid === 'string' && !qid.startsWith(`${currentFclos.qid}.`)
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
