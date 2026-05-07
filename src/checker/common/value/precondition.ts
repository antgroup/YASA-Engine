/** ruleconfig 中的前置条件定义，语义为"taint 必须经过此函数，sink 才有效"；sink rule 声明多个 preconditionIds 时采用 OR 语义——taint 命中任一即可 */
interface Precondition {
  /** 唯一标识，与 sink rule 中 preconditionIds 对应（sink rule 声明多个 id 时为 OR 语义） */
  id: string
  /** 前置条件类型，如 FunctionCallPrecondition */
  preconditionType: string
  /** 前置条件场景，如 PRECONDITION.VALIDATE_BY_FUNCTIONCALL */
  preconditionScenario: string
  /** 被调用方类型，用于函数匹配 */
  calleeType?: string
  /** 函数签名，用于函数匹配 */
  fsig?: string
  /** 参数位置列表 */
  args?: (string | number)[]
  /** 参数数量约束（复用 sanitizer 匹配逻辑） */
  argNum?: number
  /** 正则匹配（复用 sanitizer 匹配逻辑） */
  fregex?: string
}

/**
 * 将 Precondition 转换为 sanitizer 匹配函数兼容的格式
 * sanitizerType 映射自 preconditionType，sanitizerScenario 映射自 preconditionScenario
 */
interface PreconditionAsSanitizer extends Precondition {
  sanitizerType: string
  sanitizerScenario: string
}

/** 将 precondition 转换为 sanitizer 匹配兼容对象 */
function toPreconditionAsSanitizer(p: Precondition): PreconditionAsSanitizer {
  const TYPE_MAP: Record<string, string> = {
    FunctionCallPrecondition: 'FunctionCallSanitizer',
  }
  const SCENARIO_MAP: Record<string, string> = {
    'PRECONDITION.VALIDATE_BY_FUNCTIONCALL': 'SANITIZER.VALIDATE_BY_FUNCTIONCALL',
  }
  return {
    ...p,
    sanitizerType: TYPE_MAP[p.preconditionType] ?? p.preconditionType,
    sanitizerScenario: SCENARIO_MAP[p.preconditionScenario] ?? p.preconditionScenario,
  }
}

export type { Precondition, PreconditionAsSanitizer }
export { toPreconditionAsSanitizer }
