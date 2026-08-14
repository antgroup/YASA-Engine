const ScriptTaintChecker = require('./script-taint-checker')

class SkillScriptTaintChecker extends ScriptTaintChecker {
  constructor(resultManager: unknown) {
    super(resultManager, 'taint_flow_python_skill_script_input', true)
  }

  triggerAtStartOfAnalyze(analyzer: unknown, scope: unknown, node: unknown, state: unknown, info: unknown): void {
    super.triggerAtStartOfAnalyze(analyzer, scope, node, state, info)
  }

  triggerAtFunctionCallAfter(analyzer: unknown, scope: unknown, node: unknown, state: unknown, info: unknown): void {
    super.triggerAtFunctionCallAfter(analyzer, scope, node, state, info)
  }

  triggerAtMemberAccess(analyzer: unknown, scope: unknown, node: unknown, state: unknown, info: unknown): void {
    super.triggerAtMemberAccess(analyzer, scope, node, state, info)
  }
}

module.exports = SkillScriptTaintChecker
