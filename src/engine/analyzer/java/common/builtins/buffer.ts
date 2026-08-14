const _ = require('lodash')
const QidUnifyUtil = require('../../../../../util/qid-unify-util')

type BufferedCarrier = {
  uuid?: string
  logicalQid?: string
  qid?: string
  sid?: string
  vtype?: string
  type?: string
  declsNodehash?: unknown
  value?: Record<string, unknown> | unknown[]
  misc_?: Record<string, unknown>
  ast?: { fdef?: { nodehash?: string } }
  taint?: {
    isTaintedRec?: boolean
    tagTraces?: Map<string, unknown>
    getTags?: () => unknown[]
    getTrace?: (tag: string) => unknown
    markSource?: () => void
    addTag?: (tag: string) => void
    mergeTracesFrom?: (source: unknown) => void
    getSanitizerTags?: () => unknown[]
    addSanitizerTag?: (tag: unknown) => void
  }
  _taint?: unknown
}

type BufferOwner = {
  value?: Record<string, unknown>
  length?: number
  getMisc: (key: string) => unknown
  setMisc: (key: string, value: unknown) => void
}

type DeepDonorOptions = {
  includeObjectValue?: boolean
  maxDepth?: number
  maxChildrenPerNode?: number
  tag?: string
}

const DEFAULT_DEEP_DONOR_DEPTH = 4
const DEFAULT_DEEP_DONOR_FANOUT = 32
const JAVA_INPUT_TAG = 'JAVA_INPUT'

function getBuffer(_this: BufferOwner): BufferedCarrier[] {
  const buffer = _this.getMisc('buffer')
  if (Array.isArray(buffer)) {
    return buffer as BufferedCarrier[]
  }
  const newBuffer: BufferedCarrier[] = []
  _this.setMisc('buffer', newBuffer)
  return newBuffer
}

function carrierIdentity(object: BufferedCarrier): string | undefined {
  if (object.logicalQid) return `logical:${object.logicalQid}`
  const astId = object.ast?.fdef?.nodehash || object.declsNodehash
  if (object.qid && astId) return `qid-ast:${object.qid}:${String(astId)}`
  return undefined
}

function sameCarrier(left: BufferedCarrier, right: BufferedCarrier): boolean {
  if (left === right) return true
  const leftIdentity = carrierIdentity(left)
  return Boolean(leftIdentity && leftIdentity === carrierIdentity(right))
}

function mergeCarrierSanitizerTags(target: BufferedCarrier, source: BufferedCarrier): void {
  const sanitizerTags = source.taint?.getSanitizerTags?.()
  if (sanitizerTags && target.taint?.addSanitizerTag) {
    for (const tag of sanitizerTags) target.taint.addSanitizerTag(tag)
  }
}

/**
 * move exist elements to buffer
 * @param _this
 * @param startIndex
 */
function moveExistElementsToBuffer(_this: BufferOwner, startIndex?: number): void {
  if (_.isObject(_this.value)) {
    for (const key in _this.value) {
      if (Number(key) >= 0) {
        if (!startIndex || (typeof startIndex === 'number' && Number(key) >= startIndex)) {
          addElementToBuffer(_this, _this.value[key])
        }
        delete _this.value[key]
      }
    }
  }
  _this.length = 0
}

/**
 * add single object to buffer
 * @param _this
 * @param object
 */
function getBufferIdentity(object: BufferedCarrier): string | undefined {
  return object.uuid || object.logicalQid || object.qid || object.sid
}

function addElementToBuffer(_this: BufferOwner, object: unknown): boolean {
  if (!object || object === _this) {
    return false
  }
  const buffer = getBuffer(_this)
  mergeCarrierSanitizerTags(_this as unknown as BufferedCarrier, object as BufferedCarrier)
  const carrier = object as BufferedCarrier
  if (buffer.length >= 64) {
    const existing = buffer.find((element) => sameCarrier(element, carrier))
    if (existing) {
      mergeCarrierSanitizerTags(existing, carrier)
      return false
    }
  }
  const objectIdentity = getBufferIdentity(carrier)
  for (const existing of buffer) {
    if (existing === object) {
      mergeCarrierSanitizerTags(existing, carrier)
      return false
    }
    if (objectIdentity && getBufferIdentity(existing) === objectIdentity) {
      mergeCarrierSanitizerTags(existing, carrier)
      return false
    }
  }
  buffer.push(carrier)
  return true
}

/**
 * clear buffer
 * @param _this
 */
function clearBuffer(_this: BufferOwner): void {
  _this.setMisc('buffer', [])
}

/**
 * remove element from buffer
 * @param _this
 * @param element
 */
function removeElementFromBuffer(_this: BufferOwner, element: BufferedCarrier): void {
  if (!_this.getMisc('buffer')) {
    return
  }
  const tmpBuffer: BufferedCarrier[] = []
  for (const bufferElement of getBuffer(_this)) {
    if (!sameCarrier(bufferElement, element)) {
      tmpBuffer.push(bufferElement)
    }
  }
  _this.setMisc('buffer', tmpBuffer)
}

/**
 * get all element from buffer
 * @param _this
 */
function getAllElementFromBuffer(_this: BufferOwner): BufferedCarrier[] {
  const result: BufferedCarrier[] = []
  if (!_this || !_this.getMisc('buffer')) {
    return result
  }
  for (const element of getBuffer(_this)) {
    const existing = result.find((item) => sameCarrier(item, element))
    if (existing) {
      mergeCarrierSanitizerTags(existing, element)
      continue
    }
    result.push(element)
  }

  return result
}

function hasSourceTrace(value: BufferedCarrier, tag: string): boolean {
  const trace = value.taint?.getTrace?.(tag)
  return Array.isArray(trace) && trace.some((step: unknown) => {
    const sourceStep = step as { tag?: unknown; str?: unknown }
    return sourceStep.tag === 'SOURCE: ' || (typeof sourceStep.str === 'string' && sourceStep.str.includes('SOURCE: '))
  })
}

function hasUsefulTaint(value: BufferedCarrier, tag: string): boolean {
  if (hasSourceTrace(value, tag)) return true
  if (value.taint?.tagTraces instanceof Map && value.taint.tagTraces.has(tag)) return true
  if (value.taint?.isTaintedRec) return true
  const tags = value.taint?.getTags?.()
  return Array.isArray(tags) && tags.length > 0
}

function getRawBuffer(value: BufferedCarrier): unknown[] {
  if (typeof (value as BufferOwner).getMisc === 'function') {
    const buffer = (value as BufferOwner).getMisc('buffer')
    return Array.isArray(buffer) ? buffer : []
  }
  const buffer = value.misc_?.buffer
  return Array.isArray(buffer) ? buffer : []
}

function collectDeepTaintDonors(root: unknown, options: DeepDonorOptions = {}): BufferedCarrier[] {
  const maxDepth = options.maxDepth ?? DEFAULT_DEEP_DONOR_DEPTH
  const maxChildrenPerNode = options.maxChildrenPerNode ?? DEFAULT_DEEP_DONOR_FANOUT
  const tag = options.tag ?? JAVA_INPUT_TAG
  const includeObjectValue = options.includeObjectValue === true
  const donors: BufferedCarrier[] = []
  const seen = new Set<unknown>()
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    const { value, depth } = current
    if (!value || typeof value !== 'object' || depth > maxDepth || seen.has(value)) continue
    seen.add(value)

    const carrier = value as BufferedCarrier
    if (hasUsefulTaint(carrier, tag)) donors.push(carrier)
    if (depth === maxDepth) continue

    let childCount = 0
    const enqueue = (child: unknown): void => {
      if (childCount >= maxChildrenPerNode) return
      if (child && typeof child === 'object' && !seen.has(child)) {
        childCount += 1
        queue.push({ value: child, depth: depth + 1 })
      }
    }

    for (const child of getRawBuffer(carrier)) enqueue(child)
    if (carrier.vtype === 'union' && Array.isArray(carrier.value)) {
      for (const child of carrier.value) enqueue(child)
    } else if (includeObjectValue && carrier.value && typeof carrier.value === 'object') {
      for (const child of Object.values(carrier.value)) enqueue(child)
    }
  }

  return donors
}

function promoteDeepTaintToCarrier(target: unknown, source: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const targetCarrier = target as BufferedCarrier
  if (!targetCarrier.taint) return false
  const donors = collectDeepTaintDonors(source, {
    includeObjectValue: true,
    maxDepth: 5,
    maxChildrenPerNode: DEFAULT_DEEP_DONOR_FANOUT,
    tag: JAVA_INPUT_TAG,
  })
  const donor = donors.find((candidate) => hasSourceTrace(candidate, JAVA_INPUT_TAG))
  if (!donor?.taint || donor === targetCarrier) return false

  if (typeof (targetCarrier as BufferOwner).setMisc === 'function') addElementToBuffer(targetCarrier as unknown as BufferOwner, donor)
  targetCarrier.taint.markSource?.()
  targetCarrier.taint.addTag?.(JAVA_INPUT_TAG)
  targetCarrier.taint.mergeTracesFrom?.(donor.taint)
  return true
}

module.exports = {
  moveExistElementsToBuffer,
  addElementToBuffer,
  clearBuffer,
  removeElementFromBuffer,
  getAllElementFromBuffer,
  collectDeepTaintDonors,
  promoteDeepTaintToCarrier,
}
