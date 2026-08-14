export type SpringExecutionState<TSym, TScope> = {
  entryPointSymVal?: TSym
  scopeVal?: TScope
}

export type SpringExecutionClone<TSym, TScope> = {
  entryPointSymVal: TSym
  scopeVal: TScope
  restore: () => void
}

/** 为单次 Spring 入口执行建立独立值，并保证原始入口状态可恢复。 */
export function cloneSpringExecutionState<TSym, TScope>(
  state: SpringExecutionState<TSym, TScope>,
  clone: <TValue>(value: TValue | undefined) => TValue,
): SpringExecutionClone<TSym, TScope> {
  const originalEntryPointSymVal = state.entryPointSymVal
  const originalScopeVal = state.scopeVal
  const executionSymVal = clone(originalEntryPointSymVal)
  const executionScopeVal = clone(originalScopeVal)
  state.entryPointSymVal = executionSymVal
  state.scopeVal = executionScopeVal
  return {
    entryPointSymVal: executionSymVal,
    scopeVal: executionScopeVal,
    restore: () => {
      state.entryPointSymVal = originalEntryPointSymVal
      state.scopeVal = originalScopeVal
    },
  }
}
