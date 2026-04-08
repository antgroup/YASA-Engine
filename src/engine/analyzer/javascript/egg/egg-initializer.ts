const JsInitializer = require('../common/js-initializer')
const {
  valueUtil: {
    ValueUtil: { ObjectValue, Scoped },
  },
} = require('../../common')

/**
 *
 */
class EggInitializer extends JsInitializer {
  static builtin = {
    ...super.builtin,
  }

  /**
   *
   * @param moduleManager
   */
  static initEgg(moduleManager: any) {
    const egg = new Scoped(moduleManager.qid, {
      parent: moduleManager,
      sid: 'Egg',
    })
    moduleManager.setFieldValue('Egg', egg)

    // Application
    const appClass = new Scoped(egg.qid, {
      vtype: 'class',
      parent: egg,
      sid: 'Application',
    })
    appClass.ast.fdef = { type: 'ClassDefinition', body: [] }
    egg.setFieldValue('Application', appClass)

    const ctxClass = new Scoped(egg.qid, {
      vtype: 'class',
      parent: egg,
      sid: 'Context',
    })
    ctxClass.ast.fdef = { type: 'ClassDefinition', body: [] }
    egg.setFieldValue('Context', ctxClass)
  }

  /**
   * builtin variables and constants for the top global
   * @param global
   */
  static initGlobalScope(global: any) {
    global.setFieldValue(
      'app',
      new Scoped(global.qid, {
        runtime: { readonly: false },
        sid: 'egg_application',
        parent: global,
      })
    )
    global.setFieldValue(
      'ctx',
      new Scoped(global.qid, {
        runtime: { readonly: false },
        sid: 'ctx_template',
        parent: global,
      })
    )

    // introduceVariableTaint(global);
    EggInitializer.introduceGlobalBuiltin(global)
  }

  /**
   *
   * @param topScope
   * @param configVal
   */
  static assignConfig(topScope: any, configVal: any) {
    if (!configVal) return
    // defensive
    const { app } = topScope.value
    if (!app) {
      EggInitializer.initGlobalScope(topScope)
    }
    const config = (topScope.value.config =
      topScope.value.config ||
      new ObjectValue(topScope.qid, {
        sid: 'config',
      }))
    const configSource = configVal.vtype ? configVal.value : configVal
    if (configSource && typeof configSource === 'object') {
      for (const [key, value] of Object.entries(configSource)) {
        config.members.set(key, value as any)
      }
    }
    app.value.config = config
  }

  /**
   *
   * @param scope
   */
  static introduceGlobalBuiltin(scope: any) {
    super.introduceGlobalBuiltin(scope)
  }

  /**
   * Reset / reinit global variables.
   * Particularly, reset the the line trace
   * @param node
   * @param res
   * @param scope
   */
  static resetInitVariables(scope: any) {
    for (const field of Object.keys(scope.value)) {
      const v = scope.value[field]
      if (v.taint) v.taint.clearTrace()
    }
  }
}

export = EggInitializer
