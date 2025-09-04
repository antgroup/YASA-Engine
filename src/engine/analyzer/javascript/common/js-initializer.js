const {
  valueUtil: {
    ValueUtil: { ObjectValue, FunctionValue, Scoped },
  },
} = require('../../common')
const { processRequire } = require('./builtins/require')
const { processFunctionApply, processFunctionCall } = require('./builtins/function')
const { processPromise } = require('./builtins/promise')
const { processVisitArray, processArrayPush } = require('./builtins/array-builtins')
const { processReflectGet, processReflectDelete, processReflectSet } = require('./builtins/reflect-builtins')
const { processNewSet } = require('./builtins/set-builtins')
const { processNewMap } = require('./builtins/map-builtins')
const config = require('../../../../config')

/**
 *
 */
class JsInitializer {
  static builtin = {
    require: processRequire,
    'function.apply': processFunctionApply,
    'function.call': processFunctionCall,
    Promise: processPromise,
    visitArray: processVisitArray,
    push: processArrayPush,
    'Reflect.get': processReflectGet,
    'Reflect.set': processReflectSet,
    'Reflect.deleteProperty': processReflectDelete,
    newSet: processNewSet,
    newMap: processNewMap,
  }

  /**
   * 1. builtins variables and constants for the top global
   *    like JSON, Math Reflect, console, etc.
   * 2. introduce taint
   *
   * @param global
   */
  static initGlobalScope(global) {
    // Initializer.introduceVariableTaint(global);
    JsInitializer.introduceGlobalBuiltin(global)
  }

  /**
   *
   * 注意
   * 访问field中名为prototype的属性时，为了避免引起预期外的行为(访问到fields真正的原型了)
   * 一律使用field['prototype']  而不是field.prototype
   *
   * @param scope
   * @param builtinMap
   * @param varType
   */
  static initInnerFunctionBuiltin(scope, builtinMap, varType) {
    scope.setFieldValue(
      'prototype',
      ObjectValue({
        id: 'prototype',
        sid: 'prototype',
        qid: 'prototype',
        parent: scope,
      })
    )
    for (const funcName of Object.keys(builtinMap)) {
      const qqid = varType != null ? `${varType}.${funcName}` : funcName
      scope.field.prototype.setFieldValue(
        funcName,
        FunctionValue({
          sid: funcName,
          qid: qqid,
          parent: scope,
          execute: builtinMap[funcName],
        })
      )
    }
  }

  // 初始化反射建模
  /**
   *
   * @param scope
   */
  static initReflectBuiltin(scope) {
    scope.setFieldValue(
      'Reflect',
      ObjectValue({
        sid: 'Reflect',
        qid: 'Reflect',
        parent: scope,
        execute: JsInitializer.builtin.Reflect,
      })
    )

    const initBuiltinFuncList = ['get', 'set', 'deleteProperty', 'defineProperty']
    for (let func of initBuiltinFuncList) {
      if (func === 'defineProperty') {
        func = 'set'
      }
      scope.field.Reflect.setFieldValue(
        func,
        FunctionValue({
          sid: func,
          qid: `Reflect.${func}`,
          parent: scope,
          execute: JsInitializer.builtin[`Reflect.${func}`],
        })
      )
    }
  }

  // 初始化数组建模
  /**
   *
   * @param scope
   */
  static initArrayBuiltin(scope) {
    const builtinMap = {
      push: processArrayPush,
      forEach: processVisitArray,
      some: processVisitArray,
      every: processVisitArray,
    }
    JsInitializer.initInnerFunctionBuiltin(scope, builtinMap, 'Array')
  }

  /**
   *
   * @param scope
   */
  static initSetBuiltin(scope) {
    scope.setFieldValue(
      'Set',
      ObjectValue({
        sid: 'Set',
        parent: scope,
        execute: JsInitializer.builtin.newSet,
      })
    )
  }

  /**
   *
   * @param scope
   */
  static initMapBuiltin(scope) {
    scope.setFieldValue(
      'Map',
      ObjectValue({
        sid: 'Map',
        parent: scope,
        execute: JsInitializer.builtin.newMap,
      })
    )
  }

  /**
   *
   * @param scope
   */
  static initVMBuiltin(scope) {
    const vm2 = ObjectValue({
      id: 'vm2',
      sid: 'vm2',
      qid: `vm2.`,
      parent: scope,
    })
    scope.setFieldValue('vm2', vm2)
    const VM = ObjectValue({
      id: 'VM',
      sid: 'VM',
      qid: `vm2.VM`,
      parent: scope,
    })
    vm2.setFieldValue('VM', VM)
    VM.setFieldValue(
      'run',
      FunctionValue({
        id: 'run',
        sid: 'run',
        qid: `vm2.VM.run`,
        parent: VM,
      })
    )
  }

  /**
   *
   * @param scope
   */
  static introduceGlobalBuiltin(scope) {
    // TODO Global builtins modeling
    scope.setFieldValue('Object', ObjectValue({ sid: 'Object' }))
    scope.setFieldValue('Array', ObjectValue({ sid: 'Array' }))
    // scope.setFieldValue('Set', ObjectValue({ sid: 'Set' }))
    scope.setFieldValue('Map', ObjectValue({ sid: 'Map' }))
    scope.setFieldValue('JSON', ObjectValue({ sid: 'JSON' }))
    scope.setFieldValue('Math', ObjectValue({ sid: 'Math' }))
    scope.setFieldValue('Date', ObjectValue({ sid: 'Date' }))
    scope.setFieldValue('console', ObjectValue({ sid: 'console' }))
    scope.setFieldValue('__dirname', ObjectValue({ sid: '__dirname' }))
    scope.setFieldValue('process', ObjectValue({ sid: 'process' }))
    scope.setFieldValue('Symbol', ObjectValue({ sid: 'Symbol' }))
    const requireFuncVal = FunctionValue({
      sid: 'require',
      qid: 'require',
      parent: scope,
      execute: JsInitializer.builtin.require,
    })
    scope.setFieldValue('require', requireFuncVal)
    if (scope.funcSymbolTable) {
      // eslint-disable-next-line no-param-reassign
      scope.funcSymbolTable.require = requireFuncVal
    }
    const promiseFuncVal = FunctionValue({
      sid: 'Promise',
      qid: 'Promise',
      parent: scope,
      execute: JsInitializer.builtin.Promise,
    })
    scope.setFieldValue('Promise', promiseFuncVal)
    if (scope.funcSymbolTable) {
      // eslint-disable-next-line no-param-reassign
      scope.funcSymbolTable.Promise = promiseFuncVal
    }
    // 新增的建模
    // Initializer.initArrayBuiltin(scope)
    JsInitializer.initReflectBuiltin(scope)
    JsInitializer.initSetBuiltin(scope)
    JsInitializer.initMapBuiltin(scope)
    JsInitializer.initVMBuiltin(scope)
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

module.exports = JsInitializer
