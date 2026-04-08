const { newInstance } = require('./object')

const { getAllElementFromBuffer, addElementToBuffer } = require('./buffer')
const {
  ValueUtil: { UndefinedValue },
} = require('../../../../util/value-util')
/**
 * java.util.stream.Stream
 */
class Stream {
  /**
   * Constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @constructor
   */
  static Stream(_this: any, argvalues: any, state: any, node: any, scope: any) {
    return _this
  }

  /**
   * Stream.allMatch
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static allMatch(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Stream.anyMatch
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static anyMatch(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Stream.builder
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static builder(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Stream.collect
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static collect(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }

  /**
   * Stream.concat
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static concat(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    if (argvalues.length !== 2) {
      return new UndefinedValue()
    }

    const obj = newInstance(this, (this as any).topScope?.context.packages, 'java.util.stream.Stream')
    if (!obj) {
      return new UndefinedValue()
    }
    if (argvalues[0]?.getMisc('buffer')) {
      for (const element of getAllElementFromBuffer(argvalues[0])) {
        addElementToBuffer(obj, element)
      }
    } else {
      addElementToBuffer(obj, argvalues[0])
    }
    if (argvalues[1]?.getMisc('buffer')) {
      for (const element of getAllElementFromBuffer(argvalues[1])) {
        addElementToBuffer(obj, element)
      }
    } else {
      addElementToBuffer(obj, argvalues[1])
    }

    return obj
  }

  /**
   * Stream.count
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static count(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Stream.distinct
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static distinct(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }

  /**
   * Stream.dropWhile
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static dropWhile(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }

  /**
   * Stream.empty
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static empty(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Stream.filter
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static filter(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    Stream.forEach.bind(this)(fclos, argvalues, state, node, scope)
    return fclos.getThisObj()
  }

  /**
   * Stream.findAny
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static findAny(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }

  /**
   * Stream.findFirst
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static findFirst(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }

  /**
   * Stream.flatMap
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static flatMap(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    Stream.forEach.bind(this)(fclos, argvalues, state, node, scope)
    return fclos.getThisObj()
  }

  /**
   * Stream.flatMapToDouble
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static flatMapToDouble(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return Stream.flatMap.bind(this)(fclos, argvalues, state, node, scope)
  }

  /**
   * Stream.flatMapToInt
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static flatMapToInt(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return Stream.flatMap.bind(this)(fclos, argvalues, state, node, scope)
  }

  /**
   * Stream.flatMapToLong
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static flatMapToLong(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return Stream.flatMap.bind(this)(fclos, argvalues, state, node, scope)
  }

  /**
   * Stream.forEach
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static forEach(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || argvalues.length === 0 || argvalues[0].vtype !== 'fclos') {
      return new UndefinedValue()
    }

    if (_this.getMisc('buffer')) {
      const elements = getAllElementFromBuffer(_this)
      for (const element of elements) {
        ;(this as any).executeCall(node, argvalues[0], state, scope, { callArgs: (this as any).buildCallArgs(node, [element], argvalues[0]) })
      }
    } else {
      ;(this as any).executeCall(node, argvalues[0], state, scope, { callArgs: (this as any).buildCallArgs(node, [_this], argvalues[0]) })
    }

    return new UndefinedValue()
  }

  /**
   * Stream.forEachOrdered
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static forEachOrdered(_this: any, argvalues: any, state: any, node: any, scope: any) {
    return Stream.forEach.bind(this)(_this, argvalues, state, node, scope)
  }

  /**
   * Stream.gather
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static gather(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }

  /**
   * Stream.generate
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static generate(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }

  /**
   * Stream.iterate
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static iterate(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Stream.limit
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static limit(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }

  /**
   * Stream.map
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static map(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || argvalues.length === 0 || argvalues[0].vtype !== 'fclos') {
      return _this || new UndefinedValue()
    }

    // 收集 mapper 返回值到新 buffer，保持链式调用
    const result = fclos.getThisObj()
    if (_this.getMisc('buffer')) {
      const elements = getAllElementFromBuffer(_this)
      const newBuffer: any[] = []
      for (const element of elements) {
        const mapped = (this as any).executeCall(node, argvalues[0], state, scope, { callArgs: (this as any).buildCallArgs(node, [element], argvalues[0]) })
        if (mapped) {
          newBuffer.push(mapped)
        }
      }
      result.setMisc('buffer', newBuffer)
    } else {
      const mapped = (this as any).executeCall(node, argvalues[0], state, scope, { callArgs: (this as any).buildCallArgs(node, [_this], argvalues[0]) })
      if (mapped) {
        result.setMisc('buffer', [mapped])
      }
    }

    return result
  }

  /**
   * Stream.mapMulti
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static mapMulti(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return Stream.flatMap.bind(this)(fclos, argvalues, state, node, scope)
  }

  /**
   * Stream.mapMultiToDouble
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static mapMultiToDouble(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return Stream.flatMap.bind(this)(fclos, argvalues, state, node, scope)
  }

  /**
   * Stream.mapMultiToInt
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static mapMultiToInt(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return Stream.flatMap.bind(this)(fclos, argvalues, state, node, scope)
  }

  /**
   * Stream.mapMultiToLong
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static mapMultiToLong(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return Stream.flatMap.bind(this)(fclos, argvalues, state, node, scope)
  }

  /**
   * Stream.mapToDouble
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static mapToDouble(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return Stream.flatMap.bind(this)(fclos, argvalues, state, node, scope)
  }

  /**
   * Stream.mapToInt
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static mapToInt(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return Stream.flatMap.bind(this)(fclos, argvalues, state, node, scope)
  }

  /**
   * Stream.mapToLong
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static mapToLong(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return Stream.flatMap.bind(this)(fclos, argvalues, state, node, scope)
  }

  /**
   * Stream.max
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static max(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }

  /**
   * Stream.min
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static min(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }

  /**
   * Stream.noneMatch
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static noneMatch(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Stream.of
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static of(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    const obj = newInstance(this, (this as any).topScope?.context.packages, 'java.util.stream.Stream')
    if (!obj) {
      return new UndefinedValue()
    }
    for (const element of argvalues) {
      addElementToBuffer(obj, element)
    }
    return obj
  }

  /**
   * Stream.ofNullable
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static ofNullable(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return Stream.of.bind(this)(fclos, argvalues, state, node, scope)
  }

  /**
   * Stream.peek
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static peek(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }

  /**
   * Stream.reduce
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static reduce(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }

  /**
   * Stream.skip
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static skip(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }

  /**
   * Stream.sorted
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static sorted(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }

  /**
   * Stream.takeWhile
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static takeWhile(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }

  /**
   * Stream.toArray
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static toArray(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }

  /**
   * Stream.toList
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static toList(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }
}

module.exports = Stream
