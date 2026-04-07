/** Proxy → 原始对象。用于序列化/clone 时穿透 Proxy 访问底层数据 */
export const RAW_TARGET: unique symbol = Symbol('rawTarget')

/** 标记 UnionValue 的 field 数组 Proxy */
export const IS_UNION_ARRAY: unique symbol = Symbol('isUnionArray')
