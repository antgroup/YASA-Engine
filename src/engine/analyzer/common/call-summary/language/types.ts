import type { CallInfo } from '../../call-args'
import type { Scope, State, Value } from '../../../../../types/analyzer'
import type { BaseNode } from '../../../../../types/uast'
import type { CallSummaryRiskContext } from '../types'

// 语言无关的 policy 上下文携带 state，让语言实现独立构造完整 key/risk，Analyzer 不感知语言语义。
export interface CallSummaryLanguagePolicyContext {
  readonly scope: Scope
  readonly fclos: Value | undefined
  readonly callInfo: CallInfo | undefined
  readonly state: State
}

// 固定扩展点只定义通用边界，具体语言只注册各自实现对象。
export interface CallSummaryLanguagePolicy {
  readonly getCallNode?: (context: CallSummaryLanguagePolicyContext) => BaseNode | undefined
  readonly buildRiskContext: (context: CallSummaryLanguagePolicyContext) => CallSummaryRiskContext
  readonly getDisabledReason?: (
    context: CallSummaryLanguagePolicyContext,
    callNode: BaseNode | undefined
  ) => string | undefined
}
