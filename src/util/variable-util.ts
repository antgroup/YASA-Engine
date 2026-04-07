import { handleException } from '../engine/analyzer/common/exception-handler'

/**
 *
 * variable
 * @param variable
 */
function isEmpty(variable: unknown): boolean {
  return typeof variable === 'undefined'
}

/**
 *
 * variable
 * @param variable
 */
function isNotEmpty(variable: unknown): boolean {
  return typeof variable !== 'undefined'
}

/**
 *
 * @param value
 */
function primitiveToString(value: any): string {
  // 判断是否是数组
  if (Array.isArray(value)) {
    // 对每个元素调用 primitiveToString，然后用 _ 连接
    return value.map((item) => primitiveToString(item)).join('_')
  }

  // 判断是否是基本类型（primitive）
  if (value === null) {
    return 'null'
  }

  const type = typeof value

  switch (type) {
    case 'string':
      return value // 已经是字符串
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'symbol':
      return `<number_${String(value)}>` // 转换为字符串
    case 'undefined':
      return 'undefined'
    default:
      handleException(null, '', 'Error:primitiveToString, but not a primitive type')
      // 对象类型，可以选择抛出错误或特殊处理
      return '<NotLiteral>'
  }
}
export { isEmpty, isNotEmpty, primitiveToString }
