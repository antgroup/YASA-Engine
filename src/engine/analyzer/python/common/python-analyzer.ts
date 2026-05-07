import type { Instruction } from '@ant-yasa/uast-spec'
import SymAddress from '../../common/sym-address'
import { AstRefList } from '../../common/value/ast-ref-list'
import { BinaryExprValue } from '../../common/value/binary-expr'
import type {
  Scope,
  State,
  Value,
  SymbolValue as SymbolValueType,
  VoidValue as VoidValueType,
} from '../../../../types/analyzer'
import type { CallArgs, CallArg, CallArgKind, CallInfo } from '../../common/call-args'
import { INTERNAL_CALL } from '../../common/call-args'
import type {
  ScopedStatement,
  CallExpression,
  FunctionDefinition,
  BinaryExpression,
  Identifier,
  MemberAccess,
  NewExpression,
  ReturnStatement,
  TryStatement,
  VariableDeclaration,
  AssignmentExpression,
  SpreadElement,
} from '../../../../types/uast'

const Uuid = require('node-uuid')
const globby = require('fast-glob')
const _ = require('lodash')
const path = require('path')
const UastSpec = require('@ant-yasa/uast-spec')
const { lodashCloneWithTag } = require('../../../../util/clone-util')
const Analyzer: typeof import('../../common/analyzer').Analyzer = require('../../common/analyzer')
const { getLegacyArgValues } = require('../../common/call-args')
const CheckerManager = require('../../common/checker-manager')
const BasicRuleHandler = require('../../../../checker/common/rules-basic-handler')
const Parser = require('../../../parser/parser')
const {
  ValueUtil: { Scoped, PrimitiveValue, UndefinedValue, UnionValue, SymbolValue, VoidValue },
} = require('../../../util/value-util')
const logger: import('../../../../util/logger').Logger = require('../../../../util/logger')(__filename)
const Config = require('../../../../config')
const { ErrorCode } = require('../../../../util/error-code')
const { assembleFullPath } = require('../../../../util/file-util')
const SourceLine = require('../../common/source-line')
const ScopeClass = require('../../common/scope')
const { unionAllValues } = require('../../common/memStateBVT')
const AstUtil = require('../../../../util/ast-util')
const Stat = require('../../../../util/statistics')
const constValue = require('../../../../util/constant')
const entryPointConfig = require('../../common/current-entrypoint')
const FileUtil = require('../../../../util/file-util')
const { getSourceNameList } = require('./entrypoint-collector/python-entrypoint')
const { handleException } = require('../../common/exception-handler')
const {
  resolveImportPath,
  resolveRelativeImport,
  getAllRelativeImportCandidates,
  getAllAbsoluteImportCandidates,
  findProjectRoot,
  buildSearchPaths,
} = require('./python-import-resolver')

/**
 *
 */
class PythonAnalyzer extends Analyzer {
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
    this.enableLibArgToThis = true
    this.fileList = []
    this.pyAstParseManager = {}
    // 用于解析绝对导入，按优先级排序
    this.searchPaths = []
    // import 结果缓存，防止同一 import 被不同文件反复触发组合爆炸
    this._importCache = new Map<string, Value>()
    // tryLoadModule 内部缓存，按 (actualPath, fieldKey) 缓存加载结果
    this._tryLoadModuleCache = new Map<string, { module: any; field: any } | null>()
    // 规范化文件路径集合，替代 fileList.some() 的 O(n) 线性扫描
    this._normalizedFileSet = new Set<string>()
  }

  /**
   * 预处理阶段：扫描模块并解析代码
   *
   * @param dir - 项目目录
   */
  async preProcess(dir: any) {
    ;(this as any).thisIterationTime = 0
    ;(this as any).prevIterationTime = new Date().getTime()

    await this.scanModules(dir)
    this.pyAstParseManager = {}
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
    this._normalizedFileSet = new Set<string>([path.normalize(fileName)])
    const { options } = this
    this.sourceCodeCache.set(fileName, source.split(/\n/))
    const ast = Parser.parseSingleFile(fileName, options)
    this.pyAstParseManager[fileName] = ast
    this.addASTInfo(ast, source, fileName)
    if (ast) {
      this.processModule(ast, fileName)
    }
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
      this.symbolTable.clear()
      if (entryPoint.type === constValue.ENGIN_START_FUNCALL) {
        if (
          hasAnalysised.includes(
            `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?.qid}#${entryPoint.entryPointSymVal.ast.node.parameters}.${entryPoint.attribute}`
          )
        ) {
          continue
        }

        hasAnalysised.push(
          `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?.qid}#${entryPoint.entryPointSymVal.ast.node.parameters}.${entryPoint.attribute}`
        )
        entryPointConfig.setCurrentEntryPoint(entryPoint)

        this.executeCallEntryPoint(entryPoint, entryPoint.entryPointSymVal?.ast?.node, state)
        // 对重载的符号值也需要进行模拟执行
        const overloadedList = entryPoint.entryPointSymVal?.overloaded
        if (!overloadedList || overloadedList.length <= 1) {
          continue
        }
        for (const overloadFuncDef of overloadedList.filter(() => true)) {
          const tmpVal = _.clone(entryPoint)
          tmpVal.entryPointSymVal = lodashCloneWithTag(entryPoint.entryPointSymVal)
          const clonedDef = _.clone(overloadFuncDef)
          tmpVal.entryPointSymVal.ast.fdef = clonedDef
          tmpVal.entryPointSymVal.ast = clonedDef
          this.executeCallEntryPoint(tmpVal, overloadFuncDef, state)
        }
      } else if (entryPoint.type === constValue.ENGIN_START_FILE_BEGIN) {
        if (hasAnalysised.includes(`fileBegin:${entryPoint.filePath}.${entryPoint.attribute}`)) {
          continue
        }
        hasAnalysised.push(`fileBegin:${entryPoint.filePath}.${entryPoint.attribute}`)
        entryPointConfig.setCurrentEntryPoint(entryPoint)
        logger.info('EntryPoint [%s] is executing ', entryPoint.filePath)

        const fileFullPath = assembleFullPath(entryPoint.filePath, Config.maindir)
        const sourceNameList = getSourceNameList()
        this.refreshCtx(this.topScope.context.modules.members.get(fileFullPath)?.value, sourceNameList)
        this.refreshCtx(this.symbolTable.get(this.topScope.context.files[fileFullPath])?.value, sourceNameList)
        this.refreshCtx(this.topScope.context.packages.members.get(fileFullPath), sourceNameList)

        const { filePath } = entryPoint
        const scope = this.topScope.context.modules.members.get(filePath)
        if (scope) {
          try {
            this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)
            this.processCompileUnit(scope, entryPoint.entryPointSymVal?.ast?.node, state)
            this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
          } catch (e) {
            handleException(
              e,
              `[${entryPoint.entryPointSymVal?.ast?.node?.loc?.sourcefile} symbolInterpret failed. Exception message saved in error log file`,
              `[${entryPoint.entryPointSymVal?.ast?.node?.loc?.sourcefile} symbolInterpret failed. Exception message saved in error log file`
            )
          }
        }
      }
    }
    return true
  }

  /**
   *
   * @param entryPoint
   * @param ast
   * @param state
   */
  executeCallEntryPoint(entryPoint: any, ast: any, state: any) {
    logger.info(
      'EntryPoint [%s.%s] is executing',
      entryPoint.filePath?.substring(0, entryPoint.filePath?.lastIndexOf('.')),
      entryPoint.functionName ||
        `<anonymousFunc_${entryPoint.entryPointSymVal?.ast?.node?.loc?.start?.line}_$${
          entryPoint.entryPointSymVal?.ast?.node?.loc?.end?.line
        }>`
    )
    const fileFullPath = assembleFullPath(entryPoint.filePath, Config.maindir)
    const sourceNameList = getSourceNameList()
    this.refreshCtx(this.topScope.context.modules.members.get(fileFullPath)?.value, sourceNameList)
    this.refreshCtx(this.symbolTable.get(this.topScope.context.files[fileFullPath])?.value, sourceNameList)
    this.refreshCtx(this.topScope.context.packages.members.get(fileFullPath), sourceNameList)

    this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)

    const argValues: any[] = []
    try {
      const prevFindIdInCurScope = state?.findIdInCurScope
      if (state) state.findIdInCurScope = true
      try {
        for (const key in ast?.parameters) {
          argValues.push(this.processInstruction(entryPoint.entryPointSymVal, ast?.parameters[key]?.id, state))
        }
      } finally {
        if (state) {
          if (prevFindIdInCurScope === undefined) delete state.findIdInCurScope
          else state.findIdInCurScope = prevFindIdInCurScope
        }
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
      entryPoint?.entryPointSymVal?.parent?.members?.get('_CTOR_')
    ) {
      this.executeCall(
        entryPoint.entryPointSymVal?.parent?.members?.get('_CTOR_')?.ast?.node,
        entryPoint.entryPointSymVal?.parent?.members?.get('_CTOR_'),
        state,
        entryPoint.entryPointSymVal?.parent?.members?.get('_CTOR_')?.ast?.node?.parent,
        INTERNAL_CALL
      )
    }
    try {
      this.executeCall(ast, entryPoint.entryPointSymVal, state, entryPoint.entryPointSymVal?.parent, {
        callArgs: this.buildCallArgs(ast, argValues, entryPoint.entryPointSymVal),
      })
    } catch (e) {
      handleException(
        e,
        `[${entryPoint.entryPointSymVal?.ast?.node?.id?.name} symbolInterpret failed. Exception message saved in error log file`,
        `[${entryPoint.entryPointSymVal?.ast?.node?.id?.name} symbolInterpret failed. Exception message saved in error log file`
      )
    }
    this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
  }

  /**
   * Python 的 **kwargs spread 在函数调用参数中需要保留 dict 的 key→value 结构，
   * 基类 processSpreadElement 会将 dict 展平为独立值的 Set 丢失键名，
   * 导致 resolveKwSpreadEntries 无法还原 keyword 参数绑定。
   * 仅对函数调用参数直接求值内部引用，返回完整的 ObjectValue；
   * dict literal 中的 {**params} 仍走基类展平逻辑。
   * @param scope
   * @param node
   * @param state
   */
  override processSpreadElement(scope: Scope, node: SpreadElement, state: State): any {
    if ((node as any).parent?.type === 'CallExpression') {
      return this.processInstruction(scope, node.argument, state)
    }
    return super.processSpreadElement(scope, node, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processBinaryExpression(scope: Scope, node: BinaryExpression, state: State): BinaryExprValue {
    const new_left = this.processInstruction(scope, node.left, state)
    const new_right = this.processInstruction(scope, node.right, state)

    if (node.operator === 'push') {
      this.processOperator(new_left.parent ? new_left.parent : new_left, node.left, new_right, node.operator, state)
    }

    const has_tag = (new_left && new_left.taint?.isTaintedRec) || (new_right && new_right.taint?.isTaintedRec)

    // checkerManager 需要 newNode 兼容对象
    const newNode: any = { ...node, ast: node, left: new_left, right: new_right, isTainted: has_tag || null }
    if (node.operator === 'instanceof') {
      newNode._meta = { ...node._meta, type: node.right }
    }
    if (this.checkerManager && this.checkerManager.checkAtBinaryOperation)
      this.checkerManager.checkAtBinaryOperation(this, scope, node, state, { newNode })

    const result = new BinaryExprValue(scope.qid, node.operator, new_left, new_right, node, node.loc)
    if (has_tag) {
      result.taint?.mergeFrom([new_left, new_right])
    }
    return result
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processCallExpression(scope: Scope, node: CallExpression, state: State): any {
    if (this.checkerManager && this.checkerManager.checkAtFuncCallSyntax)
      this.checkerManager.checkAtFuncCallSyntax(this, scope, node, state, {
        pcond: state.pcond,
        einfo: state.einfo,
      })

    const fclos = this.processInstruction(scope, node.callee, state)
    if (!fclos) return new UndefinedValue()

    const argvalues: any[] = []
    // 参数按原始顺序处理，由 buildPythonCallArgs 标记 kind，bindCallArgs 负责绑定
    const collectedArgs = node.arguments

    for (const arg of collectedArgs) {
      const argv = this.processInstruction(scope, arg, state)
      if (logger.isTraceEnabled()) logger.trace(`arg: ${this.formatScope(argv)}`)
      if (Array.isArray(argv)) argvalues.push(...argv)
      else argvalues.push(argv)
    }

    // 构建结构化 callInfo，携带 keyword/spread/kwspread 信息
    const callInfo: CallInfo = { callArgs: this.buildPythonCallArgs(collectedArgs, argvalues, fclos, node) }

    if (argvalues && this.checkerManager) {
      this.checkerManager.checkAtFunctionCallBefore(this, scope, node, state, {
        callInfo,
        fclos,
        pcond: state.pcond,
        entry_fclos: this.entry_fclos,
        einfo: state.einfo,
        state,
        analyzer: this,
        ainfo: this.ainfo,
      })
    }

    // union callee 含 class 成员：拆出 class 走 propagateNewObject，其余交给 executeCall
    if (fclos.vtype === 'union' && Array.isArray(fclos.value)) {
      const classMembers = fclos.value.filter((m: any) => m && typeof m === 'object' && m.vtype === 'class')
      if (classMembers.length > 0) {
        const results: Value[] = []
        for (const member of classMembers) {
          const signatureAst = member.members?.get('_CTOR_')?.fdef || member.fdef || member.ast
          if (signatureAst?.type === 'FunctionDefinition') {
            callInfo.boundCall = this.bindCallArgs(node, member, signatureAst, callInfo)
          }
          const r = this.propagateNewObject(scope, node, state, member, argvalues, callInfo)
          if (r) results.push(r)
        }
        // 非 class 成员通过 executeCall 的 union 处理（已内置 checkAtFunctionCallAfter）
        const nonClassMembers = fclos.value.filter((m: any) => !m || typeof m !== 'object' || m.vtype !== 'class')
        if (nonClassMembers.length > 0) {
          for (const member of nonClassMembers) {
            if (!member || typeof member !== 'object') continue
            const r = this.executeCall(node, member, state, scope, callInfo)
            if (r) {
              results.push(r)
              if (this.checkerManager?.checkAtFunctionCallAfter) {
                this.checkerManager.checkAtFunctionCallAfter(this, scope, node, state, {
                  callInfo,
                  fclos: member,
                  ret: r,
                  pcond: state.pcond,
                  einfo: state.einfo,
                  callstack: state.callstack,
                })
              }
            }
          }
        }
        if (results.length === 1) return results[0]
        if (results.length > 1) {
          return new UnionValue(
            results,
            undefined,
            `${scope.qid}.<union@call:${node?.loc?.start?.line}:${node?.loc?.start?.column}>`,
            node
          )
        }
        return new UndefinedValue()
      }
    }

    if (fclos.vtype === 'class') {
      const signatureAst = fclos?.members?.get('_CTOR_')?.fdef || fclos?.fdef || fclos?.ast
      if (signatureAst?.type === 'FunctionDefinition') {
        callInfo.boundCall = this.bindCallArgs(node, fclos, signatureAst, callInfo)
      }
      return this.propagateNewObject(scope, node, state, fclos, argvalues, callInfo)
    }
    // list.append(x)：将元素添加到列表，并传播污点
    if (
      node.callee.type === 'MemberAccess' &&
      node.callee.property.type === 'Identifier' &&
      node.callee.property.name === 'append' &&
      (fclos as any)?.object
    ) {
      const listObj = (fclos as any).object
      const appendedVal = argvalues[0]
      if (appendedVal) {
        // 将元素存入列表的下一个索引位置
        const nextIdx =
          listObj.length ??
          Object.keys(listObj.getRawValue?.() ?? {}).filter((k: string) => !k.startsWith('__yasa')).length
        if (listObj.value && typeof listObj.value === 'object') {
          listObj.value[nextIdx] = appendedVal
        }
        if (typeof listObj.length === 'number') {
          listObj.length++
        }
        // 传播污点：如果追加的元素有污点，列表也应该有污点
        if (appendedVal._taint?.isTaintedRec) {
          listObj.taint.propagateFrom(appendedVal)
        }
      }
      return undefined
    }
    const res = this.executeCall(node, fclos, state, scope, callInfo)

    if (fclos.vtype !== 'fclos' && Config.invokeCallbackOnUnknownFunction) {
      this.executeFunctionInArguments(scope, fclos, node, argvalues, state)
    }

    if (res && this.checkerManager?.checkAtFunctionCallAfter) {
      this.checkerManager.checkAtFunctionCallAfter(this, scope, node, state, {
        callInfo,
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
   * @param fclos
   * @param argvalues
   * @param callInfo
   */
  propagateNewObject(
    scope: Scope,
    node: CallExpression,
    state: State,
    fclos: Value,
    argvalues: Value[],
    callInfo: CallInfo
  ): Value {
    // 有 __init__ 或 __new__：走完整 buildNewObject（执行构造函数）
    // 不含 fclos.ast?.cdef 条件——无 __init__ 的类走 processLibArgToRet 避免 OOM
    if (fclos.members?.has('_CTOR_') || fclos.value?.['__new__']) {
      const res = this.buildNewObject(fclos.ast.cdef, fclos, state, node, scope, callInfo)
      if (res && this.checkerManager?.checkAtFunctionCallAfter) {
        this.checkerManager.checkAtFunctionCallAfter(this, scope, node, state, {
          callInfo,
          fclos,
          ret: res,
          pcond: state.pcond,
          einfo: state.einfo,
          callstack: state.callstack,
        })
      }
      return res
    }
    const res = this.processLibArgToRet(node, fclos, argvalues, scope, state, callInfo)
    if (res && this.checkerManager?.checkAtFunctionCallAfter) {
      this.checkerManager.checkAtFunctionCallAfter(this, scope, node, state, {
        callInfo,
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
   * 构建 Python 结构化 CallArgs，识别 keyword / spread / kwspread 参数类型
   *
   * collectedArgs 经过 collectArgsFromArray 重排后与 argvalues 一一对应，
   * 通过 AST 节点类型判定参数 kind：
   * - VariableDeclaration → keyword（name=value 语法）
   * - DereferenceExpression → spread（*args 语法）
   * - SpreadElement → kwspread（**kwargs 语法）
   * - 其他 → positional
   * @param collectedArgs
   * @param argvalues
   * @param fclos
   * @param node
   */
  buildPythonCallArgs(
    collectedArgs: Array<Instruction | undefined>,
    argvalues: Value[],
    fclos: Value,
    node: CallExpression
  ): CallArgs {
    const args: CallArg[] = []
    const len = Math.min(argvalues.length, collectedArgs.length)

    for (let i = 0; i < len; i++) {
      const astNode = collectedArgs[i]
      let kind: CallArgKind = 'positional'
      let name: string | undefined

      if (UastSpec.isVariableDeclaration(astNode)) {
        kind = 'keyword'
        name = (astNode as VariableDeclaration).id?.name
      } else if (astNode?.type === 'DereferenceExpression') {
        kind = 'spread'
      } else if (astNode?.type === 'SpreadElement') {
        kind = 'kwspread'
      }

      args.push({ index: i, value: argvalues[i], node: astNode, name, kind })
    }

    // argvalues 因 Array.isArray(argv) 展开可能多于 collectedArgs，多出部分为 positional
    for (let i = len; i < argvalues.length; i++) {
      args.push({ index: i, value: argvalues[i], kind: 'positional' })
    }

    const receiver = this.getCallReceiver(fclos, node)
    return { receiver, args }
  }

  /**
   * 处理 Python import 语句
   *
   * @param scope
   * @param node
   * @param state
   */
  processImportDirect(scope: Scope, node: any, state: State): Value {
    const { from, imported } = node
    let sourcefile: string | undefined
    // 向上遍历 AST 查找 sourcefile，用独立变量避免死循环
    let current = imported
    const maxDepth = 50
    let depth = 0
    while (current && depth < maxDepth) {
      sourcefile = current.loc?.sourcefile
      if (sourcefile) break
      current = current.parent
      depth++
    }
    if (!sourcefile) {
      handleException(
        null,
        'Error occurred in PythonAnalyzer.processImportDirect: failed to sourcefile in ast',
        'Error occurred in PythonAnalyzer.processImportDirect: failed to sourcefile in ast'
      )
      return new UndefinedValue()
    }

    const sourceFileAbs = path.resolve(sourcefile.toString())
    const projectRoot = Config.maindir?.replace(/\/$/, '') || path.dirname(sourceFileAbs)

    // 入口级缓存：按 (sourcefile, from, imported) 生成 key，已处理则直接返回
    const importCacheKey = `${sourceFileAbs}|${from?.value || ''}|${imported?.name || imported?.value || ''}`
    const cachedImportResult = this._importCache.get(importCacheKey)
    if (cachedImportResult !== undefined) {
      return cachedImportResult
    }

    let importPath: string | null = null
    let modulePath: string | null = null
    const fromValue = from?.value
    const importedName = imported?.name && imported.name !== '*' ? imported.name : null
    const onlyDots = fromValue?.startsWith('.') ? /^\.+$/.test(fromValue) : false

    if (!from) {
      // 处理 "import module" 形式的导入
      const importName = imported.value || imported.name
      if (importName) {
        importPath = resolveImportPath(importName, sourceFileAbs, this.fileList, projectRoot)
      }
    } else if (fromValue) {
      // 相对导入，需要区分两种情况：
      // 1. "from .. import moduleName" - 导入整个模块，fromValue 只有点号（如 ".."）
      // 2. "from ..moduleName import fieldName" - 从模块中导入字段，fromValue 包含点号和模块名（如 "..moduleName"）
      if (fromValue.startsWith('.'))
        if (onlyDots) {
          importPath = resolveRelativeImport(fromValue, sourceFileAbs, this.fileList, importedName || undefined)
          // 不设置 modulePath，因为这是导入整个模块，应该返回整个模块对象
        } else {
          importPath = resolveImportPath(fromValue, sourceFileAbs, this.fileList, projectRoot)
          modulePath = importedName
        }
      else {
        // 绝对导入
        importPath = resolveImportPath(fromValue, sourceFileAbs, this.fileList, projectRoot)
        modulePath = importedName
      }
    }

    // 缓存结果并返回的辅助函数
    const cacheAndReturn = (result: Value): Value => {
      this._importCache.set(importCacheKey, result)
      return result
    }

    // 如果 resolver 找到了路径，加载模块
    if (importPath) {
      const normalizedPath = path.normalize(importPath)
      let candidatePaths: string[] = []

      const buildCandidatePaths = () => {
        if (!fromValue) return []
        if (fromValue.startsWith('.')) {
          if (onlyDots) {
            const resolvedPath = resolveRelativeImport(
              fromValue,
              sourceFileAbs,
              this.fileList,
              importedName || undefined
            )
            return resolvedPath ? [resolvedPath] : []
          }
          return getAllRelativeImportCandidates(
            fromValue,
            sourceFileAbs,
            this.fileList,
            undefined,
            modulePath || undefined
          )
        }
        const root = projectRoot || findProjectRoot(this.fileList, Config.maindir || process.cwd())
        const searchPaths = buildSearchPaths(sourceFileAbs, this.fileList, root)
        return getAllAbsoluteImportCandidates(fromValue, searchPaths, this.fileList, modulePath || undefined)
      }

      // 先收集全部候选路径，但保持 importPath 为首选
      candidatePaths = buildCandidatePaths()
      if (candidatePaths.length > 5) {
        logger.warn(
          `Large candidatePaths (${candidatePaths.length}) for import from=${fromValue}, imported=${importedName}`
        )
      }
      if (!candidatePaths.length) {
        candidatePaths = [importPath]
      } else if (!candidatePaths.some((p) => path.normalize(p) === normalizedPath)) {
        candidatePaths.unshift(importPath)
      } else if (path.normalize(candidatePaths[0]) !== normalizedPath) {
        candidatePaths = [importPath, ...candidatePaths.filter((p) => path.normalize(p) !== normalizedPath)]
      }

      const tryLoadModule = (
        targetPath: string,
        shouldExtractField: boolean = true
      ): { module: any; field: any } | null => {
        const isPackageDir = !targetPath.endsWith('.py')
        let actualPath = targetPath
        const fieldKey = shouldExtractField && modulePath ? modulePath : ''

        if (isPackageDir) {
          const initFile = path.join(targetPath, '__init__.py')
          const normalizedInitFile = path.normalize(initFile)
          if (this._normalizedFileSet.has(normalizedInitFile)) {
            actualPath = initFile
          }
        }

        // tryLoadModule 内部缓存，按 (actualPath, fieldKey) 缓存结果
        const tlmCacheKey = `${actualPath}|${fieldKey}`
        if (this._tryLoadModuleCache.has(tlmCacheKey)) {
          return this._tryLoadModuleCache.get(tlmCacheKey)!
        }

        const getField = (value: any) => (fieldKey ? value.members?.get(fieldKey) : undefined)

        const processingKey = `processing_${actualPath}`
        if ((this as any)[processingKey]) {
          logger.warn(`Circular import detected for: ${actualPath}`)
          return null
        }

        try {
          ;(this as any)[processingKey] = true

          const cachedModule = this.topScope.context.modules.members.get(actualPath)
          if (cachedModule) {
            const field = getField(cachedModule)
            delete (this as any)[processingKey]
            const result = { module: cachedModule, field: field || undefined }
            this._tryLoadModuleCache.set(tlmCacheKey, result)
            return result
          }

          const ast = this.pyAstParseManager[actualPath]
          if (ast) {
            const module = this.processModule(ast, actualPath)
            if (module) {
              const field = getField(module)
              delete (this as any)[processingKey]
              const result = { module, field: field || undefined }
              this._tryLoadModuleCache.set(tlmCacheKey, result)
              return result
            }
          }
          delete (this as any)[processingKey]
        } catch (e) {
          delete (this as any)[processingKey]
          handleException(
            e,
            `Error: PythonAnalyzer.processImportDirect: failed to loading: ${actualPath}`,
            `Error: PythonAnalyzer.processImportDirect: failed to loading: ${actualPath}`
          )
        }
        this._tryLoadModuleCache.set(tlmCacheKey, null)
        return null
      }

      const shouldExtractFieldForPath = (candidatePath: string) => !candidatePath.endsWith('.py') && modulePath !== null

      // 先尝试已找到的路径
      const firstResult = tryLoadModule(normalizedPath)
      if (firstResult?.field) {
        return cacheAndReturn(firstResult.field)
      }

      // 如果第一个路径找到了模块但没有所需字段，尝试其他候选路径
      if (modulePath && firstResult && !firstResult.field) {
        // 第一个是importPath，前面已经尝试过，跳过
        if (candidatePaths && candidatePaths.length > 1) {
          for (let i = 1; i < candidatePaths.length; i++) {
            const candidatePath = candidatePaths[i]
            const normalizedCandidatePath = path.normalize(candidatePath)
            // 避免重复尝试第一个路径
            if (normalizedCandidatePath !== normalizedPath) {
              // 判断候选路径是模块文件还是包目录：
              // 1. 如果是模块文件（.py），应该返回整个模块对象，不应该尝试提取字段
              // 2. 如果是包目录，才需要尝试提取字段
              const isModuleFile = normalizedCandidatePath.endsWith('.py')
              const shouldExtractField = shouldExtractFieldForPath(normalizedCandidatePath)

              const result = tryLoadModule(normalizedCandidatePath, shouldExtractField)

              if (result) {
                if (result.field) {
                  return cacheAndReturn(result.field)
                }
                if (isModuleFile) {
                  return cacheAndReturn(result.module)
                }
              }
            }
          }
        }
      }

      // 如果第一个路径找到了模块，返回它（即使没有所需字段）
      if (firstResult) {
        return cacheAndReturn(firstResult.module)
      }
    }

    // 如果所有候选路径都尝试过了，但都没有找到，尝试作为三方库处理
    const importName = from?.value || imported?.value || imported?.name
    if (importName) {
      return cacheAndReturn(
        this.loadPredefinedModule(scope, imported?.name || importName, from?.value || 'syslib_from')
      )
    }

    return cacheAndReturn(new UndefinedValue())
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processMemberAccess(scope: Scope, node: MemberAccess, state: State): SymbolValueType {
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
    const res = this.getMemberValue(defscope, resolved_prop, state)
    if (node.object.type !== 'SuperExpression') {
      if (res.vtype !== 'union' || !Array.isArray(res.value)) {
        // 非 union 类型：直接绑定 _this
        res._this = defscope
      } else {
        // union + 数组：在 union 层级设置 _this，同时为每个尚未绑定 _this 的子成员设置
        res._this = defscope
        for (const member of res.value) {
          if (member && typeof member === 'object' && !member._this) {
            member._this = defscope
          }
        }
      }
    } else if (node.object.type === 'SuperExpression' && this.thisFClos) {
      // For super().method() calls, bind this/self to the current instance.
      // In Python semantics, super() only affects method dispatch, not self binding.
      res._this = this.thisFClos
    }
    if (this.checkerManager && (this.checkerManager as any).checkAtMemberAccess) {
      this.checkerManager.checkAtMemberAccess(this, defscope, node, state, { res })
    }
    return res
  }

  /**
   *
   * @param ast
   * @param filename
   */
  processModule(ast: any, filename: any) {
    if (!ast) {
      const sourceFile = filename
      Stat.fileIssues[sourceFile] = 'Parsing Error'
      handleException(
        null,
        `Error occurred in PythonAnalyzer.processModule: ${sourceFile} parse error`,
        `Error occurred in PythonAnalyzer.processModule: ${sourceFile} parse error`
      )
      return
    }
    this.preloadFileToPackage(ast, filename)
    let m = this.topScope.context.modules.members.get(filename)
    if (m && typeof m === 'object') return m
    let relateFileName = 'file'
    if (ast.loc?.sourcefile) {
      const prefix = ast.loc.sourcefile.substring(Config.maindirPrefix.length)
      const lastDotIndex = prefix.lastIndexOf('.')
      relateFileName = lastDotIndex >= 0 ? prefix.substring(0, lastDotIndex) : prefix
    }
    const modClos = new Scoped(this.topScope.qid, { sid: relateFileName, parent: this.topScope, decls: {}, ast })
    modClos.ast.fdef = ast
    this.topScope.context.modules.members.set(filename, modClos)
    this.fileManager[filename] = { uuid: modClos.uuid, astNode: modClos.ast.node }
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
  override processNewObject(scope: Scope, node: NewExpression, state: State): any {
    const call = node
    let fclos = this.processInstruction(scope, node.callee, state)
    if (!fclos) return undefined
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

    const fdef = fclos.ast?.fdef
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
   * @param node
   * @param argvalues
   * @param operator
   * @param state
   */
  processOperator(scope: any, node: any, argvalues: any, operator: any, state: any) {
    switch (operator) {
      case 'push': {
        this.saveVarInCurrentScope(scope, node, argvalues, state)
        const has_tag = (scope && scope.taint?.isTaintedRec) || (argvalues && argvalues.taint?.isTaintedRec)
        if (has_tag) {
          scope.taint?.mergeFrom([scope, argvalues])
        }
      }
    }
  }

  /**
   * @param scope
   * @param node
   * @param state
   */
  override processReturnStatement(scope: Scope, node: ReturnStatement, state: State): VoidValueType {
    if (node.argument) {
      const return_value = this.processInstruction(scope, node.argument, state)
      if (!node.isYield) {
        if (!(this as any).lastReturnValue) {
          ;(this as any).lastReturnValue = return_value
        } else if ((this as any).lastReturnValue.vtype === 'union' && !(this as any).lastReturnValue.isTuple) {
          ;(this as any).lastReturnValue.appendValue(return_value)
        } else {
          const tmp = new UnionValue(undefined, undefined, `${scope.qid}.<union@py_ret:${node.loc?.start?.line}>`, node)
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
    return new PrimitiveValue(scope.qid, 'undefined', null, null, 'Literal', node.loc)
  }

  /**
   * Python try-except 覆盖：except handler 通过 getDefScope 向上覆盖 try body 设置的绑定
   *
   * 问题根因：基类为 except handler 创建子 scope，但赋值通过 getDefScope 向上查找到
   * 父 scope 同名变量并覆盖（如 try-import/except-None 模式）。
   *
   * 修复策略：保存 try body 后的值快照，except handler 处理后，对被覆盖的变量创建
   * union（try 值 | except 值），由 processCallExpression 的 union 遍历处理调用。
   * @param scope
   * @param node
   * @param state
   */
  override processTryStatement(scope: Scope, node: TryStatement, state: State): VoidValueType {
    this.processInstruction(scope, node.body, state)

    const { handlers } = node
    if (handlers && handlers.length > 0) {
      // 保存 try body 后的 scope 值快照
      const trySnapshot: Record<string, any> = {}
      if (scope.value) {
        for (const key of Object.keys(scope.value)) {
          trySnapshot[key] = scope.value[key]
        }
      }

      for (const clause of handlers) {
        if (!clause) continue
        const exceptScope = ScopeClass.createSubScope(
          `<block_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}>`,
          scope
        )
        clause.parameter.forEach((param: any) => this.processInstruction(exceptScope, param, state))
        this.processInstruction(exceptScope, clause.body, state)
      }

      // except handler 可能通过 getDefScope 覆盖了父 scope 的绑定
      // 对被覆盖的变量创建 union（try 值 | except 值），保留两条路径的分析能力
      if (scope.value) {
        for (const key of Object.keys(trySnapshot)) {
          const tryVal = trySnapshot[key]
          const exceptVal = scope.value[key]
          if (tryVal && exceptVal && tryVal !== exceptVal) {
            scope.value[key] = new UnionValue([tryVal, exceptVal], undefined, `${scope.qid}.${key}`, tryVal.ast)
          }
        }
      }
    }

    if (node.finalizer) this.processInstruction(scope, node.finalizer, state)
    return new UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processScopedStatement(scope: Scope, node: ScopedStatement, state: State): any {
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
      let blockScope = scope
      if (node.parent?.type === 'FunctionDefinition') {
        // 只对函数体内的块语句创建子作用域，python的其他块语句不创建子作用域
        blockScope = ScopeClass.createSubScope(scopeName, scope, 'scope')
      }
      node.body
        .filter((n: any) => needCompileFirst(n.type))
        .forEach((s: any) => this.processInstruction(blockScope, s, state))
      node.body
        .filter((n: any) => !needCompileFirst(n.type))
        .forEach((s: any) => this.processInstruction(blockScope, s, state))
    }

    if (this.checkerManager && this.checkerManager.checkAtEndOfBlock) {
      this.checkerManager.checkAtEndOfBlock(this, scope, node, state, {})
    }
    return undefined
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processVariableDeclaration(scope: Scope, node: VariableDeclaration, state: State): SymbolValueType {
    const initialNode = node.init
    const { id } = node
    if (!id || (id.type === 'Identifier' && id.name === '_')) return new UndefinedValue()
    const idName = id.type === 'Identifier' ? id.name : (id as any).name

    let initVal: any
    if (!initialNode) {
      initVal = this.createVarDeclarationScope(id, scope)
      initVal.uninit = !initialNode
      initVal = SourceLine.addSrcLineInfo(initVal, id, id.loc && id.loc.sourcefile, 'Var Pass: ', idName)
    } else if (
      node?.parent?.type === 'CatchClause' &&
      node?._meta?.isCatchParam &&
      (state?.throwstack?.length ?? 0) > 0
    ) {
      initVal = state?.throwstack && state?.throwstack.shift()
      initVal = SourceLine.addSrcLineInfo(initVal, node, node.loc && node.loc.sourcefile, 'Var Pass: ', idName)
      delete node._meta.isCatchParm
    } else {
      initVal = this.processInstruction(scope, initialNode, state)
      if (!(id.type === 'Identifier' && id.name === 'self' && initialNode.type === 'ThisExpression')) {
        initVal = SourceLine.addSrcLineInfo(initVal, node, node.loc && node.loc.sourcefile, 'Var Pass: ', idName)
      }
    }

    if (this.checkerManager && this.checkerManager.checkAtPreDeclaration)
      this.checkerManager.checkAtPreDeclaration(this, scope, node, state, {
        lnode: id,
        rvalue: null,
        pcond: state.pcond,
        entry_fclos: (this as any).entry_fclos,
        fdef: state.callstack && state.callstack[state.callstack.length - 1],
      })
    if (idName === '*') {
      for (const x in initVal.value) {
        const v = initVal.value[x]
        if (!v) continue
        const v_copy = lodashCloneWithTag(v)
        scope.value[x] = v_copy
        v_copy._this = scope
        v_copy.parent = scope
      }
    } else {
      this.saveVarInCurrentScope(scope, id, initVal, state)
    }

    if (initVal && !Array.isArray(initVal) && !(initVal.name || initVal.sid)) {
      initVal.sid = idName
      delete initVal.id
    }

    if (idName) scope.ast.setDecl(idName, id)

    const typeQualifiedName = AstUtil.typeToQualifiedName(node.varType)
    let declTypeVal
    if (typeQualifiedName) {
      declTypeVal = this.getMemberValue(scope, typeQualifiedName, state)
    }

    return initVal
  }

  /**
   * "left = right", "left *= right", etc.
   * @param scope
   * @param node
   * @param state
   */
  override processAssignmentExpression(scope: Scope, node: AssignmentExpression, state: State): any {
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
        if (node.cloned && !tmpVal?.runtime?.refCount) {
          tmpVal = lodashCloneWithTag(tmpVal)
          if (typeof tmpVal === 'object') {
            tmpVal.value = lodashCloneWithTag(tmpVal.value)
          }
        }
        const oldVal = this.processInstruction(scope, left, state)
        tmpVal = SourceLine.addSrcLineInfo(
          tmpVal,
          node,
          node.loc && node.loc.sourcefile,
          'Var Pass: ',
          left.type === 'TupleExpression' ? left.elements : (left as any).name || SymAddress.toStringID(left)
        )

        if (left.type === 'TupleExpression') {
          this.handleTupleAssign(scope, left, tmpVal, state)
        } else {
          if (!tmpVal) {
            tmpVal = new PrimitiveValue(scope.qid, 'undefined', null, null, 'Literal', right.loc)
          }
          if (typeof tmpVal !== 'object') {
            tmpVal = new PrimitiveValue(scope.qid, `<literal_${tmpVal}>`, tmpVal, null, 'Literal', right.loc)
          }
          const sid = SymAddress.toStringID(node.left)
          if (typeof tmpVal.sid === 'string' && tmpVal.sid.includes('<object')) {
            tmpVal.sid = sid
          }
          if (this.checkerManager && this.checkerManager.checkAtAssignment) {
            const lscope = this.getDefScope(scope, left)
            this.checkerManager.checkAtAssignment(this, scope, node, state, {
              lscope,
              lvalue: oldVal,
              rvalue: tmpVal,
              pcond: state.pcond,
              binfo: state.binfo,
              entry_fclos: this.entry_fclos,
              einfo: state.einfo,
              state,
              ainfo: this.ainfo,
            })
          }
          if (!(left as any).name && sid) {
            ;(left as any).name = sid
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
        const pyBinLeft = this.processInstruction(scope, node.left, state)
        const pyBinRight = this.processInstruction(scope, node.right, state)
        const val = new BinaryExprValue(
          scope.qid,
          node.operator.substring(0, node.operator.length - 1),
          pyBinLeft,
          pyBinRight,
          node,
          node.loc,
          true
        )
        if (node.cloned) {
          const clonedValue = lodashCloneWithTag(val.right!.value)
          val.right = lodashCloneWithTag(val.right)
          val.right!.value = clonedValue
        }
        const { left } = node
        const oldVal = this.getMemberValueNoCreate(scope, left, state)

        const hasTags = (val.left && val.left.taint?.isTaintedRec) || (val.right && val.right.taint?.isTaintedRec)
        if (hasTags) val.taint?.mergeFrom([val.left, val.right])

        this.saveVarInScope(scope, node.left, val, state)

        if (this.checkerManager && this.checkerManager.checkAtAssignment) {
          const lscope = this.getDefScope(scope, node.left)
          this.checkerManager.checkAtAssignment(this, scope, node, state, {
            lscope,
            lvalue: oldVal,
            rvalue: val,
            pcond: state.pcond,
            binfo: state.binfo,
            entry_fclos: this.entry_fclos,
            einfo: state.einfo,
            state,
            ainfo: this.ainfo,
          })
          // this.recordSideEffect(lscope, node.left, val.left);
        }
        return val
      }
    }
    return new SymbolValue(scope.qid, { sid: '<assignment>', ast: node })
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
      if (rightVal.isTuple) {
        // 直接 tuple：按索引 1-to-1 拆分
        const minLen = Math.min(left.elements.length, rightVal.value.length)
        for (let i = 0; i < minLen; i++) {
          this.saveVarInScope(scope, left.elements[i], rightVal.value[i], state)
        }
      } else {
        // union-of-returns：每个元素可能是 tuple 或单值，按位置提取后合并
        const leftCount = left.elements.length
        const perPos: any[][] = Array.from({ length: leftCount }, () => [])
        for (const elem of rightVal.value) {
          if (elem && elem.isTuple && elem.vtype === 'union') {
            // 某个 return 分支的 tuple，按位置提取
            for (let j = 0; j < leftCount; j++) {
              perPos[j].push(j < elem.value.length ? elem.value[j] : elem)
            }
          } else {
            // 非 tuple 值（单值 return），保守分配到所有位置
            for (let j = 0; j < leftCount; j++) {
              perPos[j].push(elem)
            }
          }
        }
        for (let i = 0; i < leftCount; i++) {
          const union = unionAllValues(perPos[i], state)
          this.saveVarInScope(scope, left.elements[i], union, state)
        }
      }
    } else if (Array.isArray(rightVal.value) && rightVal.value.length >= 1) {
      const minLen = Math.min(left.elements.length, rightVal.value.length)
      for (let i = 0; i < minLen; i++) {
        this.saveVarInScope(scope, left.elements[i], rightVal.value[i], state)
      }
    } else if (isSequentialNumericKeysMembers(rightVal)) {
      const minLen = Math.min(left.elements.length, rightVal.members.size)
      for (let i = 0; i < minLen; i++) {
        this.saveVarInScope(scope, left.elements[i], rightVal.members.get(String(i)), state)
      }
    } else {
      for (const i in left.elements) this.saveVarInScope(scope, left.elements[i], rightVal, state)
    }

    /**
     *
     * @param obj
     */
    function isSequentialNumericKeysMembers(obj: any) {
      if (!obj?.members || obj.members.size === 0) return false
      const keys = [...obj.members.keys()]
      const numericKeys = keys.map((k: string) => Number(k))
      if (numericKeys.some(isNaN)) return false
      numericKeys.sort((a: number, b: number) => a - b)
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
   */
  addASTInfo(ast: any, source: any, filename: any) {
    const { options } = this
    options.sourcefile = filename
    AstUtil.annotateAST(ast, options ? { sourcefile: filename } : null)
    // sourceCodeCache 已在 parseSingleFile/parseProject 中自动填充，或在调用 addASTInfo 之前已填充
    // 不需要在这里再次赋值
  }

  /**
   *
   * @param scope
   * @param importName
   * @param fname
   */
  loadPredefinedModule(scope: any, importName: any, fname: any) {
    let m = this.topScope.context.modules.members.get(fname)
    if (m && typeof m === 'object') {
      const fields = m.value
      if (_.has(fields, importName)) {
        return fields[importName]
      }
    } else {
      m = new SymbolValue(this.topScope.qid, { sid: fname, qid: fname, parent: this.topScope })
    }
    const objval = new SymbolValue(m.qid, {
      sid: `${importName}`,
      parent: m,
      node_module: true,
    })
    m.setFieldValue(importName, objval)
    this.topScope.context.modules.members.set(fname, m)
    return objval
  }

  /**
   *
   * @param ast
   * @param filename
   */
  preloadFileToPackage(ast: any, filename: any) {
    // 已缓存则跳过，避免 __init__.py 被反复处理
    if (this.topScope.context.modules.members.has(filename)) {
      return this.topScope.context.modules.members.get(filename)
    }

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
    const packageScope = this.topScope.context.packages.getSubPackage(packageName, true)
    if (path.basename(filename) === '__init__.py') {
      // 先注册到 members 再处理，防止递归 import 重复触发 processModuleDirect
      this.topScope.context.modules.members.set(filename, packageScope)
      this.fileManager[filename] = { uuid: packageScope.uuid, astNode: packageScope.ast.node }
      const m = this.processModuleDirect(ast, filename, packageScope)
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
  override preProcessClassDefinition(scope: any, cdef: any, state: any) {
    if (!(cdef && cdef.body)) return new UndefinedValue()

    const fname = cdef.id?.name

    const cscope = ScopeClass.createSubScope(fname, scope, 'class')
    cscope.ast = cdef
    cscope.ast.cdef = cdef
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
      if (!obj[key]) {
        continue
      }
      if (blacklist.includes(obj[key].qid)) {
        obj[key].taint.sanitize()
        obj[key].value = {}
      } else if (obj[key].vtype === 'symbol' && blacklist.includes(obj[key].sid)) {
        obj[key].taint.sanitize()
        obj[key].value = {}
      }
    }
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
      if (fclos?.id === superId?.name) {
        return
      }
      const superClos = this.processInstruction(scope, superId, state)
      if (!superClos) return new UndefinedValue()
      fclos.super = superClos

      const superValue = fclos.value.super || ScopeClass.createSubScope('super', fclos, 'fclos')
      superValue.parent = superClos
      for (const fieldName in superClos.value) {
        if (fieldName === 'super') continue
        const v = superClos.value[fieldName]
        if (v.runtime?.readonly) continue
        const v_copy = lodashCloneWithTag(v)
        if (!v_copy.func) v_copy.func = {}
        v_copy.func.inherited = true
        v_copy._this = fclos
        v_copy._base = superClos
        fclos.value[fieldName] = v_copy

        superValue.value[fieldName] = v_copy
        if (fieldName === '_CTOR_') {
          superValue.ast.node = v_copy.ast.fdef
          superValue.ast.fdef = v_copy.ast.fdef
          if (!superValue.overloaded) {
            superValue.overloaded = new AstRefList(() => superValue.getASTManager())
          }
          superValue.overloaded.push(fdef)
        }
      }

      for (const x of superClos.ast.declKeys) {
        const v = superClos.ast.getDecl(x)
        fclos.ast.setDecl(x, v)
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
   */
  async scanModules(dir: any) {
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
    // 构建规范化文件路径集合，用于 O(1) 查找
    this._normalizedFileSet = new Set<string>(this.fileList.map((f: string) => path.normalize(f)))
    if (modules.length === 0) {
      handleException(
        null,
        'find no target compileUnit of the project : no python file found in source path',
        'find no target compileUnit of the project : no python file found in source path'
      )
      process.exitCode = ErrorCode.no_valid_source_file
      return
    }

    // 预先填充 sourceCodeCache，避免 parseProject 中的 postProcessProjectResult 重复读取
    for (const mod of modules) {
      this.sourceCodeCache.set(mod.file, mod.content.split(/\n/))
    }

    this.performanceTracker.start('preProcess.parseCode')
    this.pyAstParseManager = await Parser.parseProject(dir, options, this.sourceCodeCache)
    this.performanceTracker.end('preProcess.parseCode')

    this.performanceTracker.start('preProcess.preload')
    for (const mod of modules) {
      const filename = mod.file
      const ast = this.pyAstParseManager[filename]
      if (ast) {
        this.addASTInfo(ast, mod.content, mod.file)
      }
    }
    this.performanceTracker.end('preProcess.preload')

    // 开始 ProcessModule 阶段：处理所有模块（分析 AST）
    this.performanceTracker.start('preProcess.processModule')
    for (let i = 0; i < modules.length; i++) {
      const mod = modules[i]
      const filename = mod.file
      const ast = this.pyAstParseManager[filename]
      if (ast) {
        this.processModule(ast, filename)
      }
      // 每个文件处理完后触发 checker 回调，用于逐步解析 pending 的 include()
      if (this.checkerManager && this.checkerManager.checkAtEndOfCompileUnit) {
        this.checkerManager.checkAtEndOfCompileUnit(this, null, null, null, null)
      }
    }
    this.performanceTracker.end('preProcess.processModule')
  }

  /**
   * 判断 fclos 是否有 @classmethod 装饰器
   * @param fclos
   */
  hasClassmethodDecorator(fclos: any): boolean {
    const decorators = fclos.fdef?._meta?.decorators || fclos.ast?._meta?.decorators
    if (!Array.isArray(decorators)) return false
    return decorators.some(
      (d: any) =>
        (d.type === 'Identifier' && d.name === 'classmethod') ||
        (d.type === 'MemberAccess' && d.property?.name === 'classmethod')
    )
  }

  /**
   * 从 classmethod 的 fclos 解析出所属的 class 对象
   * @param fclos
   */
  resolveClassForClassmethod(fclos: any): any {
    const thisObj = fclos._this
    if (!thisObj) return null
    if (thisObj.vtype === 'class') return thisObj
    if (thisObj._this?.vtype === 'class') return thisObj._this
    if (thisObj.cdef) return thisObj.cdef
    return thisObj
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
