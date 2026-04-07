const {
  valueUtil: {
    ValueUtil: { ObjectValue, FunctionValue },
  },
} = require('../../common')
const { processRequire } = require('./builtins/require')
const { processFunctionApply, processFunctionCall } = require('./builtins/function')
const { processPromise } = require('./builtins/promise')
const { processVisitArray, processArrayPush } = require('./builtins/array-builtins')
const { processReflectGet, processReflectDelete, processReflectSet } = require('./builtins/reflect-builtins')
const { processNewSet } = require('./builtins/set-builtins')
const { processNewMap } = require('./builtins/map-builtins')

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
  static initGlobalScope(global: any): void {
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
  static initInnerFunctionBuiltin(scope: any, builtinMap: Record<string, any>, varType: string): void {
    scope.setFieldValue(
      'prototype',
      new ObjectValue(scope.qid, {
        sid: 'prototype',
        parent: scope,
      })
    )
    for (const funcName of Object.keys(builtinMap)) {
      const qqid = varType != null ? `${varType}.${funcName}` : funcName
      scope.members.get('prototype')!.setFieldValue(
        funcName,
        new FunctionValue('', {
          sid: funcName,
          qid: qqid,
          parent: scope,
          runtime: { execute: builtinMap[funcName] },
        })
      )
    }
  }

  // 初始化反射建模
  /**
   *
   * @param scope
   */
  static initReflectBuiltin(scope: any): void {
    scope.setFieldValue(
      'Reflect',
      new ObjectValue('', {
        sid: 'Reflect',
        qid: 'Reflect',
        parent: scope,
        runtime: { execute: JsInitializer.builtin['Reflect.get'] },
      })
    )

    const initBuiltinFuncList = ['get', 'set', 'deleteProperty', 'defineProperty']
    for (let func of initBuiltinFuncList) {
      if (func === 'defineProperty') {
        func = 'set'
      }
      scope.members.get('Reflect')!.setFieldValue(
        func,
        new FunctionValue('', {
          sid: func,
          qid: `Reflect.${func}`,
          parent: scope,
          runtime: { execute: (JsInitializer.builtin as any)[`Reflect.${func}`] },
        })
      )
    }
  }

  // 初始化数组建模
  /**
   *
   * @param scope
   */
  static initArrayBuiltin(scope: any): void {
    const builtinMap: Record<string, any> = {
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
  static initSetBuiltin(scope: any): void {
    scope.setFieldValue(
      'Set',
      new ObjectValue(scope.qid, {
        sid: 'Set',
        parent: scope,
        runtime: { execute: JsInitializer.builtin.newSet },
      })
    )
  }

  /**
   *
   * @param scope
   */
  static initMapBuiltin(scope: any): void {
    scope.setFieldValue(
      'Map',
      new ObjectValue(scope.qid, {
        sid: 'Map',
        parent: scope,
        runtime: { execute: JsInitializer.builtin.newMap },
      })
    )
  }

  /**
   *
   * @param scope
   */
  static initVMBuiltin(scope: any): void {
    const vm2 = new ObjectValue('', {
      sid: 'vm2',
      qid: `vm2.`,
      parent: scope,
    })
    scope.setFieldValue('vm2', vm2)
    const VM = new ObjectValue('', {
      sid: 'VM',
      qid: `vm2.VM`,
      parent: scope,
    })
    vm2.setFieldValue('VM', VM)
    VM.setFieldValue(
      'run',
      new FunctionValue('', {
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
  static introduceGlobalBuiltin(scope: any): void {
    // TODO Global builtins modeling
    scope.setFieldValue('Object', new ObjectValue('', { sid: 'Object', qid: `${scope.qid}.Object` }))
    scope.setFieldValue('Array', new ObjectValue('', { sid: 'Array', qid: `${scope.qid}.Array` }))
    scope.setFieldValue('Map', new ObjectValue('', { sid: 'Map', qid: `${scope.qid}.Map` }))
    scope.setFieldValue('JSON', new ObjectValue('', { sid: 'JSON', qid: `${scope.qid}.JSON` }))
    scope.setFieldValue('Math', new ObjectValue('', { sid: 'Math', qid: `${scope.qid}.Math` }))
    scope.setFieldValue('Date', new ObjectValue('', { sid: 'Date', qid: `${scope.qid}.Date` }))
    scope.setFieldValue('console', new ObjectValue('', { sid: 'console', qid: `${scope.qid}.console` }))
    scope.setFieldValue('__dirname', new ObjectValue('', { sid: '__dirname', qid: `${scope.qid}.__dirname` }))
    scope.setFieldValue('process', new ObjectValue('', { sid: 'process', qid: `${scope.qid}.process` }))
    scope.setFieldValue('Symbol', new ObjectValue('', { sid: 'Symbol', qid: `${scope.qid}.Symbol` }))
    const requireFuncVal = new FunctionValue('', {
      sid: 'require',
      qid: `${scope.qid}.require`,
      parent: scope,
      runtime: { execute: JsInitializer.builtin.require },
    })
    scope.setFieldValue('require', requireFuncVal)
    if (scope.context?.funcs) {
      // eslint-disable-next-line no-param-reassign
      scope.context.funcs.require = requireFuncVal
    }
    const promiseFuncVal = new FunctionValue('', {
      sid: 'Promise',
      qid: `${scope.qid}.Promise`,
      parent: scope,
      runtime: { execute: JsInitializer.builtin.Promise },
    })
    scope.setFieldValue('Promise', promiseFuncVal)
    if (scope.context?.funcs) {
      // eslint-disable-next-line no-param-reassign
      scope.context.funcs.Promise = promiseFuncVal
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
  static resetInitVariables(scope: any): void {
    for (const field of Object.keys(scope.value)) {
      const v = scope.value[field]
      if (v.taint) v.taint.clearTrace()
    }
  }
}

module.exports = JsInitializer
