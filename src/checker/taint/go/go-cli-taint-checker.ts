import type { CallInfo } from '../../../engine/analyzer/common/call-args'

const GoDefaultTaintChecker = require('./go-default-taint-checker')
const BasicRuleHandler = require('../../common/rules-basic-handler')
const Config = require('../../../config')
const AstUtil = require('../../../util/ast-util')
const IntroduceTaint = require('../common-kit/source-util')
const entryPointConfig = require('../../../engine/analyzer/common/entrypoint/current-entrypoint')

const TAINT_TAG_NAME = 'GO_INPUT'
const COBRA_ACTION_NAMES = new Set(['PreRun', 'PreRunE', 'PersistentPreRun', 'PersistentPreRunE', 'Run', 'RunE'])
const COBRA_GETTER_NAMES = new Set(['GetString', 'GetBool', 'GetInt', 'GetStringSlice'])
const GO_RULE_FALLBACK_CHECKER_IDS = new Set([
  'taint_flow_go_input',
  'taint_flow_go_http_input',
  'taint_flow_gin_input',
  'taint_flow_gin_input_inner',
])
const COBRA_VAR_BINDING_NAMES = new Set([
  'StringVar',
  'StringVarP',
  'BoolVar',
  'BoolVarP',
  'IntVar',
  'IntVarP',
  'StringSliceVar',
  'StringSliceVarP',
])

type AstNodeLike = {
  type?: string
  name?: string
  id?: AstNodeLike
  property?: AstNodeLike
  callee?: AstNodeLike
  loc?: unknown
}

type AnalyzerLike = {
  processInstruction(entryPointSymVal: unknown, node: unknown, state: unknown): unknown
}

type FunctionCallBeforeInfo = {
  fclos?: { qid?: string; object?: unknown }
  callInfo?: CallInfo
}

type FunctionCallInfo = FunctionCallBeforeInfo & {
  ret?: unknown
}

type EntryPointLike = {
  functionName?: string
  entryPointSymVal?: {
    ast?: {
      node?: {
        parameters?: unknown[]
      }
    }
  }
}

type PendingBoundVariableSource = {
  target: unknown
  path: AstNodeLike
}

function getCalleeName(node: AstNodeLike | undefined): string | undefined {
  const callee = node?.callee
  if (!callee) return undefined
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberAccess') {
    return callee.property?.name
  }
  return undefined
}

function getCallArgValue(callInfo: CallInfo | undefined, index: number): unknown {
  return callInfo?.callArgs?.args?.find((arg) => arg.index === index)?.value
}

function isCobraActionEntryPoint(entryPoint: EntryPointLike | undefined): boolean {
  if (!entryPoint) return false
  const functionName = entryPoint.functionName
  if (typeof functionName === 'string' && COBRA_ACTION_NAMES.has(functionName)) return true
  const parameters = entryPoint.entryPointSymVal?.ast?.node?.parameters
  return Array.isArray(parameters) && parameters.length >= 2
}

function getParameterId(parameter: unknown): unknown {
  if (parameter && typeof parameter === 'object' && 'id' in parameter) {
    const astParameter = parameter as AstNodeLike
    return astParameter.id || parameter
  }
  return parameter
}

/**
 * Go CLI/script 污点追踪 checker
 * Source: os.Args、Cobra action args、pflag GetString/GetBool、StringVar/BoolVar 绑定变量。
 */
class GoCliTaintChecker extends GoDefaultTaintChecker {
  private readonly pendingBoundVariableSources: PendingBoundVariableSource[] = []

  private cliRuleConfigInitialized = false

  constructor(resultManager: unknown) {
    super(resultManager, 'taint_flow_go_cli_input')
  }

  private markCliSource(target: unknown, path: unknown): void {
    IntroduceTaint.markTaintSource(target, { path, kind: TAINT_TAG_NAME })
  }

  private markOrDeferBoundVariableSource(target: unknown, path: AstNodeLike): void {
    if (BasicRuleHandler.getPreprocessReady()) {
      this.markCliSource(target, path)
      return
    }

    this.pendingBoundVariableSources.push({ target, path })
  }

  private flushPendingBoundVariableSources(): void {
    if (!BasicRuleHandler.getPreprocessReady() || this.pendingBoundVariableSources.length === 0) return

    const pendingSources = this.pendingBoundVariableSources.splice(0)
    for (const pendingSource of pendingSources) {
      this.markCliSource(pendingSource.target, pendingSource.path)
    }
  }

  private ensureCliRuleConfigContent(): void {
    if (this.cliRuleConfigInitialized) return
    this.cliRuleConfigInitialized = true

    const existingSinks = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (Array.isArray(existingSinks) && existingSinks.length > 0) return

    const fallbackSinks = BasicRuleHandler.getRules()
      .filter((rule: { checkerIds?: string[] | string }) => {
        const checkerIds = Array.isArray(rule.checkerIds) ? rule.checkerIds : [rule.checkerIds]
        return checkerIds.some((checkerId) => typeof checkerId === 'string' && GO_RULE_FALLBACK_CHECKER_IDS.has(checkerId))
      })
      .flatMap((rule: { sinks?: { FuncCallTaintSink?: unknown[] } }) => rule.sinks?.FuncCallTaintSink ?? [])

    if (fallbackSinks.length === 0) return
    this.checkerRuleConfigContent.sinks = this.checkerRuleConfigContent.sinks || {}
    this.checkerRuleConfigContent.sinks.FuncCallTaintSink = fallbackSinks
  }

  triggerAtSymbolInterpretOfEntryPointBefore(
    analyzer: AnalyzerLike,
    scope: unknown,
    node: unknown,
    state: unknown,
    info: { entryPoint?: EntryPointLike }
  ): void {
    if (Config.entryPointMode === 'ONLY_CUSTOM') return
    const entryPoint = info.entryPoint || entryPointConfig.getCurrentEntryPoint()
    if (!isCobraActionEntryPoint(entryPoint)) return

    const actionArgsParam = entryPoint.entryPointSymVal?.ast?.node?.parameters?.[1]
    const actionArgsId = getParameterId(actionArgsParam)
    if (!actionArgsId) return

    const actionArgs = analyzer.processInstruction(entryPoint.entryPointSymVal, actionArgsId, state)
    this.markCliSource(actionArgs, actionArgsId)
  }

  triggerAtFunctionCallBefore(
    analyzer: unknown,
    scope: unknown,
    node: AstNodeLike,
    state: unknown,
    info: FunctionCallBeforeInfo
  ): void {
    this.flushPendingBoundVariableSources()
    this.ensureCliRuleConfigContent()
    super.checkByNameAndClassMatch(node, info.fclos, info.callInfo, scope, state)
    if (Config.entryPointMode === 'ONLY_CUSTOM') return

    const calleeName = getCalleeName(node)
    if (!calleeName || !COBRA_VAR_BINDING_NAMES.has(calleeName)) return

    const boundVariable = getCallArgValue(info.callInfo, 0)
    if (boundVariable) {
      this.markOrDeferBoundVariableSource(boundVariable, node)
    }
  }

  triggerAtFunctionCallAfter(
    analyzer: unknown,
    scope: unknown,
    node: AstNodeLike,
    state: unknown,
    info: FunctionCallInfo
  ): void {
    this.flushPendingBoundVariableSources()
    if (Config.entryPointMode === 'ONLY_CUSTOM' || !info.ret) return

    const calleeName = getCalleeName(node)
    if (calleeName && COBRA_GETTER_NAMES.has(calleeName)) {
      this.markCliSource(info.ret, node)
      return
    }

    const qid = info.fclos?.qid
    if (typeof qid === 'string' && /\.(GetString|GetBool|GetInt|GetStringSlice)$/.test(qid)) {
      this.markCliSource(info.ret, node)
    }
  }

  triggerAtMemberAccess(
    analyzer: unknown,
    scope: unknown,
    node: AstNodeLike,
    state: unknown,
    info: { res?: unknown }
  ): void {
    this.flushPendingBoundVariableSources()
    if (Config.entryPointMode === 'ONLY_CUSTOM') return

    if (AstUtil.prettyPrintAST(node) === 'os.Args') {
      this.markCliSource(info.res, node)
    }
  }
}

module.exports = GoCliTaintChecker
module.exports.isCobraActionEntryPoint = isCobraActionEntryPoint
