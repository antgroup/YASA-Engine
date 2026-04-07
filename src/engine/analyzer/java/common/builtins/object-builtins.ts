const UastSpec = require('@ant-yasa/uast-spec')
const {
  ValueUtil: { UndefinedValue },
} = require('../../../../util/value-util')
const { prettyPrint } = require('../../../../../util/ast-util')
const { getValueFromPackageByQid } = require('../../../../util/value-util')

/**
 * java.lang.Object
 */
class _Object {
  /**
   * getClass
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static getClass(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }
    if (_this.rtype?.definiteType && !_this.rtype?.vagueType) {
      const fullType = prettyPrint(_this.rtype.definiteType)
      let classVal
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

    return new UndefinedValue()
  }
}

module.exports = _Object
