const {
  ValueUtil: { UndefinedValue },
} = require('../../../../util/value-util')
const { getAllElementFromBuffer, addElementToBuffer } = require('./buffer')
const { newInstance } = require('./object')

/**
 * java.util.Collection
 */
class Collection {
  /**
   * Constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @constructor
   */
  static Collection(_this: any, argvalues: any[], state: any, node: any, scope: any) {
    return _this
  }

  /**
   * Collection.stream
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static stream(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }
    const obj = newInstance(this, (this as any).topScope?.context.packages, 'java.util.stream.Stream')
    if (!obj) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      if (_this.getMisc('buffer')) {
        for (const element of getAllElementFromBuffer(_this)) {
          addElementToBuffer(obj, element)
        }
      } else {
        addElementToBuffer(obj, _this)
      }
    } else {
      for (const element of Object.values(_this.value) as any) {
        if (element?.vtype !== 'fclos') {
          addElementToBuffer(obj, element)
        }
      }
    }

    return obj
  }
}

module.exports = Collection
