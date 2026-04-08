const _ = require('lodash')
import { DataValue } from './data-value'
import { ValueRefMap } from './value-ref-map'
import { ValueRef } from './value-ref'
const astUtil = require('../../../../util/ast-util')
const { TaintRecord, NULL_TAINT } = require('./taint-record')

export interface BVTValueOptions {
  sid?: string
  qid?: string
  children?: Record<string, any>
  parent?: any
}

/**
 * BVTValue (Branch Value Tree) class
 *
 * 路径敏感分析的条件分支值
 */
export class BVTValue extends DataValue {
  private _children!: ValueRefMap
  private _cachedChildren: Record<string, any> | null = null
  declare children: Record<string, any>

  constructor(upperQid: string, sid: string, childrenData: Record<string, any>) {
    const opts: { sid: string; qid?: string } = { sid }

    const childQids: string[] = []
    for (const key in childrenData) {
      if (childrenData.hasOwnProperty(key)) {
        const child = childrenData[key]
        if (child && child.hasOwnProperty('qid') && child.qid) {
          childQids.push(child.qid)
        }
      }
    }
    if (childQids.length > 0) {
      opts.sid = `${sid}.<BVTValue>`
      opts.qid = `<BVTValue_${childQids.join('_')}>`
    }

    super('BVT', upperQid || '', opts)
    if (this.taint === NULL_TAINT) this.taint = new TaintRecord(this)
    this.taint.markRecursive()

    this._initChildren(childrenData)
  }

  /**
   * 初始化 _children 和 children 自有访问器属性
   * children 必须是 own enumerable accessor，保证 spread、for...in、Object.keys 兼容
   */
  _initChildren(source?: Record<string, any>): void {
    Object.defineProperty(this, '_children', {
      value: new ValueRefMap(() => this.getSymbolTable()),
      writable: true,
      enumerable: false,
      configurable: true,
    })

    Object.defineProperty(this, 'children', {
      get: () => this._resolveChildren(),
      set: (obj: Record<string, any>) => {
        Object.defineProperty(this, '_children', {
          value: new ValueRefMap(() => this.getSymbolTable()),
          writable: true,
          enumerable: false,
          configurable: true,
        })
        this._cachedChildren = null
        if (obj && typeof obj === 'object') {
          for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
              this._children.set(key, obj[key])
            }
          }
        }
      },
      enumerable: true,
      configurable: true,
    })

    if (source && typeof source === 'object') {
      for (const key in source) {
        if (source.hasOwnProperty(key)) {
          this._children.set(key, source[key])
        }
      }
    }
  }

  private _resolveChildren(): Record<string, any> {
    if (!this._children) return {}
    if (this._cachedChildren) return this._cachedChildren
    const st = this.getSymbolTable()
    const result: Record<string, any> = {}
    for (const [key, ref] of this._children._map) {
      const resolved = ref.resolve(st)
      if (resolved) {
        result[key] = resolved
      } else if (ref.uuid) {
        result[key] = ref.uuid
      } else {
        result[key] = undefined
      }
    }
    this._cachedChildren = result
    return result
  }

  getChild(key: string): any {
    return this._children.get(key)
  }

  setChild(key: string, value: any): void {
    this._children.set(key, value)
    this._cachedChildren = null
  }



  static fromOpts(upperQid: string, opts: BVTValueOptions): BVTValue {
    const finalOpts = opts || {}
    const childrenData = finalOpts.children || {}
    const sid = finalOpts.sid || '<BVT>'
    const qid = finalOpts.qid
    const bvt = new BVTValue(upperQid, sid, childrenData)
    if (qid) {
      bvt._qid = qid
    }
    return bvt
  }

  override clone(): this {
    const copy = super.clone()
    if (this._children && typeof this._children._clone === 'function') {
      Object.defineProperty(copy, '_children', {
        value: this._children._clone(() => copy.getSymbolTable()),
        writable: true,
        enumerable: false,
        configurable: true,
      })
      copy._cachedChildren = null
      Object.defineProperty(copy, 'children', {
        get: () => copy._resolveChildren(),
        set: (obj: Record<string, any>) => { copy.value = obj },
        enumerable: true,
        configurable: true,
      })
    }
    return copy
  }

  override cloneAlias(): this {
    const copy = super.cloneAlias()
    if (this._children && typeof this._children._clone === 'function') {
      Object.defineProperty(copy, '_children', {
        value: this._children._clone(() => copy.getSymbolTable()),
        writable: true,
        enumerable: false,
        configurable: true,
      })
      copy._cachedChildren = null
      Object.defineProperty(copy, 'children', {
        get: () => copy._resolveChildren(),
        set: (obj: Record<string, any>) => { copy.value = obj },
        enumerable: true,
        configurable: true,
      })
    }
    return copy
  }

  override getRawValue(): any[] {
    const childrenValues = this._children.entries().map(([_, val]) => val)
    const tmpArry = childrenValues.filter((val) => !!val)
    return _.uniqWith(tmpArry, _.isEqual)
  }

  override get value(): Record<string, any> {
    return this._resolveChildren()
  }

  override set value(obj: Record<string, any>) {
    Object.defineProperty(this, '_children', {
      value: new ValueRefMap(() => this.getSymbolTable()),
      writable: true,
      enumerable: false,
      configurable: true,
    })
    this._cachedChildren = null
    Object.defineProperty(this, 'children', {
      get: () => this._resolveChildren(),
      set: (newObj: Record<string, any>) => {
        this.value = newObj
      },
      enumerable: true,
      configurable: true,
    })
    if (obj && typeof obj === 'object') {
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          this._children.set(key, obj[key])
        }
      }
    }
  }

  override getTrace(tag: any): any {
    return _.find(this.value, (v: any) => {
      if (v?.taint.containsTag(tag)) {
        return v.taint.getTrace(tag)
      }
    })
  }

  getTaintInfo(tag: any): { value: any; trace: any } | undefined {
    const value = _.find(this.value, (v: any) => {
      return v?.taint.containsTag(tag)
    })
    if (value) {
      return {
        value,
        trace: value.taint.getTrace(tag),
      }
    }
  }

  override getMisc(key: string): any[] {
    const values = this.getRawValue()
    return values.map((val: any) => val.getMisc(key))
  }
}
