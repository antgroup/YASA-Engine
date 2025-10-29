const UastSpec = require('@ant-yasa/uast-spec')
const UndefinedValue = require('../../../common/value/undefine')
const MemState = require('../../../common/memState')
const MemSpace = require('../../../common/memSpace')

const memSpaceUtil = new MemSpace()

/**
 * java.util.concurrent.CompletableFuture
 */
class CompletableFuture {
  /**
   * constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   * @constructor
   */
  static CompletableFuture(_this: any, argvalues: any[], state: any, node: any, scope: any) {
    if (_this) {
      return _this
    }

    if (argvalues.length > 0) {
      memSpaceUtil.saveVarInScope(_this, '_result', argvalues[0], state)
      _this.setMisc('thenFuncsWithContext', [])
    }

    return _this
  }

  /**
   * CompletableFuture.join
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static join(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThis()
    if (!_this || !(this as any).executeCall) {
      return new UndefinedValue()
    }

    const thenFuncsWithContext = _this.getMisc('thenFuncsWithContext') || []
    let res = new UndefinedValue()
    for (const element of thenFuncsWithContext) {
      let elementArgvalues = element.argvalues
      if (elementArgvalues?.length > 0) {
        elementArgvalues = [res]
      }
      res = (this as any).executeCall(element.node, element.fclos, elementArgvalues, element.state, element.scope)
    }

    _this.setMisc('thenFuncsWithContext', [])

    return new UndefinedValue()
  }

  /**
   * CompletableFuture.runAsync
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static runAsync(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    let instance = new UndefinedValue()
    if (
      !(this as any).processNewExpression ||
      argvalues.length < 1 ||
      argvalues[0].vtype !== 'fclos' ||
      !(this as any).processAndCallFuncDef
    ) {
      return instance
    }

    const identifer = UastSpec.identifier('CompletableFuture')
    const newExpression = UastSpec.newExpression(identifer, [])
    if (!newExpression) {
      return instance
    }
    instance = (this as any).processNewExpression(scope, newExpression, state)

    const futureScope = MemState.deepScopeClone(scope, () => true)
    const thenFuncsWithContext: any[] = []
    const funcOldScope = argvalues[0].parent
    argvalues[0].parent = futureScope
    ;(this as any).processAndCallFuncDef(futureScope, node.arguments[0], argvalues[0], state)
    argvalues[0].parent = funcOldScope
    scope.value = MemState.unionScopeValues(scope, futureScope)
    thenFuncsWithContext.push({
      scope,
      node: node.arguments[0],
      fclos: argvalues[0],
      state,
      argvalues: [],
    })

    instance.setMisc('futureScope', futureScope)
    instance.setMisc('thenFuncsWithContext', thenFuncsWithContext)

    return instance
  }

  /**
   * CompletableFuture.supplyAsync
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static supplyAsync(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    let instance = new UndefinedValue()
    if (
      !(this as any).processNewExpression ||
      argvalues.length < 1 ||
      argvalues[0].vtype !== 'fclos' ||
      !(this as any).processAndCallFuncDef
    ) {
      return instance
    }

    const identifer = UastSpec.identifier('CompletableFuture')
    const newExpression = UastSpec.newExpression(identifer, [])
    if (!newExpression) {
      return instance
    }
    instance = (this as any).processNewExpression(scope, newExpression, state)

    const futureScope = MemState.deepScopeClone(scope, () => true)
    const thenFuncsWithContext: any[] = []
    const funcOldScope = argvalues[0].parent
    argvalues[0].parent = futureScope
    const result = (this as any).processAndCallFuncDef(futureScope, node.arguments[0], argvalues[0], state)
    memSpaceUtil.saveVarInScope(instance, '_result', result, state)
    argvalues[0].parent = funcOldScope
    scope.value = MemState.unionScopeValues(scope, futureScope)
    thenFuncsWithContext.push({
      scope,
      node: node.arguments[0],
      fclos: argvalues[0],
      state,
      argvalues: [],
    })

    instance.setMisc('futureScope', futureScope)
    instance.setMisc('thenFuncsWithContext', thenFuncsWithContext)

    return instance
  }

  /**
   * CompletableFuture.thenRun
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static thenRun(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThis()
    if (!_this || argvalues.length < 1 || argvalues[0].vtype !== 'fclos' || !(this as any).processAndCallFuncDef) {
      return new UndefinedValue()
    }

    const futureScope = _this.getMisc('futureScope') || MemState.deepScopeClone(scope, () => true)
    const thenFuncsWithContext = _this.getMisc('thenFuncsWithContext') || []
    const funcOldScope = argvalues[0].parent
    argvalues[0].parent = futureScope
    ;(this as any).processAndCallFuncDef(futureScope, node.arguments[0], argvalues[0], state)
    argvalues[0].parent = funcOldScope
    scope.value = MemState.unionScopeValues(scope, futureScope)
    thenFuncsWithContext.push({
      scope,
      node: node.arguments[0],
      fclos: argvalues[0],
      state,
      argvalues: [],
    })

    _this.setMisc('thenFuncsWithContext', thenFuncsWithContext)

    return _this
  }

  /**
   * CompletableFuture.thenRunAsync
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static thenRunAsync(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return CompletableFuture.thenRun(fclos, argvalues, state, node, scope)
  }

  /**
   * CompletableFuture.thenApply
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static thenApply(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThis()
    if (!_this || argvalues.length < 1 || argvalues[0].vtype !== 'fclos' || !(this as any).executeCall) {
      return new UndefinedValue()
    }

    const futureScope = _this.getMisc('futureScope') || MemState.deepScopeClone(scope, () => true)
    const thenFuncsWithContext = _this.getMisc('thenFuncsWithContext') || []
    const funcOldScope = argvalues[0].parent
    argvalues[0].parent = futureScope
    let result = memSpaceUtil.getMemberValueNoCreate(_this, '_result', state)
    result = (this as any).executeCall(node.arguments[0], argvalues[0], [result], state, futureScope)
    argvalues[0].parent = funcOldScope
    memSpaceUtil.saveVarInScope(_this, '_result', result, state)
    scope.value = MemState.unionScopeValues(scope, futureScope)
    thenFuncsWithContext.push({
      scope,
      node: node.arguments[0],
      fclos: argvalues[0],
      state,
      argvalues: [result],
    })

    _this.setMisc('thenFuncsWithContext', thenFuncsWithContext)

    return _this
  }

  /**
   * CompletableFuture.thenApplyAsync
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {UndefinedValue|*}
   */
  static thenApplyAsync(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return CompletableFuture.thenApply(fclos, argvalues, state, node, scope)
  }

  /**
   * CompletableFuture.thenAccept
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static thenAccept(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThis()
    if (!_this || argvalues.length < 1 || argvalues[0].vtype !== 'fclos' || !(this as any).executeCall) {
      return new UndefinedValue()
    }

    const futureScope = _this.getMisc('futureScope') || MemState.deepScopeClone(scope, () => true)
    const thenFuncsWithContext = _this.getMisc('thenFuncsWithContext') || []
    const funcOldScope = argvalues[0].parent
    argvalues[0].parent = futureScope
    const result = memSpaceUtil.getMemberValueNoCreate(_this, '_result', state)
    ;(this as any).executeCall(node.arguments[0], argvalues[0], [result], state, futureScope)
    argvalues[0].parent = funcOldScope
    scope.value = MemState.unionScopeValues(scope, futureScope)
    thenFuncsWithContext.push({
      scope,
      node: node.arguments[0],
      fclos: argvalues[0],
      state,
      argvalues: [result],
    })

    _this.setMisc('thenFuncsWithContext', thenFuncsWithContext)

    return _this
  }

  /**
   * CompletableFuture.thenAcceptAsync
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static thenAcceptAsync(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return CompletableFuture.thenAccept(fclos, argvalues, state, node, scope)
  }
}

export = CompletableFuture
