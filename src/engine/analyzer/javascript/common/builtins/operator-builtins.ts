const _ = require('lodash')
const {
  valueUtil: {
    ValueUtil: { FunctionValue, ObjectValue, PrimitiveValue, UndefinedValue, UnionValue },
  },
} = require('../../../common')

const BINARY_OPERATOR_PROCESS_MAP: Record<string, any> = {
  '&&': processAndOperator,
  '||': processOrOperator,
  '??': processNullMergeOperator,
}

/**
 *
 * @param resValue
 * @param scope
 * @param node
 * @param state
 */
function processBinaryOperator(resValue: any, scope: any, node: any, state: any) {
  try {
    const op = resValue?.operator
    const processFunction = (BINARY_OPERATOR_PROCESS_MAP as any)[op] ?? processUnknownOperator
    if (!checkLhsAndRhsValid(resValue)) return resValue
    return processFunction(resValue, scope, node, state)
  } catch (error) {
    return resValue
  }
}

/**
 * 校验resValue及其ast是否有效
 * @param resValue
 * @returns {boolean}
 */
function checkLhsAndRhsValid(resValue: any) {
  return !!(resValue?.left && resValue?.right && resValue?.ast?.node?.left && resValue?.ast?.node?.right)
}

/**
 * 处理逻辑与运算符&&
 * res= left&&right left转换成boolean 类型 如果为true则返回right 否则返回left
 * @param resValue
 * @param scope
 * @param node
 * @param state
 */
function processAndOperator(resValue: any, scope: any, node: any, state: any) {
  const leftValue = resValue.left
  const rightValue = resValue.right
  // 此处疑似uast有问题 nan应该和undefined一样是primitive
  // 先打个补丁吧～
  if (leftValue?.vtype === 'symbol' && leftValue?.type === 'Identifier' && leftValue?.name === 'NaN') {
    return leftValue.clone()
  }
  if (leftValue?.vtype === 'primitive') {
    if ((_.has(leftValue, 'raw_value') as any) && leftValue?.raw_value != null) {
      return leftValue.raw_value
        ? rightValue.clone()
        : leftValue.clone()
    }
  }
  if (resValue?.taint.isTaintedRec) {
    for (const t of leftValue.taint.getTags() ?? []) resValue.taint.addTag(t)
    for (const t of rightValue.taint.getTags() ?? []) resValue.taint.addTag(t)
    const traceVal = (leftValue.taint.getFirstTrace()?.length ? leftValue.taint.getFirstTrace() : null) || rightValue.taint.getFirstTrace()
    if (traceVal) {
      resValue.taint.setAllTraces(traceVal)
    } else {
      resValue.taint.clearTrace()
    }
  }
  return resValue
}

// or和and返回值相反
/**
 *
 * @param resValue
 * @param scope
 * @param node
 * @param state
 */
function processOrOperator(resValue: any, scope: any, node: any, state: any) {
  const leftValue = resValue.left
  const rightValue = resValue.right

  if (leftValue?.vtype === 'symbol' && leftValue?.type === 'Identifier' && leftValue?.name === 'NaN') {
    return rightValue.clone()
  }
  if (leftValue?.vtype === 'primitive') {
    if ((_.has(leftValue, 'raw_value') as any) && leftValue?.raw_value != null) {
      return leftValue.raw_value
        ? leftValue.clone()
        : rightValue.clone()
    }
  }
  if (resValue?.taint.isTaintedRec) {
    for (const t of leftValue.taint.getTags() ?? []) resValue.taint.addTag(t)
    for (const t of rightValue.taint.getTags() ?? []) resValue.taint.addTag(t)
    const traceVal = (leftValue.taint.getFirstTrace()?.length ? leftValue.taint.getFirstTrace() : null) || rightValue.taint.getFirstTrace()
    if (traceVal) {
      resValue.taint.setAllTraces(traceVal)
    } else {
      resValue.taint.clearTrace()
    }
  }
  return resValue
}

/**
 * 处理合并空值运算符??
 * res = left??right left为空返回right 否则返回left  重点关注null和undefined
 * @param resValue
 * @param scope
 * @param node
 * @param state
 */
function processNullMergeOperator(resValue: any, scope: any, node: any, state: any) {
  const leftValue = resValue.left
  const rightValue = resValue.right
  // 重点只关注左值是否为空
  // 对于leftValue的raw_value不存在或存在其值为null则返回右值 其余情况返回左值
  if (leftValue.vtype === 'primitive') {
    // 不能写成!leftValue?.raw_value 因为除了空值转换为boolean以后为false
    // 还有当leftValue为false 0 NaN ‘’时leftValue转换为boolean也为false但此时leftValue本身不为空
    // 空值合并关注是否为空，而不是转换以后是否为false，因此要排除这些耦合情况
    if (leftValue.raw_value === null || leftValue.raw_value === undefined) {
      return rightValue.clone()
    }
  }
  if (resValue?.taint.isTaintedRec) {
    for (const t of leftValue.taint.getTags() ?? []) resValue.taint.addTag(t)
    for (const t of rightValue.taint.getTags() ?? []) resValue.taint.addTag(t)
    const traceVal = (leftValue.taint.getFirstTrace()?.length ? leftValue.taint.getFirstTrace() : null) || rightValue.taint.getFirstTrace()
    if (traceVal) {
      resValue.taint.setAllTraces(traceVal)
    } else {
      resValue.taint.clearTrace()
    }
  }
  return resValue
}

/**
 * 未处理操作符 后续补充
 * @param resValue
 * @param scope
 * @param node
 * @param state
 * @returns {*}
 */
function processUnknownOperator(resValue: any, scope: any, node: any, state: any) {
  return resValue
}

export = {
  processBinaryOperator,
}
