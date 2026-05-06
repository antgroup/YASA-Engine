const _ = require('lodash')
import { RAW_TARGET } from '../engine/analyzer/common/value/symbols'

let _instanceCounter = 0
// 追踪同一 AST 位置创建的实例数量，用于去重：防止 func 多次调用时实例 QID 碰撞
const _sigUsageCount: Map<string, number> = new Map()
import { ObjectValue } from '../engine/analyzer/common/value/object'
import { SymbolValue } from '../engine/analyzer/common/value/symbolic'
import { PackageValue } from '../engine/analyzer/common/value/package'
import { FunctionValue } from '../engine/analyzer/common/value/function'
import { Scoped } from '../engine/analyzer/common/value/scoped'

/**
 * 浅拷贝值，不触发 getter/setter
 * Value 类型委托到 value.clone()，其他类型（数组/Map/Set/plain object）手动拷贝
 * @param value
 */
function shallowCopyValue(value: any, _visited?: WeakSet<any>): any {
  // 基本类型直接返回
  if (value === null || value === undefined || typeof value !== 'object') {
    return value
  }

  // Value 类型：委托到 clone()
  if (typeof value.clone === 'function') {
    return value.clone()
  }

  // 循环引用检测
  if (!_visited) _visited = new WeakSet()
  if (_visited.has(value)) return value
  _visited.add(value)

  // 数组：创建新数组，直接复制元素
  if (Array.isArray(value)) {
    const arrCopy: any[] = []
    for (let i = 0; i < value.length; i++) {
      arrCopy[i] = shallowCopyValue(value[i], _visited)
    }
    return arrCopy
  }

  // Map 类型：通过原型链创建新 Map，复制键值对（对键和值都运行 shallowCopyValue）
  if (value instanceof Map || (typeof value.entries === 'function' && value.constructor !== Object)) {
    try {
      const MapConstructor = Object.getPrototypeOf(value).constructor || Map
      const mapCopy = new MapConstructor()
      if (typeof mapCopy.set === 'function') {
        for (const [key, val] of value.entries()) {
          mapCopy.set(key, shallowCopyValue(val, _visited))
        }
        return mapCopy
      }
    } catch (e) {
      // 如果创建失败，继续后续处理
    }
  }

  // Set 类型：通过原型链创建新 Set，复制元素（对元素都运行 shallowCopyValue）
  if (value instanceof Set || (typeof value.values === 'function' && value.constructor !== Object)) {
    try {
      const SetConstructor = Object.getPrototypeOf(value).constructor || Set
      const setCopy = new SetConstructor()
      if (typeof setCopy.add === 'function') {
        for (const item of value.values()) {
          setCopy.add(shallowCopyValue(item, _visited))
        }
        return setCopy
      }
    } catch (e) {
      // 如果创建失败，继续后续处理
    }
  }

  // Plain object: 创建新对象，直接复制属性值
  const objCopy: any = {}
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      objCopy[key] = value[key]
    }
  }
  return objCopy
}

/**
 * 本质是带深度的拷贝，将field下的内容也创建新的实例
 * @param analyzer
 * @param originalObj
 * @param originalObj
 * @param node
 * @param scope
 * @param f
 * @param f1
 * @param f2
 * @param recursiveDepth
 * @param options
 * @param options.skipTagTraceMap
 */
// 根据原始对象类型选择构造函数（默认 ObjectValue）
const INSTANCE_CTOR_MAP: Record<string, any> = {
  ObjectValue,
  SymbolValue,
  FunctionValue,
  PackageValue,
  Scoped,
}

function buildNewValueInstance(
  analyzer: any,
  originalObj: any,
  node: any,
  scope: any,
  f1: any,
  f2: any,
  recursiveDepth = 1,
  options?: { skipTagTraceMap?: boolean; qidSuffix?: string; forceVtype?: string }
): any {
  const qidSuffix = options?.qidSuffix || ''
  const forceVtype = options?.forceVtype
  const opts = { ...originalObj, vtype: forceVtype || 'object' }
  delete opts._field
  opts._field = {}
  // taint 由构造函数创建，删除 opts.taint 让构造函数创建空实例
  delete opts.taint
  let sig = '<astloc_unknown>'
  if (
    node?.loc &&
    node?.loc?.sourcefile &&
    node?.loc?.start?.line &&
    node?.loc?.start?.column &&
    node?.loc?.end?.line &&
    node?.loc?.end?.column
  ) {
    const filename = node.loc.sourcefile.split('/').pop()
    sig = `${filename.substring(0, filename.lastIndexOf('.') > 0 ? filename.lastIndexOf('.') : filename.length)}_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}_${++_instanceCounter}`
  } else if (
    node?.callee?.loc &&
    node?.callee?.loc?.sourcefile &&
    node?.callee?.loc?.start?.line &&
    node?.callee?.loc?.start?.column &&
    node?.callee?.loc?.end?.line &&
    node?.callee?.loc?.end?.column
  ) {
    const filename = node.callee.loc.sourcefile.split('/').pop()
    sig = `${filename.substring(0, filename.lastIndexOf('.') > 0 ? filename.lastIndexOf('.') : filename.length)}_${node.callee.loc?.start?.line}_${node.callee.loc?.start?.column}_${node.callee.loc?.end?.line}_${node.callee.loc?.end?.column}_${++_instanceCounter}`
  } else {
    sig = `<astloc_seq_${++_instanceCounter}>`
  }
  // 同一 (originalObj.qid, sig) 组合被多次使用时，追加计数器以避免 UUID 碰撞
  // 场景：同一函数被多次调用，每次在相同 AST 位置创建不同实例（如 Regist 被调用 21 次）
  const dedupKey = `${originalObj.qid}|${sig}`
  const dedupCount = (_sigUsageCount.get(dedupKey) ?? 0) + 1
  _sigUsageCount.set(dedupKey, dedupCount)
  const dedupSuffix = dedupCount > 1 ? `_x${dedupCount}` : ''
  opts._sid = `${originalObj.sid}<instance_${sig}${dedupSuffix}_endtag>`
  opts._qid = `${originalObj.qid}<instance_${sig}${dedupSuffix}_endtag>${qidSuffix}`
  opts._skipRegister = false
  const CtorClass = (!forceVtype || forceVtype === 'object') ? ObjectValue : (INSTANCE_CTOR_MAP[originalObj.constructor?.name] || ObjectValue)
  const obj = new CtorClass(opts)
  obj.reset()

  obj._this = obj
  if (obj.parent?.sid === '<global>') {
    obj.parent = scope
  }
  if (typeof originalObj.value === 'object') {
    const instanceTag = `<instance_${sig}_endtag>`
    const visited = new WeakSet()
    const MAX_RECURSION_DEPTH = recursiveDepth // 最大递归层数，默认往下1层，总共2层

    /**
     * 递归处理符号值，为其添加 instance 标记
     * @param val 要处理的符号值
     * @param parentObj 父对象
     * @param key 父对象value中的索引
     * @param depth 当前递归深度
     */
    const addInstanceTagRecursive = (val: any, parentObj: any, key: any, depth: number): void => {
      // 检查递归深度限制
      if (depth >= MAX_RECURSION_DEPTH) {
        return
      }

      if (!val || typeof val !== 'object') {
        return
      }

      // 避免循环引用
      if (visited.has(val)) {
        return
      }
      visited.add(val)
      const newVal = shallowCopyValue(val)
      // skipTagTraceMap 时清空 taint 而非删除引用
      if (options?.skipTagTraceMap && newVal.taint) {
        newVal.taint.clear()
      }
      // 如果是符号值（有 vtype 和 qid 属性），添加 instance 标记
      if (newVal.vtype && newVal.qid && typeof newVal.qid === 'string') {
        // 如果 qid 还没有这个标记，添加它
        if (!newVal.qid.includes(instanceTag)) {
          let newQid = newVal.qid

          // 如果父对象有 qid 且包含 instanceTag，需要在正确位置插入
          if (parentObj && parentObj.qid && typeof parentObj.qid === 'string' && parentObj.qid.includes(instanceTag)) {
            // 找到父对象 qid 中 instanceTag 的位置
            const parentQidWithTag = parentObj.qid
            const parentQidWithoutTag = parentQidWithTag.replace(instanceTag, '')

            // 如果子对象的 qid 以父对象的 qid（不含 tag）开头
            if (newVal.qid.startsWith(parentQidWithoutTag)) {
              // 提取子对象相对于父对象的部分
              const relativePart = newVal.qid.substring(parentQidWithoutTag.length)
              // 如果 relativePart 以 . 开头，去掉开头的 .
              const suffix = relativePart.startsWith('.') ? relativePart.substring(1) : relativePart
              // 构造新的 qid: parentQidWithTag + '.' + suffix
              newQid = suffix ? `${parentQidWithTag}.${suffix}` : parentQidWithTag
            } else {
              // 如果子对象的 qid 不以父对象的 qid 开头，直接在末尾添加
              newQid = `${newVal.qid}${instanceTag}`
            }
          } else {
            // 如果父对象没有 instanceTag，直接在末尾添加
            newQid = `${newVal.qid}${instanceTag}`
          }
          newVal._qid = newQid
          newVal._logicalQid = undefined
          newVal._this = parentObj
          newVal.parent = parentObj
          parentObj.value[key] = newVal
        }
      }

      // 递归处理 value 属性（如果存在且是对象）
      if (newVal.value && typeof newVal.value === 'object' && newVal.value !== newVal._field) {
        if (Array.isArray(newVal.value)) {
          for (let i = 0; i < newVal.value.length; i++) {
            const item = newVal.value[i]
            if (item && typeof item === 'object') {
              addInstanceTagRecursive(item, newVal, i, depth + 1)
            }
          }
        } else {
          for (const vkey in newVal.value) {
            if (Object.prototype.hasOwnProperty.call(newVal.value, vkey)) {
              const item = newVal.value[vkey]
              addInstanceTagRecursive(item, newVal, vkey, depth + 1)
            }
          }
        }
      }

      // 递归处理 _field 中的值
      if (newVal._field && typeof newVal._field === 'object') {
        const fieldTarget = (newVal._field as any)[RAW_TARGET] || newVal._field

        // 如果是数组（union 类型）
        if (Array.isArray(fieldTarget)) {
          for (let i = 0; i < fieldTarget.length; i++) {
            const element = fieldTarget[i]
            // 如果是 UUID，从符号表中获取实际对象并递归处理
            if (typeof element === 'string' && element.startsWith('symuuid_')) {
              const unit = analyzer.symbolTable.get(element)
              if (unit) {
                addInstanceTagRecursive(unit, newVal, i, depth + 1)
              }
            } else if (element && typeof element === 'object') {
              addInstanceTagRecursive(element, newVal, i, depth + 1)
            }
          }
        }
        // 如果是普通对象
        else {
          for (const fieldKey in fieldTarget) {
            if (Object.prototype.hasOwnProperty.call(fieldTarget, fieldKey)) {
              const fieldValue = fieldTarget[fieldKey]
              // 如果是 UUID，从符号表中获取实际对象并递归处理
              if (typeof fieldValue === 'string' && fieldValue.startsWith('symuuid_')) {
                const unit = analyzer.symbolTable.get(fieldValue)
                if (unit) {
                  addInstanceTagRecursive(unit, newVal, fieldKey, depth + 1)
                }
              } else if (fieldValue && typeof fieldValue === 'object') {
                addInstanceTagRecursive(fieldValue, newVal, fieldKey, depth + 1)
              }
            }
          }
        }
      }
    }

    // 处理下层的 value
    for (const x in originalObj.value) {
      if (f1(x)) {
        continue
      }
      const v = originalObj.value[x]
      if (f2(v)) {
        continue
      }
      if (typeof v === 'object') {
        // 递归处理 v_copy 及其嵌套的 value，从深度0开始
        addInstanceTagRecursive(v, obj, x, 0)
      }
    }
  }
  return obj
}

/**
 *
 * @param analyzer
 * @param value
 * @param tag
 */
function buildNewCopiedWithTag(analyzer: any, value: any, tag: string) {
  const copiedTag = `<copied_${tag}_endtag>`
  let targetUuid = analyzer.symbolTable.calculateUUID(value, copiedTag)
  let suffix = 0
  let newTag = copiedTag
  while (analyzer.symbolTable.has(targetUuid)) {
    suffix++
    newTag = `<copied_${tag}_${suffix}_endtag>`
    targetUuid = analyzer.symbolTable.calculateUUID(value, newTag)
  }
  const newVal = shallowCopyValue(value)
  newVal._qid += newTag
  newVal._logicalQid = undefined
  newVal.uuid = null
  if (typeof newVal.calculateAndRegisterUUID === 'function') {
    newVal.calculateAndRegisterUUID()
  }
  return newVal
}

/**
 * Alias-clone a Value and assign a new UUID (cloned tag).
 * Uses value.cloneAlias() for shallow clone that shares _field Proxy,
 * then appends a timestamp+random tag to qid and re-registers in symbolTable.
 * @param value
 */
function lodashCloneWithTag(value: any) {
  const newVal = typeof value?.cloneAlias === 'function' ? value.cloneAlias() : _.clone(value)
  if (newVal.qid) {
    const timestamp = Date.now().toString().slice(-8)
    const random = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, '0')
    const copiedTag = `<cloned_${timestamp}_${random}_endtag>`
    newVal._qid += copiedTag
    newVal._logicalQid = undefined
    newVal.uuid = null
    newVal.calculateAndRegisterUUID()
  }
  return newVal
}

// eslint-disable-next-line import/prefer-default-export
export { shallowCopyValue, buildNewValueInstance, buildNewCopiedWithTag, lodashCloneWithTag }
