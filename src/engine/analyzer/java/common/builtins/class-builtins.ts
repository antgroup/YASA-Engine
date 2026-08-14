const UastSpec = require('@ant-yasa/uast-spec')
const {
  ValueUtil: { UndefinedValue },
} = require('../../../../util/value-util')
const MemSpace = require('../../../common/memSpace')
const { getValueFromPackageByQid } = require('../../../../util/value-util')
const { buildNewCopiedWithTag } = require('../../../../../util/clone-util')
const { newInstance } = require('./object')

const memSpaceUtil = new MemSpace()

type RuntimeValue = {
  qid?: string
  logicalQid?: string
  _this?: RuntimeValue
  rtype?: { type?: unknown; definiteType?: unknown; vagueType?: unknown }
  cloneAlias?: () => RuntimeValue
  getThisObj?: () => RuntimeValue | undefined
}

function asRuntimeValue(value: unknown): RuntimeValue | undefined {
  return value && typeof value === 'object' ? (value as RuntimeValue) : undefined
}

function getClassLiteralTarget(value: unknown): string | undefined {
  const classValue = asRuntimeValue(value)
  if (!classValue || classValue.logicalQid !== 'java.lang.Class') return undefined
  const thisObj = classValue.getThisObj?.() ?? classValue._this
  if (!thisObj?.logicalQid || thisObj.logicalQid === 'java.lang.Class') return undefined
  return thisObj.logicalQid
}

function copyCastResult(analyzer: unknown, value: unknown): RuntimeValue | undefined {
  const runtimeValue = asRuntimeValue(value)
  if (!runtimeValue) return undefined
  const copied = runtimeValue.qid ? buildNewCopiedWithTag(analyzer, runtimeValue, 'class-cast') : (runtimeValue.cloneAlias?.() ?? runtimeValue)
  const copiedValue = asRuntimeValue(copied)
  if (copiedValue?.rtype) copiedValue.rtype = { ...copiedValue.rtype }
  return copiedValue
}

/**
 * java.lang.Class
 */
class Class {
  /**
   * Class.cast 只做运行期类型校验，返回值仍是原对象。
   */
  static cast(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    if (argvalues.length === 0 || !argvalues[0]) {
      return new UndefinedValue()
    }

    const targetType = getClassLiteralTarget(fclos.getThisObj?.())
    if (!targetType) return argvalues[0]

    const result = copyCastResult(this, argvalues[0])
    if (!result) return new UndefinedValue()
    result.rtype = { type: result.rtype?.type, definiteType: UastSpec.identifier(targetType) }
    return result
  }

  /**
   * getMethod
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static getMethod(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    const _this = fclos.getThisObj()
    if (!_this || _this.parent?.vtype !== 'class') {
      return new UndefinedValue()
    }
    if (argvalues.length === 0 || argvalues[0].vtype !== 'primitive') {
      return new UndefinedValue()
    }
    return memSpaceUtil.getMemberValueNoCreate(_this.parent, UastSpec.identifier(argvalues[0].raw_value), state)
  }

  /**
   * forName
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static forName(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    if (argvalues.length !== 1 || argvalues[0].vtype !== 'primitive' || !argvalues[0].value) {
      return new UndefinedValue()
    }

    let classVal
    const fullType = argvalues[0].raw_value
    if (fullType.includes('.')) {
      classVal = getValueFromPackageByQid((this as any).topScope?.context.packages, fullType)
    } else {
      classVal = (this as any).getMemberValueNoCreate(scope, fullType)
    }
    if (!classVal) {
      return new UndefinedValue()
    }
    return (this as any).getMemberValueNoCreate(classVal, UastSpec.identifier('class'), state, 1)
  }

  /**
   * getConstructor
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   * @returns {*}
   */
  static getConstructor(fclos: any, argvalues: any[], state: any, node: any, scope: any): any {
    return fclos.getThisObj()
  }

  /**
   * newInstance
   * @param fclos
   * @param argvalues
   * @param state
   * @param node
   * @param scope
   */
  static newInstance(fclos: any, argvalues: any[], state: any, node: any, scope: any) {
    const _this = fclos.getThisObj()
    if (!_this || _this.parent?.vtype !== 'class') {
      return new UndefinedValue()
    }
    const obj = newInstance(this, (this as any).topScope?.context.packages, _this.parent.qid)
    if (!obj) {
      return new UndefinedValue()
    }
    return obj
  }
}

module.exports = Class
