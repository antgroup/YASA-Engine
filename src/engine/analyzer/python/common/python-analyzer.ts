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
import type { Analyzer as AnalyzerType } from '../../common/analyzer'
import type { Logger } from '../../../../util/logger'
import type { CallArgs, CallArg, CallArgKind, CallInfo } from '../../common/call-args'
import { dispatchPythonCallbackApiModel, handlePythonFrameworkCall } from '../framework-call-model'
import { pythonCallSummaryPolicy } from '../../common/call-summary/language/python'
import type { CallSummaryLanguagePolicy } from '../../common/call-summary/language/types'
import { INTERNAL_CALL } from '../../common/call-args'
import type {
  ScopedStatement,
  CompileUnit,
  CallExpression,
  BinaryExpression,
  MemberAccess,
  NewExpression,
  ReturnStatement,
  TryStatement,
  VariableDeclaration,
  AssignmentExpression,
  SpreadElement,
} from '../../../../types/uast'
import {
  createMemoryGuardState,
  resetForEntryPoint,
  probeMemoryAndUpdate,
  flushFindingsToReport,
  getEntryPointHeapDeltaMb,
  type MemoryGuardState,
} from '../../common/memory-guard/entrypoint-memory-guard'
import { describeEntryPointForLog } from '../../../../util/entrypoint-metrics'

const Uuid = require('node-uuid')
const globby = require('fast-glob')
const _ = require('lodash')
const path = require('path')
const UastSpec = require('@ant-yasa/uast-spec')
const { lodashCloneWithTag } = require('../../../../util/clone-util')

const Analyzer: typeof AnalyzerType = require('../../common/analyzer')
const CheckerManager = require('../../common/checker-manager')
const BasicRuleHandler = require('../../../../checker/common/rules-basic-handler')
const Parser = require('../../../parser/parser')
const {
  ValueUtil: { Scoped, PrimitiveValue, UndefinedValue, UnionValue, SymbolValue, VoidValue },
} = require('../../../util/value-util')
const logger: Logger = require('../../../../util/logger')(__filename)
const Config = require('../../../../config')
const { ErrorCode } = require('../../../../util/error-code')
const { assembleFullPath } = require('../../../../util/file-util')
const { addElementToBuffer } = require('../../java/common/builtins/buffer')
const SourceLine = require('../../common/source-line')
const ScopeClass = require('../../common/scope')
const { resetCrossCallVisited } = require('../../common/cross-call-visited')
const { unionAllValues } = require('../../common/memStateBVT')
const AstUtil = require('../../../../util/ast-util')
const Stat = require('../../../../util/statistics')
const constValue = require('../../../../util/constant')
const entryPointConfig = require('../../common/entrypoint/current-entrypoint')
const { executeViaEntryPointExecutor } = require('../../common/entrypoint/entrypoint-executor') as typeof import('../../common/entrypoint/entrypoint-executor')
const FileUtil = require('../../../../util/file-util')
const { getSourceNameList } = require('./entrypoint-collector/python-entrypoint')
const { handleException } = require('../../common/exception-handler')
const { filterDataFromScope } = require('../../../../util/common-util')
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
  protected override readonly callSummaryLanguagePolicy: CallSummaryLanguagePolicy = pythonCallSummaryPolicy

  /**
   * 单入口内存护栏状态。
   *
   * 防护机制：每入口开始前 reset（记录基线 heap），processInstruction/executeCall 边界
   * 节流探测 heapUsed，超阈设 exceeded=true 让本入口内后续指令提前返回 UndefinedValue。
   * 入口结束后若 exceeded=true，flush 已分析入口 finding 到 report.sarif 并记录 diagnostics。
   * 不改 clone 逻辑，零污染风险。
   */
  protected override memoryGuardState: MemoryGuardState | undefined = createMemoryGuardState()

  /**
   * 内存护栏 abort 计数与 flush 计数，输出到 stdout 用于 PoC 校验。
   */
  private memoryGuardAbortCount: number = 0
  private memoryGuardFlushCount: number = 0

  /**
   * 单入口内存护栏 hook：节流探测 heapUsed，超阈置 exceeded 提前退出本入口。
   */
  protected override shouldAbortExecutionForMemory(_state: State): boolean {
    const state = this.memoryGuardState
    if (!state || !state.enabled) return false
    return probeMemoryAndUpdate(state)
  }

  /**
   * 入口开始前重置护栏状态。
   */
  protected override resetMemoryGuardForEntryPoint(entryPointLabel: string): void {
    const state = this.memoryGuardState
    if (!state || !state.enabled) return
    resetForEntryPoint(state, entryPointLabel)
    // Step A：每入口开始重置跨调用 visited memo，避免跨入口污染（卡点 A 完全失败）。
    resetCrossCallVisited()
  }

  /**
   * 入口结束处理护栏：若 exceeded=true 则 flush 当前 resultManager finding 到 report.sarif，
   * 记录 diagnostics（入口名/峰值/已 flush finding 数），返回 abort 信息供上层 metrics。
   */
  protected override onEntryPointMemoryGuardFinalize(entryPoint: unknown, findingsBefore: number): {
    aborted: boolean
    peakHeapMb: number
    deltaHeapMb: number
  } {
    const state = this.memoryGuardState
    if (!state || !state.enabled) {
      return { aborted: false, peakHeapMb: 0, deltaHeapMb: 0 }
    }
    const deltaInfo = getEntryPointHeapDeltaMb(state)
    if (!state.exceeded) {
      return { aborted: false, peakHeapMb: deltaInfo.peakMb, deltaHeapMb: deltaInfo.deltaMb }
    }
    this.memoryGuardAbortCount++
    // flush 当前已分析入口的 finding 到 report.sarif（全量覆盖写，不 clear resultManager）
    const resultManager = this.checkerManager?.getResultManager?.()
    const findingsAtFlush = flushFindingsToReport(resultManager ?? null, Config)
    state.cumulativeFlushedFindings = findingsAtFlush
    this.memoryGuardFlushCount++
    // abort 后释放本入口累积的 clone 副本：清 tmpSymbolTable 持有的临时注册项 + 强制 gc，
    // 否则 7GB+ clone 副本留在 tmpSymbolMap 跨入口累积，后续入口一进来就超阈被立刻 abort
    const tmpBefore = (this as any).tmpSymbolTable ? (this as any).tmpSymbolTable.size : -1
    try {
      if ((this as any).tmpSymbolTable && typeof (this as any).tmpSymbolTable.clear === 'function') {
        ;(this as any).tmpSymbolTable.clear()
      }
    } catch (e) { /* 清理失败不影响下一入口 */ }
    const gcFn = (globalThis as any).gc
    if (typeof gcFn === 'function') {
      try { gcFn() } catch (e) { /* --expose-gc 未启时无 gc，忽略 */ }
    }
    const heapAfterGc = process.memoryUsage().heapUsed
    logger.warn(
      `[memory-guard] entrypoint aborted: ${state.entryPointLabel} peak=${deltaInfo.peakMb.toFixed(1)}MB ` +
      `delta=${deltaInfo.deltaMb.toFixed(1)}MB limit=${state.limitMb}MB ` +
      `flushedFindings=${findingsAtFlush} cumulativeAborts=${this.memoryGuardAbortCount} ` +
      `cumulativeFlushes=${this.memoryGuardFlushCount} findingsBefore=${findingsBefore} ` +
      `tmpBefore=${tmpBefore} heapAfterGcMb=${(heapAfterGc / 1024 / 1024).toFixed(1)}`
    )
    return { aborted: true, peakHeapMb: deltaInfo.peakMb, deltaHeapMb: deltaInfo.deltaMb }
  }

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
    this.crossCallVisitedEnabled = true
    this.enableNestedSourceLineIsolation = true
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
  async symbolInterpret(): Promise<boolean> {
    const { entryPoints } = this as { entryPoints?: unknown[] }
    const state = this.initState(this.topScope)

    if (_.isEmpty(entryPoints)) {
      logger.info('[symbolInterpret]：EntryPoints are not found')
      return true
    }
    const hasAnalysised = new Set<string>()
    let epIdx = 0
    for (const entryPoint of entryPoints ?? []) {
      epIdx++
      const metricStartTime = Date.now()
      const findingsBefore = this.countFindings()
      let skipped = false
      let skipReason: string | undefined
      let overloadCount = 0
      // 单入口内存护栏 reset：每入口开始前记录基线 heap，清 exceeded
      const epLabel = describeEntryPointForLog(entryPoint).replace(/^\[|\]$/g, '')
      this.resetMemoryGuardForEntryPoint(epLabel)
      let memoryAborted = false
      try {
        this.symbolTable.clear()
        const entryPointRecord = entryPoint as Record<string, unknown>
        if (entryPointRecord.type === constValue.ENGIN_START_FUNCALL) {
          const entryPointSymVal = entryPointRecord.entryPointSymVal as
            | { qid?: unknown; ast?: { node?: { parameters?: unknown; loc?: unknown } } }
            | undefined
          const legacyAnalysisKey = `python-function:${entryPointRecord.filePath}.${entryPointRecord.functionName}/${entryPointSymVal?.qid}#${entryPointSymVal?.ast?.node?.parameters}.${entryPointRecord.attribute}`
          if (hasAnalysised.has(legacyAnalysisKey)) {
            skipped = true
            skipReason = 'duplicate-function-entrypoint'
            continue
          }
          hasAnalysised.add(legacyAnalysisKey)
          const entryPointMark = this.markEntryPointForAnalysis(entryPoint, hasAnalysised)
          if (entryPointMark.skipped) {
            skipped = true
            skipReason = entryPointMark.skipReason
            continue
          }
          entryPointConfig.setCurrentEntryPoint(entryPoint)

          let executedOverloads = 0
          executeViaEntryPointExecutor(
            {
              analyzer: this,
              entryPoint,
              metricStartTime,
              findingsBefore,
              executionState: state,
              overloadCount,
              epIndex: epIdx,
              epTotal: (entryPoints ?? []).length,
            },
            {
              language: 'python',
              classify: () => 'function',
              execute: () => {
                this.executeCallEntryPoint(entryPoint, entryPointSymVal?.ast?.node, state)
                executedOverloads++
                const overloadedList = this.getOverloadedEntryPoints(entryPoint)
                for (const overloadFuncDef of overloadedList.length <= 1 ? [] : overloadedList) {
                  const tmpVal = _.clone(entryPoint)
                  tmpVal.entryPointSymVal = lodashCloneWithTag(entryPointSymVal)
                  const clonedDef = _.clone(overloadFuncDef)
                  tmpVal.entryPointSymVal.ast.fdef = clonedDef
                  tmpVal.entryPointSymVal.ast = clonedDef
                  this.executeCallEntryPoint(tmpVal, overloadFuncDef, state)
                  executedOverloads++
                }
              },
            },
            this.checkerManager?.resultManagerProxy,
          )
          overloadCount += executedOverloads
        } else if (entryPointRecord.type === constValue.ENGIN_START_FILE_BEGIN) {
          const legacyAnalysisKey = `python-file:${entryPointRecord.filePath}.${entryPointRecord.attribute}`
          if (hasAnalysised.has(legacyAnalysisKey)) {
            skipped = true
            skipReason = 'duplicate-file-entrypoint'
            continue
          }
          hasAnalysised.add(legacyAnalysisKey)
          const entryPointMark = this.markEntryPointForAnalysis(entryPoint, hasAnalysised)
          if (entryPointMark.skipped) {
            skipped = true
            skipReason = entryPointMark.skipReason
            continue
          }
          entryPointConfig.setCurrentEntryPoint(entryPoint)
          const fileFullPath = assembleFullPath(entryPointRecord.filePath, Config.maindir)
          const sourceNameList = getSourceNameList()
          this.refreshCtx(this.topScope.context.modules.members.get(fileFullPath)?.value, sourceNameList)
          this.refreshCtx(this.symbolTable.get(this.topScope.context.files[fileFullPath])?.value, sourceNameList)
          this.refreshCtx(this.topScope.context.packages.members.get(fileFullPath), sourceNameList)

          const filePath = typeof entryPointRecord.filePath === 'string' ? entryPointRecord.filePath : undefined
          const scope = filePath ? this.topScope.context.modules.members.get(filePath) : undefined
          if (!scope) {
            skipped = true
            skipReason = 'missing-file-scope'
            continue
          }
          overloadCount = 1
          try {
            const astNode = (entryPointRecord.entryPointSymVal as { ast?: { node?: CompileUnit } } | undefined)?.ast?.node
            if (!astNode) {
              skipped = true
              skipReason = 'missing-file-ast'
              continue
            }
            executeViaEntryPointExecutor(
              {
                analyzer: this,
                entryPoint,
                metricStartTime,
                findingsBefore,
                executionState: state,
                overloadCount,
                epIndex: epIdx,
                epTotal: (entryPoints ?? []).length,
              },
              {
                language: 'python',
                classify: () => 'file',
                execute: () => {
                  this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)
                  this.processCompileUnit(scope, astNode, state)
                  this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
                },
              },
              this.checkerManager?.resultManagerProxy,
            )
          } catch (e) {
            const sourceFile = (entryPointRecord.entryPointSymVal as
              | { ast?: { node?: { loc?: { sourcefile?: unknown } } } }
              | undefined)?.ast?.node?.loc?.sourcefile
            handleException(
              e,
              `[${sourceFile} symbolInterpret failed. Exception message saved in error log file`,
              `[${sourceFile} symbolInterpret failed. Exception message saved in error log file`
            )
          }
        } else {
          skipped = true
          skipReason = 'unsupported-entrypoint-type'
        }
      } finally {
        // 单入口内存护栏 finalize：若本入口 exceeded，flush 已分析 finding 并记 diagnostics
        const guardResult = this.onEntryPointMemoryGuardFinalize(entryPoint, findingsBefore)
        if (guardResult.aborted) {
          memoryAborted = true
          if (!skipped) {
            skipped = true
            skipReason = `memory-guard-heap-exceeded:peak=${guardResult.peakHeapMb.toFixed(1)}MB,delta=${guardResult.deltaHeapMb.toFixed(1)}MB`
          }
        }
        this.recordEntryPointLoopMetric(entryPoint, metricStartTime, findingsBefore, skipped, skipReason, overloadCount)
        if (memoryAborted) {
          logger.warn(
            `[memory-guard] entrypoint ${epIdx}/${entryPoints?.length ?? 0} skipped due to memory guard: ${epLabel}`
          )
        }
      }
    }
    return true
  }

  private getOverloadedEntryPoints(entryPoint: unknown): unknown[] {
    const entryPointRecord = entryPoint as { entryPointSymVal?: { overloaded?: unknown } }
    const overloaded = entryPointRecord.entryPointSymVal?.overloaded
    return Array.isArray(overloaded) ? overloaded : []
  }

  /**
   *
   * @param entryPoint
   * @param ast
   * @param state
   */
  executeCallEntryPoint(entryPoint: any, ast: any, state: any) {
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
      // 入口点方法若被自定义装饰器包裹（如 Tornado handler 的 @error_catch），
      // executeCallWithDecorators 会执行 wrapper 函数体而非原始方法体，
      // 导致 wrapper 内闭包调用 method(self, *args, **kwargs) 无法解析到原始函数，
      // self.request.body 的 triggerAtMemberAccess 从未触发 → 0 Sources。
      // 解决：skipDecorators 标记的入口点执行前剥离装饰器，直接执行原始方法体。
      let entryFclos = entryPoint.entryPointSymVal
      if (entryPoint.skipDecorators && entryFclos?.decorators?.length > 0) {
        entryFclos = lodashCloneWithTag(entryFclos)
        entryFclos.decorators = []
      }
      this.executeCall(ast, entryFclos, state, entryFclos?.parent, {
        callArgs: this.buildCallArgs(ast, argValues, entryFclos),
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

    const argvalues: Value[] = []
    // 参数按原始顺序处理，由 buildPythonCallArgs 标记 kind，bindCallArgs 负责绑定
    const collectedArgs = node.arguments

    for (const arg of collectedArgs) {
      const argv = this.processInstruction(scope, arg, state)
      if (logger.isTraceEnabled()) logger.trace(`arg: ${this.formatScope(argv)}`)
      if (Array.isArray(argv)) argvalues.push(...argv)
      else argvalues.push(argv)
    }

    // 构建结构化 callInfo，携带 keyword/spread/kwspread 信息
    const callInfo: CallInfo = {
      callArgs: this.buildPythonCallArgs(collectedArgs, argvalues, fclos, node),
      callsiteNode: node,
    }
    callInfo.callArgs!.node = node

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

    return this.processPythonCallExpressionDirect(scope, node, state, fclos, argvalues, callInfo) ?? new UndefinedValue()
  }

  executeCallbackModelCall(node: CallExpression, fclos: Value, state: State, scope: Scope, callInfo: CallInfo): boolean {
    const callbackState = { ...state, throwstack: undefined, throwstackScopeAndState: [] } as State
    try {
      this.executeCall(node, fclos, callbackState, scope, callInfo)
    } catch {
      return false
    }
    return callbackState.throwstackScopeAndState?.length === 0 && callbackState.throwstack === undefined
  }

  private processPythonCallExpressionDirect(
    scope: Scope,
    node: CallExpression,
    state: State,
    fclos: Value,
    argvalues: Value[],
    callInfo: CallInfo
  ): Value | undefined {
    const collectedArgs = node.arguments

    // union callee 含 class 成员：拆出 class 走 propagateNewObject，其余交给 executeCall
    if (fclos.vtype === 'union' && Array.isArray(fclos.value)) {
      const classMembers = fclos.value.filter((m: Value | undefined) => m && typeof m === 'object' && m.vtype === 'class')
      if (classMembers.length > 0) {
        const results: Value[] = []
        for (const member of classMembers) {
          const signatureAst = member.members?.get('_CTOR_')?.fdef || member.fdef || member.ast
          if (signatureAst?.type === 'FunctionDefinition') {
            callInfo.boundCall = this.bindCallArgs(node, member, signatureAst, callInfo)
          }
          const r = this.executeWithSummary(
            scope,
            fclos,
            callInfo,
            state,
            () => this.propagateNewObject(scope, node, state, member, argvalues, callInfo),
            { getReplayValue: () => undefined }
          )
          if (r) {
            results.push(r)
          }
        }
        // 非 class 成员通过 executeCall 的 union 处理（已内置 checkAtFunctionCallAfter）
        const nonClassMembers = fclos.value.filter((m: Value | undefined) => !m || typeof m !== 'object' || m.vtype !== 'class')
        if (nonClassMembers.length > 0) {
          for (const member of nonClassMembers) {
            if (!member || typeof member !== 'object') continue
            const r = this.executeWithSummary(
              scope,
              fclos,
              callInfo,
              state,
              () => this.executeCall(node, member, state, scope, callInfo),
              { getReplayValue: () => undefined }
            )
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
      const res = this.executeWithSummary(
        scope,
        fclos,
        callInfo,
        state,
        () => this.propagateNewObject(scope, node, state, fclos, argvalues, callInfo),
        { getReplayValue: () => undefined }
      )
      return res
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
    const res = this.executeWithSummary(
      scope,
      fclos,
      callInfo,
      state,
      () => this.executeCall(node, fclos, state, scope, callInfo),
      { getReplayValue: () => undefined }
    )

    const callbackModelHandled = dispatchPythonCallbackApiModel({
      analyzer: this,
      scope,
      node,
      state,
      fclos,
      res,
      argvalues,
      callInfo,
      collectedArgs,
    })

    if (fclos.vtype !== 'fclos' && Config.invokeCallbackOnUnknownFunction && !callbackModelHandled) {
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

    // MemberAccess 调用：receiver 有污点但返回值无污点时，传播 receiver taint 到返回值
    // 解决 executeSingleCall 不传播 receiver taint 的问题（如 dict.get() 返回值丢失污点）
    if (res && node.callee?.type === 'MemberAccess' && !res?.taint?.isTaintedRec) {
      const receiver = fclos?._this
      if (receiver?.taint?.isTaintedRec) {
        res.taint.mergeFrom([receiver])
        addElementToBuffer(res, receiver)
      }
    }

    handlePythonFrameworkCall({
      analyzer: this,
      scope,
      node,
      state,
      fclos,
      res,
      argvalues,
      callInfo,
      collectedArgs,
    })



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
    if (fclos.ast?.cdef) {
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
    let res = this.getMemberValue(defscope, resolved_prop, state)
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
   * Python 专属 SINGLE-UNROLL：iter1 后比对 scope 变量状态，有变化才跑 iter2。
   * 避免无条件 unroll-2 在大项目 OOM，同时保留回边累积污点的传播能力。
   * ITER-CONCRETE 分支（具体可枚举迭代体）逐元素行为完全保留。
   * 仅 Python override，避免 Go/Java MemberExpr 链式访问在第二轮 body 重入触发栈爆。
   */
  override processRangeStatement(scope: Scope, node: any, state: State): any {
    const { key, value, right, body } = node
    scope = ScopeClass.createSubScope(
      `<block_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}>`,
      scope
    )
    const rightVal = this.processInstruction(scope, right, state)
    if (
      !Array.isArray(rightVal) &&
      ((this as any).inRange ||
        rightVal?.vtype === 'primitive' ||
        Object.keys(rightVal.getRawValue()).filter((k: string) => !k.startsWith('__yasa')).length === 0 ||
        rightVal?.vtype === 'union')
    ) {
      if (value) {
        if (value.type === 'VariableDeclaration') {
          this.saveVarInCurrentScope(scope, value.id, rightVal, state)
        } else if (value.type === 'TupleExpression') {
          for (const ele of value.elements) {
            this.saveVarInCurrentScope(scope, ele.name, rightVal, state)
          }
        } else {
          this.saveVarInScope(scope, value, rightVal, state)
        }
      }
      if (key) {
        this.saveVarInScope(scope, key, rightVal, state)
      }
      const snapBefore = PythonAnalyzer.snapshotScopeStates(scope)
      const findingsBefore = this.countFindings()
      this.processInstruction(scope, body, state)
      const snapAfter = PythonAnalyzer.snapshotScopeStates(scope)
      const findingsAfter = this.countFindings()
      // 增量门控：iter1 已命中 sink → 跳过 iter2 避免重复 hop；iter1 未命中 sink 且状态变化 → 进 iter2 让回边累积污点被 sink 看见
      if (findingsAfter === findingsBefore && PythonAnalyzer.diffSnapshots(snapBefore, snapAfter)) {
        this.processInstruction(scope, body, state)
      }
    } else {
      ;(this as any).inRange = true
      if ((this as any).isNullLiteral(rightVal)) {
        ;(this as any).inRange = false
        return undefined as any
      }
      const itr = (this as any).getValueIterator(rightVal, filterDataFromScope)
      let countLimit = 30
      for (let { value: field, done } = itr.next(); !done; { value: field, done } = itr.next()) {
        if (countLimit-- === 0) break
        if (!field) continue
        let { k, v } = field
        if (key) {
          if (key.type === 'VariableDeclaration') {
            this.saveVarInCurrentScope(scope, key.id, k, state)
          } else {
            if (_.isString(k)) k = new PrimitiveValue(scope.qid, k, k, null, key.type, key.loc, key)
            this.saveVarInCurrentScope(scope, key, k, state)
          }
        }
        if (value) {
          if (value.type === 'VariableDeclaration') {
            this.saveVarInCurrentScope(scope, value.id, v, state)
          } else if (value.type === 'TupleExpression') {
            for (let i = 0; i < value.elements.length; i++) {
              const eleVal = v?.members?.get(String(i)) ?? v
              this.saveVarInCurrentScope(scope, value.elements[i].name, eleVal, state)
            }
          } else {
            this.saveVarInCurrentScope(scope, value, v, state)
          }
        }
        this.processInstruction(scope, body, state)
      }
      ;(this as any).inRange = false
    }
    return new VoidValue()
  }

  /**
   * scope 自身变量的 (vtype, taint tags, isTaintedRec) 轻量快照。
   * 仅看 scope.value 一层（不递归 enclosing scope），覆盖 SINGLE-UNROLL 分支内
   * body 直接修改的局部变量（key/value 形参 + body 内赋值）。
   * 跳过子作用域条目（vtype=scope/class 或 key 以 <block_ 开头），
   * 因为 createSubScope 产生的 Scoped/ClassValue 是结构性产物不属于语义变量状态变化，
   * 误纳入 diff 会导致 iter2 被无条件触发（子作用域在 body 首次执行时必然创建）。
   */
  static snapshotScopeStates(scope: any): Map<string, { vtype: string; tags: string[]; tr: boolean }> {
    const m = new Map<string, { vtype: string; tags: string[]; tr: boolean }>()
    if (!scope?.value || typeof scope.value !== 'object') return m
    for (const k of Object.keys(scope.value)) {
      const v = (scope.value as any)[k]
      if (!v || typeof v !== 'object') continue
      // 跳过子作用域：createSubScope 产生的 Scoped/ClassValue 不参与变量状态 diff
      if (v.vtype === 'scope' || v.vtype === 'class') continue
      if (k.startsWith('<block_')) continue
      const tags: string[] = typeof v?._taint?.getTags === 'function' ? v._taint.getTags() : []
      const tr = !!v?._taint?.isTaintedRec
      const vtype = typeof v?.vtype === 'string' ? v.vtype : 'unknown'
      m.set(k, { vtype, tags, tr })
    }
    return m
  }

  /**
   * 比对前后两个 scope 状态快照，任意 (新增 / 删除 / vtype 变 / tags 集合变 / isTaintedRec 变)
   * 视为状态变化。tags 比较忽略顺序。
   */
  static diffSnapshots(
    a: Map<string, { vtype: string; tags: string[]; tr: boolean }>,
    b: Map<string, { vtype: string; tags: string[]; tr: boolean }>
  ): boolean {
    if (a.size !== b.size) return true
    for (const [k, sa] of a) {
      const sb = b.get(k)
      if (!sb) return true
      if (sa.vtype !== sb.vtype) return true
      if (sa.tr !== sb.tr) return true
      if (sa.tags.length !== sb.tags.length) return true
      // tags 集合比较（忽略顺序）
      const setB = new Set(sb.tags)
      for (const t of sa.tags) if (!setB.has(t)) return true
    }
    for (const k of b.keys()) if (!a.has(k)) return true
    return false
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
      // 用 ast（CompileUnit）而非 packageScope.ast.node：getSubPackage 可能返回
      // 被同名函数 scope 污染的 PackageValue，其 ast.node 可能是 FunctionDefinition
      this.fileManager[filename] = { uuid: packageScope.uuid, astNode: ast }
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
      ['**/*.(py)', '.claude/skills/**/*.py', '.codex/skills/**/*.py', '.codefuse/skills/**/*.py', '.skills/**/*.py', '!**/.venv/**', '!**/vendor/**', '!**/node_modules/**', '!**/site-packages/**'],
      dir
    )
    this.fileList = globby
      .sync(['**/*.(py)', '.claude/skills/**/*.py', '.codex/skills/**/*.py', '.codefuse/skills/**/*.py', '.skills/**/*.py', '!**/.venv/**', '!**/vendor/**', '!**/node_modules/**', '!**/site-packages/**'], {
        cwd: dir,
        caseSensitiveMatch: false,
        dot: true,
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
    for (const mod of modules) {
      if (this.pyAstParseManager[mod.file]) continue
      const ast = Parser.parseSingleFile(mod.file, { ...options, sourcefile: mod.file }, this.sourceCodeCache)
      if (ast) {
        this.pyAstParseManager[mod.file] = ast
      }
    }
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
    this.callSummarySessions[0].beginForLanguage('Python'
    )
    try {
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
    } finally {
      this.callSummarySessions[0].finish()
      this.performanceTracker.end('preProcess.processModule')
    }
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

  /**
   * Python 装饰器路径下 params.forEach(processInstruction) 对 Parameter 类型无 handler，
   * 从不触发 SOURCE mark。此处对每个 param.id 显式触发 checkAtIdentifier，与 baseline
   * 直接 entrypoint 路径语义对齐；非 entrypoint 形参 sourceScope 无匹配 rule 不会误 mark。
   */
  protected override onParamsBound(fscope: any, params: any[], state: State, node: any): void {
    for (const param of params || []) {
      const pid = param?.id
      if (!pid?.name) continue
      const paramVal = this._getMemberValueDirect(fscope, pid, state, false, 0, new Set())
      if (!paramVal) continue
      const info = { res: paramVal }
      this.checkerManager?.checkAtIdentifier(this, fscope, pid, state, info)
      if (info.res && info.res !== paramVal) {
        this.saveVarInCurrentScope(fscope, pid, info.res, state)
      }
    }
  }

  /**
   * Python 专属：处理 `from X import *` 引入 outer fclos 后，同模块同名 `def` 覆盖 scope 导致
   * 装饰器 `@<name>` sid 反查命中本地 self-fclos 而非 outer（LEGB shadow）的形态。
   * Python 求值顺序：`from X import *` → 装饰器 `@name` 求值（读 scope[name]=outer） → `def name(): pass`（覆盖）。
   * PFD 静态扫描不按求值顺序，后来居上直接盖掉 outer，装饰器反查错路径。
   * 修复：本地 def 走超类注册逻辑完成后，把 scope[name] 还原为 import 来源，本地 def 改挂 `<localDef_${name}>`，
   * 让 EP 索引（按 ast.node.id.name 收集）仍能找到本体。仅当 existing 是不同源文件的 fclos 时触发。
   */
  createFuncScope(node: any, scope: any): any {
    const funcName: string | undefined = node?.id?.name
    if (!funcName || typeof funcName !== 'string') {
      return super.createFuncScope(node, scope)
    }
    const existing = scope?.value?.[funcName]
    const existingSrc: string | undefined =
      existing?.vtype === 'fclos' ? existing?.ast?.fdef?.loc?.sourcefile : undefined
    const nodeSrc: string | undefined = node?.loc?.sourcefile
    const isClassOverride = scope?.vtype === 'class'
    const isImportShadow = !isClassOverride && !!(existingSrc && nodeSrc && existingSrc !== nodeSrc)
    if (!isImportShadow) {
      return super.createFuncScope(node, scope)
    }
    const savedImport = existing
    delete scope.value[funcName]
    const localFclos = super.createFuncScope(node, scope)
    scope.value[funcName] = savedImport
    scope.value[`<localDef_${funcName}>`] = localFclos
    return localFclos
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
