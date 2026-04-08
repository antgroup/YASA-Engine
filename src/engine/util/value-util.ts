const Loader = require('../../util/loader')

/**
 * get value from package manager by qid
 * @param scope
 * @param qid
 */
function getValueFromPackageByQid(scope: any, qid: string): any {
  if (!qid || !qid.includes('.')) {
    return null
  }
  if (qid.includes('<global>')) {
    const QidUnifyUtil = require('../../util/qid-unify-util')
    qid = new QidUnifyUtil(qid).removeGlobal().get()
  }
  qid = qid.startsWith('.') ? qid.slice(1) : qid
  const arr = Loader.getPackageNameProperties(qid)
  let packageManagerT = scope
  arr.forEach((path: string) => {
    packageManagerT = packageManagerT?.members ? packageManagerT.members.get(path) : packageManagerT?.getMemberValue?.(path)
  })

  return packageManagerT
}

// ***
// 导入 Value 类（直接路由到构造函数）

const { UnknownValue } = require('../analyzer/common/value/unkown')
const { UndefinedValue: UndefinedValueClass } = require('../analyzer/common/value/undefine')
const { VoidValue: VoidValueClass } = require('../analyzer/common/value/void')
const { UninitializedValue } = require('../analyzer/common/value/uninit')
const { ObjectValue } = require('../analyzer/common/value/object')
const { Scoped } = require('../analyzer/common/value/scoped')
const { ClassValue } = require('../analyzer/common/value/class')
const { FunctionValue } = require('../analyzer/common/value/function')
const { PrimitiveValue } = require('../analyzer/common/value/primitive')
const { UnionValue: UnionValueClass } = require('../analyzer/common/value/union')
const { SymbolValue } = require('../analyzer/common/value/symbolic')
const { PackageValue } = require('../analyzer/common/value/package')
const { BVTValue } = require('../analyzer/common/value/bvt')
const { TypedValue } = require('../analyzer/common/value/typed')
const { TaintedValue } = require('../analyzer/common/value/tainted')
const { SpreadValue } = require('../analyzer/common/value/spread')
const { ExprValue } = require('../analyzer/common/value/expr-value')
const { BinaryExprValue } = require('../analyzer/common/value/binary-expr')
const { UnaryExprValue } = require('../analyzer/common/value/unary-expr')
const { MemberExprValue } = require('../analyzer/common/value/member-expr')
const { CallExprValue } = require('../analyzer/common/value/call-expr')
const { IdentifierRefValue } = require('../analyzer/common/value/identifier-ref')
const { ValueRefMap } = require('../analyzer/common/value/value-ref-map')
const { ValueRefList } = require('../analyzer/common/value/value-ref-list')

// 特殊包装函数（只保留无参数或特殊参数的）
function UndefinedValue(opts?: any) {
  return new UndefinedValueClass(opts)
}

function VoidValue() {
  return new VoidValueClass()
}

function UnionValue(value?: any[], sid?: string, qid?: string) {
  return new UnionValueClass(value, sid, qid)
}

module.exports = {
  getValueFromPackageByQid,

  Unit: require('../analyzer/common/value/unit'),
  ValueRefMap,
  
  ValueUtil: {
    // 直接路由到类构造函数
    UnknownValue,
    UninitializedValue,
    ObjectValue,
    Scoped,
    ClassValue,
    FunctionValue,
    PrimitiveValue,
    SymbolValue,
    PackageValue,
    BVTValue,
    TypedValue,
    TaintedValue,
    SpreadValue,
    ExprValue,
    BinaryExprValue,
    UnaryExprValue,
    MemberExprValue,
    CallExprValue,
    IdentifierRefValue,
    ValueRefMap,
    ValueRefList,

    // 特殊包装函数（无参数或可选参数）
    UndefinedValue,
    VoidValue,
    UnionValue,
  },
}
