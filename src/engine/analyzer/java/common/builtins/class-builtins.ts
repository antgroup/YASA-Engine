const UastSpec = require('@ant-yasa/uast-spec')
const {
  ValueUtil: { UndefinedValue },
} = require('../../../../util/value-util')
const MemSpace = require('../../../common/memSpace')
const { getValueFromPackageByQid } = require('../../../../util/value-util')
const { newInstance } = require('./object')

const memSpaceUtil = new MemSpace()

/**
 * java.lang.Class
 */
class Class {
  /**
   * getMethod
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static getMethod(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    const _this = fclos.getThisObj()
    if (!_this || _this.parent?.vtype !== 'class') {
      return new UndefinedValue()
    }
    if (argvalues.length === 0 || argvalues[0].vtype !== 'primitive') {
      return new UndefinedValue()
    }
    return memSpaceUtil.getMemberValueNoCreate(_this.parent, UastSpec.identifier(argvalues[0].raw_value), state)
  }

  /**
   * forName
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static forName(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    if (argvalues.length !== 1 || argvalues[0].vtype !== 'primitive' || !argvalues[0].value) {
      return new UndefinedValue()
    }

    let classVal
    const fullType = argvalues[0].raw_value
    if (fullType.includes('.')) {
      classVal = getValueFromPackageByQid((this as any).topScope?.context.packages, fullType)
    } else {
      classVal = (this as any).getMemberValueNoCreate(scope, fullType)
    }
    if (!classVal) {
      return new UndefinedValue()
    }
    return (this as any).getMemberValueNoCreate(classVal, UastSpec.identifier('class'), state, 1)
  }

  /**
   * getConstructor
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static getConstructor(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    return fclos.getThisObj()
  }

  /**
   * newInstance
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static newInstance(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || _this.parent?.vtype !== 'class') {
      return new UndefinedValue()
    }
    const obj = newInstance(this, (this as any).topScope?.context.packages, _this.parent.qid)
    if (!obj) {
      return new UndefinedValue()
    }
    return obj
  }
}

module.exports = Class
