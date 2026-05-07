const _ = require('lodash')
import { DataValue } from './data-value'
import Unit = require('./unit')
import { ValueRefList } from './value-ref-list'
import { ValueRef } from './value-ref'
const { TaintRecord, NULL_TAINT } = require('./taint-record')
import { RAW_TARGET, IS_UNION_ARRAY } from './symbols'
const astUtil = require('../../../../util/ast-util')

/**
 * UnionValue - 联合值
 *
 * 固定构造函数：具名参数，不使用 opts 对象
 * AST-based UUID：union 只用 AST，不用序号
 */
export class UnionValue extends DataValue {
  set: WeakSet<Unit>
  elements!: ValueRefList
  isTuple: boolean = false

  raw_value: unknown

  /**
   * @param value - Union 元素数组（可选，默认空数组）
   * @param sid - 符号 ID（可选，默认 '<unionValue>'）
   * @param qid - 限定 ID（可选，默认 '<unionValue>'）
   * @param astNode - 创建点的 AST 节点（用于 UUID 稳定性）
   */
  constructor(value?: Unit[], sid?: string, qid?: string, astNode?: object | null) {
    const opts: Record<string, any> = {
      sid: sid || '<unionValue>',
      qid: qid || '<unionValue>',
    }
    if (astNode) opts.ast = astNode

    super('union', opts)
    if (this.taint === NULL_TAINT) this.taint = new TaintRecord(this)
    this.taint.markRecursive()

    this.set = new WeakSet()
    Object.defineProperty(this, 'elements', {
      value: new ValueRefList(() => this.getSymbolTable()),
      writable: true,
      enumerable: false,
      configurable: true,
    })

    // 通过 value setter 设置（触发 wrapFieldArray，匹配旧行为）
    this.value = (value && Array.isArray(value)) ? value : []
  }


  static fromOpts(upperQid: string, opts: any): UnionValue {
    const value = opts?.value
    const sid = opts?.sid
    const qid = opts?.qid

    const unionValue = new UnionValue(undefined, sid, qid)

    // 恢复 value
    if (value) {
      if (Array.isArray(value)) {
        unionValue._field = value
      } else {
        unionValue._field = Object.values(value)
      }
    }

    // 处理 raw_value 合并（反序列化专用）
    const rawValue = opts?.raw_value
    if (rawValue) {
      let oldValue: any[] = []
      if (!_.isArray(value)) {
        oldValue = Object.values(value || {})
      }

      let rawArr = rawValue
      if (!_.isArray(rawArr)) {
        rawArr = Object.values(rawArr)
      }
      rawArr.forEach((element: any) => oldValue.push(element))
      unionValue._field = oldValue
    }

    const rawField = Array.isArray(unionValue._field) ? [...unionValue._field] : Object.values(unionValue._field || {})
    unionValue.wrapFieldArray()
    unionValue._syncElements(rawField)

    // 恢复原始 qid
    if (opts?.qid) {
      unionValue._qid = opts.qid
    }
    if (opts?.parent) {
      unionValue.parent = opts.parent
    }
    if (opts?._this) {
      unionValue._this = opts._this
    }
    if (opts?.name) {
      unionValue.name = opts.name
    }

    return unionValue
  }

  /**
   * Clone _field for UnionValue: extract raw array from double Proxy, re-wrap.
   */
  protected override _cloneField(copy: UnionValue, fieldValue: any): void {
    if (!fieldValue || typeof fieldValue !== 'object') {
      copy._field = fieldValue
      return
    }
    const desc = Object.getOwnPropertyDescriptor(fieldValue, RAW_TARGET)
    const raw = desc?.value
    if (Array.isArray(raw)) {
      copy._field = [...raw]
    } else if (Array.isArray(fieldValue)) {
      copy._field = [...fieldValue]
    } else {
      copy._field = fieldValue
    }
    copy.wrapFieldArray()
  }

  override clone(): this {
    const copy = super.clone()
    copy.set = new WeakSet()
    if (this.elements && typeof this.elements._clone === 'function') {
      Object.defineProperty(copy, 'elements', {
        value: this.elements._clone(() => copy.getSymbolTable()),
        writable: true,
        enumerable: false,
        configurable: true,
      })
    }
    return copy
  }

  override cloneAlias(): this {
    const copy = super.cloneAlias()
    copy.set = new WeakSet()
    if (this.elements && typeof this.elements._clone === 'function') {
      Object.defineProperty(copy, 'elements', {
        value: this.elements._clone(() => copy.getSymbolTable()),
        writable: true,
        enumerable: false,
        configurable: true,
      })
    }
    return copy
  }

  /**
   * Get value
   */
  override get value(): any[] {
    if (!Array.isArray(this._field)) {
      this._field = Object.values(this._field)
      this.wrapFieldArray()
    }
    return this._field as any[]
  }

  /**
   * Set value
   * @param v - New value
   */
  override set value(v: any[]) {
    this._field = v
    this.set = new WeakSet()
    this.wrapFieldArray()
    this._syncElements(v)
  }

  /**
   * Get trace by tag — delegate to children's TaintBinding
   * @param tag - Tag to search for
   */
  override getTrace(tag: string): any {
    return _.find(this.value, (v: Unit) => {
      if (v?.taint.containsTag(tag)) {
        return v.taint.getTrace(tag)
      }
    })
  }

  /**
   * Get taint info by tag
   * @param tag - Tag to search for
   */
  getTaintInfo(tag: string): { value: Unit; trace: unknown } | undefined {
    const value = _.find(this.value, (v: Unit) => {
      return v?.taint.containsTag(tag)
    })
    if (value) {
      return {
        value,
        trace: value.taint.getTrace(tag),
      }
    }
  }

  /**
   * Get this instance
   */
  override getThisObj(): UnionValue {
    return new UnionValue(this.value.map((v: Unit) => v.getThisObj()), this.sid, this.qid, this.ast?.node)
  }

  /**
   * Append value to union
   * @param val - Value to append
   * @param uniqueFlag - Whether to deduplicate
   * @param flatten - Whether to flatten inner UnionValues (false preserves tuple position structure)
   */
  appendValue(val: Unit | Unit[], uniqueFlag: boolean = true, flatten: boolean = true): void {
    if (!val) return

    if (Array.isArray(val)) {
      val.forEach((v: Unit) => {
        this._pushValue(v, uniqueFlag)
      })
      return
    }

    if (flatten && val instanceof UnionValue && !val.isTuple) {
      for (const v of val.value) {
        this.appendValue(v, uniqueFlag, flatten)
      }
    } else if (val instanceof Unit) {
      this._pushValue(val, uniqueFlag)
    }
  }

  /**
   * Push value to union
   * @param val - Value to push
   * @param uniqueFlag - Whether to deduplicate
   */
  private _pushValue(val: Unit, uniqueFlag: boolean = true): void {
    if (this === val) {
      return
    }
    if (this.uuid === val.uuid) {
      return
    }
    if (this.isUnionInBVT(this, val)) {
      return
    }
    if (this.set.has(val) && uniqueFlag) {
      return
    }
    const isEqual = this.value.some((ele: Unit) => {
      return (
        _.isEqual(ele, val) ||
        (val.vtype === ele.vtype && val.vtype === 'symbol' && ele.hasOwnProperty('loc') && _.isEqual(ele.loc, val.loc))
      )
    })
    if (isEqual && uniqueFlag) {
      return
    }

    const valueToPush = val.uuid

    this.value.push(valueToPush)
    this.set.add(val)
    this.elements.push(val)
  }

  /**
   * 包装 field 数组为 Proxy，拦截所有数组操作，自动更新 UUID
   */
  _syncElements(source?: unknown[]): void {
    Object.defineProperty(this, 'elements', {
      value: new ValueRefList(() => this.getSymbolTable()),
      writable: true,
      enumerable: false,
      configurable: true,
    })
    if (!source) return
    for (let i = 0; i < source.length; i++) {
      const val = source[i]
      if (typeof val === 'string' && val.startsWith('symuuid_')) {
        this.elements._refs.push(new ValueRef(val))
      } else if (val && typeof val === 'object' && 'uuid' in val && typeof (val as Unit).uuid === 'string') {
        this.elements._refs.push(new ValueRef((val as Unit).uuid))
      }
    }
  }

  private wrapFieldArray(): void {
    if (!Array.isArray(this._field)) {
      return
    }

    if ((this._field as any)[IS_UNION_ARRAY]) {
      return
    }

    const self = this
    const rawArray = this._field
    const arrayMethods = ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse']
    let hasUnionArrayProxy = false

    const fieldProxy = new Proxy(rawArray, {
      get(target, prop) {
        const value = (target as any)[prop]

        // 拦截数组修改方法
        if (typeof prop === 'string' && arrayMethods.includes(prop) && typeof value === 'function') {
          return function (...args: any[]) {
            const result = value.apply(target, args)
            return result
          }
        }

        // 拦截 length 属性的设置（通过直接赋值 length = n）
        if (prop === 'length' && typeof value === 'number') {
          return value
        }

        // 如果是数组索引访问（如 array[0], array[1]），需要检查值是否是 UUID
        if (typeof prop === 'string' && !isNaN(Number(prop))) {
          // 如果值是 UUID，从符号表中查找对应的符号值对象
          if (typeof value === 'string' && value.startsWith('symuuid_')) {
            const symbolTable = self.getSymbolTable()
            if (symbolTable && symbolTable.has(value)) {
              return symbolTable.get(value)
            }
          }
        }

        // 如果不是数组索引或不是 UUID，返回原始值
        return value
      },
      set(target, prop, value) {
        // 拦截直接赋值操作（如 array[0] = value, array.length = n）
        const symbolTable = self.getSymbolTable()

        // 如果是数组索引赋值（如 array[0] = value），需要处理 UUID 引用关系
        if (typeof prop === 'string' && !isNaN(Number(prop))) {
          if (value instanceof Unit || (value && typeof value === 'object' && value.vtype && value.qid)) {
            if (symbolTable) {
              const uuid = symbolTable.register(value)
              ;(target as any)[prop] = uuid
              return true
            }
          }
        }

        ;(target as any)[prop] = value

        return true
      },

      ownKeys(target) {
        // 获取所有自有属性键
        const keys: (string | symbol)[] = Reflect.ownKeys(target).filter((key) => typeof key === 'string')
        if (hasUnionArrayProxy) {
          keys.push(IS_UNION_ARRAY, RAW_TARGET)
        }
        return keys
      },

      getOwnPropertyDescriptor(target, prop) {
        if (prop === IS_UNION_ARRAY && hasUnionArrayProxy) {
          return {
            value: true,
            writable: false,
            enumerable: false,
            configurable: false,
          }
        }
        return Object.getOwnPropertyDescriptor(target, prop)
      },
    })

    if (
      !Object.prototype.hasOwnProperty.call(fieldProxy, IS_UNION_ARRAY) &&
      Object.getOwnPropertyDescriptor(fieldProxy, IS_UNION_ARRAY) === undefined
    ) {
      Object.defineProperty(fieldProxy, IS_UNION_ARRAY, {
        value: true,
        writable: false,
        enumerable: false,
        configurable: false,
      })
      hasUnionArrayProxy = true
    }

    Object.defineProperty(fieldProxy, RAW_TARGET, {
      value: rawArray,
      writable: false,
      enumerable: false,
      configurable: false,
    })

    this._field = fieldProxy
  }

  /**
   * 已废弃：uuid 不再随 field 变化重算
   */
  updateUUID(): void {}

  /**
   * Check if union is in BVT to prevent infinite loops
   * @param targetUnion - Target union
   * @param baseBVT - Base BVT
   */
  private isUnionInBVT(targetUnion: UnionValue, baseBVT: Unit, visited?: Set<Unit>): boolean {
    if (!targetUnion || !baseBVT) return false
    if (!visited) visited = new Set()
    if (visited.has(baseBVT)) return false
    visited.add(baseBVT)

    if (baseBVT.vtype === 'BVT') {
      // 如果存在 children 属性，则递归检查每个子对象
      if (baseBVT.children && typeof baseBVT.children === 'object') {
        for (const key in baseBVT.children) {
          const child = baseBVT.children[key]

          // 如果子对象的 vtype 为 "union"，检查其值是否为 "this"
          if (child.vtype === 'union') {
            if (child._field === targetUnion._field) {
              return true
            }
          }
          // 如果子对象的 vtype 为 "BVT"，递归检查它
          else if (child.vtype === 'BVT') {
            if (this.isUnionInBVT(targetUnion, child, visited)) {
              return true
            }
          }
        }
      }

      return false
    }

    // 如果当前对象的 vtype 不是 "BVT"，返回 false
    return false
  }
}
