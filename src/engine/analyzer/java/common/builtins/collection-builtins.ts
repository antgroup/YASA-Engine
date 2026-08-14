const {
  ValueUtil: { UndefinedValue },
} = require('../../../../util/value-util')
const { getAllElementFromBuffer, addElementToBuffer } = require('./buffer')
const { newInstance } = require('./object')
const Config = require('../../../../../config')

function getCallbackParameterCount(callback: any): number {
  const parameters = callback?.ast?.fdef?.parameters ?? callback?.ast?.node?.parameters ?? callback?.parameters
  if (Array.isArray(parameters)) return parameters.length
  if (Array.isArray(parameters?.parameters)) return parameters.parameters.length
  return 0
}

function getTypeText(value: any): string {
  const definiteType = value?.rtype?.definiteType
  if (typeof definiteType === 'string') return definiteType
  if (typeof definiteType?.name === 'string') return definiteType.name
  if (typeof value?.logicalQid === 'string') return value.logicalQid
  if (typeof value?.qid === 'string') return value.qid
  return ''
}

function isMapLikeReceiver(value: any): boolean {
  const typeText = getTypeText(value)
  return /(^|\.)(Map|HashMap|ConcurrentMap|ConcurrentHashMap|Hashtable)(<|$|\.)/.test(typeText) ||
    value?.getFieldValue?.('keyRefSet') instanceof Set
}

const JAVA_INPUT_TAG = 'JAVA_INPUT'

type TraceItem = {
  tag?: string
  str?: string
}

type TaintLike = {
  isTaintedRec?: boolean
  getTags?: () => unknown[]
  getTrace?: (tag: string) => unknown[] | null
  markSource?: () => void
  addTag?: (tag: string) => void
  mergeTracesFrom?: (source: unknown) => void
  tagTraces?: Map<string, unknown[]>
}

type TaintCarrier = {
  sid?: string
  qid?: string
  uuid?: string
  logicalQid?: string
  vtype?: string
  type?: string
  value?: Record<string, unknown> | unknown[]
  getMisc?: (key: string) => unknown
  taint?: TaintLike
}

function getTagTrace(taint: TaintLike | undefined, tag: string): unknown[] | null {
  if (!taint) return null
  const trace = taint.getTrace?.(tag)
  if (Array.isArray(trace)) return trace
  const directTrace = taint.tagTraces instanceof Map ? taint.tagTraces.get(tag) : null
  return Array.isArray(directTrace) ? directTrace : null
}

function isSourceStep(item: unknown): boolean {
  const traceItem = item as TraceItem | undefined
  return traceItem?.tag === 'SOURCE: ' || (typeof traceItem?.str === 'string' && traceItem.str.includes('SOURCE: '))
}

function hasSourceFirstTrace(value: TaintCarrier | undefined, tag = JAVA_INPUT_TAG): boolean {
  const trace = getTagTrace(value?.taint, tag)
  return !!(trace && trace.length > 0 && isSourceStep(trace[0]))
}

function hasSourceTrace(value: TaintCarrier | undefined): boolean {
  return !!(value?.taint?.isTaintedRec || (value?.taint?.getTags?.().length ?? 0) > 0)
}

function mergeElementTrace(target: TaintCarrier | undefined, source: TaintCarrier | undefined): void {
  if (!target?.taint || !source?.taint || !hasSourceTrace(source)) return
  target.taint.markSource?.()
  if (typeof target.taint.mergeTracesFrom === 'function') {
    target.taint.mergeTracesFrom(source.taint)
  }
}

function isTaintCarrier(value: unknown): value is TaintCarrier {
  if (!value || typeof value !== 'object') return false
  const carrier = value as TaintCarrier
  if (!carrier.taint || typeof carrier.taint !== 'object') return false
  return !!(
    carrier.taint.tagTraces instanceof Map ||
    typeof carrier.taint.getTrace === 'function' ||
    typeof carrier.taint.getTags === 'function' ||
    carrier.taint.isTaintedRec !== undefined
  )
}

function findVisibleJavaInputDonor(receiver: TaintCarrier | undefined): TaintCarrier | null {
  if (!receiver || typeof receiver !== 'object') return null
  const visited = new Set<object>()
  const queue: Array<{ value: TaintCarrier; depth: number }> = [{ value: receiver, depth: 0 }]
  const maxDepth = 3
  const maxFanout = 64
  let seen = 0
  let enqueued = 1

  const enqueueChild = (child: unknown, depth: number): void => {
    if (enqueued >= maxFanout) return
    if (!child || typeof child !== 'object') return
    const childCarrier = child as TaintCarrier
    if (childCarrier.vtype === 'fclos' || childCarrier.vtype === 'class' || childCarrier.vtype === 'primitive') return
    queue.push({ value: childCarrier, depth })
    enqueued += 1
  }

  while (queue.length > 0 && seen < maxFanout) {
    const current = queue.shift()!
    const value = current.value
    if (!value || typeof value !== 'object' || visited.has(value)) continue
    visited.add(value)
    seen += 1

    if (isTaintCarrier(value) && hasSourceFirstTrace(value)) {
      return value
    }
    if (current.depth >= maxDepth) continue

    const childDepth = current.depth + 1
    const rawBuffer = typeof value.getMisc === 'function' ? value.getMisc('buffer') : null
    if (Array.isArray(rawBuffer)) {
      for (let i = 0; i < rawBuffer.length && enqueued < maxFanout; i += 1) {
        enqueueChild(rawBuffer[i], childDepth)
      }
    }
    if (value.vtype === 'union' && value.value && typeof value.value === 'object') {
      for (const branch of Object.values(value.value)) {
        if (enqueued >= maxFanout) break
        enqueueChild(branch, childDepth)
      }
    } else if (typeof value.getMisc === 'function' && value.getMisc('precise') && value.value && typeof value.value === 'object') {
      for (const key of Object.keys(value.value)) {
        if (enqueued >= maxFanout) break
        if (Number(key) >= 0) enqueueChild((value.value as Record<string, unknown>)[key], childDepth)
      }
    }
  }

  return null
}
/**
 * java.util.Collection
 */
class Collection {
  /**
   * Constructor
   * @param _this
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @constructor
   */
  static Collection(_this: any, argvalues: any[], state: any, node: any, scope: any) {
    if (Array.isArray(argvalues)) {
      for (const argvalue of argvalues) {
        Collection.addCollectionElementsToBuffer(_this, argvalue)
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
   * Collection.stream
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static stream(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }
    const obj = newInstance(this, (this as any).topScope?.context.packages, 'java.util.stream.Stream')
    if (!obj) {
      return new UndefinedValue()
    }

    const bufferedElements = _this.getMisc('buffer') ? getAllElementFromBuffer(_this) : []
    if (bufferedElements.length > 0) {
      for (const element of bufferedElements) {
        addElementToBuffer(obj, element)
        mergeElementTrace(obj, element)
      }
    } else if (!_this.getMisc('precise')) {
      addElementToBuffer(obj, _this)
      mergeElementTrace(obj, _this)
    } else {
      for (const element of Object.values(_this.value) as any) {
        if (element?.vtype !== 'fclos') {
          addElementToBuffer(obj, element)
          mergeElementTrace(obj, element)
        }
      }
    }

    if (_this.taint?.isTaintedRec && !obj.taint?.tagTraces?.has('JAVA_INPUT')) {
      addElementToBuffer(obj, _this)
      mergeElementTrace(obj, _this)
    }

    return obj
  }

  /**
   * Iterable.forEach / Collection.forEach
   * 显式调用 callback，将容器元素绑定到 lambda 形参。支持 union receiver（取各分支元素并集）。
   * 若无可用元素，退化用 _this 作为占位（保留 over-approximation 语义，至少让 lambda body 穿透）。
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
    if (!callback || (callback.vtype !== 'fclos' && callback.vtype !== 'symbol') || typeof (this as any).executeCall !== 'function') {
      return new UndefinedValue()
    }
    const isMethodReference = callback.vtype === 'symbol'

    if (getCallbackParameterCount(callback) >= 2 && isMapLikeReceiver(_this)) {
      const JavaMap = require('./map-builtins')
      return JavaMap.forEach.call(this, fclos, argvalues, state, node, scope)
    }

    const elements: any[] = []
    const visited = new Set<any>()
    const collectElements = (container: any, depth: number) => {
      if (!container || depth > 2 || visited.has(container)) return
      visited.add(container)
      if (container.vtype === 'union' && container.value && typeof container.value === 'object') {
        for (const branch of Object.values(container.value) as any[]) {
          collectElements(branch, depth + 1)
        }
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
          if (Number(key) >= 0) {
            const v = container.value[key]
            if (v && v.vtype !== 'fclos') elements.push(v)
          }
        }
      }
    }
    collectElements(_this, 0)

    if (elements.length === 0) {
      elements.push(_this)
    }

    const parentJavaInputDonor = findVisibleJavaInputDonor(_this)

    // 形参 over-approximation：union receiver 自身 tagTraces 空但分支/buffer 深处含 source tag，
    // 收集所有深层 taint 并 mergeTracesFrom 到元素自身 tagTraces，保证 lambda 形参在下游
    // ARG→ARG / ARG→RET schema（只看 own tagTraces）能识别为污染入口。
    if (_this.taint?.isTaintedRec) {
      for (const element of elements) {
        if (element && element.taint && typeof element.taint.markSource === 'function') {
          element.taint.markSource()
        }
        if (element && element.taint && typeof element.taint.addTag === 'function') {
          element.taint.addTag('JAVA_INPUT')
        }
        if (element && element.taint && _this.taint && typeof element.taint.mergeTracesFrom === 'function') {
          element.taint.mergeTracesFrom(_this.taint)
        }
      }
    }

    for (const element of elements) {
      if (isMethodReference && callback.taint && element?.taint?.isTaintedRec) {
        callback.taint.markSource?.()
        if (typeof callback.taint.mergeTracesFrom === 'function') {
          callback.taint.mergeTracesFrom(element.taint)
        }
        addElementToBuffer(callback, element)
      }
      ;(this as any).executeCall(node, callback, state, scope, {
        callArgs: (this as any).buildCallArgs(node, [element], callback),
      })
      if (state?._methodBodyInstructionCount !== undefined) {
        state._methodBodyInstructionCount += (Config.builtinIterationCost ?? 500)
      }
    }

    // 调用 lambda 后将受污染的 receiver taint 反向写入 lambda 闭包的外层作用域：
    // builtin executeCall 显式执行 lambda 时 caller scope 的 free variable（典型如外层声明的 list/map/set
    // 被 lambda body 调用 add/put）状态写回 caller scope 不一定生效。over-approximation 立场下，把
    // receiver 的源标签复制到 lambda 闭包 parent scope 中的同类 receiver（list/set/map），保留下游
    // Library 调用 / sink-side satisfy BFS 起点过滤识别污染入口的能力。
    if (_this.taint?.isTaintedRec) {
      const lambdaParent = (callback as any)?.parent
      if (lambdaParent && lambdaParent.value && typeof lambdaParent.value === 'object') {
        for (const key of Object.keys(lambdaParent.value)) {
          const v = lambdaParent.value[key]
          if (!v || typeof v !== 'object') continue
          if (v === _this || v === callback) continue
          if (v.vtype === 'fclos' || v.vtype === 'class' || v.vtype === 'primitive') continue
          if (v.taint && typeof v.taint.markSource === 'function' && typeof v.taint.addTag === 'function') {
            const existingJavaInputTrace = getTagTrace(v.taint, JAVA_INPUT_TAG)
            const needsJavaInputDonor = !existingJavaInputTrace || existingJavaInputTrace.length === 0
            const donor = needsJavaInputDonor ? parentJavaInputDonor : _this
            if (!needsJavaInputDonor || donor) {
              v.taint.markSource()
              v.taint.addTag(JAVA_INPUT_TAG)
              if (typeof v.taint.mergeTracesFrom === 'function' && donor?.taint) {
                v.taint.mergeTracesFrom(donor.taint)
              }
            }
          }
        }
      }
    }

    return new UndefinedValue()
  }
}

module.exports = Collection
