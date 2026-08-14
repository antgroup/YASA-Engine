const { buildNewCopiedWithTag, buildNewValueInstance } = require('../../../../../util/clone-util')
const { addElementToBuffer, moveExistElementsToBuffer, removeElementFromBuffer, clearBuffer, getAllElementFromBuffer, collectDeepTaintDonors, promoteDeepTaintToCarrier } = require('./buffer')
const MemSpace = require('../../../common/memSpace')
const Collection = require('./collection-builtins')
const QidUnifyUtil = require('../../../../../util/qid-unify-util')
const Config = require('../../../../../config')

import { UnionValue } from '../../../common/value/union'
import { UndefinedValue } from '../../../common/value/undefine'

type TaintCarrier = {
  taint?: {
    isTaintedRec?: boolean
    getTags?: () => unknown[]
    getSanitizerTags?: () => unknown[]
    addSanitizerTag?: (tag: unknown) => void
    markSource?: () => void
    mergeTracesFrom?: (source: unknown) => void
    clear?: () => void
  }
  getMisc?: (key: string) => unknown
  setMisc?: (key: string, value: unknown) => void
}

type AnalyzerValue = TaintCarrier & {
  vtype?: string
  value?: unknown[]
  rtype?: { type?: unknown; definiteType?: unknown; vagueType?: unknown }
  cloneAlias?: () => AnalyzerValue
  qid?: string
  uuid?: string | null
  getFieldValue?: (fieldName: string) => TaintCarrier | undefined
  members?: { get?: (key: string) => TaintCarrier | undefined }
  calculateAndRegisterUUID?: () => void
}

type MethodOwner = AnalyzerValue & {
  getFieldValue?: (fieldName: string) => TaintCarrier | undefined
  members?: { get?: (key: string) => TaintCarrier | undefined }
}

function clearListMethodCarrierTaint(receiver: MethodOwner | undefined): void {
  if (!receiver) return
  const visited = new Set<MethodOwner>()
  const clearOne = (target: MethodOwner | undefined): void => {
    if (!target || visited.has(target)) return
    visited.add(target)
    for (const methodName of ['add', 'remove', 'set']) {
      const methodCarrier = target.getFieldValue?.(methodName) ?? target.members?.get?.(methodName)
      methodCarrier?.taint?.clear?.()
      methodCarrier?.setMisc?.('buffer', [])
    }
    if (target.vtype === 'union' && Array.isArray(target.value)) {
      for (const branch of target.value) clearOne(branch as MethodOwner)
    }
  }
  clearOne(receiver)
  for (const alias of getReceiverAliases(receiver as ReceiverAliasValue)) clearOne(alias)
}

function splitUnionElements(value: AnalyzerValue): AnalyzerValue[] {
  if (value?.vtype === 'union' && Array.isArray(value.value)) return value.value as AnalyzerValue[]
  return [value]
}

function snapshotListElement(value: AnalyzerValue, analyzer?: unknown): AnalyzerValue {
  const snapshot = value?.qid && analyzer ? buildNewCopiedWithTag(analyzer, value, 'list-element') : (typeof value?.cloneAlias === 'function' ? value.cloneAlias() : value)
  if (snapshot?.rtype) {
    snapshot.rtype = { ...snapshot.rtype }
  }
  return snapshot
}

function mergeSanitizerTags(target: TaintCarrier | undefined, source: TaintCarrier | undefined): void {
  const sanitizerTags = source?.taint?.getSanitizerTags?.()
  if (!sanitizerTags || !target?.taint?.addSanitizerTag) return
  for (const tag of sanitizerTags) target.taint.addSanitizerTag(tag)
}

function valueHasSourceTrace(value: TaintCarrier | undefined): boolean {
  return !!(value?.taint?.isTaintedRec || (value?.taint?.getTags?.().length ?? 0) > 0 || collectDeepTaintDonors(value).length > 0)
}

function mergeSourceTrace(target: TaintCarrier | undefined, source: TaintCarrier | undefined): void {
  if (!target?.taint || !source?.taint || !valueHasSourceTrace(source)) return
  target.taint.markSource?.()
  if (typeof target.taint.mergeTracesFrom === 'function') {
    target.taint.mergeTracesFrom(source.taint)
  }
  promoteDeepTaintToCarrier(target, source)
  mergeSanitizerTags(target, source)
}

type ReceiverAliasValue = AnalyzerValue & {
  getSymbolTable?: () => { getMap?: () => Map<string, ReceiverAliasValue> }
}

function getReceiverAliases(receiver: ReceiverAliasValue): ReceiverAliasValue[] {
  const aliases: ReceiverAliasValue[] = []
  const addAlias = (alias: unknown): void => {
    if (alias && typeof alias === 'object' && alias !== receiver && !aliases.includes(alias as ReceiverAliasValue)) {
      aliases.push(alias as ReceiverAliasValue)
    }
  }
  addAlias(typeof receiver?.getMisc === 'function' ? receiver.getMisc('unionReceiverAlias') : undefined)
  const qid = typeof receiver?.qid === 'string' ? receiver.qid : ''
  const marker = '.<union@mem:'
  const markerIndex = qid.indexOf(marker)
  if (markerIndex > 0) {
    const aliasQid = qid.slice(0, markerIndex)
    const symbolTable = typeof receiver?.getSymbolTable === 'function' ? receiver.getSymbolTable() : undefined
    const values = typeof symbolTable?.getMap === 'function' ? symbolTable.getMap().values() : []
    for (const value of values) {
      if (value?.qid === aliasQid) addAlias(value)
    }
  }
  return aliases
}

function mergeReceiverBackToAliases(receiver: ReceiverAliasValue): void {
  for (const alias of getReceiverAliases(receiver)) {
    mergeSourceTrace(alias, receiver)
  }
}

function getReceiverAndAliases(receiver: ReceiverAliasValue): ReceiverAliasValue[] {
  return [receiver, ...getReceiverAliases(receiver)]
}

function clearListCarrierTaint(receiver: ReceiverAliasValue): void {
  for (const target of getReceiverAndAliases(receiver)) {
    target.taint?.clear?.()
    target.setMisc?.('buffer', [])
  }
}

function refreshListCarrierFromElements(receiver: ReceiverAliasValue): void {
  clearListCarrierTaint(receiver)
  if (receiver.getMisc?.('precise') && receiver.value && typeof receiver.value === 'object') {
    for (const key of Object.keys(receiver.value)) {
      if (Number.isFinite(Number(key))) {
        const value = receiver.value[Number(key)] as TaintCarrier | undefined
        mergeSourceTrace(receiver, value)
      }
    }
  }
  mergeReceiverBackToAliases(receiver)
}

const memSpaceUtil = new MemSpace()

/**
 * java.util.List
 */
class List extends (Collection as any) {
  /**
   * Constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @private
   */
  static List(_this: any, argvalues: any[], state: any, node: any, scope: any) {
    super.Collection(_this, argvalues, state, node, scope)
    _this.setMisc('precise', true)

    // new ArrayList<>(collection) 拷贝构造：把入参集合的元素 / buffer / 深层 taint 转移到新 list，
    // 否则 Stream.collect(toMap).values() 链上的元素与污点全部断在构造器入口。
    if (argvalues && argvalues.length > 0) {
      const src = argvalues[0]
      if (src) {
        // 把 src 的 buffer 元素（包含 union/Stream 中通过 Stream.collect/values 一路传过来的元素）
        // 转入新 list buffer，使下游 forEach 能枚举到具体元素
        const collectFromSrc = (container: any, depth: number, seen: Set<any>): void => {
          if (!container || depth > 3 || (typeof container === 'object' && seen.has(container))) return
          if (typeof container === 'object') seen.add(container)
          if (container.vtype === 'union' && container.value && typeof container.value === 'object') {
            for (const branch of Object.values(container.value) as any[]) collectFromSrc(branch, depth + 1, seen)
            return
          }
          if (typeof container.getMisc === 'function' && container.getMisc('buffer')) {
            for (const e of (container.getMisc('buffer') || [])) {
              if (e) addElementToBuffer(_this, e)
            }
          }
          if (typeof container.getMisc === 'function' && container.getMisc('precise') &&
              container.value && typeof container.value === 'object') {
            for (const key of Object.keys(container.value)) {
              if (Number.isFinite(Number(key))) {
                const v = container.value[key]
                if (v && v.vtype !== 'fclos') addElementToBuffer(_this, v)
              }
            }
          }
        }
        collectFromSrc(src, 0, new Set())
        // 拷贝深层 taint 到新 list 自身 tagTraces：保留 source tag 在 receiver 层可见，
        // 让下游 forEach builtin 的 _this.taint?.isTaintedRec 触发 over-approximation 路径。
        if (src.taint?.isTaintedRec && _this.taint && typeof _this.taint.mergeTracesFrom === 'function') {
          const collectTaints = (container: any, depth: number, seen: Set<any>): void => {
            if (!container || depth > 3 || seen.has(container)) return
            seen.add(container)
            if (container.taint?.tagTraces instanceof Map && container.taint.tagTraces.size > 0) {
              _this.taint.mergeTracesFrom(container.taint)
            }
            if (container.vtype === 'union' && container.value && typeof container.value === 'object') {
              for (const branch of Object.values(container.value) as any[]) collectTaints(branch, depth + 1, seen)
            }
            if (typeof container.getMisc === 'function') {
              const buf = container.getMisc('buffer')
              if (Array.isArray(buf)) for (const child of buf) collectTaints(child, depth + 1, seen)
            }
          }
          collectTaints(src, 0, new Set())
          if (typeof _this.taint.markSource === 'function') _this.taint.markSource()
        }
      }
    }

    return _this
  }

  private static addCollectionElementsToBuffer(target: any, source: any): void {
    const elements = getAllElementFromBuffer(source)
    if (elements.length === 0) {
      addElementToBuffer(target, source)
      return
    }
    for (const element of elements) {
      addElementToBuffer(target, element)
    }
  }

  /**
   * List.add
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static add(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      for (const element of splitUnionElements(argvalues[0])) {
        const snapshot = snapshotListElement(element, this)
        addElementToBuffer(_this, snapshot)
        mergeSourceTrace(_this, snapshot)
      }
    } else {
      _this.length = _this.length ?? 0
      if (argvalues.length === 1) {
        for (const element of splitUnionElements(argvalues[0])) {
          const snapshot = snapshotListElement(element, this)
          _this.value[_this.length] = snapshot
          mergeSourceTrace(_this, snapshot)
          _this.length++
        }
      } else if (argvalues.length === 2) {
        const indexVal = argvalues[0]
        if (indexVal?.vtype === 'primitive' && indexVal?.type === 'Literal' && indexVal?.literalType === 'number') {
          const index = parseInt(indexVal.value, 10)
          if (index >= 0 && index <= _this.length) {
            const snapshot = snapshotListElement(argvalues[1], this)
            _this.value[index] = snapshot
            mergeSourceTrace(_this, snapshot)
            if (index === _this.length) {
              _this.length++
            }
          }
        } else {
          _this.setMisc('precise', false)
          moveExistElementsToBuffer(_this)
          for (const element of splitUnionElements(argvalues[1])) {
            const snapshot = snapshotListElement(element, this)
            addElementToBuffer(_this, snapshot)
            mergeSourceTrace(_this, snapshot)
          }
          _this.length = 0
        }
      }
    }

    mergeReceiverBackToAliases(_this)

    if (argvalues.length === 1) {
      return new UndefinedValue()
    }
  }

  /**
   * List.addAll
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static addAll(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }

    _this.setMisc('precise', false)
    moveExistElementsToBuffer(_this)
    const src = argvalues[0]
    const elements = src && typeof src.getMisc === 'function' && src.getMisc('buffer')
      ? getAllElementFromBuffer(src)
      : (src ? splitUnionElements(src) : [])
    for (const element of elements) {
      const snapshot = snapshotListElement(element, this)
      addElementToBuffer(_this, snapshot)
      mergeSanitizerTags(_this, snapshot)
    }
    mergeSanitizerTags(_this, src)
    _this.length = 0

    return new UndefinedValue()
  }

  /**
   * List.addFirst
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static addFirst(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || !argvalues || argvalues.length === 0) {
      return
    }

    if (!_this.getMisc('precise')) {
      for (const element of splitUnionElements(argvalues[0])) {
        addElementToBuffer(_this, snapshotListElement(element, this))
      }
    } else {
      const tmpVal: any = {}
      for (const key in _this.value) {
        if (Number(key) >= 0) {
          tmpVal[key] = _this.value[key]
        }
      }

      _this.value[0] = snapshotListElement(argvalues[0], this)
      for (const key in tmpVal) {
        _this.value[Number(key) + 1] = tmpVal[key]
      }
      _this.length = _this.length ?? 0
      _this.length++
    }
  }

  /**
   * List.addList
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static addLast(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()

    if (!_this || !argvalues || argvalues.length === 0) {
      return
    }

    if (!_this.getMisc('precise')) {
      for (const element of splitUnionElements(argvalues[0])) {
        addElementToBuffer(_this, snapshotListElement(element, this))
      }
    } else {
      _this.length = _this.length ?? 0
      _this.value[_this.length] = snapshotListElement(argvalues[0], this)
      _this.length++
    }
  }

  /**
   * List.clear
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static clear(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return
    }

    if (!_this.getMisc('precise')) {
      clearBuffer(_this)
    } else {
      const indexKeys: string[] = []
      for (const key in _this.value) {
        if (Number(key) >= 0) {
          indexKeys.push(key)
        }
      }
      for (const indexKey of indexKeys) {
        delete _this.value[indexKey]
      }
      _this.length = 0
    }
  }

  /**
   * List.contains
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {null}
   */
  static contains(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * List.containsAll
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {null}
   */
  static containsAll(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * List.equals
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static equals(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * List.get
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {{type, object, property}|*}
   */
  static get(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      return _this
    }
    if (argvalues.length === 0) {
      const values = Object.keys(_this.value)
        .filter((key) => /^[0-9]+$/.test(key))
        .map((key) => _this.value[key])
      if (values.length === 1) return values[0]
      if (values.length > 1) return new UnionValue(values, `${_this.sid}-listElements`, `${_this.qid}.list-elements`, node)
    }
    return memSpaceUtil.getMemberValue(_this, argvalues[0], state)
  }

  /**
   * List.getFirst
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static getFirst(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      return _this
    }
    return memSpaceUtil.getMemberValue(_this, '0', state)
  }

  /**
   * List.getLast
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static getLast(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      return _this
    }

    const length = _this.length ?? 0
    return memSpaceUtil.getMemberValue(_this, String(length - 1), state)
  }

  /**
   * List.hashCode
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {null}
   */
  static hashCode(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * List.indexOf
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {null}
   */
  static indexOf(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * List.isEmpty
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {null}
   */
  static isEmpty(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * Iterable / Collection / List.forEach
   * 显式调用 callback lambda，把容器元素绑定到 lambda 形参，避免通用 anonymous funcDef 兜底导致形参 uninitialized。
   * 元素来源覆盖三类形态：precise value（数组索引位）、buffer 元素、union receiver 各分支。
   * 无可用元素时退化用 _this 占位（over-approximation 立场，保证 lambda body 至少穿透一次）。
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static forEach(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }
    const callback = argvalues[0]
    if (!callback || callback.vtype !== 'fclos' || typeof (this as any).executeCall !== 'function') {
      return new UndefinedValue()
    }
    const elements: any[] = []
    const visited = new WeakSet<any>()
    const collect = (container: any, depth: number) => {
      if (!container || depth > 2 || (typeof container === 'object' && visited.has(container))) return
      if (typeof container === 'object') visited.add(container)
      if (container.vtype === 'union' && container.value && typeof container.value === 'object') {
        for (const branch of Object.values(container.value) as any[]) collect(branch, depth + 1)
        return
      }
      if (typeof container.getMisc === 'function' && container.getMisc('buffer')) {
        for (const e of getAllElementFromBuffer(container)) {
          if (e) elements.push(e)
        }
      }
      if (
        typeof container.getMisc === 'function' &&
        container.getMisc('precise') &&
        container.value &&
        typeof container.value === 'object'
      ) {
        for (const key of Object.keys(container.value)) {
          if (Number.isFinite(Number(key))) {
            const v = container.value[key]
            if (v && v.vtype !== 'fclos') elements.push(v)
          }
        }
      }
    }
    collect(_this, 0)
    if (elements.length === 0) elements.push(_this)
    for (const element of elements) {
      // 方法体内 builtin 循环迭代预算检查：超过即停止，防止 list.forEach 路径爆炸
      if (state?._methodBodyInstructionCount !== undefined &&
          state._methodBodyInstructionCount > (Config.maxMethodBodyInstructionLimit ?? 3000)) {
        break
      }
      ;(this as any).executeCall(node, callback, state, scope, {
        callArgs: (this as any).buildCallArgs(node, [element], callback),
      })
      if (state?._methodBodyInstructionCount !== undefined) {
        state._methodBodyInstructionCount += (Config.builtinIterationCost ?? 500)
      }
    }
    return new UndefinedValue()
  }

  /**
   * List.iterator
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static iterator(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }

    const newThis = buildNewValueInstance(
      this,
      _this,
      node,
      scope,
      () => {
        return false
      },
      (v: any) => {
        return !v
      }
    )
    newThis._this = newThis
    newThis.setMisc('precise', false)
    moveExistElementsToBuffer(newThis)
    newThis.length = 0
    for (const key in newThis.value) {
      const prop = newThis.value[key]
      if (prop.vtype === 'fclos') {
        prop._this = newThis
      }
    }

    return newThis
  }

  /**
   * List.lastIndexOf
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {null}
   */
  static lastIndexOf(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * List.listIterator
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static listIterator(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || !argvalues) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      return _this
    }

    const newThis = buildNewValueInstance(
      this,
      _this,
      node,
      scope,
      () => {
        return false
      },
      (v: any) => {
        return !v
      }
    )
    newThis._this = newThis
    newThis.setMisc('precise', false)
    newThis.length = 0
    for (const key in newThis.value) {
      const prop = newThis.value[key]
      if (prop.vtype === 'fclos') {
        prop._this = newThis
      }
    }

    if (argvalues.length === 0) {
      moveExistElementsToBuffer(newThis)
    } else if (argvalues.length === 1) {
      let index: number = 0
      const indexVal = argvalues[0]
      if (indexVal?.vtype === 'primitive' && indexVal?.type === 'Literal' && indexVal?.literalType === 'number') {
        index = parseInt(indexVal.value, 10)
      }
      moveExistElementsToBuffer(newThis, index)
    }

    return newThis
  }

  /**
   * List.remove
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static remove(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      removeElementFromBuffer(_this, argvalues[0])
      return _this
    }

    const tmpVal: any = {}
    const indexKeys: string[] = []
    for (const key in _this.value) {
      if (Number(key) >= 0) {
        tmpVal[key] = _this.value[key]
        indexKeys.push(key)
      }
    }

    let removeKey: string = ''
    let needReturnObj = false
    let element: any
    if (
      argvalues[0]?.vtype === 'primitive' &&
      argvalues[0]?.type === 'Literal' &&
      argvalues[0]?.literalType === 'number'
    ) {
      removeKey = parseInt(argvalues[0].value, 10).toString()
      needReturnObj = true
    } else {
      for (const indexKey of indexKeys) {
        if (
          _this.value[indexKey].logicalQid ===
          argvalues[0].logicalQid
        ) {
          removeKey = indexKey
          break
        }
      }
    }

    if (Number(removeKey) >= 0) {
      if (needReturnObj) {
        element = tmpVal[removeKey]
      }
      delete tmpVal[removeKey]
      _this.length = _this.length ?? 0
      if (_this.length > 0) {
        _this.length--
      }
      for (const indexKey of indexKeys) {
        delete _this.value[indexKey]
      }

      let newIndex = 0
      Object.keys(tmpVal)
        .sort()
        .map((key) => {
          _this.value[newIndex] = tmpVal[key]
          newIndex++
        })
      refreshListCarrierFromElements(_this)
      clearListMethodCarrierTaint(_this)
    }

    if (!element) {
      element = new UndefinedValue()
    }
    return element
  }

  /**
   * List.removeAll
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static removeAll(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (_this || !argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }

    _this.setMisc('precise', false)
    moveExistElementsToBuffer(_this)
    removeElementFromBuffer(_this, argvalues[0])
    _this.length = 0

    return new UndefinedValue()
  }

  /**
   * List.removeFirst
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static removeFirst(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }

    if (_this.getMisc('precise')) {
      const tmpVal: any = {}
      for (const key in _this.value) {
        if (Number(key) >= 0) {
          tmpVal[key] = _this.value[key]
        }
      }

      _this.length = _this.length ?? 0
      let element: any
      if (_this.length > 0) {
        element = _this.value['0']
        delete _this.value[_this.length - 1]
        for (const key in tmpVal) {
          if (Number(key) !== 0) {
            _this.value[Number(key) - 1] = tmpVal[key]
          }
        }
        _this.length--
      }
      return element
    }

    return _this
  }

  /**
   * List.removeLast
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static removeLast(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }

    if (_this.getMisc('precise')) {
      _this.length = _this.length ?? 0
      let element: any
      if (_this.length > 0) {
        element = _this.value[_this.length - 1]
        delete _this.value[_this.length - 1]
        _this.length--
      }
      return element
    }

    return _this
  }

  /**
   * List.replaceAll
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static replaceAll(fclos: any, argvalues: any[], state: any, node: any, scope: any) {}

  /**
   * List.retainAll
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static retainAll(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!argvalues || argvalues.length === 0) {
      return new UndefinedValue()
    }

    _this.setMisc('precise', false)
    moveExistElementsToBuffer(_this)

    return new UndefinedValue()
  }

  /**
   * List.reversed
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static reversed(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }

    if (_this.getMisc('precise')) {
      const tmpVal: any = {}
      for (const key in _this.value) {
        if (Number(key) >= 0) {
          tmpVal[key] = _this.value[key]
        }
      }

      _this.length = _this.length ?? 0
      for (let index = 0; index < _this.length; index++) {
        _this.value[index] = tmpVal[_this.length - 1 - index]
      }
    }

    return _this
  }

  /**
   * List.set
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static set(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()

    if (!_this || !argvalues || argvalues.length !== 2) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      for (const element of splitUnionElements(argvalues[1])) {
        addElementToBuffer(_this, snapshotListElement(element, this))
      }
      return _this
    }

    const indexVal = argvalues[0]
    if (
      _this.getMisc('precise') &&
      indexVal?.vtype === 'primitive' &&
      indexVal?.type === 'Literal' &&
      indexVal?.literalType === 'number'
    ) {
      const index = parseInt(indexVal.value, 10)
      const elment = _this.value[index]
      _this.value[index] = snapshotListElement(argvalues[1], this)
      refreshListCarrierFromElements(_this)
      clearListMethodCarrierTaint(_this)
      return elment
    }

    moveExistElementsToBuffer(_this)
    for (const element of splitUnionElements(argvalues[1])) {
      addElementToBuffer(_this, snapshotListElement(element, this))
    }
    return _this
  }

  /**
   * List.size
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {null}
   */
  static size(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return new UndefinedValue()
  }

  /**
   * List.sort
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static sort(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return
    }

    _this.setMisc('precise', false)
    moveExistElementsToBuffer(_this)
    _this.length = 0
  }

  /**
   * List.spliterator
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static spliterator(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return List.iterator(fclos, argvalues, state, node, scope)
  }

  /**
   * List.subList
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static subList(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || !argvalues || argvalues.length !== 2) {
      return new UndefinedValue()
    }

    const newThis = buildNewValueInstance(
      this,
      _this,
      node,
      scope,
      () => {
        return false
      },
      (v: any) => {
        return !v
      }
    )
    newThis._this = newThis
    if (newThis.getMisc('precise')) {
      let startIndex: number = 0
      let endIndex: number = 0
      if (
        argvalues[0]?.vtype === 'primitive' &&
        argvalues[0]?.type === 'Literal' &&
        argvalues[0]?.literalType === 'number'
      ) {
        startIndex = parseInt(argvalues[0].value, 10)
      }
      if (
        argvalues[1]?.vtype === 'primitive' &&
        argvalues[1]?.type === 'Literal' &&
        argvalues[1]?.literalType === 'number'
      ) {
        endIndex = parseInt(argvalues[1].value, 10)
      }

      if (startIndex >= 0 && endIndex >= 0) {
        const tmpVal: any = {}
        const indexKeys: string[] = []
        for (const key in newThis.value) {
          if (Number(key) >= 0) {
            tmpVal[key] = newThis.value[key]
            indexKeys.push(key)
          }
        }

        const removeKeys: string[] = []
        for (const indexKey of indexKeys) {
          if (Number(indexKey) < startIndex || Number(indexKey) >= endIndex) {
            removeKeys.push(indexKey)
          }
        }

        if (removeKeys.length > 0) {
          for (const removeKey of removeKeys) {
            delete tmpVal[removeKey]
          }
          for (const indexKey of indexKeys) {
            delete newThis.value[indexKey]
          }

          let newIndex = 0
          Object.keys(tmpVal)
            .sort()
            .map((key) => {
              newThis.value[newIndex] = tmpVal[key]
              newIndex++
            })
        }
      } else {
        newThis.setMisc('precise', false)
        moveExistElementsToBuffer(newThis)
        for (const key in newThis.value) {
          const prop = newThis.value[key]
          if (prop.vtype === 'fclos') {
            prop._this = newThis
          }
        }
      }
    }

    return newThis
  }

  /**
   * List.toArray
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static toArray(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    return fclos.getThisObj()
  }

  /**
   * callback for unknown function
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @private
   */
  static _functionNotFoundCallback_(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return
    }
    _this.setMisc('precise', false)
    moveExistElementsToBuffer(_this)
  }
}

export = List
