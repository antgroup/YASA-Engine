import { buildCallSummaryRiskContext } from '../keys'
import type { CallSummaryRiskContext } from '../types'
import type { CallSummaryLanguagePolicy, CallSummaryLanguagePolicyContext } from './types'

// 无语言特化时只使用通用 positive-replay-only 风险边界。
function buildDefaultCallSummaryRiskContext(
  _context: CallSummaryLanguagePolicyContext
): CallSummaryRiskContext {
  return buildCallSummaryRiskContext({ sideEffectRisk: 'positive-replay-only' })
}

export const defaultCallSummaryPolicy: CallSummaryLanguagePolicy = {
  buildRiskContext: buildDefaultCallSummaryRiskContext,
}
