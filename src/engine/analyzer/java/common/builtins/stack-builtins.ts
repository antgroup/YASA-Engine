const List = require('./list-builtins')
const UndefinedValueStack = require('../../../common/value/undefine')

/**
 * java.util.Stack
 */
class Stack extends List {
  /**
   * Constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @constructor
   */
  static Stack(_this: any, argvalues: any[], state: any, node: any, scope: any): any {
    super.List(_this, argvalues, state, node, scope)
    _this.setMisc('precise', true)

    return _this
  }

  /**
   * Stack.empty
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static empty(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    return new UndefinedValueStack()
  }

  /**
   * Stack.peek
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static peek(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    return super.getLast(fclos, argvalues, state, node, scope)
  }

  /**
   * Stack.pop
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static pop(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    const lastElement = super.getLast(fclos, argvalues, state, node, scope)
    super.removeLast(fclos, argvalues, state, node, scope)
    return lastElement
  }

  /**
   * Stack.push
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static push(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    super.add(fclos, argvalues, state, node, scope)

    if (argvalues.length > 0) {
      return argvalues[0]
    }
    return new UndefinedValueStack()
  }

  /**
   * Stack.search
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static search(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    return new UndefinedValueStack()
  }
}

module.exports = Stack
