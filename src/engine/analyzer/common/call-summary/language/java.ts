import type { CallInfo } from '../../call-args'
import type { BaseNode } from '../../../../../types/uast'
import { buildCallSummaryRiskContext } from '../keys'
import type { CallSummaryRiskContext } from '../types'
import { defaultCallSummaryPolicy } from './default'
import type { CallSummaryLanguagePolicy, CallSummaryLanguagePolicyContext } from './types'

type CallArgsWithNode = NonNullable<CallInfo['callArgs']> & { readonly node?: BaseNode }

interface CallsiteLocation {
  readonly start?: { readonly line?: number; readonly column?: number }
  readonly end?: { readonly line?: number; readonly column?: number }
}

function getJavaCallNode(context: CallSummaryLanguagePolicyContext): BaseNode | undefined {
  return (context.callInfo?.callArgs as CallArgsWithNode | undefined)?.node
}

function buildJavaCallsiteShape(callNode: BaseNode | undefined): string {
  const loc = (callNode as { readonly loc?: CallsiteLocation } | undefined)?.loc
  return loc
    ? `${callNode?.type ?? 'call'}@${loc.start?.line ?? 0}:${loc.start?.column ?? 0}:${loc.end?.line ?? 0}:${loc.end?.column ?? 0}`
    : `${callNode?.type ?? 'callsite'}_unknown`
}

// Java policy 实现封装 callsite、member 与 receiver 风险形态。
function buildJavaCallSummaryRiskContext(
  context: CallSummaryLanguagePolicyContext
): CallSummaryRiskContext {
  const base = defaultCallSummaryPolicy.buildRiskContext(context)
  const callInfo = context.callInfo
  const callsiteShape = buildJavaCallsiteShape(getJavaCallNode(context))
  return buildCallSummaryRiskContext({
    ...base,
    callKind: callInfo?.callArgs?.receiver ? 'member' : 'direct',
    receiverShape: callInfo?.callArgs?.receiver ? 'receiver' : 'none',
    sideEffectRisk: `${base.sideEffectRisk}-${callsiteShape}`,
  })
}

export const javaCallSummaryPolicy: CallSummaryLanguagePolicy = {
  getCallNode: getJavaCallNode,
  buildRiskContext: buildJavaCallSummaryRiskContext,
}
