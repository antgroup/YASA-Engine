const {
  ValueUtil: { UndefinedValue },
} = require('../../../../util/value-util')
const { getAllElementFromBuffer } = require('./buffer')

/**
 * java.util.Iterator
 *
 * 为 Iterator.next()/hasNext() 提供建模，使污点能从 iterator 对象传播到 next() 返回值。
 * List.iterator() / Set.iterator() 返回的对象将元素存入 buffer，
 * next() 从 buffer 中按 iteratorIndex 取出下一个元素并携带污点返回。
 */
class Iterator {
  /**
   * Iterator.next
   * 从 buffer 中按 iteratorIndex 取出下一个元素，传播污点到返回值
   */
  static next(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos._this
    if (!_this || typeof _this.getMisc !== 'function') {
      return new UndefinedValue()
    }

    const buffer = _this.getMisc('buffer')
    if (!Array.isArray(buffer) || buffer.length === 0) {
      return new UndefinedValue()
    }

    const currentIndex = _this.getMisc('iteratorIndex') ?? 0
    const index = typeof currentIndex === 'number' ? currentIndex : 0

    if (index >= buffer.length) {
      return new UndefinedValue()
    }

    const element = buffer[index]
    _this.setMisc('iteratorIndex', index + 1)

    return element !== undefined ? element : new UndefinedValue()
  }

  /**
   * Iterator.hasNext
   * 检查 buffer 中是否还有未遍历的元素
   */
  static hasNext(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos._this
    if (!_this || typeof _this.getMisc !== 'function') {
      return new UndefinedValue()
    }

    const buffer = _this.getMisc('buffer')
    if (!Array.isArray(buffer)) {
      return new UndefinedValue()
    }

    const currentIndex = _this.getMisc('iteratorIndex') ?? 0
    const index = typeof currentIndex === 'number' ? currentIndex : 0

    // hasNext 不改变状态，只检查是否还有元素
    return index < buffer.length
  }
}

module.exports = Iterator