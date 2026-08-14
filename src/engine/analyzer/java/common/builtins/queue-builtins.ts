const { moveExistElementsToBuffer: moveExistElementsToBufferQueue, addElementToBuffer, promoteDeepTaintToCarrier } = require('./buffer')
const MemSpaceQueue = require('../../../common/memSpace')
const Collection = require('./collection-builtins')
const List = require('./list-builtins')
import { UndefinedValue } from '../../../common/value/undefine'

type MethodCarrier = {
  taint?: { clear?: () => void }
  setMisc?: (key: string, value: unknown) => void
}

type MethodOwner = {
  vtype?: string
  value?: unknown[]
  taint?: { clear?: () => void }
  getMisc?: (key: string) => unknown
  setMisc?: (key: string, value: unknown) => void
  getFieldValue?: (fieldName: string) => MethodCarrier | undefined
  members?: { get?: (key: string) => MethodCarrier | undefined }
}

type ReceiverAliasValue = MethodOwner & {
  qid?: string
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

function clearQueueMethodCarrierTaint(receiver: MethodOwner | undefined): void {
  if (!receiver) return
  const visited = new Set<MethodOwner>()
  const clearOne = (target: MethodOwner | undefined): void => {
    if (!target || visited.has(target)) return
    visited.add(target)
    for (const methodName of ['add', 'remove']) {
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

function clearQueueCarrierTaint(receiver: ReceiverAliasValue): void {
  for (const target of [receiver, ...getReceiverAliases(receiver)]) {
    target.taint?.clear?.()
    target.setMisc?.('buffer', [])
  }
}

function refreshQueueCarrierFromElements(receiver: ReceiverAliasValue): void {
  clearQueueCarrierTaint(receiver)
  if (receiver.getMisc?.('precise') && receiver.value && typeof receiver.value === 'object') {
    for (const key of Object.keys(receiver.value)) {
      if (!Number.isFinite(Number(key))) continue
      const value = receiver.value[Number(key)] as ReceiverAliasValue | undefined
      if (!value) continue
      addElementToBuffer(receiver, value)
      promoteDeepTaintToCarrier(receiver, value)
    }
  }
  for (const alias of getReceiverAliases(receiver)) {
    promoteDeepTaintToCarrier(alias, receiver)
  }
}

const memSpaceUtil = new MemSpaceQueue()

/**
 * java.util.Queue
 */
class Queue extends Collection {
  /**
   * Constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @private
   */
  static Queue(_this: any, argvalues: any[], state: any, node: any, scope: any): any {
    super.Collection(_this, argvalues, state, node, scope)
    _this.setMisc('precise', true)

    return _this
  }

  /**
   * Queue.add
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static add(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    return List.add.call(this, fclos, argvalues, state, node, scope) ?? new UndefinedValue()
  }

  /**
   * Queue.element
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static element(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
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
   * Queue.offer
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static offer(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    return Queue.add(fclos, argvalues, state, node, scope)
  }

  /**
   * Queue.peek
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*|{type, object, property}}
   */
  static peek(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    return Queue.element(fclos, argvalues, state, node, scope)
  }

  /**
   * Queue.poll
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static poll(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }

    if (!_this.getMisc('precise')) {
      return _this
    }
    const firstElement = memSpaceUtil.getMemberValue(_this, '0', state)
    const tmpVal: any = {}
    for (const key in _this.value) {
      if (Number(key) >= 0) {
        tmpVal[key] = _this.value[key]
      }
    }

    delete _this.value[_this.length - 1]
    for (const key in tmpVal) {
      if (Number(key) !== 0) {
        _this.value[Number(key) - 1] = tmpVal[key]
      }
    }

    _this.length = _this.length ?? 0
    if (_this.length > 0) {
      _this.length--
    }
    refreshQueueCarrierFromElements(_this)
    clearQueueMethodCarrierTaint(_this)

    return firstElement
  }

  /**
   * Queue.remove
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static remove(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    return Queue.poll(fclos, argvalues, state, node, scope)
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
  static _functionNotFoundCallback_(fclos: any, argvalues: any[], state: any, node: any, scope: any): void {
    const _this = fclos.getThisObj()
    if (!_this) {
      return
    }
    _this.setMisc('precise', false)
    moveExistElementsToBufferQueue(_this)
  }
}

module.exports = Queue
