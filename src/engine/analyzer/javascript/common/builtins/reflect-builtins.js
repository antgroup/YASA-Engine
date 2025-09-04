const {
  valueUtil: {
    ValueUtil: { PrimitiveValue, ObjectValue, FunctionValue },
  },
} = require('../../../common')
const SourceLine = require('../../../common/source-line')
/**
 *
 * 针对Reflect.get  target 可以多层非常复杂，但是property只能一层
 * @param fclos
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 * @returns {*}
 */
function processReflectGet(fclos, argvalues, state, node, scope) {
  if (Array.isArray(argvalues) && argvalues?.length >= 2) {
    const target = argvalues[0]
    const propertyKey = argvalues[1]
    const index = propertyKey.vtype === 'primitive' ? propertyKey.raw_value : propertyKey.sid
    return target?.field[index]
  }
}

/**
 * Reflect.set(target, propertyKey, value)
 * 在一个对象上设置一个属性
 *
 * @param fclos
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 * @returns {*}
 */
function processReflectSet(fclos, argvalues, state, node, scope) {
  if (Array.isArray(argvalues) && argvalues?.length >= 3) {
    const target = argvalues[0]
    const propertyKey = argvalues[1]
    const value = argvalues[2]
    const index = propertyKey.vtype === 'primitive' ? propertyKey.raw_value : propertyKey.sid
    const new_value = SourceLine.addSrcLineInfo(
      value,
      node,
      node.loc && node.loc.sourcefile,
      'Reflect.set Pass: ',
      target.sid
    )
    target.setFieldValue(
      index,
      ObjectValue({
        id: index,
        sid: index,
        qid: `${target}.${index}`,
        parent: target,
        value: new_value,
      })
    )
    // qid = target.index
    return target
  }
}
/**
 *
 * @param fclos
 * @param argvalues
 * @param state
 * @param node
 * @param scope
 */
function processReflectDelete(fclos, argvalues, state, node, scope) {
  if (Array.isArray(argvalues) && argvalues?.length >= 2) {
    const target = argvalues[0]
    const propertyKey = argvalues[1]
    const index = propertyKey.vtype === 'primitive' ? propertyKey.raw_value : propertyKey.sid
    if (target?.field[index]) {
      delete target?.field[index]
    }
  }
}

module.exports = {
  processReflectGet,
  processReflectSet,
  processReflectDelete,
}
