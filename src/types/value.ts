/**
 * Value 类型系统 - 导出层
 * 
 * 职责：重新导出 value/ 文件夹中的实现类
 * 实现：engine/analyzer/common/value/*.ts
 * 
 * 注意：export class 既导出值（构造函数）也导出类型
 */

// ===== 引用类型 =====
export { ValueRef } from '../engine/analyzer/common/value/value-ref'
export { ValueRefMap } from '../engine/analyzer/common/value/value-ref-map'
export { ValueRefList } from '../engine/analyzer/common/value/value-ref-list'
export type { ValueStore, ValueRegistry } from '../engine/analyzer/common/value/value-ref-map'
export { AstRef } from '../engine/analyzer/common/value/ast-ref'

// ===== 基类 =====
export { SentinelValue } from '../engine/analyzer/common/value/sentinel-value'
export { DataValue } from '../engine/analyzer/common/value/data-value'
export { EntityValue } from '../engine/analyzer/common/value/entity-value'

// ===== 表达式类型（ExprValue 子类）=====
export { ExprValue } from '../engine/analyzer/common/value/expr-value'
export { BinaryExprValue } from '../engine/analyzer/common/value/binary-expr'
export { UnaryExprValue } from '../engine/analyzer/common/value/unary-expr'
export { MemberExprValue } from '../engine/analyzer/common/value/member-expr'
export { CallExprValue } from '../engine/analyzer/common/value/call-expr'
export { IdentifierRefValue } from '../engine/analyzer/common/value/identifier-ref'

// ===== 导出所有 Value 类（既是值也是类型）=====
export { PrimitiveValue } from '../engine/analyzer/common/value/primitive'
export { ObjectValue } from '../engine/analyzer/common/value/object'
export { Scoped as ScopedValue } from '../engine/analyzer/common/value/scoped'
export { FunctionValue } from '../engine/analyzer/common/value/function'
export { UndefinedValue } from '../engine/analyzer/common/value/undefine'
export { UninitializedValue } from '../engine/analyzer/common/value/uninit'
export { UnknownValue } from '../engine/analyzer/common/value/unkown'
export { UnionValue } from '../engine/analyzer/common/value/union'
export { SymbolValue } from '../engine/analyzer/common/value/symbolic'
export { BVTValue } from '../engine/analyzer/common/value/bvt'
export { PackageValue } from '../engine/analyzer/common/value/package'
export { VoidValue } from '../engine/analyzer/common/value/void'
export { TypedValue } from '../engine/analyzer/common/value/typed'
export { TaintedValue } from '../engine/analyzer/common/value/tainted'
export { SpreadValue } from '../engine/analyzer/common/value/spread'
export { ClassValue } from '../engine/analyzer/common/value/class'

// ===== 导入类（用于 instanceof 和类型定义）=====
// ExprValue 子类：需要运行时值（instanceof），用 import 而非 import type
import { ExprValue } from '../engine/analyzer/common/value/expr-value'
import { BinaryExprValue } from '../engine/analyzer/common/value/binary-expr'
import { UnaryExprValue } from '../engine/analyzer/common/value/unary-expr'
import { MemberExprValue } from '../engine/analyzer/common/value/member-expr'
import { CallExprValue } from '../engine/analyzer/common/value/call-expr'
import { IdentifierRefValue } from '../engine/analyzer/common/value/identifier-ref'

// 其他 Value 类：仅用于类型定义，用 import type
import type { PrimitiveValue } from '../engine/analyzer/common/value/primitive'
import type { ObjectValue } from '../engine/analyzer/common/value/object'
import type { Scoped } from '../engine/analyzer/common/value/scoped'
import type { FunctionValue } from '../engine/analyzer/common/value/function'
import type { UndefinedValue } from '../engine/analyzer/common/value/undefine'
import type { UninitializedValue } from '../engine/analyzer/common/value/uninit'
import type { UnknownValue } from '../engine/analyzer/common/value/unkown'
import type { UnionValue } from '../engine/analyzer/common/value/union'
import type { SymbolValue } from '../engine/analyzer/common/value/symbolic'
import type { BVTValue } from '../engine/analyzer/common/value/bvt'
import type { PackageValue } from '../engine/analyzer/common/value/package'
import type { VoidValue } from '../engine/analyzer/common/value/void'
import type { TypedValue } from '../engine/analyzer/common/value/typed'
import type { TaintedValue } from '../engine/analyzer/common/value/tainted'
import type { SpreadValue } from '../engine/analyzer/common/value/spread'
import type { ClassValue } from '../engine/analyzer/common/value/class'

// ===== 基类和联合类型 =====
export type ValueBase = any // Unit 基类

// 前向声明（用于伪 Value 类型的循环引用）
export type Value = 
  | PrimitiveValue
  | ObjectValue
  | Scoped
  | FunctionValue
  | UndefinedValue
  | UninitializedValue
  | UnknownValue
  | UnionValue
  | SymbolValue
  | BVTValue
  | PackageValue
  | VoidValue
  | TypedValue
  | TaintedValue
  | SpreadValue
  | ClassValue
  | ExprValue
  | BinaryExprValue
  | UnaryExprValue
  | MemberExprValue
  | CallExprValue
  | IdentifierRefValue

// ===== 类型守卫 =====
export function isPrimitive(v: any): v is PrimitiveValue {
  return v?.vtype === 'primitive'
}

export function isObject(v: any): v is ObjectValue {
  return v?.vtype === 'object'
}

export function isScoped(v: any): v is Scoped {
  return v?.vtype === 'scope'
}

export function isFunction(v: any): v is FunctionValue {
  return v?.vtype === 'fclos'
}

export function isUndefined(v: any): v is UndefinedValue {
  return v?.vtype === 'undefine'
}

export function isUninitialized(v: any): v is UninitializedValue {
  return v?.vtype === 'uninitialized'
}

export function isUnknown(v: any): v is UnknownValue {
  return v?.vtype === 'unknown'
}

export function isUnion(v: any): v is UnionValue {
  return v?.vtype === 'union'
}

export function isSymbol(v: any): v is SymbolValue {
  return v?.vtype === 'symbol'
}

export function isBVT(v: any): v is BVTValue {
  return v?.vtype === 'BVT'
}

export function isPackage(v: any): v is PackageValue {
  return v?.vtype === 'package'
}

// ===== 兼容性导出（旧接口名称）=====

export function isClass(v: any): v is ClassValue {
  return v?.vtype === 'class'
}

export function isVoid(v: any): v is VoidValue {
  return v?.vtype === 'void'
}

export function isTyped(v: any): boolean {
  return v?.vtype === 'typed'
}

export function isTainted(v: any): boolean {
  return v?.vtype === 'tainted'
}

export function isSpread(v: any): boolean {
  return v?.vtype === 'spread'
}

// ===== ExprValue 类型守卫 =====

/**
 * 判断是否为 ExprValue 子类（BinaryExprValue, UnaryExprValue, MemberExprValue, CallExprValue, IdentifierRefValue）
 * 注意：旧的 SymbolValue 不是 ExprValue 子类
 */
export function isExpr(v: any): v is ExprValue {
  return v instanceof ExprValue
}

export function isBinaryExpr(v: any): v is BinaryExprValue {
  return v instanceof BinaryExprValue
}

export function isUnaryExpr(v: any): v is UnaryExprValue {
  return v instanceof UnaryExprValue
}

export function isMemberExpr(v: any): v is MemberExprValue {
  return v instanceof MemberExprValue
}

export function isCallExpr(v: any): v is CallExprValue {
  return v instanceof CallExprValue
}

export function isIdentifierRef(v: any): v is IdentifierRefValue {
  return v instanceof IdentifierRefValue
}
