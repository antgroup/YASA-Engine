const {
  ValueUtil: { UndefinedValue },
} = require('../../../../util/value-util')
const { addElementToBuffer } = require('./buffer')
const { UnionValue } = require('../../../common/value/union')
const JAVA_INPUT_TAG = 'JAVA_INPUT'

type TaintLike = {
  isTainted?: boolean
  isTaintedRec?: boolean
  getTags?: () => unknown[]
  getTrace?: (tag: string) => unknown
  addTag?: (tag: string) => void
  markSource?: () => void
  mergeTracesFrom?: (source: TaintLike) => void
}

type AnalyzerValueLike = {
  sid?: string
  qid?: string
  vtype?: string
  value?: unknown
  taint?: TaintLike
  misc_?: { buffer?: unknown }
  getMisc?: (key: string) => unknown
  getFieldValue?: (fieldName: string, createIfNotExists?: boolean) => unknown
  object?: unknown
}

type TraceStepLike = {
  tag?: unknown
  str?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function isAnalyzerValue(value: unknown): value is AnalyzerValueLike {
  return isRecord(value)
}

function hasDirectSourceTrace(value: unknown): value is AnalyzerValueLike {
  if (!isAnalyzerValue(value)) return false
  return !!(value.taint?.isTainted || (value.taint?.getTags?.().length ?? 0) > 0)
}

function mergeDirectTrace(target: unknown, source: unknown): void {
  if (!isAnalyzerValue(target) || !isAnalyzerValue(source) || !target.taint || !source.taint || !hasDirectSourceTrace(source)) return
  target.taint.markSource?.()
  if (typeof target.taint.mergeTracesFrom === 'function') {
    target.taint.mergeTracesFrom(source.taint)
  }
}

function findJavaInputTraceDonor(root: unknown, maxDepth = 4): AnalyzerValueLike | null {
  const seen = new Set<unknown>()
  const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    const { value, depth } = current
    if (!isAnalyzerValue(value) || depth > maxDepth || seen.has(value)) continue
    seen.add(value)
    const trace = value.taint?.getTrace?.(JAVA_INPUT_TAG)
    if (Array.isArray(trace) && trace.some((step: unknown) => {
      const traceStep = step as TraceStepLike
      return traceStep.tag === 'SOURCE: ' || (typeof traceStep.str === 'string' && traceStep.str.includes('SOURCE: '))
    })) return value
    if (depth === maxDepth) continue
    const enqueue = (child: unknown): void => {
      if (isRecord(child) && !seen.has(child)) queue.push({ value: child, depth: depth + 1 })
    }
    const buffer = typeof value.getMisc === 'function' ? value.getMisc('buffer') : value.misc_?.buffer
    if (Array.isArray(buffer)) for (const child of buffer) enqueue(child)
    if (value.vtype === 'union' && Array.isArray(value.value)) {
      for (const child of value.value) enqueue(child)
    } else if (isRecord(value.value)) {
      for (const child of Object.values(value.value)) enqueue(child)
    }
  }
  return null
}

function attachJavaInputTrace(target: unknown, donor: AnalyzerValueLike | null): void {
  if (!isAnalyzerValue(target) || !target.taint || !donor?.taint) return
  if (target !== donor) addElementToBuffer(target, donor)
  target.taint.addTag?.(JAVA_INPUT_TAG)
  target.taint.markSource?.()
  target.taint.mergeTracesFrom?.(donor.taint)
}

function getBufferedFieldValue(branch: unknown, fieldName: string): AnalyzerValueLike | undefined {
  if (!isAnalyzerValue(branch)) return undefined
  const buffer = typeof branch.getMisc === 'function' ? branch.getMisc('buffer') : branch.misc_?.buffer
  if (!Array.isArray(buffer)) return undefined
  return buffer.find((value: unknown) => isAnalyzerValue(value) && (value.sid === fieldName || (typeof value.sid === 'string' && value.sid.startsWith(`${fieldName}(`))))
}

function getUnionFieldValue(receiver: unknown, fieldName: string, node: unknown): AnalyzerValueLike | undefined {
  if (!isAnalyzerValue(receiver) || receiver.vtype !== 'union' || !Array.isArray(receiver.value)) return undefined
  const values: AnalyzerValueLike[] = []
  const seen = new Set<AnalyzerValueLike>()
  for (const branch of receiver.value) {
    if (!isAnalyzerValue(branch)) continue
    const directFieldValue = branch.getFieldValue?.(fieldName, false)
    const fieldValue = (isAnalyzerValue(directFieldValue) ? directFieldValue : undefined) ?? getBufferedFieldValue(branch, fieldName)
    if (!fieldValue || seen.has(fieldValue)) continue
    seen.add(fieldValue)
    values.push(fieldValue)
  }
  if (values.length === 0) return undefined
  const donor = values.map((value) => findJavaInputTraceDonor(value)).find((value): value is AnalyzerValueLike => Boolean(value)) ?? null
  if (values.length === 1) {
    if (donor) attachJavaInputTrace(values[0], donor)
    return values[0]
  }
  const astNode = isRecord(node) ? node : null
  const res = new UnionValue(values, `${receiver.sid}.${fieldName}`, `${receiver.qid}.${fieldName}`, astNode)
  if (donor) attachJavaInputTrace(res, donor)
  return res
}

module.exports = {
  /**
   * require processing for commonJS module
   * @param fname
   * @param fieldName
   */
  processGetter(fname: any, fieldName: any) {
    return function getter(fclos: any, argvalues: any, state: any, node: any, scope: any) {
      const _this = fclos.getThisObj()
      if (!_this) {
        return new UndefinedValue()
      }
      const res = getUnionFieldValue(_this, fieldName, node) ?? _this.getFieldValue(fieldName, true)
      if (res && typeof res === 'object' && res?.vtype !== 'fclos' && res?.vtype !== 'class' && ['symbol', 'object'].includes(_this.vtype)) {
        res.object = _this
        mergeDirectTrace(res, _this)
      }
      // 补齐 union 接收者 taint 传播（与 java-analyzer.ts:1542-1569 对称）
      // 当 _this.vtype === 'union' 时，上方 symbol/object 守卫跳过了 mergeDirectTrace，
      // 导致 getter 返回值丢失 JAVA_INPUT taint
      if (_this.vtype === 'union' && res && typeof res === 'object'
          && res?.vtype !== 'fclos' && res?.vtype !== 'class'
          && res !== _this) {
        if (!res.taint?.tagTraces?.has('JAVA_INPUT')) {
          const donor = findJavaInputTraceDonor(_this)
          if (donor && donor.taint && donor !== res) {
            const resBuf = typeof res.getMisc === 'function' ? res.getMisc('buffer') : null
            const donorAlreadyInBuf = Array.isArray(resBuf) && resBuf.includes(donor)
            if (!donorAlreadyInBuf) {
              addElementToBuffer(res, donor)
              res.taint?.markSource?.()
              if (typeof res.taint?.mergeTracesFrom === 'function') {
                res.taint.mergeTracesFrom(donor.taint)
              }
            }
          }
        }
        res.object = _this
      }
      return res
    }
  },
  processSetter(fname: any, fieldName: any) {
    // TODO setter 有点问题，如
    // public void setSuccess(){
    //         this.setSuccess("S");
    //         this.setResultCode("00000000");
    //         this.setResultMsg("SUCCESS");
    //     }
    // 没有入参，会把符号值变为undefined
    return function setter(fclos: any, argvalues: any, state: any, node: any, scope: any) {
      const _this = fclos.getThisObj()
      if (!_this) {
        return new UndefinedValue()
      }
      if (_this.vtype === 'primitive') {
        return _this
      }
      _this.setFieldValue(fieldName, argvalues[0])
      // setter 挂 buffer 受三重保护：让 setter 链路（748 类型）的污点能经 _this.buffer 传到下游
      // sink；non-tainted setter 不进 buffer，避免 Spring DTO 链 N 次 setter 把无污点参数累积引发
      // getter copyBufferedElements 端 N×N fan-out OOM（onepaas/medreg 教训）。
      //   1. argvalues[0] 自身带污点（isTaintedRec 或 tagTraces.size > 0）
      //   2. argvalues[0].tagTraces.size <= 4（防深 trace 触发 N×N 合并）
      //   3. _this.buffer.length < 8（防累积爆量）
      const setterArg = argvalues[0]
      const tt = setterArg?.taint?.tagTraces
      const tainted = setterArg?.taint?.isTaintedRec || (tt instanceof Map && tt.size > 0)
      if (tainted && (!(tt instanceof Map) || tt.size <= 4)) {
        const existingBuf = typeof _this.getMisc === 'function' ? _this.getMisc('buffer') : undefined
        const bufLen = Array.isArray(existingBuf) ? existingBuf.length : 0
        if (bufLen < 8) {
          addElementToBuffer(_this, setterArg)
          mergeDirectTrace(_this, setterArg)
        }
      }
      return _this
    }
  },
  _CTOR_(fclos: any, argvalues: any, state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this) {
      return new UndefinedValue()
    }
    if (_this.vtype === 'primitive' || !Array.isArray(argvalues)) {
      return _this
    }
    for (const argvalue of argvalues) {
      if (argvalue.sid) {
        _this.setFieldValue(argvalue.sid, argvalue)
        addElementToBuffer(_this, argvalue)
      }
    }
    return _this
  },
}
