const AbstractWrapper = require('./abstractwrapper-builtins')

/**
 * com.baomidou.mybatisplus.core.conditions.query.QueryWrapper
 */
class QueryWrapper extends AbstractWrapper {
  /**
   * Constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @constructor
   */
  static QueryWrapper(_this: any, argvalues: any[], state: any, node: any, scope: any) {
    return _this
  }

  /**
   * lambda
   * @param _this
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static lambda(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }
}

export = QueryWrapper
