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
  static initEgg(moduleManager) {
    const egg = Scoped({
      parent: moduleManager,
      sid: 'Egg',
    })
    moduleManager.setFieldValue('Egg', egg)

    // Application
    egg.setFieldValue(
      'Application',
      Scoped({
        vtype: 'class',
        parent: egg,
        sid: 'Egg.Application',
        fdef: {
          type: 'ClassDefinition',
          body: [],
        },
      })
    )

    // Context
    egg.setFieldValue(
      'Context',
      Scoped({
        vtype: 'class',
        parent: egg,
        sid: 'Egg.Context',
        fdef: {
          type: 'ClassDefinition',
          body: [],
        },
      })
    )
  }

  /**
   * builtin variables and constants for the top global
   * @param global
   */
  static initGlobalScope(global) {
    global.setFieldValue(
      'app',
      Scoped({
        readonly: false,
        sid: 'egg_application',
        parent: global,
      })
    )
    global.setFieldValue(
      'ctx',
      Scoped({
        readonly: false,
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
  static assignConfig(topScope, configVal) {
    if (!configVal) return
    // defensive
    const { app } = topScope.value
    if (!app) {
      EggInitializer.initGlobalScope(topScope)
    }
    const config = (topScope.value.config =
      topScope.value.config ||
      ObjectValue({
        sid: 'config',
      }))
    Object.assign(config.value, configVal.vtype ? configVal.value : configVal)
    app.value.config = config
  }

  /**
   *
   * @param scope
   */
  static introduceGlobalBuiltin(scope) {
    super.introduceGlobalBuiltin(scope)
  }

  /**
   * Reset / reinit global variables.
   * Particularly, reset the the line trace
   * @param node
   * @param res
   * @param scope
   */
  static resetInitVariables(scope) {
    for (const field of Object.keys(scope.value)) {
      const v = scope.value[field]
      if (v.trace) delete v.trace
    }
  }
}

module.exports = EggInitializer
