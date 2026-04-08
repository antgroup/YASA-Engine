import Unit = require('./unit')
import { TaintRecord } from './taint-record'

/**
 * AstBinding - AST 绑定属性组（EntityValue 特有）
 *
 * 将 node/fdef/cdef/decls/id 聚合为一个属性组
 * 底层通过 AstRef 存储 nodehash，getter 自动通过 ASTManager resolve
 */
export interface AstBinding {
  node: any        // AST 节点（对应原 ast 属性）
  fdef: any        // 函数定义 AST 节点
  cdef: any        // 类定义 AST 节点
  decls: any       // 声明映射（Proxy，name → AST node）
  id: any          // 标识符 AST 节点
}

/**
 * SpringCtx - Spring 框架上下文（仅 Spring 项目使用）
 */
export interface SpringCtx {
  beanMap: Map<string, any>
  springReferenceMap: Map<string, any>
  springServiceMap: Map<string, any>
}

/**
 * FuncMeta - 函数元信息（FunctionValue 特有）
 *
 * 注意：attribute/filePath 属于 EntryPoint，不在此处
 */
export interface FuncMeta {
  inherited?: boolean  // 是否继承自父类
  superDef?: any  // 父类方法定义（AST node）
  jumpLocate?: ((val: any, qid: any, scope: any) => any) | null  // 跳转位置回调
}

/**
 * RuntimeState - 运行时状态属性组
 *
 * 聚合 execute/readonly/refCount/ctorInit/transDep
 * opts 中直接传入 runtime: { execute: fn } 形式
 */
export interface RuntimeState {
  refCount?: number           // 引用计数（指针语义，Go）
  readonly?: boolean          // 是否只读
  execute?: Function | null   // 内建执行函数（替代 AST 解释执行）
  ctorInit?: boolean          // 构造函数初始化标记
  transDep?: any              // 传递依赖
}

/**
 * ValueBase - 所有 Value 类的基类
 * 
 * 职责：
 * - 处理构造函数重载（支持 opts 或 upperQid+opts 两种调用方式）
 * - 统一处理 sid/qid 生成和拼接
 * - 简化子类实现（子类只需传递 vtype）
 * - 提供 clone() 基础实现（子类 override 处理特有成员）
 */
export class ValueBase extends Unit {
  declare _taint: TaintRecord | null
  /**
   * Constructor with options only
   * @param vtype - Value type
   * @param opts - Options
   */
  constructor(vtype: string, opts?: any)
  /**
   * Constructor with upperQid and options
   * @param vtype - Value type
   * @param upperQid - Parent qualified ID
   * @param opts - Options
   */
  constructor(vtype: string, upperQid: string, opts: any)
  constructor(vtype: string, upperQidOrOpts?: string | any, opts?: any) {
    let upperQid: string = ''
    let finalOpts: any

    // 处理构造函数重载
    if (typeof upperQidOrOpts === 'string') {
      // Called as: new XxxValue(upperQid, opts)
      upperQid = upperQidOrOpts
      finalOpts = opts || {}
    } else {
      // Called as: new XxxValue(opts)
      upperQid = ''
      finalOpts = upperQidOrOpts || {}
    }

    // 统一处理 sid/qid 生成和拼接
    const preparedOpts = ValueBase.prepareOpts(upperQid, finalOpts)

    // 调用 Unit 构造函数
    super({
      vtype,
      ...preparedOpts,
    })
  }

  /**
   * Prepare options for Value constructor
   * Handles sid/qid generation and concatenation
   * 
   * @param upperQid - Parent qualified ID
   * @param opts - Options to prepare
   * @returns Prepared options with sid/qid
   */
  protected static prepareOpts(upperQid: string, opts: Record<string, any>): any {
    // Generate sid if not provided
    if (opts.sid === undefined && opts._sid === undefined) {
      if (opts.name !== undefined && typeof opts.name === 'string') {
        opts.sid = opts.name
      } else if (opts.value !== undefined && typeof opts.value === 'string') {
        opts.sid = opts.value
      }
    }

    // Generate qid from sid if not provided
    if (opts.qid === undefined && opts.sid !== undefined) {
      opts.qid = opts.sid
    }

    // Concatenate with parent qid if needed
    if (upperQid && upperQid !== '' && opts.qid && !opts.qid.startsWith(upperQid)) {
      opts.qid = `${upperQid}.${opts.qid}`
    }

    return opts || {}
  }

  /**
   * Clone this value: same prototype, own properties copied, property groups deep-copied.
   * Subclasses override for type-specific members (e.g. UnionValue resets WeakSet).
   */
  override clone(): this {
    const copy: any = Object.create(Object.getPrototypeOf(this))

    // Copy enumerable own data properties only (matches old for...in + hasOwnProperty)
    const keys = Object.keys(this as any)
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      const desc = Object.getOwnPropertyDescriptor(this, key)
      if (!desc || !('value' in desc)) continue

      if (key === '_field') {
        this._cloneField(copy, desc.value)
      } else {
        copy[key] = desc.value
      }
    }

    const exprRefKeys = ['_objectRef', '_propertyRef', '_leftRef', '_rightRef', '_calleeRef', '_argumentRefs', '_expressionRef', '_argumentRef']
    for (let i = 0; i < exprRefKeys.length; i++) {
      const key = exprRefKeys[i]
      if (!Object.prototype.hasOwnProperty.call(this, key)) continue
      const sourceDesc = Object.getOwnPropertyDescriptor(this, key)
      if (!sourceDesc || !('value' in sourceDesc)) continue
      Object.defineProperty(copy, key, {
        value: sourceDesc.value,
        writable: sourceDesc.writable ?? true,
        enumerable: false,
        configurable: sourceDesc.configurable ?? true,
      })
    }

    // Rebuild own enumerable accessors for getter-based operands so that
    // satisfy() (for...in + hasOwnProperty) can traverse them on the clone.
    const exprPropPairs: [string, string][] = [
      ['_leftRef', 'left'],
      ['_rightRef', 'right'],
      ['_objectRef', 'object'],
      ['_propertyRef', 'property'],
      ['_calleeRef', 'callee'],
      ['_argumentRef', 'argument'],
    ]
    for (let i = 0; i < exprPropPairs.length; i++) {
      const [refKey, propKey] = exprPropPairs[i]
      if (!Object.prototype.hasOwnProperty.call(this, refKey)) continue
      const propVal = (this as any)[propKey]
      if (propVal !== undefined) {
        Object.defineProperty(copy, propKey, {
          value: propVal,
          writable: true,
          enumerable: true,
          configurable: true,
        })
      }
    }
    // Rebuild arguments accessor for CallExprValue clones
    if (Object.prototype.hasOwnProperty.call(this, '_argumentRefs')) {
      Object.defineProperty(copy, 'arguments', {
        get(this: any) {
          if (!this._argumentRefs) return []
          return this._argumentRefs.map((ref: any) => ref?.resolve(this.getSymbolTable()) ?? undefined)
        },
        set(this: any, val: any) {
          this._argumentRefs = Array.isArray(val)
            ? val.map((v: any) => v != null ? this._makeValueRefDirect(v) : null)
            : []
        },
        enumerable: true,
        configurable: true,
      })
    }
    // Rebuild expression accessor for CallExprValue clones
    if (Object.prototype.hasOwnProperty.call(this, '_expressionRef')) {
      Object.defineProperty(copy, 'expression', {
        get(this: any) { return this._expressionRef?.resolve(this.getSymbolTable()) ?? undefined },
        set(this: any, val: any) { this._expressionRef = val != null ? this._makeValueRefDirect(val) : null },
        enumerable: true,
        configurable: true,
      })
    }

    // Deep-copy taint via TaintRecord._clone（跳过未初始化的）
    if (copy._taint) {
      copy._taint = copy._taint._clone(copy)
    }
    // Deep-copy runtime
    if (copy.runtime && typeof copy.runtime === 'object') {
      copy.runtime = { ...copy.runtime }
    }
    // func: reference copy only (matches old shallowCopyValue behavior)

    // Clone RefGroups and rebind to new owner
    if (copy._ast && typeof copy._ast._clone === 'function') {
      copy._ast = copy._ast._clone(copy)
    }
    if (copy._scopeCtx && typeof copy._scopeCtx._clone === 'function') {
      copy._scopeCtx = copy._scopeCtx._clone(copy)
    }

    copy._skipRegister = true
    return copy as this
  }

  /**
   * Clone _field storage. Iterates _field Proxy entries, preserving UUID strings
   * and shallow-copying non-UUID values to match legacy shallowCopyValue semantics.
   * Subclasses override for different field types (e.g. UnionValue array).
   */
  protected _cloneField(copy: any, fieldValue: any): void {
    if (!fieldValue || typeof fieldValue !== 'object') {
      copy._field = fieldValue
      return
    }

    const fieldCopy: Record<string, any> = {}
    for (const key in fieldValue) {
      if (!Object.prototype.hasOwnProperty.call(fieldValue, key)) continue
      const desc = Object.getOwnPropertyDescriptor(fieldValue, key)
      if (desc && 'value' in desc && typeof desc.value === 'string' && desc.value.startsWith('symuuid')) {
        fieldCopy[key] = desc.value
      } else {
        fieldCopy[key] = fieldValue[key]
      }
    }
    copy._field = fieldCopy
  }
}
