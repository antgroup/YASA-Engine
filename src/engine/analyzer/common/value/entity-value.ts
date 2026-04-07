import { ValueBase, SpringCtx, RuntimeState } from './value-base'
import { ValueRefMap } from './value-ref-map'
import { RAW_TARGET } from './symbols'

export abstract class EntityValue extends ValueBase {
  declare name?: string
  declare type?: string
  declare rtype?: any
  declare spring?: SpringCtx
  declare runtime?: RuntimeState

  // 内部属性声明（通过 Object.defineProperty 定义）
  protected _members!: ValueRefMap

  constructor(vtype: string, opts?: any)
  constructor(vtype: string, upperQid: string, opts: any)
  constructor(vtype: string, upperQidOrOpts?: string | any, opts?: any) {
    if (typeof upperQidOrOpts === 'string') {
      super(vtype, upperQidOrOpts, opts)
    } else {
      super(vtype, upperQidOrOpts)
    }
    const finalOpts: any = typeof upperQidOrOpts === 'string' ? (opts || {}) : (upperQidOrOpts || {})

    const members = new ValueRefMap(() => this.getSymbolTable())

    // 从 Unit 构造函数设置的 _field 迁移数据到 _members
    const unitField = this._field
    if (unitField && typeof unitField === 'object') {
      const raw = (unitField as any)[RAW_TARGET] || unitField
      if (raw && typeof raw === 'object') {
        for (const key of Object.keys(raw)) {
          const val = raw[key]
          if (val != null) members.set(key, val)
        }
      }
    }

    Object.defineProperty(this, '_members', {
      value: members,
      writable: true,
      enumerable: false,
      configurable: true,
    })

    // 保持 _field 与 _members Proxy 同步（source-line taint 传播等通过 _field 遍历成员）
    this._field = members.getProxy()

    if ('runtime' in finalOpts) this.runtime = finalOpts.runtime
    if ('field' in finalOpts) {
      const val = finalOpts.field
      if (val && typeof val === 'object') {
        const raw = val[RAW_TARGET] || val
        for (const key of Object.keys(raw)) {
          if (raw[key] != null) members.set(key, raw[key])
        }
      }
    }
    if ('fdata' in finalOpts) this.fdata = finalOpts.fdata
    if ('id' in finalOpts) this.id = finalOpts.id
  }

  get members(): ValueRefMap {
    return this._members
  }

  override get value(): any {
    if (Object.prototype.hasOwnProperty.call(this, 'raw_value')) {
      return this.raw_value
    }
    if (!this._members) {
      // 构造阶段或异常路径，回退到基类 _field
      return this._field
    }
    return this._members.getProxy()
  }

  override set value(val: any) {
    const members = this._members
    if (!members) {
      // 构造阶段 _members 尚未初始化
      this.raw_value = val
      return
    }
    if (val === members.getProxy()) return
    const newOwner = val && typeof val === 'object' && val._owner
    if (newOwner && newOwner instanceof ValueRefMap) {
      this._members = newOwner
      this._field = newOwner.getProxy()
      return
    }
    if (val && typeof val === 'object') {
      members.clear()
      const raw = val[RAW_TARGET] || val
      if (typeof raw === 'object') {
        for (const key of Object.keys(raw)) {
          if (raw[key] != null) members.set(key, raw[key])
        }
      }
    } else {
      this.raw_value = val
    }
  }

  protected override _cloneField(copy: any, _fieldValue: any): void {
    const originalMembers = this._members
    if (originalMembers) {
      const clonedMembers = originalMembers._clone(() => copy.getSymbolTable())
      Object.defineProperty(copy, '_members', {
        value: clonedMembers,
        writable: true,
        enumerable: false,
        configurable: true,
      })
      // _field 保持与 _members Proxy 同步
      copy._field = clonedMembers.getProxy()
    } else {
      super._cloneField(copy, _fieldValue)
    }
  }
}
