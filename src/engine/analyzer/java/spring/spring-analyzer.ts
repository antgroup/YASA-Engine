import { FindingsCheckpointWriter, combineFindingsFinalizationErrors } from '../../common/findings-checkpoint'
import JavaInitializer from '../common/java-initializer'
import { INTERNAL_CALL } from '../../common/call-args'
import { UnionValue } from '../../common/value/union'
import type { Invocation } from '../../../../resolver/common/value/invocation'
import type { Scope, State, Value } from '../../../../types/analyzer'
import type { AstSourceLocation, EntryPoint as CommonEntryPoint } from '../../common/entrypoint/entrypoint'
import type {
  VariableDeclaration,
  FunctionDefinition,
  ClassDefinition,
  Expr,
  Stmt,
  Decl,
  AssignmentExpression,
  Literal,
  ScopedStatement,
  CallExpression,
  Identifier,
  MemberAccess,
  Node,
  RangeStatement,
  ConditionalExpression,
} from '../../../../types/uast'

const UastSpec = require('@ant-yasa/uast-spec')
const _ = require('lodash')
const fs: typeof import('fs') = require('fs')
const Config = require('../../../../config')
const logger = require('../../../../util/logger')(__filename)
const JavaAnalyzer: typeof import('../common/java-analyzer') = require('../common/java-analyzer')
const AstUtil = require('../../../../util/ast-util')
const Initializer = require('./spring-initializer')
const entryPointConfig = require('../../common/entrypoint/current-entrypoint')
const { executeViaEntryPointExecutor } =
  require('../../common/entrypoint/entrypoint-executor') as typeof import('../../common/entrypoint/entrypoint-executor')
const constValue = require('../../../../util/constant')
const { handleException } = require('../../common/exception-handler')
const FullCallGraphFileEntryPoint = require('../../../../checker/common/full-callgraph-file-entrypoint')
const Rules = require('../../../../checker/common/rules-basic-handler')
const { newInstance } = require('../common/builtins/object')
const { prettyPrint } = require('../../../../util/ast-util')
const {
  ValueUtil: { SymbolValue },
} = require('../../../util/value-util')
const QidUnifyUtil = require('../../../../util/qid-unify-util')
const { getLegacyArgValues } = require('../../common/call-args')
const { yasaLog } = require('../../../../util/format-util')
const { createDeadlinePlan, createTimeoutLatch, formatBudgetMs } = require('../../common/entrypoint/deadline-scheduler') as typeof import('../../common/entrypoint/deadline-scheduler')
const { runAllocatedAttempt } = require('../../common/entrypoint/attempt-runner') as typeof import('../../common/entrypoint/attempt-runner')
const { buildSpringConcreteWorklist, runSpringConcreteWorklist } =
  require('./spring-entrypoint-scheduler') as typeof import('./spring-entrypoint-scheduler')

type SpringEntryPointSymValLike = {
  qid?: string
  ast?: { node?: { parameters?: unknown; loc?: AstSourceLocation }; fdef?: FunctionDefinition }
  overloaded?: FunctionDefinition[]
  value?: Record<string, unknown>
}

type SpringEntryPointLike = Omit<CommonEntryPoint, 'entryPointSymVal' | 'scopeVal'> & {
  entryPointSymVal?: SpringEntryPointSymValLike
  scopeVal?: unknown
}

type SymbolValueType = ReturnType<typeof SymbolValue>

type UastMeta = {
  nodehash?: string
  modifiers?: string[]
}

type UastRecord = Record<string, unknown> & {
  type?: string
  _meta?: UastMeta
}

type ValueRefMapLike = {
  size?: number
  get(name: string): unknown
  has?(name: string): boolean
  set?(name: string, value: unknown): unknown
  entries?(): Array<[string, unknown]>
}

type FunctionClosureLike = {
  vtype: 'fclos'
  ast?: {
    fdef?: FunctionDefinition
    node?: FunctionDefinition
  }
  overloaded?: FunctionDefinition[]
  value?: Record<string, unknown>
  invocationMap?: Map<string, Invocation[]>
}

type ClassValueLike = {
  vtype: 'class'
  ast?: {
    node?: ClassDefinition
  }
  members?: ValueRefMapLike
  value?: Record<string, unknown>
  qid?: string
  logicalQid?: string
}

type SpringBeanLike = {
  className?: string
  isPrimary?: boolean
}

type CollectionCallsite = {
  call: CallExpression
  nodeHash: string
  interfaceName: string
}

/**
 *
 * @param value
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 *
 * @param value
 */
function isUastRecord(value: unknown): value is UastRecord {
  return isRecord(value)
}

/**
 *
 * @param value
 */
function isIdentifierNode(value: unknown): value is Identifier {
  return isUastRecord(value) && value.type === 'Identifier' && typeof value.name === 'string'
}

/**
 *
 * @param value
 */
function isVariableDeclarationNode(value: unknown): value is VariableDeclaration {
  return isUastRecord(value) && value.type === 'VariableDeclaration'
}

/**
 *
 * @param value
 */
function isVariableDeclarationWithIdentifier(value: unknown): value is VariableDeclaration & { id: Identifier } {
  return isVariableDeclarationNode(value) && isIdentifierNode(value.id)
}

/**
 *
 * @param value
 */
function isFunctionDefinitionNode(value: unknown): value is FunctionDefinition {
  return isUastRecord(value) && value.type === 'FunctionDefinition'
}

/**
 *
 * @param value
 */
function isRangeStatementNode(value: unknown): value is RangeStatement {
  return isUastRecord(value) && value.type === 'RangeStatement'
}

/**
 *
 * @param value
 */
function isConditionalExpressionNode(value: unknown): value is ConditionalExpression {
  return isUastRecord(value) && value.type === 'ConditionalExpression'
}

/**
 *
 * @param value
 */
function isMemberAccessNode(value: unknown): value is MemberAccess {
  return isUastRecord(value) && value.type === 'MemberAccess'
}

/**
 *
 * @param value
 */
function isCallExpressionNode(value: unknown): value is CallExpression {
  return isUastRecord(value) && value.type === 'CallExpression'
}

/**
 *
 * @param value
 */
function isFunctionClosureLike(value: unknown): value is FunctionClosureLike {
  return isRecord(value) && value.vtype === 'fclos'
}

/**
 *
 * @param value
 */
function isClassValueLike(value: unknown): value is ClassValueLike {
  return isRecord(value) && value.vtype === 'class'
}

/**
 *
 * @param value
 */
function isSpringBeanLike(value: unknown): value is SpringBeanLike {
  return isRecord(value) && (value.className === undefined || typeof value.className === 'string')
}

/**
 *
 * @param value
 */
function getNodeHash(value: unknown): string | undefined {
  if (!isUastRecord(value)) {
    return undefined
  }
  return typeof value._meta?.nodehash === 'string' ? value._meta.nodehash : undefined
}

/**
 *
 * @param value
 */
function getModifiers(value: unknown): string[] {
  if (!isUastRecord(value) || !Array.isArray(value._meta?.modifiers)) {
    return []
  }
  return value._meta.modifiers.filter((modifier): modifier is string => typeof modifier === 'string')
}

/**
 *
 * @param value
 */
function getTypeIdentifierName(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  return isIdentifierNode(value.id) ? value.id.name : undefined
}

/**
 *
 * @param fclos
 */
function getFunctionNode(fclos: FunctionClosureLike): FunctionDefinition | undefined {
  if (isFunctionDefinitionNode(fclos.ast?.fdef)) {
    return fclos.ast.fdef
  }
  if (isFunctionDefinitionNode(fclos.ast?.node)) {
    return fclos.ast.node
  }
  return undefined
}

/**
 *
 * @param classVal
 * @param name
 */
function getMemberOrValue(classVal: ClassValueLike, name: string): unknown {
  return classVal.members?.get(name) || classVal.value?.[name]
}

/**
 *
 * @param value
 * @param visit
 */
function visitObjectChildren(value: unknown, visit: (child: unknown) => void) {
  if (!isRecord(value)) {
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'parent') {
      continue
    }
    if (Array.isArray(child)) {
      child.forEach(visit)
    } else if (isRecord(child)) {
      visit(child)
    }
  }
}

/**
 *
 */
class SpringAnalyzer extends JavaAnalyzer {
  /**
   *
   * @param options
   */
  constructor(options: Record<string, unknown>) {
    super(options)
    this.beanReferenceAnnotationByName = ['@SofaReference', '@OsgiReference', '@Qualifier', '@Resource']
    this.beanReferenceAnnotationByClass = ['@Autowired', '@Resource', '@TestBean']
    this.beanServiceAnnotationOnClass = ['@Component', '@Service', '@Repository', '@SofaService']
    this.beanServiceAnnotationOnFunction = ['@Bean']
  }

  /**
   * 预处理前的初始化阶段，会创建一些全局builtin
   */
  override initAfterUsingCache() {
    // init global scope
    Initializer.initGlobalScope(this.topScope)
    Initializer.initPackageScope(this.topScope.context.packages)
    this.assembleClassMap(this.topScope.context.packages)
  }

  /**
   *
   * @param dir
   */
  override async preProcess(dir: string) {
    Initializer.initGlobalScope(this.topScope)
    Initializer.initPackageScope(this.topScope.context.packages, this)

    await Initializer.initBeans(this.topScope, dir)

    await this.scanPackages(dir)

    if (!Config.miniSaveContextEnvironment) {
      this.assembleClassMap(this.topScope.context.packages)
      this.compensateDependencyInjection(this.classMap)
      if (!Config.loadContextEnvironment) {
        JavaInitializer.addClassProto(this.classMap, this.topScope.context.packages, this)
      }
    }
  }

  /**
   *
   */
  override startAnalyze() {
    super.startAnalyze()
    this.adJustDependencyInjection(this.classMap, this.topScope.context.packages)
  }

  /**
   *
   *
   */
  override async symbolInterpret(): Promise<boolean> {
    const entryPoints = (this as { entryPoints?: SpringEntryPointLike[] }).entryPoints ?? []
    const state = this.initState(this.topScope) as State & {
      entryPointStartTimestamp?: number | null
      entryPointDeadline?: number
      entryPointClock?: () => number
      entryPointTimeoutLatch?: ReturnType<typeof createTimeoutLatch>
    }
    const oldEntryPointTimeoutMs = Config.entryPointTimeoutMs
    const oldAggressiveMode = this.pruneInfoMap.aggressiveMode
    const scanTimeoutMs = Config.scanTimeoutMs ?? 0
    const remainingScanBudgetMs = Math.max(0, scanTimeoutMs - (Date.now() - this.scanStartTimestamp))
    const monotonicClock = (): number => performance.now()
    const monotonicNow = monotonicClock()
    const deadlinePlan = createDeadlinePlan({
      outerDeadline: monotonicNow + remainingScanBudgetMs,
      finalizationReserveMs: 30_000,
      exitReserveMs: 5_000,
    }, monotonicClock)
    const checkpointWriter = new FindingsCheckpointWriter({ filePath: require('path').join(Config.reportDir || './report', 'findings-checkpoint.json'), reason: 'timeout' })
    let mandatoryCheckpointAttempted = false
    const persistMandatoryCheckpoint = async (): Promise<void> => {
      if (mandatoryCheckpointAttempted) return
      mandatoryCheckpointAttempted = true
      try {
        await this.outputAnalyzerExistResult(undefined, 'timeout', checkpointWriter)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        logger.warn('Timeout recovery checkpoint persistence failed; continuing analysis finalization', {
          checkpoint: 'findings-checkpoint.json',
          error: detail,
        })
      }
    }
    type AttemptSnapshot = {
      entryPointDeadline?: number
      entryPointClock?: () => number
      entryPointTimeoutLatch?: ReturnType<typeof createTimeoutLatch>
      entryPointTimeout: unknown
      meetOtherEntryPoint: unknown
    }
    let attemptSnapshot: AttemptSnapshot | undefined
    const clearAttemptState = (): void => {
      if (attemptSnapshot) {
        state.entryPointDeadline = attemptSnapshot.entryPointDeadline
        state.entryPointClock = attemptSnapshot.entryPointClock
        state.entryPointTimeoutLatch = attemptSnapshot.entryPointTimeoutLatch
        if (attemptSnapshot.entryPointTimeout === undefined) delete this.globalState.entryPointTimeout
        else this.globalState.entryPointTimeout = attemptSnapshot.entryPointTimeout
        if (attemptSnapshot.meetOtherEntryPoint === undefined) delete this.globalState.meetOtherEntryPoint
        else this.globalState.meetOtherEntryPoint = attemptSnapshot.meetOtherEntryPoint
      }
      attemptSnapshot = undefined
    }
    const allocateAttempt = (remainingAttempts: number, cap: number): import('../../common/entrypoint/deadline-scheduler').AttemptBudget | null => {
      const budget = deadlinePlan.allocateAttempt(remainingAttempts, { configuredCapMs: cap })
      if (!budget) return null
      Config.entryPointTimeoutMs = budget.allocationMs
      state.entryPointDeadline = budget.deadline
      state.entryPointClock = deadlinePlan.now
      state.entryPointTimeoutLatch = createTimeoutLatch()
      this.globalState.entryPointTimeout = false
      return budget
    }

    try {
    if (_.isEmpty(entryPoints)) {
      logger.info('[symbolInterpret]：EntryPoints are not found')
      return true
    }

    for (const entryPoint of entryPoints) {
      this.entryPointSymValArray.push(entryPoint.entryPointSymVal)
    }

    this.pruneInfoMap.sinkArray = this.loadAllSink()
    this.pruneInfoMap.funcCallSourceSinkSanitizerArray.push(...this.pruneInfoMap.sinkArray)

    const allSources = this.loadAllSource()
    this.pruneInfoMap.funcCallSourceSinkSanitizerArray.push(...allSources[0])
    this.pruneInfoMap.otherSourceArray = allSources[1]

    const allSanitizers = this.loadAllSanitizer()
    this.pruneInfoMap.funcCallSourceSinkSanitizerArray.push(...allSanitizers[0])
    this.pruneInfoMap.otherSanitizerArray = allSanitizers[1]

    const pruneSupported = this.checkPruneSupported(entryPoints.length, this.pruneInfoMap.sinkArray.length)
    if (pruneSupported) {
      yasaLog('EntryPoint pruning is enabled', 'symbolInterpret')
    }

    Config.entryPointTimeoutMs = Config.entryPointTimeoutQuickMs
    const hasAnalysised = new Set<string>()
    // 自定义 source 入口方式，并根据入口自主加载 source。
    const concreteWorklist = buildSpringConcreteWorklist({
      entryPoints,
      getSymbol: (entryPoint) => entryPoint.entryPointSymVal,
      getOverloads: (symbol) => symbol.overloaded?.filter((item): item is FunctionDefinition => !!item) ?? [],
      isSupported: (entryPoint) => entryPoint.type === constValue.ENGIN_START_FUNCALL && !!entryPoint.entryPointSymVal?.ast?.node,
      mark: (entryPoint) => this.markEntryPointForAnalysis(entryPoint, hasAnalysised),
      canPrune: (symVal) => {
        if (!pruneSupported) return false
        const entryPoint = entryPoints.find((candidate) => candidate.entryPointSymVal === symVal)
        if (!entryPoint) return false
        const entryPointLoc = symVal.ast?.node?.loc
        const anonymousEntryPointName = `<anonymousFunc_${entryPointLoc?.start?.line}_${entryPointLoc?.end?.line}>`
        const entrypointCanPrune = this.checkFclosCanPrune(symVal)
        if (entrypointCanPrune) {
          const pruneFilePath = entryPoint.filePath?.substring(0, entryPoint.filePath?.lastIndexOf('.'))
          const pruneFuncName = entryPoint.functionName || anonymousEntryPointName
          yasaLog(`EntryPoint [${pruneFilePath}.${pruneFuncName}] is pruned`, 'symbolInterpret')
        }
        return entrypointCanPrune
      },
      deadlinePlan,
    })
    let overloadCount = 0
    const attemptArgs = new Map<object, Value[]>()
    runSpringConcreteWorklist({
      plan: deadlinePlan,
      worklist: concreteWorklist,
      state,
      clock: monotonicClock,
      quickCapMs: Config.entryPointTimeoutQuickMs,
      getArgs: (item) => {
        const entryPoint = item.entryPoint
        this.symbolTable.clear()
        entryPoint.entryPointSymVal = this.tmpSymbolTable.tmpTableCopyUnit(entryPoint.entryPointSymVal)
        entryPoint.scopeVal = this.tmpSymbolTable.tmpTableCopyUnit(entryPoint.scopeVal)
        entryPointConfig.setCurrentEntryPoint(entryPoint)
        const symVal = entryPoint.entryPointSymVal
        const args: Value[] = []
        for (const param of item.overload.parameters ?? []) {
          if (!param?.id) continue
          let argValue = this.processInstruction(symVal, param.id, state)
          if (argValue.vtype !== 'symbol') {
            argValue.taint.sanitize()
            const sid = param.id?.type === 'Identifier' ? param.id.name : undefined
            const tmpVal = new SymbolValue(symVal?.qid ?? '', { sid, parent: symVal })
            if (symVal?.value && tmpVal.sid) symVal.value[tmpVal.sid] = tmpVal
            argValue = this.processInstruction(symVal, param.id, state)
          }
          if (param.varType?.id) {
            const val = this.getMemberValueNoCreate(symVal, param.varType.id, state)
            argValue.rtype.definiteType = val?.vtype === 'class' ? UastSpec.identifier(val.logicalQid) : param.varType.id
          }
          args.push(argValue)
        }
        attemptArgs.set(entryPoint as object, args)
        return args
      },
      execute: (item, argValues, progress) => {
        const entryPoint = item.entryPoint
        const symVal = entryPoint.entryPointSymVal
        const metricStartTime = Date.now()
        const findingsBefore = this.countFindings()
        let beforeCalled = false
        executeViaEntryPointExecutor({ analyzer: this, entryPoint, metricStartTime, findingsBefore, executionState: state, overloadCount, epIndex: progress.epIndex, epTotal: concreteWorklist.length }, {
          language: 'spring', classify: () => 'function', execute: () => {
            this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)
            beforeCalled = true
            try {
              overloadCount++
              state.entryPointStartTimestamp = Date.now()
              this.callsiteInterpretCount.clear()
              this.methodCumulativeTime.clear()
              this.currentFanoutOverloadIdentity = this.buildFanoutOverloadIdentity(item.overload)
              try {
                this.executeCall(item.overload, symVal, state, entryPoint.scopeVal, { callArgs: this.buildCallArgs(item.overload, argValues, symVal) })
              } catch (e) {
                const fdefIdName = item.overload.id?.name
                handleException(e, `[${fdefIdName} symbolInterpret failed. Exception message saved in error log file`, `[${fdefIdName} symbolInterpret failed. Exception message saved in error log file`)
                if (this.globalState.meetOtherEntryPoint) delete this.globalState.meetOtherEntryPoint
              }
              this.currentFanoutOverloadIdentity = ''
              if (this.globalState.meetOtherEntryPoint) delete this.globalState.meetOtherEntryPoint
            } finally {
              if (beforeCalled) this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
            }
          }, }, this.checkerManager?.resultManagerProxy)
      },
      enqueueTimeout: (item, argValues) => {
        logger.info(
          'EntryPoint [%s.%s] is interrupted because timeout',
          typeof item.entryPoint.filePath === 'string'
            ? item.entryPoint.filePath.substring(0, item.entryPoint.filePath.lastIndexOf('.'))
            : undefined,
          item.entryPoint.functionName ||
            `<anonymousFunc_${item.overload.loc.start.line}_$${item.overload.loc.end.line}>`
        )
        this.timeoutEntryPoints.push({ entryPoint: item.entryPoint, overloadFuncDef: item.overload, argValues })
      },
    })
    // 基于全局时间预算的超时入口点重跑
    if (this.timeoutEntryPoints.length > 0) {
      if (deadlinePlan.canStartAnalysis()) {
        const initialAttempts = this.timeoutEntryPoints.length
        const initialRemaining = formatBudgetMs(Math.max(0, deadlinePlan.analysisDeadline - deadlinePlan.now()))
        const initialAllocation = formatBudgetMs(Math.min(oldEntryPointTimeoutMs ?? 0, initialRemaining / initialAttempts))
        logger.info(
          'Rerun %d timeout entrypoints with aggressive prune mode, configuredCapMs=%d, remaining=%dms, initialAllocationMs=%d, initialRemainingAttempts=%d',
          initialAttempts,
          formatBudgetMs(oldEntryPointTimeoutMs ?? 0),
          initialRemaining,
          initialAllocation,
          initialAttempts
        )
        this.pruneInfoMap.aggressiveMode = true
        try {
          let rerunIdx = 0
          for (const timeoutEntryPoint of this.timeoutEntryPoints) {
            rerunIdx++
            const metricStartTime = Date.now()
            const findingsBefore = this.countFindings()
            let skipped = false
            let skipReason: string | undefined
            let overloadCount = 0
            attemptSnapshot = {
              entryPointDeadline: state.entryPointDeadline,
              entryPointClock: state.entryPointClock,
              entryPointTimeoutLatch: state.entryPointTimeoutLatch,
              entryPointTimeout: this.globalState.entryPointTimeout,
              meetOtherEntryPoint: this.globalState.meetOtherEntryPoint,
            }
            try {
              const remainingAttempts = this.timeoutEntryPoints.length - rerunIdx + 1
              const attemptBudget = !deadlinePlan.canStartAnalysis() ? null : allocateAttempt(remainingAttempts, oldEntryPointTimeoutMs)
              if (!attemptBudget) {
                skipped = true
                skipReason = 'analysis-deadline'
                logger.info('Skip remaining timeout entrypoints: scan analysis deadline reached')
                continue
              }
              logger.info(
                'Aggressive rerun attempt %d/%d allocatedMs=%d, remainingAttempts=%d',
                rerunIdx,
                initialAttempts,
                formatBudgetMs(attemptBudget.allocationMs),
                attemptBudget.remainingAttempts
              )
              this.symbolTable.clear()
              overloadCount = 1

              executeViaEntryPointExecutor(
                {
                  analyzer: this,
                  entryPoint: timeoutEntryPoint.entryPoint,
                  metricStartTime,
                  findingsBefore,
                  executionState: state,
                  overloadCount,
                  epIndex: rerunIdx,
                  epTotal: this.timeoutEntryPoints.length,
                },
                {
                  language: 'spring',
                  classify: () => 'function',
                  execute: () => {
                    let beforeCalled = false
                    this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)
                    beforeCalled = true
                    try {
                    this.currentFanoutOverloadIdentity = this.buildFanoutOverloadIdentity(
                      timeoutEntryPoint.overloadFuncDef
                    )
                    try {
                      entryPointConfig.setCurrentEntryPoint(timeoutEntryPoint.entryPoint)
                      state.entryPointStartTimestamp = Date.now()
                      this.callsiteInterpretCount.clear()
                      this.executeCall(
                        timeoutEntryPoint.overloadFuncDef,
                        timeoutEntryPoint.entryPoint.entryPointSymVal,
                        state,
                        timeoutEntryPoint.entryPoint.scopeVal,
                        {
                          callArgs: this.buildCallArgs(
                            timeoutEntryPoint.overloadFuncDef,
                            timeoutEntryPoint.argValues,
                            timeoutEntryPoint.entryPoint.entryPointSymVal
                          ),
                        }
                      )
                    } catch (e) {
                      handleException(
                        e,
                        `[${timeoutEntryPoint.overloadFuncDef?.id?.name} symbolInterpret failed. Exception message saved in error log file`,
                        `[${timeoutEntryPoint.overloadFuncDef?.id?.name} symbolInterpret failed. Exception message saved in error log file`
                      )
                      if (this.globalState.meetOtherEntryPoint) {
                        delete this.globalState.meetOtherEntryPoint
                      }
                    }

                    this.currentFanoutOverloadIdentity = ''

                    if (this.globalState.meetOtherEntryPoint) {
                      delete this.globalState.meetOtherEntryPoint
                    }
                    if (this.globalState.entryPointTimeout) {
                      logger.info(
                        'EntryPoint [%s.%s] is interrupted because timeout (aggressive rerun)',
                        timeoutEntryPoint.entryPoint.filePath?.substring(
                          0,
                          timeoutEntryPoint.entryPoint.filePath?.lastIndexOf('.')
                        ),
                        timeoutEntryPoint.entryPoint.functionName ||
                          `<anonymousFunc_${timeoutEntryPoint.overloadFuncDef.loc.start.line}_$${timeoutEntryPoint.overloadFuncDef.loc.end.line}>`
                      )
                      skipped = true
                      skipReason = 'timeout'
                    }

                    } finally {
                      if (beforeCalled) this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
                    }
                  },
                },
                this.checkerManager?.resultManagerProxy
              )
            } finally {
              clearAttemptState()
              this.recordEntryPointLoopMetric(
                timeoutEntryPoint.entryPoint,
                metricStartTime,
                findingsBefore,
                skipped,
                skipReason,
                overloadCount
              )
            }
          }
        } finally {
          this.pruneInfoMap.aggressiveMode = false
          Config.entryPointTimeoutMs = oldEntryPointTimeoutMs
          this.clearFanoutContinuationState()
        }
      } else {
        logger.info(
          'Skip rerun of %d timeout entrypoints: scan budget exhausted (remaining=%dms)',
          this.timeoutEntryPoints.length,
          Math.max(0, deadlinePlan.analysisDeadline - deadlinePlan.now())
        )
      }
      // 清空，避免重复重跑
      this.timeoutEntryPoints = []
    }
    this.clearFanoutContinuationState()
    return true
  } catch (schedulingError) {
    let persistenceError: unknown
    await persistMandatoryCheckpoint()
    const combined = combineFindingsFinalizationErrors(
      schedulingError instanceof Error ? { code: 'unknown', message: schedulingError.message, retriable: false } : schedulingError === undefined ? undefined : { code: 'unknown', message: String(schedulingError), retriable: false },
      persistenceError instanceof Error ? { code: 'unknown', message: persistenceError.message, retriable: true } : persistenceError === undefined ? undefined : { code: 'unknown', message: String(persistenceError), retriable: true },
    )
    const finalizationError = new Error('Analysis finalization failed')
    Object.assign(finalizationError, { schedulingError, persistenceError, combined })
    throw finalizationError
  } finally {
    clearAttemptState()
    this.pruneInfoMap.aggressiveMode = oldAggressiveMode
    Config.entryPointTimeoutMs = oldEntryPointTimeoutMs
  }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processVariableDeclaration(scope: Scope, node: VariableDeclaration, state: State) {
    const idName = node.id?.type === 'Identifier' ? node.id.name : undefined
    if (!node.init && !Rules.getPreprocessReady()) {
      let targetClassName = ''
      if (node.varType?.id?.type === 'Identifier') {
        const classRes = this.processIdentifier(scope, node.varType?.id, state)
        if (classRes && classRes?.vtype === 'symbol') {
          targetClassName = (classRes as any).name
        } else {
          targetClassName = classRes.logicalQid
        }
      }

      let hasBeanInject = false
      // @Autowired Map<String, Interface>：将 varType 改写为 value type 接口名，复用 injectBeanByClass 路径
      const varTypeName = node.varType?.id?.name?.split('.').pop()
      if (varTypeName === 'Map' && node.varType?.id) {
        const hasAutowiredOrResource = node._meta?.modifiers?.some?.((m: string) =>
          this.beanReferenceAnnotationByClass.some((d: string) => m.includes(d))
        )
        if (hasAutowiredOrResource) {
          const mapValueType = this.extractMapValueType(node)
          if (mapValueType) {
            node.varType.id.name = mapValueType
            targetClassName = mapValueType
          }
        }
      }
      // bean注入注解形式
      if (node?._meta?.modifiers && Array.isArray(node?._meta?.modifiers)) {
        const decoratorArray = node?._meta?.modifiers.filter((item: string) => item.startsWith('@'))
        let isBeanReferenceByName = false
        let isBeanReferenceByClass = false
        let matchedDecorator = ''
        let decoratorMeta = ''
        const indexByName = this.beanReferenceAnnotationByName.findIndex((decorator: string) => {
          const matchingItem = decoratorArray.find((item: string) => item.includes(decorator))
          if (matchingItem) {
            if (matchingItem.includes('@Resource')) {
              const regex = /type\s*=\s*([^",]*)/
              const match = matchingItem.match(regex)
              if (match) {
                return false
              }
            }
            decoratorMeta = matchingItem
            return true
          }
          return false
        })
        if (indexByName !== -1) {
          isBeanReferenceByName = true
          matchedDecorator = this.beanReferenceAnnotationByName[indexByName]
        } else {
          const indexByClass = this.beanReferenceAnnotationByClass.findIndex((decorator: string) => {
            const matchingItem = decoratorArray.find((item: string) => item.includes(decorator))
            if (matchingItem) {
              decoratorMeta = matchingItem
              return true
            }
            return false
          })
          if (indexByClass !== -1) {
            isBeanReferenceByClass = true
            matchedDecorator = this.beanReferenceAnnotationByClass[indexByClass]
          }
        }
        if (isBeanReferenceByName && matchedDecorator !== '' && decoratorMeta !== '') {
          let beanName = idName ?? ''
          if (matchedDecorator === '@SofaReference' && decoratorMeta.includes('uniqueId')) {
            const regex = /uniqueId\s*=\s*"([^"]*)"/
            const match = decoratorMeta.match(regex)
            if (match) {
              beanName = match[1]
            }
          } else if (matchedDecorator === '@Qualifier' && decoratorMeta.includes('(') && decoratorMeta.includes('"')) {
            const qualifierValue = decoratorMeta
              .slice(decoratorMeta.indexOf('"') + 1, decoratorMeta.lastIndexOf('"'))
              .replace(/\s+/g, '')
            if (qualifierValue) {
              beanName = qualifierValue
            }
          } else if (matchedDecorator === '@Resource' && decoratorMeta.includes('name')) {
            const regex = /name\s*=\s*"([^"]*)"/
            const match = decoratorMeta.match(regex)
            if (match) {
              beanName = match[1]
            }
          }
          hasBeanInject = this.injectBeanByName(beanName, node, targetClassName)
        }
        if (isBeanReferenceByClass && matchedDecorator !== '' && decoratorMeta !== '' && !hasBeanInject) {
          if (node.varType?.id?.type === 'Identifier') {
            if (matchedDecorator === '@Resource') {
              const regex = /type\s*=\s*([^",)]*)/
              const match = decoratorMeta.match(regex)
              if (match) {
                node.varType.id.name = match[1].split('.')[0]
              }
            }
            const classRes = this.processIdentifier(scope, node.varType?.id, state)
            if (classRes && classRes?.vtype === 'symbol') {
              targetClassName = (classRes as any).name || classRes.qid || ''
            } else {
              targetClassName = classRes.logicalQid
            }
          }
          if (targetClassName) {
            hasBeanInject = this.injectBeanByClass(targetClassName, node) || false
          }
        }
      }
      // 同package下无注解形式
      if (!hasBeanInject) {
        const beanName = idName || ''
        hasBeanInject = this.injectBeanByName(beanName, node, targetClassName)
      }
      if (!hasBeanInject) {
        this.injectBeanByClass(targetClassName, node)
      }
    }

    return super.processVariableDeclaration(scope, node, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processFunctionDefinition(scope: Scope, node: FunctionDefinition, state: State) {
    // bean发布@Bean
    let isBeanService = false
    let isPrimary = false
    let beanName = ''
    if (node._meta?.modifiers && Array.isArray(node._meta?.modifiers)) {
      // TODO 后续UAST需要统一到Annotation
      for (const modifier of node._meta?.modifiers) {
        if (AstUtil.prettyPrintAST(modifier).includes('Primary')) {
          isPrimary = true
        }
        if (
          typeof modifier === 'string' &&
          this.beanServiceAnnotationOnFunction.some((anno: string) => modifier.includes(anno))
        ) {
          isBeanService = true
          const regex = /name\s*=\s*"([^"]*)"/
          const match = modifier.match(regex)
          const funcIdName = node.id?.type === 'Identifier' ? node.id.name : ''
          beanName = this.transformBeanNameVariable(funcIdName)
          if (match && beanName && beanName !== '') {
            beanName = match[1]
          }
        }
      }
    }
    const res = super.processFunctionDefinition(scope, node, state)
    if (isBeanService && beanName && beanName !== '') {
      let returnType = ''
      if (node.returnType?.id?.type === 'Identifier') {
        const returnClass = node.returnType?.id
        const returnTypeIdentifier = this.processIdentifier(scope, returnClass, state)
        returnType = returnTypeIdentifier.qid
      }
      this.topScope.spring.beanMap.set(beanName, {
        initFClos: res,
        className: QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(returnType),
        isPrimary,
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
  override processClassDefinition(scope: Scope, node: ClassDefinition, state: State) {
    let isBeanService = false
    let beanName = ''
    let isPrimary = false
    const { annotations } = node._meta as { annotations?: unknown[] }
    if (annotations && Array.isArray(annotations)) {
      for (const rawAnnotation of annotations) {
        const annotation = rawAnnotation as any
        if (AstUtil.prettyPrintAST(annotation).includes('Primary')) {
          isPrimary = true
        }
        // TODO 后续这里UAST节点需要优化，现在prettyPrintAST出来结果不对
        if (
          this.beanServiceAnnotationOnClass.some((anno: string) =>
            AstUtil.prettyPrintAST(annotation).includes(anno.slice(1))
          )
        ) {
          isBeanService = true
          beanName = this.transformBeanNameVariable(node.id?.name ?? '')
          if (annotation.type === 'Sequence' && annotation.expressions && Array.isArray(annotation.expressions)) {
            for (const expr of annotation.expressions) {
              const exprBeanName = this.findBeanNameFromSequenceExpr(expr)
              if (exprBeanName) {
                beanName = exprBeanName
                break
              }
            }
          }
        }
      }
    }
    const res = super.processClassDefinition(scope, node, state)
    if (isBeanService) {
      this.topScope.spring.beanMap.set(beanName, {
        className: res.logicalQid,
        isPrimary,
      })
    }
    /* 收集 @Handler 注解映射：识别 @Handler(value) 并建立 value → className 映射。
       @Handler 的 value 通常是常量引用（如 HandlerConstants.XXX），在 processModule 阶段
       常量已被解析到 scope 中，通过 scope 查找获取字面量值，避免调用 processInstruction */
    if (annotations && Array.isArray(annotations) && res.logicalQid) {
      for (const rawAnnotation of annotations) {
        const annotationStr = AstUtil.prettyPrintAST(rawAnnotation)
        if (!annotationStr?.includes('Handler')) continue
        const annotation = rawAnnotation as { type?: string; body?: Array<{ type?: string }> }
        if (annotation.type !== 'ScopedStatement' || !Array.isArray(annotation.body)) continue
        /* ScopedStatement: body[0] 是注解类型声明，body[1+] 是注解参数值 */
        for (let i = 1; i < annotation.body.length; i++) {
          const candidate = annotation.body[i]
          /* 尝试解析常量引用（MemberAccess 如 HandlerConstants.XXX） */
          const candidateStr = AstUtil.prettyPrintAST(candidate)
          if (!candidateStr) continue
          /* 从 scope 中查找常量值：遍历 scope 链找到常量定义 */
          let handlerValue: string | undefined
          const val = this.processInstruction(scope, candidate as Expr, state)
          if (val?.vtype === 'primitive' && typeof val.value === 'string') {
            handlerValue = val.value
          }
          if (handlerValue) {
            if (!this.topScope.spring.handlerAnnotationMap) {
              this.topScope.spring.handlerAnnotationMap = new Map<string, string>()
            }
            this.topScope.spring.handlerAnnotationMap.set(handlerValue, res.logicalQid)
          }
          break
        }
        break
      }
    }
    return res
  }

  /**
   *
   * @param beanName
   * @param node
   * @param targetClassName
   */
  injectBeanByName(beanName: string, node: VariableDeclaration, targetClassName?: string) {
    if (
      beanName &&
      beanName !== '' &&
      this.topScope.spring.beanMap?.has(beanName) &&
      this.topScope.spring.beanMap?.get(beanName)?.className
    ) {
      const implValue = this.topScope.spring.beanMap?.get(beanName).className
      if (node.varType?.id?.type === 'Identifier' && node.varType?.id?.name) {
        node.varType.id.name = implValue?.split('.').pop()
      }
      const nodeParent = node.parent
      const fromLiteral = {
        type: 'Literal',
        value: implValue,
        literalType: 'string',
        _meta: {},
        loc: node.loc,
        parent: node.init,
      } as unknown as Literal
      const importExpr = {
        type: 'ImportExpression',
        from: fromLiteral,
        arguments: [],
        _meta: node._meta,
        loc: node.loc,
        parent: nodeParent,
      } as unknown as Expr
      node.init = importExpr
      if (implValue && targetClassName && implValue !== targetClassName) {
        this.addExtraClassHierarchyByName(implValue, targetClassName)
      }
      return true
    }
    // spring reference场景
    if (beanName && beanName !== '' && this.topScope.spring.springReferenceMap.has(beanName)) {
      const { interfaceName } = this.topScope.spring.springReferenceMap.get(beanName)
      if (interfaceName && this.topScope.spring.springServiceMap.has(interfaceName)) {
        const beanRef = this.topScope.spring.springServiceMap.get(interfaceName)
        const implValue = this.topScope.spring.beanMap?.get(beanRef.ref)?.className
        if (implValue) {
          if (node.varType?.id?.type === 'Identifier' && node.varType?.id?.name) {
            node.varType.id.name = implValue?.split('.').pop()
          }
          const nodeParent = node.parent
          const fromLiteral = {
            type: 'Literal',
            value: implValue,
            literalType: 'string',
            _meta: {},
            loc: node.loc,
            parent: node.init,
          } as unknown as Literal
          const importExpr = {
            type: 'ImportExpression',
            from: fromLiteral,
            arguments: [],
            _meta: node._meta,
            loc: node.loc,
            parent: nodeParent,
          } as unknown as Expr
          node.init = importExpr
          if (implValue && targetClassName && implValue !== targetClassName) {
            this.addExtraClassHierarchyByName(implValue, targetClassName)
          }
          return true
        }
      }
    }
    return false
  }

  /**
   * 将字段注入目标改写为具体实现类，保证接口字段调用可进入实现方法体。
   * @param node
   * @param implValue
   * @param targetClassName
   */
  private applyInjectedBeanImport(node: VariableDeclaration, implValue: string, targetClassName?: string): boolean {
    if (node.varType?.id?.type === 'Identifier' && node.varType?.id?.name) {
      node.varType.id.name = implValue.split('.').pop() || implValue
    }
    const nodeParent = node.parent
    const fromLiteral = {
      type: 'Literal',
      value: implValue,
      literalType: 'string',
      _meta: {},
      loc: node.loc,
      parent: node.init,
    } as unknown as Literal
    const importExpr = {
      type: 'ImportExpression',
      from: fromLiteral,
      arguments: [],
      _meta: node._meta,
      loc: node.loc,
      parent: nodeParent,
    } as unknown as Expr
    node.init = importExpr
    if (targetClassName && implValue !== targetClassName) {
      this.addExtraClassHierarchyByName(implValue, targetClassName)
    }
    return true
  }

  /**
   *
   * @param targetClassName
   * @param node
   */
  injectBeanByClass(targetClassName: string, node: VariableDeclaration) {
    let hasFindPrimary = false
    for (const beanValue of this.topScope.spring.beanMap.values()) {
      if (beanValue.isPrimary && beanValue.className === targetClassName) {
        hasFindPrimary = true
        const nodeParent = node.parent
        const fromLiteral = {
          type: 'Literal',
          value: targetClassName,
          literalType: 'string',
          _meta: {},
          loc: node.loc,
          parent: node.init,
        } as unknown as Literal
        const importExpr = {
          type: 'ImportExpression',
          from: fromLiteral,
          arguments: [],
          _meta: node._meta,
          loc: node.loc,
          parent: nodeParent,
        } as unknown as Expr
        node.init = importExpr
        return true
      }
    }
    if (!hasFindPrimary) {
      for (const beanValue of this.topScope.spring.beanMap.values()) {
        if (beanValue.className === targetClassName) {
          hasFindPrimary = true
          const nodeParent = node.parent
          const fromLiteral = {
            type: 'Literal',
            value: targetClassName,
            literalType: 'string',
            _meta: {},
            loc: node.loc,
            parent: node.init,
          } as unknown as Literal
          const importExpr = {
            type: 'ImportExpression',
            from: fromLiteral,
            arguments: [],
            _meta: node._meta,
            loc: node.loc,
            parent: nodeParent,
          } as unknown as Expr
          node.init = importExpr
          return true
        }
      }
    }

    // 接口→实现类匹配：通过 AST supers 检查 bean 的类是否 implements targetClassName
    // 只注册 classHierarchy 继承关系，不修改 AST 节点
    // 原因：修改 varType/init 会导致接口 default 方法在 callgraph 中丢失
    if (!hasFindPrimary && this.classMap && this.symbolTable && targetClassName) {
      const targetShortName = targetClassName.split('.').pop() || targetClassName
      let matchedBean: { className: string; isPrimary: boolean } | undefined
      for (const beanValue of this.topScope.spring.beanMap.values()) {
        if (!beanValue.className) {
          continue
        }
        const classUuid = this.classMap.get(beanValue.className)
        if (!classUuid) {
          continue
        }
        const classVal = this.symbolTable.get(classUuid)
        if (!classVal?.ast?.node?.supers || !Array.isArray(classVal.ast.node.supers)) {
          continue
        }
        const implementsTarget = classVal.ast.node.supers.some(
          (superAst: { name?: string }) => superAst?.name === targetShortName
        )
        if (implementsTarget) {
          if (beanValue.isPrimary) {
            matchedBean = beanValue
            break
          }
          if (!matchedBean) {
            matchedBean = beanValue
          }
        }
      }
      if (matchedBean) {
        return this.applyInjectedBeanImport(node, matchedBean.className, targetClassName)
      }
    }
  }

  /**
   * 为 @Autowired Map<String, Interface> 字段注入第一个匹配的实现类 bean。
   * 让 Map.get() fallback 路径返回正确类型的 bean 实例，使接口方法调用能分派。
   * @param valueTypeName
   * @param node
   */
  injectMapBeanByValueType(valueTypeName: string, node: VariableDeclaration): boolean {
    const targetShortName = valueTypeName.split('.').pop() || valueTypeName
    for (const beanValue of this.topScope.spring.beanMap.values()) {
      if (!isSpringBeanLike(beanValue) || !beanValue.className) {
        continue
      }
      // classMap 可用时用 classImplementsType 精确匹配
      if (this.classMap?.size > 0) {
        const implClassUuid = this.classMap.get(beanValue.className)
        if (!implClassUuid) continue
        const implClassVal = this.symbolTable?.get(implClassUuid)
        if (!isClassValueLike(implClassVal) || !this.classImplementsType(implClassVal, targetShortName)) continue
      } else {
        // classMap 不可用时（早期阶段），用 className 包含接口短名判断
        const beanShortName = beanValue.className.split('.').pop() || ''
        if (!beanShortName.includes(targetShortName) && !beanShortName.endsWith('Impl')) continue
        // 跳过明显不相关的 bean（名称中不含目标接口关键字）
        if (
          !beanValue.className
            .toLowerCase()
            .includes(targetShortName.toLowerCase().replace('executor', '').replace('handler', ''))
        )
          continue
      }
      const nodeParent = node.parent
      const fromLiteral = {
        type: 'Literal',
        value: beanValue.className,
        literalType: 'string',
        _meta: {},
        loc: node.loc,
        parent: node.init,
      } as unknown as Literal
      const importExpr = {
        type: 'ImportExpression',
        from: fromLiteral,
        arguments: [],
        _meta: node._meta,
        loc: node.loc,
        parent: nodeParent,
      } as unknown as Expr
      node.init = importExpr
      return true
    }
    return false
  }

  /**
   * 在 compensateCollectionInjectionInvocations 阶段为 @Autowired Map 字段注入 bean 运行时值。
   * 直接修改 classVal 成员中 Map 字段指向第一个匹配的实现类实例。
   * @param classVal
   * @param fields
   */
  injectMapFieldBeanValues(classVal: ClassValueLike, fields: Map<string, string>): void {
    for (const [fieldName, elementType] of fields) {
      const fieldValue = getMemberOrValue(classVal, fieldName)
      if (!fieldValue || typeof fieldValue !== 'object') {
        continue
      }
      const fieldVtype = (fieldValue as Record<string, unknown>).vtype
      if (fieldVtype !== 'symbol' && fieldVtype !== 'object') {
        continue
      }
      // 只对 Map 类型字段做运行时注入
      const fieldSid = (fieldValue as Record<string, unknown>).sid
      if (typeof fieldSid !== 'string') continue
      const targetShortName = elementType.split('.').pop() || elementType
      for (const beanValue of this.topScope.spring.beanMap.values()) {
        if (!isSpringBeanLike(beanValue) || !beanValue.className) continue
        const implClassUuid = this.classMap?.get(beanValue.className)
        if (!implClassUuid) continue
        const implClassVal = this.symbolTable?.get(implClassUuid)
        if (!isClassValueLike(implClassVal) || !this.classImplementsType(implClassVal, targetShortName)) continue
        // 找到匹配的 bean，将其 classVal 作为 Map 字段的值，让 Map.get fallback 能返回 bean 实例
        if (typeof (fieldValue as Record<string, unknown>).setMisc === 'function') {
          ;(fieldValue as any).setMisc('precise', false)
        }
        const { addElementToBuffer } = require('../common/builtins/buffer')
        addElementToBuffer(fieldValue, implClassVal)
        break
      }
    }
  }

  /**
   *
   * @param variable
   */
  transformBeanNameVariable(variable: string) {
    // 检查是否是字符串
    if (typeof variable !== 'string') {
      handleException(
        new TypeError('SpringAnalyzer:transformBeanNameVariable.The input variable must be a string.'),
        'Error in SpringAnalyzer:transformBeanNameVariable.The input variable must be a string.',
        'Error in SpringAnalyzer:transformBeanNameVariable.The input variable must be a string.'
      )
      return ''
    }

    // 如果是连续多个大写字母开头（如"HELLO"），直接返回
    if (/^[A-Z]{2,}/.test(variable)) {
      return variable
    }

    // 如果是单个大写字母开头，将第一个字母转换为小写
    if (/^[A-Z]/.test(variable)) {
      return variable.charAt(0).toLowerCase() + variable.slice(1)
    }

    // 如果不是以大写字母开头，直接返回原变量
    return variable
  }

  /**
   *
   * @param classMap
   */
  compensateDependencyInjection(classMap: Map<string, string>) {
    if (!classMap) {
      return
    }
    for (const classUuid of classMap.values()) {
      const classVal = this.symbolTable.get(classUuid)
      if (
        classVal.vtype !== 'class' ||
        !classVal.ast.node ||
        !Array.isArray(classVal.ast.node.body) ||
        !classVal.members
      ) {
        continue
      }
      for (const bodyAst of classVal.ast.node.body) {
        if (
          bodyAst.type !== 'VariableDeclaration' ||
          !bodyAst.id ||
          !bodyAst.id.name ||
          !classVal.members.has(bodyAst.id.name) ||
          classVal.members.get(bodyAst.id.name)?.vtype !== 'uninitialized'
        ) {
          continue
        }
        const state = this.initState(classVal)
        this.processVariableDeclaration(classVal, bodyAst, state)
      }
    }
  }

  /**
   * inject object instead of class
   * @param classMap
   * @param packageManager
   */
  adJustDependencyInjection(classMap: Map<string, string>, packageManager: unknown) {
    if (!classMap) {
      return
    }
    for (const classValUUid of classMap.values()) {
      const classVal = this.symbolTable.get(classValUUid)
      if (
        classVal.vtype !== 'class' ||
        !classVal.ast.node ||
        !Array.isArray(classVal.ast.node.body) ||
        classVal.members.size === 0
      ) {
        continue
      }
      for (const bodyAst of classVal.ast.node.body) {
        if (
          bodyAst.type !== 'VariableDeclaration' ||
          !bodyAst.id ||
          !bodyAst.id.name ||
          !bodyAst.init ||
          bodyAst.init.type !== 'ImportExpression' ||
          !classVal.members.has(bodyAst.id.name) ||
          classVal.members.get(bodyAst.id.name)?.vtype !== 'class'
        ) {
          continue
        }
        const memberVal = classVal.members.get(bodyAst.id.name)
        const objVal = newInstance(this, packageManager, memberVal.qid, bodyAst)
        objVal.injected = true
        objVal.rtype = { type: undefined }
        objVal.rtype.definiteType = UastSpec.identifier(memberVal.logicalQid)
        /* DI 阶段执行 @PostConstruct/afterPropertiesSet lifecycle 方法，
           确保 handler bean 初始化回调中的 taint 传播不断裂。
           使用 _lifecycleDepth 递归深度保护，防止 bean 间循环依赖导致无限递归 */
        const lifecycleDepth = typeof (this as any)._lifecycleDepth === 'number' ? (this as any)._lifecycleDepth : 0
        if (lifecycleDepth < 3) {
          const objMembers = (objVal as { members?: ValueRefMapLike }).members
          const memberEntries: Array<[string, unknown]> = objMembers?.entries
            ? Array.from(objMembers.entries() as Array<[string, unknown]>)
            : []
          for (const [, fieldVal] of memberEntries) {
            const val = fieldVal as {
              vtype?: string
              ast?: { node?: { _meta?: { modifiers?: string[] } } }
              sid?: string
            }
            if (val.vtype !== 'fclos' || !val.ast?.node) {
              continue
            }
            if (val.sid === 'afterPropertiesSet' || val.ast?.node?._meta?.modifiers?.includes('@PostConstruct')) {
              ;(this as any)._lifecycleDepth = lifecycleDepth + 1
              try {
                const lifecycleState = this.initState(objVal)
                this.executeCall(
                  val.ast?.node,
                  val as unknown as SymbolValueType,
                  lifecycleState,
                  objVal,
                  INTERNAL_CALL
                )
              } finally {
                ;(this as any)._lifecycleDepth = lifecycleDepth
              }
            }
          }
        }
        classVal.members.set(bodyAst.id.name, objVal)

        /* @Handler dispatch：对有 initApplicationContext 方法的 bean（如 HandlerFactory），
           在 CLASS 级别覆盖 getHandler 方法，使其返回所有 @Handler 注解 bean 的联合体。
           必须修改 memberVal（CLASS 值，被 parent/child 共享），而非 objVal（仅在当前类可见的新实例）。
           注意：引擎的 member access 使用 scope.value[key]，不是 scope.members.get(key） */
        const handlerMap = this.topScope.spring.handlerAnnotationMap as Map<string, string> | undefined
        if (handlerMap && handlerMap.size > 0 && memberVal.members?.has('initApplicationContext')) {
          /* 从 value 和 members 两处获取 getHandler，确保修改生效 */
          const classGetHandler = memberVal.value?.getHandler || memberVal.members?.get('getHandler')
          if (classGetHandler?.vtype === 'fclos') {
            /* 收集所有 handler 实例联合体 */
            const handlerInstances: any[] = []
            /* 跨 field / 跨 class 共享 handler 实例缓存：同一 handler class 只需 newInstance 一次 */
            if (!this._handlerInstanceCache) this._handlerInstanceCache = new Map()
            for (const [, handlerClassName] of handlerMap) {
              const cached = this._handlerInstanceCache.get(handlerClassName)
              if (cached) {
                handlerInstances.push(cached)
                continue
              }
              const handlerClassUuid = classMap.get(handlerClassName)
              if (!handlerClassUuid) continue
              const handlerClassVal = this.symbolTable.get(handlerClassUuid)
              if (!handlerClassVal) continue
              const handlerObj = newInstance(this, packageManager, handlerClassVal.qid, bodyAst)
              handlerObj.injected = true
              handlerObj.rtype = { type: undefined }
              handlerObj.rtype.definiteType = UastSpec.identifier(handlerClassName)
              this._handlerInstanceCache.set(handlerClassName, handlerObj)
              handlerInstances.push(handlerObj)
            }
            if (handlerInstances.length > 0) {
              const handlerUnion = new UnionValue(
                undefined,
                'handler-dispatch-union',
                `${memberVal.qid}.handler-union`,
                bodyAst
              )
              handlerUnion.parent = memberVal
              for (const instance of handlerInstances) {
                handlerUnion.appendValue(instance)
              }
              /* 在 CLASS 的 getHandler 上设置 runtime.execute（同时设置 value 和 members）
                 同时清除 fdef，确保引擎走 runtime.execute 而非原始函数体 */
              if (!classGetHandler.runtime) classGetHandler.runtime = {}
              /* 捕获 analyzer 引用，用于精确 dispatch + lazy 剪枝 */
              const analyzer = this as any
              /* handlerValue → handler instance 的精确映射 */
              const handlerInstanceMap = new Map<string, any>()
              for (const [handlerValue, handlerClassName] of handlerMap) {
                const matchingInstance = handlerInstances.find(
                  (inst: any) => inst.rtype?.definiteType?.name === handlerClassName
                )
                if (matchingInstance) {
                  handlerInstanceMap.set(handlerValue, matchingInstance)
                }
              }
              let prunedUnion: any = null
              classGetHandler.runtime.execute = (
                _fclos: any,
                _argvalues: any[],
                _state: any,
                _node: any,
                _scope: any
              ) => {
                /* 精确 dispatch：如果参数是已解析的字符串常量，直接返回对应的 handler 实例 */
                const arg = _argvalues?.[0]
                if (arg?.vtype === 'primitive' && typeof arg.value === 'string') {
                  const exactMatch = handlerInstanceMap.get(arg.value)
                  if (exactMatch) {
                    logger.info('@Handler dispatch exact: "%s" → %s', arg.value, exactMatch.rtype?.definiteType?.name)
                    return exactMatch
                  }
                }
                /* 回退：lazy 剪枝，首次调用时过滤只保留 sink-reachable 的 handler */
                if (prunedUnion) return prunedUnion
                const { sinkArray, sofaStrictMatchSinkCacheMap } = analyzer.pruneInfoMap || {}
                if (!sinkArray || sinkArray.length === 0) {
                  prunedUnion = handlerUnion
                  return prunedUnion
                }
                const reachableInstances: any[] = []
                for (const instance of handlerInstances) {
                  const executeFclos = instance.members?.get('execute') || instance.value?.execute
                  const doExecuteFclos = instance.members?.get('doExecute') || instance.value?.doExecute
                  const targetFclos = doExecuteFclos || executeFclos
                  if (!targetFclos || !targetFclos.invocationMap) {
                    reachableInstances.push(instance)
                    continue
                  }
                  if (analyzer.checkFclosMatchSink(targetFclos, [], sinkArray, sofaStrictMatchSinkCacheMap, false)) {
                    reachableInstances.push(instance)
                  }
                }
                if (reachableInstances.length === 0) {
                  prunedUnion = handlerUnion
                } else {
                  prunedUnion = new UnionValue(
                    undefined,
                    'handler-dispatch-union-pruned',
                    `${memberVal.qid}.handler-union-pruned`,
                    bodyAst
                  )
                  prunedUnion.parent = memberVal
                  for (const instance of reachableInstances) {
                    prunedUnion.appendValue(instance)
                  }
                }
                logger.info(
                  '@Handler dispatch lazy prune fallback: %d/%d handler sink-reachable',
                  reachableInstances.length,
                  handlerInstances.length
                )
                return prunedUnion
              }
              if (classGetHandler.ast) classGetHandler.ast.fdef = undefined
              /* 确保 value 和 members 都指向同一个有 runtime.execute 的 fclos */
              if (memberVal.value) memberVal.value.getHandler = classGetHandler
              if (memberVal.members) memberVal.members.set('getHandler', classGetHandler)
              /* 为静态剪枝注入虚拟 invocation：getHandler fclos 指向每个 handler 实例的 execute/doExecute fclos。
                 目的：checkFclosMatchSink 只递归 invocationMap 的静态 invocation，看不到 runtime.execute；
                 注入后剪枝可沿 getHandler → handler.execute/doExecute 自然递归到 sink。
                 calleeType/fsig/callSiteLiteral 使用特殊前缀，确保不误命中 sink 精确匹配或 dynamic feature。 */
              if (!(classGetHandler.invocationMap instanceof Map)) {
                classGetHandler.invocationMap = new Map()
              }
              const virtualInvocations: Invocation[] = []
              for (const instance of handlerInstances) {
                for (const sid of ['execute', 'doExecute']) {
                  const targetFclos = instance.members?.get(sid) || instance.value?.[sid]
                  if (targetFclos?.vtype !== 'fclos') continue
                  const targetFdef =
                    targetFclos.ast?.fdef ||
                    (Array.isArray(targetFclos.overloaded) && targetFclos.overloaded[0]) ||
                    targetFclos.ast?.node
                  virtualInvocations.push({
                    callSiteLiteral: `<@Handler dispatch virtual>.${sid}`,
                    calleeType: '<@Handler dispatch virtual>',
                    fsig: `<@Handler dispatch virtual>.${sid}`,
                    argTypes: [],
                    callSite: bodyAst,
                    fromScope: memberVal,
                    fromScopeAst: memberVal.ast?.node,
                    toScope: targetFclos,
                    toScopeAst: targetFdef,
                  })
                }
              }
              if (virtualInvocations.length > 0) {
                const virtualNodeHash = `${memberVal.qid}.handler-dispatch-virtual`
                classGetHandler.invocationMap.set(virtualNodeHash, virtualInvocations)
              }
              logger.info(
                '@Handler dispatch virtual invocation: CLASS [%s] getHandler 注入 %d 个虚拟 invocation (execute/doExecute handler fclos) 供静态剪枝递归',
                memberVal.logicalQid || memberVal.qid,
                virtualInvocations.length
              )
              logger.info(
                '@Handler dispatch: 在 CLASS [%s] 的 getHandler 方法上设置 runtime.execute，返回 %d 个 handler 联合体',
                memberVal.logicalQid || memberVal.qid,
                handlerInstances.length
              )
            }
          }
        }
      }
      this.compensateCollectionInjectionInvocations(classVal)
    }
  }

  /**
   * Spring 集合注入的剪枝可见调用补偿。
   * @param classVal 当前 Spring bean class
   */
  compensateCollectionInjectionInvocations(classVal: unknown) {
    if (!isClassValueLike(classVal)) {
      return
    }
    const fields = this.collectAutowiredCollectionFields(classVal)
    if (fields.size === 0) {
      return
    }
    // @Autowired Map 运行时 bean 注入：在 classVal.members 上找到 Map 字段，直接设置为实现类实例
    this.injectMapFieldBeanValues(classVal, fields)

    const functions = this.collectFunctionClosures(classVal)
    for (const fclos of functions) {
      const functionNode = getFunctionNode(fclos)
      if (!functionNode) {
        continue
      }
      const localCollectionTypes = new Map<string, string>()
      this.collectLocalCollectionAliases(functionNode, fields, localCollectionTypes)
      if (localCollectionTypes.size === 0) {
        continue
      }
      const callsites = this.collectCollectionElementCalls(functionNode, localCollectionTypes)
      for (const callsite of callsites) {
        const invocations = this.buildCollectionInjectionInvocations(
          classVal,
          fclos,
          callsite.call,
          callsite.interfaceName
        )
        if (invocations.length === 0) {
          continue
        }
        this.addInvocationsToFclos(fclos, callsite.nodeHash, invocations)
      }
    }
  }

  /**
   * 收集 @Autowired/@Resource List/Collection/Set 字段的元素接口类型。
   * @param classVal 当前 class value
   */
  collectAutowiredCollectionFields(classVal: ClassValueLike): Map<string, string> {
    const result = new Map<string, string>()
    const body = classVal.ast?.node?.body
    if (!Array.isArray(body)) {
      return result
    }
    for (const bodyAst of body) {
      if (!isVariableDeclarationWithIdentifier(bodyAst)) {
        continue
      }
      const modifiers = getModifiers(bodyAst)
      const hasAutowired = modifiers.some((modifier) =>
        this.beanReferenceAnnotationByClass.some((decorator: string) => modifier.includes(decorator))
      )
      if (!hasAutowired) {
        continue
      }
      const collectionName = bodyAst.varType?.id?.name?.split('.').pop()
      if (!collectionName || !['List', 'Collection', 'Set', 'Map'].includes(collectionName)) {
        continue
      }
      const isMapType = collectionName === 'Map'
      const elementType = isMapType ? this.extractMapValueType(bodyAst) : this.extractCollectionElementType(bodyAst)
      if (elementType) {
        result.set(bodyAst.id.name, elementType)
      }
    }
    return result
  }

  /**
   * 优先读取 UAST 泛型；Java UAST 缺失时只读取声明行兜底，失败即放弃补偿。
   * @param node 字段声明节点
   */
  extractCollectionElementType(node: VariableDeclaration): string | undefined {
    const varTypeWithArguments = node.varType as unknown as { typeArguments?: unknown[] } | undefined
    const firstArgument = Array.isArray(varTypeWithArguments?.typeArguments)
      ? varTypeWithArguments.typeArguments[0]
      : undefined
    const typeArgumentName = getTypeIdentifierName(firstArgument)
    if (typeArgumentName) {
      return typeArgumentName
    }
    const sourcefile = node.loc?.sourcefile
    const startLine = node.loc?.start?.line
    if (!sourcefile || !startLine) {
      return undefined
    }
    try {
      const source = fs.readFileSync(sourcefile, 'utf8').split(/\r?\n/)[startLine - 1] || ''
      const match = source.match(/(?:List|Collection|Set)\s*<\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*>/)
      return match?.[1]?.replace(/\s+/g, '')
    } catch (_err) {
      return undefined
    }
  }

  /**
   * 提取 Map<K, V> 字段的 value 类型（第二个泛型参数）。
   * @param node
   */
  extractMapValueType(node: VariableDeclaration): string | undefined {
    const varTypeWithArguments = node.varType as unknown as { typeArguments?: unknown[] } | undefined
    const typeArgs = varTypeWithArguments?.typeArguments
    const secondArgument = Array.isArray(typeArgs) && typeArgs.length >= 2 ? typeArgs[1] : undefined
    const typeArgumentName = getTypeIdentifierName(secondArgument)
    if (typeArgumentName) {
      return typeArgumentName
    }
    const sourcefile = node.loc?.sourcefile
    const startLine = node.loc?.start?.line
    if (!sourcefile || !startLine) {
      return undefined
    }
    try {
      const source = fs.readFileSync(sourcefile, 'utf8').split(/\r?\n/)[startLine - 1] || ''
      const match = source.match(
        /Map\s*<\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*,\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*>/
      )
      return match?.[1]?.replace(/\s+/g, '')
    } catch (_err) {
      return undefined
    }
  }

  /**
   * 收集 class 内真实方法闭包。
   * @param classVal 当前 class value
   */
  collectFunctionClosures(classVal: ClassValueLike): FunctionClosureLike[] {
    const result: FunctionClosureLike[] = []
    const values = classVal.members?.entries?.().map(([, value]) => value) ?? []
    for (const value of values) {
      if (isFunctionClosureLike(value)) {
        result.push(value)
      }
    }
    return result
  }

  /**
   * 收集局部变量到注入集合字段的别名。
   * @param node 方法 AST
   * @param fields 注入集合字段
   * @param output 输出别名表
   */
  collectLocalCollectionAliases(node: Node, fields: Map<string, string>, output: Map<string, string>) {
    const visit = (current: unknown) => {
      if (isVariableDeclarationWithIdentifier(current)) {
        const elementType = this.resolveCollectionElementType(current.init, fields)
        if (elementType) {
          output.set(current.id.name, elementType)
        }
        // Map.get(key) 赋值给局部变量：StrategyExecutor x = mapField.get(key)
        if (!elementType) {
          const mapValueType = this.resolveMapGetValueType(current.init, fields)
          if (mapValueType) {
            output.set(current.id.name, mapValueType)
          }
        }
      }
      visitObjectChildren(current, visit)
    }
    visit(node)
    for (const [fieldName, elementType] of fields) {
      output.set(fieldName, elementType)
    }
  }

  /**
   * 解析局部变量来自哪个注入集合元素类型。
   * @param node 表达式节点
   * @param fields 注入集合字段
   */
  resolveCollectionElementType(node: unknown, fields: Map<string, string>): string | undefined {
    const fieldName = this.resolveDirectCollectionFieldName(node)
    if (fieldName) {
      return fields.get(fieldName)
    }
    if (isConditionalExpressionNode(node)) {
      return (
        this.resolveCollectionElementType(node.consequent, fields) ||
        this.resolveCollectionElementType(node.alternative, fields)
      )
    }
    return undefined
  }

  /**
   * 解析 mapField.get(key) 表达式的 Map value 类型。
   * @param node
   * @param fields
   */
  resolveMapGetValueType(node: unknown, fields: Map<string, string>): string | undefined {
    if (!isCallExpressionNode(node) || !isMemberAccessNode(node.callee)) {
      return undefined
    }
    const methodName = isIdentifierNode(node.callee.property) ? node.callee.property.name : undefined
    if (methodName !== 'get') {
      return undefined
    }
    const mapFieldName = this.resolveDirectCollectionFieldName(node.callee.object)
    return mapFieldName ? fields.get(mapFieldName) : undefined
  }

  /**
   * 解析 this.field / field 形式的集合字段名。
   * @param node 表达式节点
   */
  resolveDirectCollectionFieldName(node: unknown): string | undefined {
    if (isIdentifierNode(node)) {
      return node.name
    }
    if (isMemberAccessNode(node) && isIdentifierNode(node.property)) {
      return node.property.name
    }
    return undefined
  }

  /**
   * 收集增强 for 中集合元素接口调用的真实 callsite。
   * @param functionNode 方法 AST
   * @param localCollectionTypes 集合变量到元素类型
   */
  collectCollectionElementCalls(functionNode: Node, localCollectionTypes: Map<string, string>): CollectionCallsite[] {
    const result: CollectionCallsite[] = []
    const visit = (current: unknown) => {
      if (isRangeStatementNode(current)) {
        this.collectRangeElementCalls(current, localCollectionTypes, result)
      }
      // Map.get(key).method() 模式：map 注入字段调用 get 后对返回值调方法
      if (isCallExpressionNode(current) && isMemberAccessNode(current.callee)) {
        const mapGetReceiver = current.callee.object
        if (isCallExpressionNode(mapGetReceiver) && isMemberAccessNode(mapGetReceiver.callee)) {
          const getMethodName = isIdentifierNode(mapGetReceiver.callee.property)
            ? mapGetReceiver.callee.property.name
            : undefined
          if (getMethodName === 'get') {
            const mapFieldName = this.resolveDirectCollectionFieldName(mapGetReceiver.callee.object)
            const interfaceName = mapFieldName ? localCollectionTypes.get(mapFieldName) : undefined
            if (interfaceName) {
              const nodeHash = getNodeHash(current)
              if (nodeHash) {
                result.push({ call: current, nodeHash, interfaceName })
              }
            }
          }
        }
        // localVar.method() 模式：localVar 是 Map.get 返回值的局部变量
        const receiverName = isIdentifierNode(current.callee.object) ? current.callee.object.name : undefined
        if (receiverName) {
          const interfaceName = localCollectionTypes.get(receiverName)
          if (interfaceName) {
            const nodeHash = getNodeHash(current)
            if (nodeHash) {
              result.push({ call: current, nodeHash, interfaceName })
            }
          }
        }
      }
      visitObjectChildren(current, visit)
    }
    visit(functionNode)
    return result
  }

  /**
   * 处理单个增强 for 的元素 receiver 调用。
   * @param node RangeStatement
   * @param localCollectionTypes 集合变量到元素类型
   * @param output 输出 callsite
   */
  collectRangeElementCalls(
    node: RangeStatement,
    localCollectionTypes: Map<string, string>,
    output: CollectionCallsite[]
  ) {
    const collectionName = isIdentifierNode(node.right) ? node.right.name : undefined
    const interfaceName = collectionName ? localCollectionTypes.get(collectionName) : undefined
    const loopVar = this.resolveRangeValueName(node.value)
    if (!interfaceName || !loopVar) {
      return
    }
    const visitBody = (current: unknown) => {
      if (this.isLoopReceiverCall(current, loopVar)) {
        const nodeHash = getNodeHash(current)
        if (nodeHash) {
          output.push({ call: current, nodeHash, interfaceName })
        }
      }
      visitObjectChildren(current, visitBody)
    }
    visitBody(node.body)
  }

  /**
   * 判断调用是否来自增强 for 的元素变量。
   * @param node 候选节点
   * @param loopVar 增强 for 元素变量名
   */
  isLoopReceiverCall(node: unknown, loopVar: string): node is CallExpression {
    if (!isCallExpressionNode(node) || !isMemberAccessNode(node.callee)) {
      return false
    }
    const receiver = node.callee.object
    return isIdentifierNode(receiver) && receiver.name === loopVar && Boolean(getNodeHash(node))
  }

  /**
   * 解析增强 for 的 value 变量名。
   * @param value RangeStatement.value
   */
  resolveRangeValueName(value: unknown): string | undefined {
    if (isIdentifierNode(value)) {
      return value.name
    }
    if (isVariableDeclarationWithIdentifier(value)) {
      return value.id.name
    }
    return undefined
  }

  /**
   * 为集合元素接口调用构造实现方法 invocation。
   * @param classVal caller 所在 class
   * @param fclos caller fclos
   * @param call 真实 callsite
   * @param interfaceName 集合元素接口类型
   */
  buildCollectionInjectionInvocations(
    classVal: ClassValueLike,
    fclos: FunctionClosureLike,
    call: CallExpression,
    interfaceName: string
  ): Invocation[] {
    const { callee } = call
    const methodName =
      isMemberAccessNode(callee) && isIdentifierNode(callee.property) ? callee.property.name : undefined
    if (!methodName) {
      return []
    }
    const targetShortName = interfaceName.split('.').pop() || interfaceName
    const result: Invocation[] = []
    const beanValues = this.topScope.spring.beanMap.values() as Iterable<unknown>
    for (const beanValue of beanValues) {
      if (!isSpringBeanLike(beanValue)) {
        continue
      }
      const implClassName = beanValue.className
      if (!implClassName) {
        continue
      }
      const implClassUuid = this.classMap.get(implClassName)
      if (!implClassUuid) {
        continue
      }
      const implClassVal = this.symbolTable.get(implClassUuid)
      if (!isClassValueLike(implClassVal) || !this.classImplementsType(implClassVal, targetShortName)) {
        continue
      }
      const targetFclos = getMemberOrValue(implClassVal, methodName)
      if (!isFunctionClosureLike(targetFclos)) {
        continue
      }
      const targetFdef = getFunctionNode(targetFclos)
      if (!targetFdef || targetFdef.body?.type === 'Noop') {
        continue
      }
      this.addExtraClassHierarchyByName(implClassName, interfaceName)
      result.push({
        callSiteLiteral: prettyPrint(call.callee),
        calleeType: implClassName,
        fsig: methodName,
        argTypes: [],
        callSite: call,
        fromScope: fclos,
        fromScopeAst: getFunctionNode(fclos),
        toScope: targetFclos,
        toScopeAst: targetFdef,
      })
    }
    return result
  }

  /**
   * 判断实现类 AST supers 是否包含目标接口。
   * @param classVal 候选实现 class value
   * @param targetShortName 接口短名
   */
  classImplementsType(classVal: ClassValueLike, targetShortName: string): boolean {
    const supers = classVal.ast?.node?.supers
    if (!Array.isArray(supers)) {
      return false
    }
    return supers.some((superAst) => isRecord(superAst) && superAst.name === targetShortName)
  }

  /**
   * 向 caller fclos 的真实 callsite nodehash 合并 invocation，避免重复写入。
   * @param fclos caller fclos
   * @param nodeHash 真实 callsite nodehash
   * @param invocations 待写入 invocation
   */
  addInvocationsToFclos(fclos: FunctionClosureLike, nodeHash: string | undefined, invocations: Invocation[]) {
    if (!nodeHash || invocations.length === 0) {
      return
    }
    if (!(fclos.invocationMap instanceof Map)) {
      fclos.invocationMap = new Map<string, Invocation[]>()
    }
    const existed = fclos.invocationMap.get(nodeHash)
    const merged = Array.isArray(existed) ? [...existed] : []
    for (const invocation of invocations) {
      const duplicate = merged.some(
        (item) =>
          item.toScope === invocation.toScope &&
          item.toScopeAst?._meta?.nodehash === invocation.toScopeAst?._meta?.nodehash
      )
      if (!duplicate) {
        merged.push(invocation)
      }
    }
    fclos.invocationMap.set(nodeHash, merged)
  }

  /**
   * find bean name from sequence expr
   * @param expr
   */
  findBeanNameFromSequenceExpr(expr: Expr | Stmt | Decl): string | undefined {
    let beanName: string | undefined
    if (expr.type === 'Literal' && (expr as Literal).value) {
      beanName = (expr as Literal).value as string
    } else if (expr.type === 'AssignmentExpression' && (expr as AssignmentExpression).right?.type === 'Literal') {
      const leftStr = AstUtil.prettyPrintAST((expr as AssignmentExpression).left)
      if (leftStr?.endsWith('value') || leftStr?.endsWith('uniqueId')) {
        beanName = ((expr as AssignmentExpression).right as Literal).value as string
      }
    } else if (expr.type === 'ScopedStatement' && Array.isArray((expr as ScopedStatement).body)) {
      for (const subExpr of (expr as ScopedStatement).body) {
        beanName = this.findBeanNameFromSequenceExpr(subExpr)
        if (beanName) {
          break
        }
      }
    }
    return beanName
  }
}

export = SpringAnalyzer
