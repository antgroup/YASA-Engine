const { addElementToBuffer } = require('./buffer')
const {
  ValueUtil: { UndefinedValue },
} = require('../../../../util/value-util')

/**
 * com.baomidou.mybatisplus.core.conditions.AbstractWrapper
 */
class AbstractWrapper {
  /**
   * allEq
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static allEq(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }
    if (argvalues.length < 1) {
      return _this
    }

    if (argvalues.length === 1) {
      addElementToBuffer(_this, argvalues[0])
    } else if (argvalues.length === 2) {
      for (const argvalue of argvalues) {
        if (argvalue?.vtype !== 'fclos') {
          addElementToBuffer(_this, argvalue)
        }
      }
    } else if (argvalues.length === 3) {
      addElementToBuffer(_this, argvalues[1])
    } else if (argvalues.length === 4) {
      addElementToBuffer(_this, argvalues[2])
    }

    return _this
  }

  /**
   * between
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static between(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return AbstractWrapper.threeCondition(fclos, argvalues, state, node, scope)
  }

  /**
   * eq
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static eq(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return AbstractWrapper.twoCondition(fclos, argvalues, state, node, scope)
  }

  /**
   * ge
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static ge(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return AbstractWrapper.twoCondition(fclos, argvalues, state, node, scope)
  }

  /**
   * gt
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static gt(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return AbstractWrapper.twoCondition(fclos, argvalues, state, node, scope)
  }

  /**
   * le
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static le(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return AbstractWrapper.twoCondition(fclos, argvalues, state, node, scope)
  }

  /**
   * like
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static like(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return AbstractWrapper.twoCondition(fclos, argvalues, state, node, scope)
  }

  /**
   *
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static likeLeft(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return AbstractWrapper.twoCondition(fclos, argvalues, state, node, scope)
  }

  /**
   * likeRight
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static likeRight(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return AbstractWrapper.twoCondition(fclos, argvalues, state, node, scope)
  }

  /**
   * lt
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static lt(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return AbstractWrapper.twoCondition(fclos, argvalues, state, node, scope)
  }

  /**
   * ne
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static ne(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return AbstractWrapper.twoCondition(fclos, argvalues, state, node, scope)
  }

  /**
   * notBetween
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static notBetween(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return AbstractWrapper.threeCondition(fclos, argvalues, state, node, scope)
  }

  /**
   * notLike
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static notLike(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return AbstractWrapper.twoCondition(fclos, argvalues, state, node, scope)
  }

  /**
   * two condition
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static twoCondition(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }
    if (!argvalues || argvalues.length < 2) {
      return _this
    }

    if (argvalues.length === 2) {
      addElementToBuffer(_this, argvalues[1])
    } else if (argvalues.length === 3) {
      addElementToBuffer(_this, argvalues[2])
    }

    return _this
  }

  /**
   * three condition
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static threeCondition(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }
    if (!argvalues || argvalues.length < 3) {
      return _this
    }

    if (argvalues.length === 3) {
      addElementToBuffer(_this, argvalues[1])
      addElementToBuffer(_this, argvalues[2])
    } else if (argvalues.length === 4) {
      addElementToBuffer(_this, argvalues[2])
      addElementToBuffer(_this, argvalues[3])
    }

    return _this
  }
}

export = AbstractWrapper
