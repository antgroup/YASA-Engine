import { Invocation } from '../../../resolver/common/value/invocation'
import TypeRelatedInfoResolver from '../../../resolver/common/type-related-info-resolver'
import type { ClassHierarchy } from '../../../resolver/common/value/class-hierarchy'
import { getExplicitArgCount, type CallInfo } from '../../../engine/analyzer/common/call-args'

const _ = require('lodash')
const { matchField: matchFieldSinkUtil } = require('../../common/rules-basic-handler')
const AstUtilSinkUtil = require('../../../util/ast-util')
const { handleException: handleExceptionSinkUtil } = require('../../../engine/analyzer/common/exception-handler')

// 全局统计：实际匹配的 sink 数量
let matchedSinkCount = 0

function getMatchedSinkCount(): number {
  return matchedSinkCount
}

function resetMatchedSinkCount(): void {
  matchedSinkCount = 0
}

function addMatchedSinkCount(delta: number): void {
  if (delta > 0) matchedSinkCount += delta
}

interface SinkRule {
  argNum?: number
  fsig?: string
  fregex?: string
  calleeType?: string
  /** sink 关联的前置条件 id 列表，采用 OR 语义：taint 上命中任一 id 对应的 tag 即生成 finding */
  preconditionIds?: string[]
  [key: string]: unknown
}

/**
 * Go interface→concrete 穿透 helper 所需的最小能力集。
 *
 * 两种真实入参形态：
 *   - Go 路径的 analyzer：自身挂 classHierarchyMap（独立对象，见 gin-taint-checker:131 triggerAtStartOfAnalyze 写入），
 *     findSubTypes 挂在 analyzer.typeResolver 上
 *   - 单测/其它入口：直接传入兼具 classHierarchyMap 与 findSubTypes 的 typeResolver
 * 故两个成员均 optional，helper 内按优先级取值并做非空判断。
 */
interface SinkPassthroughCarrier {
  classHierarchyMap?: Map<string, ClassHierarchy>
  findSubTypes?(hierarchy: ClassHierarchy): string[]
  typeResolver?: {
    classHierarchyMap?: Map<string, ClassHierarchy>
    findSubTypes?(hierarchy: ClassHierarchy): string[]
  }
}

/** Go interface→concrete 穿透最多考察的 implementer 数量上限，防止 error/io.Reader 这类广接口 FP 爆炸 */
const GO_INTERFACE_PASSTHROUGH_MAX_IMPLEMENTERS = 8

/**
 * Go sink 匹配：interface → concrete 实现穿透。
 *
 * 场景：rule.calleeType 声明为 concrete 类型（如 *sql.DB），但实际 receiver 是接口（如 sqlQuerier）。
 * 当前字符串比对 4 条分支在 declType==='sqlQuerier' 时全部失配，sink 漏检。
 *
 * 保守约束（双重）：
 *   1) declType 必须在 classHierarchyMap 中登记为 interface（typeDeclaration === 'interface'）
 *   2) 该接口的 implementers（subTypes）数量不超过 GO_INTERFACE_PASSTHROUGH_MAX_IMPLEMENTERS，
 *      避免 error/io.Reader 这类广接口拖进 FP
 *   3) 其中必须有 implementer 的类型名与 rule.calleeType 精确或 endsWith 匹配
 *
 * 注意：本函数只在 Go 路径（由调用方传入 analyzer + declType 才会触发）启用，
 * Java 共用的 checkInvocationMatchSink 不受影响。
 *
 * Go 分析流程把层级信息写入 analyzer.classHierarchyMap，而子类型查询由
 * analyzer.typeResolver.findSubTypes 提供，因此 helper 同时读取这两个对象。
 */
function tryMatchSinkGoInterfacePassthrough(
  declType: string,
  rule: SinkRule,
  analyzerOrLike: SinkPassthroughCarrier
): boolean {
  if (!declType || !rule.calleeType || !analyzerOrLike) return false
  if (rule.calleeType === '' || rule.calleeType === '*') return false

  // 兼容两种入参形态：
  //   - analyzer：classHierarchyMap 在 analyzer 上、findSubTypes 在 analyzer.typeResolver 上（Go 真实路径）
  //   - 单测/其它入口：直接传入既具备 classHierarchyMap 又具备 findSubTypes 的对象
  const classHierarchyMap: Map<string, ClassHierarchy> | undefined =
    analyzerOrLike.classHierarchyMap || analyzerOrLike.typeResolver?.classHierarchyMap
  if (!classHierarchyMap) return false
  const ownFind = analyzerOrLike.findSubTypes
  const resolverFind = analyzerOrLike.typeResolver?.findSubTypes
  const findSubTypes: ((h: ClassHierarchy) => string[]) | undefined =
    typeof ownFind === 'function'
      ? ownFind.bind(analyzerOrLike)
      : typeof resolverFind === 'function'
        ? resolverFind.bind(analyzerOrLike.typeResolver)
        : undefined
  if (!findSubTypes) return false

  // declType 可能形如 "dataprovider.sqlQuerier" 或 "sqlQuerier"；查表允许精确 + 尾匹配
  const classHierarchy = resolveInterfaceHierarchyByTypeName(declType, classHierarchyMap)
  if (!classHierarchy) return false
  if (classHierarchy.typeDeclaration !== 'interface') return false

  const implementers = findSubTypes(classHierarchy)
  if (!implementers.length) return false
  if (implementers.length > GO_INTERFACE_PASSTHROUGH_MAX_IMPLEMENTERS) return false

  // 约束 3：必须有 implementer 与 rule.calleeType 精确或 endsWith 匹配
  const calleeTypeBase = rule.calleeType.startsWith('*') ? rule.calleeType.slice(1) : rule.calleeType
  for (const impl of implementers) {
    if (!impl) continue
    if (impl === rule.calleeType || impl.endsWith(`.${rule.calleeType}`)) return true
    if (calleeTypeBase && (impl === calleeTypeBase || impl.endsWith(`.${calleeTypeBase}`))) return true
  }
  return false
}

/**
 * 根据类型名（可能带包前缀或纯短名）在 classHierarchyMap 中定位对应 ClassHierarchy。
 * 先尝试精确匹配，再尝试 key endsWith `.${declType}`。
 */
function resolveInterfaceHierarchyByTypeName(
  declType: string,
  classHierarchyMap: Map<string, ClassHierarchy>
): ClassHierarchy | undefined {
  const direct = classHierarchyMap.get(declType)
  if (direct) return direct
  const suffix = `.${declType}`
  for (const [qid, hierarchy] of classHierarchyMap) {
    if (qid === declType || qid.endsWith(suffix)) return hierarchy
  }
  return undefined
}

/**
 *
 * @param node
 * @param fclos
 * @param sinks
 * @param callInfo
 * @returns {Array}
 */
function matchSinkAtFuncCall(node: any, fclos: any, sinks: SinkRule[], callInfo: CallInfo): SinkRule[] {
  const argCount = getExplicitArgCount(callInfo)
  const callExpr = node.callee || node
  const res: SinkRule[] = []
  if (sinks && sinks.length > 0) {
    for (const tspec of sinks) {
      if (tspec.argNum !== undefined && tspec.argNum >= 0 && tspec.argNum !== argCount) {
        continue
      }

      if (tspec.fsig) {
        const marray = tspec.fsig.split('.')
        if (matchFieldSinkUtil(callExpr, marray, marray.length - 1)) {
          res.push(tspec)
          matchedSinkCount++ // 统计实际匹配的 sink
        }
      } else if (tspec.fregex) {
        if (callExpr.type === 'MemberAccess' && matchRegex(tspec.fregex, fclos.qid)) {
          res.push(tspec)
          matchedSinkCount++ // 统计实际匹配的 sink
        }
      }
    }
  }
  return res
}

/**
 *
 * @param node
 * @param fclos
 * @param rules
 * @param scope
 * @param callInfo
 * @param analyzer Go 路径专用：用于 interface → concrete 实现穿透的 CHA 查询；从 analyzer.classHierarchyMap
 *                + analyzer.typeResolver.findSubTypes 取数。Java/PHP 路径不传即不启用穿透分支。
 */
function matchSinkAtFuncCallWithCalleeType(
  node: any,
  fclos: any,
  rules: SinkRule[],
  scope: any,
  callInfo: CallInfo,
  analyzer?: SinkPassthroughCarrier
): SinkRule[] {
  const argCount = getExplicitArgCount(callInfo)
  const callExpr = node.callee || node
  const res: SinkRule[] = []
  if (rules && rules.length > 0) {
    if (fclos.vtype === 'union' && !_.isEmpty(fclos.value)) {
      fclos.value.forEach((subFClos: any) => {
        res.push(...matchSinkAtFuncCallWithCalleeType(node, subFClos, rules, scope, callInfo, analyzer))
      })
      return res
    }
    for (const tspec of rules) {
      if (tspec.argNum !== undefined && tspec.argNum >= 0 && tspec.argNum !== argCount) {
        continue
      }

      // Go 指针类型 sink 规则的 calleeType 带 * 前缀（如 *Collection），引擎解析的类型不带，需 normalize
      const calleeTypeBase = tspec.calleeType?.startsWith('*') ? tspec.calleeType.slice(1) : ''

      if (tspec.fsig) {
        if (matchEmptyCalleeTypeInstanceMethod(callExpr, fclos, tspec)) {
          res.push(tspec)
          matchedSinkCount++
        } else if ((!tspec.calleeType || tspec.calleeType === '') && tspec.fsig === AstUtilSinkUtil.prettyPrint(callExpr)) {
          res.push(tspec)
          matchedSinkCount++ // 统计实际匹配的 sink（与 matchSinkAtFuncCall 对齐）
        } else if (
          callExpr.type === 'MemberAccess' &&
          (AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType) === tspec.calleeType ||
            AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType).endsWith(`.${tspec.calleeType}`) ||
            (calleeTypeBase && (AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType) === calleeTypeBase ||
              AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType).endsWith(`.${calleeTypeBase}`))) ||
            tspec.calleeType === '*') &&
          (tspec.fsig === '*' || `${AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.vagueType).replace(/"/g, '')}.${AstUtilSinkUtil.prettyPrint(
            fclos.property
          )}` === tspec.fsig)
        ) {
          res.push(tspec)
          matchedSinkCount++
        } else if (
          (callExpr.type === 'MemberAccess' || callExpr.type === 'Identifier') &&
          (AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType) === tspec.calleeType ||
            AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType).endsWith(`.${tspec.calleeType}`) ||
            (calleeTypeBase && (AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType) === calleeTypeBase ||
              AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType).endsWith(`.${calleeTypeBase}`))) ||
            tspec.calleeType === '*') &&
          (tspec.fsig === '*' ||
            AstUtilSinkUtil.prettyPrint(fclos.rtype?.vagueType).replace(/"/g, '') === tspec.fsig ||
            fclos.sid === tspec.fsig)
        ) {
          // import cn.hutool.http.HttpRequest; HttpRequest.post
          res.push(tspec)
          matchedSinkCount++
        } else if (
          callExpr.type === 'MemberAccess' &&
          (AstUtilSinkUtil.prettyPrint(fclos.object?.rtype) === tspec.calleeType ||
            AstUtilSinkUtil.prettyPrint(fclos.object?.rtype).endsWith(`.${tspec.calleeType}`) ||
            AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType) === tspec.calleeType ||
            AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType).endsWith(`.${tspec.calleeType}`) ||
            (calleeTypeBase && (AstUtilSinkUtil.prettyPrint(fclos.object?.rtype) === calleeTypeBase ||
              AstUtilSinkUtil.prettyPrint(fclos.object?.rtype).endsWith(`.${calleeTypeBase}`) ||
              AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType) === calleeTypeBase ||
              AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType).endsWith(`.${calleeTypeBase}`))) ||
            tspec.calleeType === '*') &&
          (tspec.fsig === '*' || AstUtilSinkUtil.prettyPrint(fclos.property) === tspec.fsig)
        ) {
          res.push(tspec)
          matchedSinkCount++
        } else if (
          callExpr.type === 'MemberAccess' &&
          (AstUtilSinkUtil.prettyPrint(fclos.rtype) === tspec.calleeType ||
            AstUtilSinkUtil.prettyPrint(fclos.rtype).endsWith(`.${tspec.calleeType}`) ||
            AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType) === tspec.calleeType ||
            AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType).endsWith(`.${tspec.calleeType}`) ||
            (calleeTypeBase && (AstUtilSinkUtil.prettyPrint(fclos.rtype) === calleeTypeBase ||
              AstUtilSinkUtil.prettyPrint(fclos.rtype).endsWith(`.${calleeTypeBase}`) ||
              AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType) === calleeTypeBase ||
              AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType).endsWith(`.${calleeTypeBase}`))) ||
            tspec.calleeType === '*') &&
          (tspec.fsig === '*' || AstUtilSinkUtil.prettyPrint(fclos.ast?.node) === tspec.fsig)
        ) {
          res.push(tspec)
          matchedSinkCount++
        } else if (
          callExpr.type === 'MemberAccess' &&
          (AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType) === tspec.calleeType ||
            AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType).endsWith(`.${tspec.calleeType}`) ||
            (calleeTypeBase && (AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType) === calleeTypeBase ||
              AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType).endsWith(`.${calleeTypeBase}`)))) &&
          (tspec.fsig === '*' || (AstUtilSinkUtil.prettyPrint(fclos.property) || AstUtilSinkUtil.prettyPrint(callExpr.property)) === tspec.fsig)
        ) {
          // receiver 丢失但 fclos.rtype.definiteType 保留了类型（如 Go 的 metaDb.Select 形态）
          // fclos.property 缺失时，从 callExpr AST 节点的 property 提取方法名作为 fallback
          res.push(tspec)
          matchedSinkCount++
        } else if (matchCallInfoReceiverCalleeType(callExpr, callInfo, tspec, calleeTypeBase)) {
          // Java dispatch 进入具体实现体时，callInfo 保留调用点 receiver 的声明类型。
          res.push(tspec)
          matchedSinkCount++
        } else if (
          // Go interface → concrete 实现穿透：rule.calleeType 声明 concrete，receiver 为 interface 时上面 4 条字符串比对全部失配
          analyzer &&
          callExpr.type === 'MemberAccess' &&
          tspec.calleeType &&
          tspec.calleeType !== '' &&
          tspec.calleeType !== '*' &&
          (tspec.fsig === '*' || AstUtilSinkUtil.prettyPrint(fclos.property) === tspec.fsig) &&
          tryMatchSinkGoInterfacePassthrough(
            AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType) ||
              AstUtilSinkUtil.prettyPrint(fclos.object?.rtype),
            tspec,
            analyzer
          )
        ) {
          res.push(tspec)
          matchedSinkCount++
        } else if (matchCalleeTypeViaQid(fclos.qid, tspec.calleeType, calleeTypeBase, tspec.fsig)) {
          // rtype 缺失但 qid 编码了 receiver 类型时（如 Go 全局变量 method call），按 qid 后缀匹配
          res.push(tspec)
        }
      } else if (tspec.fregex) {
        if (
          // 用于匹配形如 squirrel.Delete(*).Where形式的sink点，*为通配符
          callExpr.type === 'MemberAccess' &&
          tspec.calleeType === '' &&
          matchRegex(tspec.fregex, fclos.qid)
        ) {
          res.push(tspec)
          matchedSinkCount++
        }
      }
    }
  }
  return res
}

/**
 * 当 fclos.rtype 缺失但 fclos.qid 编码 receiver 类型时（如 Go 全局变量 method call），
 * 按 qid 后缀匹配 calleeType 与 fsig，并忽略 qid 中的 `<instance_*>` 标记。
 * @param qid fclos.qid
 * @param calleeType sink rule calleeType（可能带 `*` 前缀）
 * @param calleeTypeBase calleeType 去 `*` 后的形式
 * @param fsig sink rule fsig
 */

function matchCallInfoReceiverCalleeType(
  callExpr: { type?: string; property?: unknown },
  callInfo: CallInfo | undefined,
  rule: SinkRule,
  calleeTypeBase: string
): boolean {
  if (callExpr.type !== 'MemberAccess' || !rule.fsig) return false
  if (!rule.calleeType || rule.calleeType === '') return false
  const propertyName = AstUtilSinkUtil.prettyPrint(callExpr.property).replace(/"/g, '')
  if (rule.fsig !== '*' && propertyName !== rule.fsig) return false
  const receiverType = AstUtilSinkUtil.prettyPrint(callInfo?.callArgs?.receiver?.rtype?.definiteType)
  if (matchReceiverTypeName(receiverType, rule.calleeType)) return true
  return Boolean(calleeTypeBase && matchReceiverTypeName(receiverType, calleeTypeBase))
}

function matchCalleeTypeViaQid(
  qid: any,
  calleeType: string | undefined,
  calleeTypeBase: string,
  fsig: string | undefined
): boolean {
  if (!fsig || !calleeType || calleeType === '' || calleeType === '*' || typeof qid !== 'string') return false
  const cleanQid = qid.replace(/<instance_[^>]*>/g, '')
  if (fsig === '*') {
    // fsig 通配：只要 qid 包含 calleeType 层级即可
    if (cleanQid.endsWith(`.${calleeType}.`) || cleanQid.includes(`.${calleeType}.`)) return true
    if (calleeTypeBase && (cleanQid.endsWith(`.${calleeTypeBase}.`) || cleanQid.includes(`.${calleeTypeBase}.`))) return true
    return false
  }
  if (cleanQid.endsWith(`.${calleeType}.${fsig}`)) return true
  if (calleeTypeBase && cleanQid.endsWith(`.${calleeTypeBase}.${fsig}`)) return true
  return false
}


function matchEmptyCalleeTypeInstanceMethod(
  callExpr: { type?: string; property?: unknown },
  fclos: { object?: { rtype?: { definiteType?: unknown } }; property?: unknown; rtype?: { definiteType?: unknown }; qid?: unknown },
  rule: SinkRule
): boolean {
  if (rule.calleeType !== '' || !rule.fsig || !rule.fsig.includes('.')) return false
  if (callExpr.type !== 'MemberAccess') return false

  const lastDot = rule.fsig.lastIndexOf('.')
  const typeName = rule.fsig.slice(0, lastDot)
  const methodName = rule.fsig.slice(lastDot + 1)
  const propertyName = AstUtilSinkUtil.prettyPrint(fclos.property || callExpr.property).replace(/"/g, '')
  if (propertyName !== methodName) return false

  const cleanQid = typeof fclos.qid === 'string' ? fclos.qid.replace(/<instance_[^>]*>/g, '') : ''
  return (
    matchReceiverTypeName(AstUtilSinkUtil.prettyPrint(fclos.object?.rtype?.definiteType), typeName) ||
    matchReceiverTypeName(AstUtilSinkUtil.prettyPrint(fclos.rtype?.definiteType), typeName) ||
    cleanQid.endsWith(`.${rule.fsig}`)
  )
}

function matchReceiverTypeName(actualType: string, expectedType: string): boolean {
  if (!actualType || !expectedType) return false
  const normalizedActual = actualType.replace(/"/g, '')
  const expectedBase = expectedType.startsWith('*') ? expectedType.slice(1) : expectedType
  const actualBase = normalizedActual.startsWith('*') ? normalizedActual.slice(1) : normalizedActual
  return (
    normalizedActual === expectedType ||
    normalizedActual.endsWith(`.${expectedType}`) ||
    actualBase === expectedBase ||
    actualBase.endsWith(`.${expectedBase}`)
  )
}

/**
 *
 * @param pattern
 * @param testStr
 */
function matchRegex(pattern: string, testStr: string): boolean {
  try {
    return new RegExp(pattern, 'g').test(testStr)
  } catch (e) {
    handleExceptionSinkUtil(
      e,
      '[sink-util]An Error Occurred in compile regex',
      '[sink-util]An Error Occurred in compile regex'
    )
    return false
  }
}

/**
 * check if invocation match sink
 * @param invocation
 * @param sink
 * @param typeResolver
 */
function checkInvocationMatchSink(invocation: Invocation, sink: SinkRule, typeResolver: TypeRelatedInfoResolver): boolean {
  if (!invocation || !sink) {
    return false
  }

  if (!sink.fsig || sink.fsig === '') {
    return false
  }
  if (!sink.calleeType || sink.calleeType === '') {
    if (invocation.callSiteLiteral === sink.fsig || invocation.fsig === sink.fsig) {
      return true
    }
  } else {
    if (invocation.fsig === sink.fsig && invocation.calleeType && invocation.calleeType !== '') {
      if (invocation.calleeType === sink.calleeType || invocation.calleeType.endsWith(`.${sink.calleeType}`)) {
        return true
      } else if (typeResolver) {
        const classHierarchy: ClassHierarchy | undefined = typeResolver.classHierarchyMap.get(invocation.calleeType)
        if (classHierarchy) {
          const baseTypes: string[] = typeResolver.findBaseTypes(classHierarchy)
          for (const baseType of baseTypes) {
            if (baseType === sink.calleeType || baseType?.endsWith(`.${sink.calleeType}`)) {
              return true
            }
          }
          const subTypes: string[] = typeResolver.findSubTypes(classHierarchy)
          for (const subType of subTypes) {
            if (subType === sink.calleeType || subType?.endsWith(`.${sink.calleeType}`)) {
              return true
            }
          }
        }
      }
    }
    if (invocation.callSiteLiteral === `${sink.calleeType}.${sink.fsig}` || invocation.callSiteLiteral?.endsWith(`.${sink.calleeType}.${sink.fsig}`)) {
      return true
    }
  }

  return false
}

module.exports = {
  matchSinkAtFuncCall,
  matchSinkAtFuncCallWithCalleeType,
  matchRegex,
  checkInvocationMatchSink,
  getMatchedSinkCount,
  resetMatchedSinkCount,
  addMatchedSinkCount,
  // 导出供单元测试用
  tryMatchSinkGoInterfacePassthrough,
  matchEmptyCalleeTypeInstanceMethod,
  matchReceiverTypeName,
}
