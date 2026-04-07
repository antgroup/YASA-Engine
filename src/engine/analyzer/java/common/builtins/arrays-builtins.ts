const Collection = require('./collection-builtins')
const { newInstance } = require('./object')
const { UndefinedValue } = require('../../../common/value/undefine')
const { addElementToBuffer } = require('./buffer')

/**
 * java.util.Arrays
 */
class Arrays extends (Collection as any) {
  /**
   * Constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static Arrays(_this: any, argvalues: any[], state: any, node: any, scope: any) {
    super.Collection(_this, argvalues, state, node, scope)
    return _this
  }

  /**
   * Arrays.asList
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static asList(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const obj = newInstance(this, (this as any).topScope?.context.packages, 'java.util.List')
    if (!obj) {
      return UndefinedValue()
    }
    if (argvalues?.length > 0) {
      for (const argvalue of argvalues) {
        if (obj.getMisc('precise')) {
          obj.length = obj.length ?? 0
          obj.value[obj.length] = argvalue
          obj.length++
        } else {
          addElementToBuffer(obj, argvalue)
        }
      }
    }
    return obj
  }
}

export = Arrays
