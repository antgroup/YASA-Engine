import { DEFAULT_CALL_SUMMARY_STAGE_CONFIG } from './types'
import type { CallSummaryStageConfig, CallSummaryStrategy } from './types'

/**
 * 获取阶段 call summary 策略。
 * @param stage 调用阶段
 * @param config 阶段配置
 * @returns {CallSummaryStrategy} 阶段策略
 */
export function getCallSummaryStrategy(
  stage: string,
  config: CallSummaryStageConfig | undefined = DEFAULT_CALL_SUMMARY_STAGE_CONFIG
): CallSummaryStrategy {
  return config?.[stage] ?? DEFAULT_CALL_SUMMARY_STAGE_CONFIG[stage] ?? 'bypass'
}
