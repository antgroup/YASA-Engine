const List = require('./list-builtins')
const UndefinedValue = require('../../../common/value/undefine')

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
  static Stack(_this, argvalues, state, node, scope) {
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
  static empty(fclos, argvalues, state, node, scope) {
    return new UndefinedValue()
  }

  /**
   * Stack.peek
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static peek(fclos, argvalues, state, node, scope) {
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
  static pop(fclos, argvalues, state, node, scope) {
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
  static push(fclos, argvalues, state, node, scope) {
    super.add(fclos, argvalues, state, node, scope)

    if (argvalues.length > 0) {
      return argvalues[0]
    }
    return new UndefinedValue()
  }

  /**
   * Stack.search
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static search(fclos, argvalues, state, node, scope) {
    return new UndefinedValue()
  }
}

module.exports = Stack
