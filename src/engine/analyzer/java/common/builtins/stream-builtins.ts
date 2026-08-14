const { newInstance } = require('./object')
const { ObjectValue } = require('../../../common/value/object')

const { getAllElementFromBuffer, addElementToBuffer, promoteDeepTaintToCarrier } = require('./buffer')
const JavaMap = require('./map-builtins')
const Config = require('../../../../../config')
const {
  ValueUtil: { FunctionValue, UndefinedValue },
} = require('../../../../util/value-util')

type JavaBuiltinContext = {
  topScope?: { context?: { packages?: unknown } }
}

type TaintCarrier = {
  sid?: string
  qid?: string
  uuid?: string
  logicalQid?: string
  vtype?: string
  type?: string
  loc?: { sourcefile?: string; start?: { line?: number; column?: number } }
  ast?: { loc?: { sourcefile?: string; start?: { line?: number; column?: number } } }
  getMisc?: (key: string) => unknown
  setMisc?: (key: string, value: unknown) => void
  taint?: {
    isTaintedRec?: boolean
    getTags?: () => unknown[]
    getTrace?: (tag: string) => unknown[] | null
    markSource?: () => void
    mergeTracesFrom?: (source: unknown) => void
  }
}

function hasSourceTrace(value: TaintCarrier | undefined): boolean {
  return !!(value?.taint?.isTaintedRec || (value?.taint?.getTags?.().length ?? 0) > 0)
}

function mergeElementTaint(target: TaintCarrier | undefined, source: TaintCarrier | undefined): void {
  if (!target?.taint || !source?.taint) return
  target.taint.markSource?.()
  if (typeof target.taint.mergeTracesFrom === 'function') {
    target.taint.mergeTracesFrom(source.taint)
  }
}

function propagateStreamElementTaint(target: TaintCarrier | undefined, source: TaintCarrier | undefined): void {
  if (!target || !source || !hasSourceTrace(source)) return
  mergeElementTaint(target, source)
}

function copyStreamBuffer(target: TaintCarrier | undefined, source: TaintCarrier | undefined): void {
  if (!target || !source || typeof source.getMisc !== 'function' || typeof target.setMisc !== 'function') return
  const buffer = source.getMisc('buffer')
  if (Array.isArray(buffer) && buffer.length > 0) {
    target.setMisc('buffer', [...buffer])
  }
}

function getCollectorName(collector: TaintCarrier | undefined): string {
  return String(collector?.qid ?? collector?.sid ?? collector?.logicalQid ?? '')
}

function isCollectionCollector(collector: TaintCarrier | undefined): boolean {
  const name = getCollectorName(collector)
  return /Collectors\.(toList|toSet|toCollection)|\b(toList|toSet|toCollection)\b/.test(name)
}

function isGroupingCollector(collector: TaintCarrier | undefined): boolean {
  const name = getCollectorName(collector)
  return /Collectors\.groupingBy|\bgroupingBy\b/.test(name)
}

function isReadWrapperCollector(collector: TaintCarrier | undefined): boolean {
  const name = getCollectorName(collector)
  return /Collectors\.joining|\bjoining\b/.test(name)
}

function getCollectedCarrierType(collector: TaintCarrier | undefined): string {
  return isCollectionCollector(collector) ? 'java.util.ArrayList' : 'java.util.Map'
}

function buildCollectedCarrier(context: typeof Stream & JavaBuiltinContext, receiver: TaintCarrier | undefined, collector: TaintCarrier | undefined, node: any): TaintCarrier | undefined {
  const carrierType = getCollectedCarrierType(collector)
  let collected = newInstance(context, context.topScope?.context?.packages, carrierType, node)
  if (collected?.vtype === 'undefine' && carrierType === 'java.util.ArrayList') {
    collected = newInstance(context, context.topScope?.context?.packages, 'java.util.List', node)
  }
  if (!collected || collected.vtype === 'undefine') {
    collected = new ObjectValue('', { sid: carrierType, qid: carrierType, ast: node })
  }
  if (!isGroupingCollector(collector)) {
    copyStreamBuffer(collected, receiver)
  }
  const shouldPromoteToCarrier = isReadWrapperCollector(collector)
  if (shouldPromoteToCarrier) {
    propagateStreamElementTaint(collected, receiver)
    promoteDeepTaintToCarrier(collected, receiver)
  }
  const elements = receiver?.getMisc?.('buffer') ? getAllElementFromBuffer(receiver) : []
  if (shouldPromoteToCarrier) {
    for (const element of elements) {
      propagateStreamElementTaint(collected, element)
    }
  }
  if (isGroupingCollector(collector)) {
    attachGroupedMapEntry(context, collected, receiver, node)
  }
  return collected
}

function attachGroupedMapEntry(context: typeof Stream & JavaBuiltinContext, collected: TaintCarrier | undefined, receiver: TaintCarrier | undefined, node: any): void {
  if (!collected || !receiver) return
  let groupValue = newInstance(context, context.topScope?.context?.packages, 'java.util.ArrayList', node)
  if (groupValue?.vtype === 'undefine') {
    groupValue = newInstance(context, context.topScope?.context?.packages, 'java.util.List', node)
  }
  if (!groupValue || groupValue.vtype === 'undefine') {
    groupValue = new ObjectValue('', { sid: 'java.util.List', qid: 'java.util.List', ast: node })
  }
  copyStreamBuffer(groupValue, receiver)
  propagateStreamElementTaint(groupValue, receiver)
  const elements = receiver.getMisc?.('buffer') ? getAllElementFromBuffer(receiver) : []
  for (const element of elements) {
    propagateStreamElementTaint(groupValue, element)
  }
  const groupKey = new ObjectValue('', { sid: 'Collectors.groupingBy(<key>)', qid: 'Collectors.groupingBy(<key>)', ast: node })
  JavaMap.put({ getThisObj: () => collected }, [groupKey, groupValue], {}, node, {})
}

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
    const receiver = fclos.getThisObj()
    return buildCollectedCarrier(this, receiver, argvalues?.[0], node)
  }

  /**
   * Stream.values — Java 标准 Stream API 无 values 方法，但 `Stream.collect(toMap)` 在当前引擎
   * 当前 modeling 下返回 Stream 本身（未真正构造 Map），下游对返回值再调 .values() 时落入未建模
   * 路径，元素链断。这里把 Stream.values 视作恒等：把 _this（携带 buffer 元素与 taint）原样
   * 返回，让 toMap/values/keySet 链上元素能继续传播到 `new ArrayList<>(...)` 构造器。
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static values(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }

  /**
   * Stream.keySet — 同 values：保持 toMap 链元素与 taint 不丢。
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static keySet(fclos: any, argvalues: any, state: any, node: any, scope: any) {
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
        propagateStreamElementTaint(obj, element)
      }
    } else {
      addElementToBuffer(obj, argvalues[0])
      propagateStreamElementTaint(obj, argvalues[0])
    }
    if (argvalues[1]?.getMisc('buffer')) {
      for (const element of getAllElementFromBuffer(argvalues[1])) {
        addElementToBuffer(obj, element)
        propagateStreamElementTaint(obj, element)
      }
    } else {
      addElementToBuffer(obj, argvalues[1])
      propagateStreamElementTaint(obj, argvalues[1])
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
    const receiver = fclos.getThisObj()
    Stream.forEach.bind(this)(fclos, argvalues, state, node, scope)
    return receiver
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
        if (state?._methodBodyInstructionCount !== undefined) {
          state._methodBodyInstructionCount += (Config.builtinIterationCost ?? 500)
        }
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

    const result = Stream.newStream(this, node)
    if (!result) {
      return new UndefinedValue()
    }

    const carrier = typeof _this.getMisc === 'function' ? _this.getMisc('_carrierTrace') : undefined
    if (carrier && typeof result.setMisc === 'function') {
      result.setMisc('_carrierTrace', carrier)
    }

    const elements = _this.getMisc('buffer') ? getAllElementFromBuffer(_this) : [_this]
    for (const element of elements) {
      const mapper = Stream.bindFieldReturningMapper(argvalues[0], element)
      const mapped = (this as any).executeCall(node, mapper, state, scope, { callArgs: (this as any).buildCallArgs(node, [element], mapper) })
      if (mapped) {
        propagateStreamElementTaint(mapped, element)
        if (carrier && mapped.taint && typeof mapped.taint.markSource === 'function') {
          const tags = typeof mapped.taint.getTags === 'function' ? (mapped.taint.getTags() || []) : []
          if (!Array.isArray(tags) || !tags.includes('JAVA_INPUT')) {
            mapped.taint.markSource()
            if (typeof mapped.taint.addTag === 'function') mapped.taint.addTag('JAVA_INPUT')
            if (typeof mapped.taint.mergeTracesFrom === 'function' && carrier.taint) {
              mapped.taint.mergeTracesFrom(carrier.taint)
            }
          }
        }
        addElementToBuffer(result, mapped)
        propagateStreamElementTaint(result, mapped)
      }
      if (state?._methodBodyInstructionCount !== undefined) {
        state._methodBodyInstructionCount += (Config.builtinIterationCost ?? 500)
      }
    }
    propagateStreamElementTaint(result, _this)

    return result
  }

  private static newStream(context: any, node: any): any {
    return newInstance(context, context.topScope?.context.packages, 'java.util.stream.Stream', node)
  }

  private static bindFieldReturningMapper(mapper: any, element: any): any {
    if (!Stream.isResolvableFieldReturningMapper(mapper, element)) {
      return mapper
    }
    const boundMapper = new FunctionValue('', {
      sid: mapper.sid,
      qid: mapper.qid,
      parent: mapper.parent,
      runtime: mapper.runtime,
      ast: mapper.ast,
      overloaded: mapper.overloaded,
      _this: element,
    })
    boundMapper.rtype = mapper.rtype
    return boundMapper
  }

  private static isResolvableFieldReturningMapper(mapper: any, element: any): boolean {
    if (!mapper || mapper.vtype !== 'fclos' || !element || typeof element.getFieldValue !== 'function') {
      return false
    }
    const currentThis = typeof mapper.getThisObj === 'function' ? mapper.getThisObj() : mapper._this
    if (currentThis && currentThis.vtype !== 'class' && currentThis.vtype !== 'package') {
      return false
    }
    const fieldName = Stream.getReturnedFieldName(mapper)
    if (fieldName && element.getFieldValue(fieldName, false)) {
      return true
    }
    // lombok host-getter 形态（无 Java AST body）：method-reference `Clazz::getX` 的 _this 仍是 class，
    // 让 bindFieldReturningMapper 把 _this 改绑为 element，lombok processGetter 的 isTaintedRec 路径
    // 才能把 element 携带的 carrier trace 经 copyBufferedElements 带到 mapped 值。
    const lombokFieldName = Stream.getLombokHostGetterFieldName(mapper)
    return Boolean(lombokFieldName && element.getFieldValue(lombokFieldName, false))
  }

  /** lombok host-getter（注入闭包，无 Java AST）的字段名：sid 形如 get/isXxx，去前缀首字母小写。 */
  private static getLombokHostGetterFieldName(mapper: any): string | undefined {
    const sid = typeof mapper?.sid === 'string' ? mapper.sid : undefined
    if (!sid) return undefined
    const body = mapper.ast?.fdef?.body
    if (body && Array.isArray(body.body) && body.body.length > 0) return undefined
    const match = /^(get|is)([A-Z]\w*)$/.exec(sid)
    if (!match) return undefined
    const tail = match[2]
    return tail.charAt(0).toLowerCase() + tail.slice(1)
  }

  private static getReturnedFieldName(mapper: any): string | undefined {
    const body = mapper.ast?.fdef?.body
    const statements = Array.isArray(body?.body) ? body.body : []
    if (statements.length !== 1 || statements[0]?.type !== 'ReturnStatement') {
      return undefined
    }
    const argument = statements[0].argument || statements[0].expression
    if (argument?.type !== 'MemberAccess' || argument.object?.type !== 'ThisExpression') {
      return undefined
    }
    return argument.property?.name || argument.property?.value
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
      propagateStreamElementTaint(obj, element)
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
