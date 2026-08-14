import { defaultCallSummaryPolicy } from './default'
import type { CallSummaryLanguagePolicy } from './types'

// Go 当前没有语言特化，显式复用 default policy 保持固定语言落点。
export const goCallSummaryPolicy: CallSummaryLanguagePolicy = defaultCallSummaryPolicy
