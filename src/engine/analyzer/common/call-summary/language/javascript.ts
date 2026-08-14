import type { CallInfo } from '../../call-args'
import type { CallSummaryRiskContext } from '../types'
import type { CallSummaryLanguagePolicy, CallSummaryLanguagePolicyContext } from './types'
import type { Scope } from '../../../../../types/analyzer'
import type { BaseNode, CallExpression } from '../../../../../types/uast'

type CallArgsWithNode = NonNullable<CallInfo['callArgs']> & { readonly node?: BaseNode }

function getAstParent(node: BaseNode | undefined): BaseNode | undefined {
  return (node as { readonly parent?: BaseNode } | undefined)?.parent
}

function getJsCallKind(node: BaseNode | undefined): string {
  if (!node || node.type !== 'CallExpression') return 'unknown'
  const callNode = node as CallExpression
  if (callNode.callee?.type === 'Identifier') return 'direct'
  if (callNode.callee?.type === 'MemberAccess') return 'member'
  return callNode.callee?.type ?? 'unknown'
}

function isSummaryTaintedValue(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const record = value as {
    readonly _taint?: { readonly isTaintedRec?: boolean }
    readonly taint?: { readonly isTaintedRec?: boolean }
  }
  return Boolean(record._taint?.isTaintedRec || record.taint?.isTaintedRec)
}

function getJsArgEffectShape(callInfo: CallInfo | undefined): string {
  const args = callInfo?.callArgs?.args ?? []
  return args.some((arg) => isSummaryTaintedValue(arg.value)) ? 'effectful' : 'plain'
}

function isResultIgnoredExpressionStatement(node: BaseNode): boolean {
  let cur: BaseNode = node
  let parent = getAstParent(cur)
  while (parent?.type === 'ParenthesizedExpression' || parent?.type === 'ChainExpression') {
    cur = parent
    parent = getAstParent(parent)
  }
  return parent?.type === 'ExpressionStatement' && (parent as { readonly expression?: BaseNode }).expression === cur
}

function isTopLevelCallsite(callNode: BaseNode | undefined): boolean {
  let parent = getAstParent(callNode)
  while (parent?.type === 'ParenthesizedExpression' || parent?.type === 'ChainExpression' || parent?.type === 'ExpressionStatement') {
    parent = getAstParent(parent)
  }
  return parent?.type === 'CompileUnit'
}

function getJsCallNode(context: CallSummaryLanguagePolicyContext): BaseNode | undefined {
  return (context.callInfo?.callArgs as CallArgsWithNode | undefined)?.node
}

function isModuleInitScope(scope: Scope | undefined, callNode: BaseNode | undefined): boolean {
  if (isTopLevelCallsite(callNode)) return true
  const qid = typeof scope?.qid === 'string' ? scope.qid : ''
  return qid === '<global>' || qid.endsWith('.<global>') || qid.includes('module.exports')
}

// JS policy 实现封装 module-init 禁用原因与调用形态风险。
function buildJsCallSummaryRiskContext(
  context: CallSummaryLanguagePolicyContext
): CallSummaryRiskContext {
  const { scope, fclos, callInfo } = context
  const callNode = getJsCallNode(context)
  const callKind = getJsCallKind(callNode)
  const receiverShape = callInfo?.callArgs?.receiver ? 'receiver' : 'none'
  const argEffectShape = getJsArgEffectShape(callInfo)
  const resultUse = callNode ? (isResultIgnoredExpressionStatement(callNode) ? 'ignored' : 'used') : 'unknown'
  const scopeShape = isModuleInitScope(scope, callNode) ? 'module_init' : 'scoped_call'
  const repeatedEffectShape = [
    scopeShape,
    callKind,
    receiverShape,
    argEffectShape,
    resultUse,
    fclos && callInfo ? 'call_facts' : 'missing_facts',
  ].join('_')
  return { callKind, receiverShape, argEffectShape, resultUse, sideEffectRisk: repeatedEffectShape }
}

export const jsCallSummaryPolicy: CallSummaryLanguagePolicy = {
  getCallNode: getJsCallNode,
  buildRiskContext: buildJsCallSummaryRiskContext,
  getDisabledReason: (context, callNode) => isModuleInitScope(context.scope, callNode) ? 'js-module-init-unmodelled' : undefined,
}
