import type { CallInfo } from '../../engine/analyzer/common/call-args'
import { toPreconditionAsSanitizer, type Precondition, type PreconditionAsSanitizer } from '../common/value/precondition'

const _ = require('lodash')
const BasicRuleHandler = require('../common/rules-basic-handler')
const SanitizerTag = require('../common/value/sanitizer-tag')
const SanitizerResult = require('../common/value/sanitizer-result')
const { prettyPrint, defaultFilter } = require('../../util/ast-util')
const SanitizerCallstackElement = require('../common/value/sanitizer-callstack-element')
const { matchSinkAtFuncCall, matchSinkAtFuncCallWithCalleeType } = require('../taint/common-kit/sink-util')
const { setTaint } = require('../taint/common-kit/source-util')
const { satisfy } = require('../../util/ast-util')
const Config = require('../../config')
const { shortenSourceFile } = require('../../util/file-util')
const NdResultWithMatchedSanitizerTag = require('../common/value/nd-result-with-matched-sanitizer-tag')
const Checker = require('../common/checker')

const SANITIZER = {
  SANITIZER_TYPE: {
    FUNCTION_CALL_SANITIZER: 'FunctionCallSanitizer',
    BINARY_OPERATION_SANITIZER: 'BinaryOperationSanitizer',
  },
  SANITIZER_SCENARIO: {
    VALIDATE_BY_FUNCTIONCALL: 'SANITIZER.VALIDATE_BY_FUNCTIONCALL',
    CONFIG_BY_FUNCTIONCALL: 'SANITIZER.CONFIG_BY_FUNCTIONCALL',
    CALLSTACK_HAS_FUNCTIONCALL: 'SANITIZER.CALLSTACK_HAS_FUNCTIONCALL',
    FILTER_BY_FUNCTIONCALL: 'SANITIZER.FILTER_BY_FUNCTIONCALL',
    DEFAULT: 'SANITIZER.DEFAULT',
    VALIDATE_BY_BINARYOPERATION: 'SANITIZER.VALIDATE_BY_BINARYOPERATION',
  },
}
const PRECONDITION = {
  PRECONDITION_TYPE: {
    FUNCTION_CALL_PRECONDITION: 'FunctionCallPrecondition',
  },
  PRECONDITION_SCENARIO: {
    VALIDATE_BY_FUNCTIONCALL: 'PRECONDITION.VALIDATE_BY_FUNCTIONCALL',
  },
}

/**
 * 根据 sanitizer 规则的 from/to 字段推断 scenario
 * - to 包含 "R" → FILTER_BY_FUNCTIONCALL（返回值带 sanitizer tag）
 * - to 包含以 "P" 开头的项 → VALIDATE_BY_FUNCTIONCALL（参数带 sanitizer tag）
 * - 其他 → DEFAULT
 */
function inferSanitizerScenario(item: { from?: string; to?: string | string[] }): string {
  const toArr = Array.isArray(item.to) ? item.to : item.to ? [item.to] : []
  if (toArr.some((t: string) => t === 'R')) {
    return SANITIZER.SANITIZER_SCENARIO.FILTER_BY_FUNCTIONCALL
  }
  if (toArr.some((t: string) => /^P\d*$/.test(t))) {
    return SANITIZER.SANITIZER_SCENARIO.VALIDATE_BY_FUNCTIONCALL
  }
  return SANITIZER.SANITIZER_SCENARIO.DEFAULT
}

const callstackSanitizers = new Set()

/** 缓存：precondition 转为 sanitizer 兼容格式的列表 */
let preconditionAsSanitizerCache: PreconditionAsSanitizer[] | undefined

/**
 *
 */
class SanitizerChecker extends Checker {
  static sanitizerMap: Map<any, any> | undefined = undefined

  static matchSanitizerResultMap = new Map()

  /**
   *
   * @param mng
   */
  constructor(mng: any) {
    super(mng, 'sanitizer')
  }

  /**
   * trigger before execute of entry point
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtSymbolInterpretOfEntryPointBefore(analyzer: any, scope: any, node: any, state: any, info: any): void {
    callstackSanitizers.clear()
  }

  /**
   * trigger after execute of entry point
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtSymbolInterpretOfEntryPointAfter(analyzer: any, scope: any, node: any, state: any, info: any): void {}

  /**
   * trigger after function call
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallAfter(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const { fclos, ret, callInfo } = info
    // legacy 兼容：Java 分析器传 argvalues 而非 callInfo，转换为 CallInfo 格式
    const effectiveCallInfo: CallInfo | undefined = callInfo ?? (Array.isArray(info.argvalues) ? { callArgs: { args: info.argvalues.map((v: any, i: number) => ({ index: i, value: v })) } } as CallInfo : undefined)
    const sanitizers = SanitizerChecker.findAllSanitizers()
    if (sanitizers) {
      SanitizerChecker.checkAddOrDeleteFunctionCallSanitizer(
        sanitizers,
        node,
        fclos,
        ret,
        effectiveCallInfo,
        scope,
        info?.callstack
      )
    }
    // precondition 打标：复用 sanitizer 匹配逻辑
    SanitizerChecker.checkAndTagPreconditions(node, fclos, ret, effectiveCallInfo, scope, info?.callstack)
  }

  /**
   * trigger after object initialization
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtNewExprAfter(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const { fclos, ret, callInfo } = info
    // legacy 兼容：Java 分析器传 argvalues 而非 callInfo，转换为 CallInfo 格式
    const effectiveCallInfo: CallInfo | undefined = callInfo ?? (Array.isArray(info.argvalues) ? { callArgs: { args: info.argvalues.map((v: any, i: number) => ({ index: i, value: v })) } } as CallInfo : undefined)
    const sanitizers = SanitizerChecker.findAllSanitizers()
    if (sanitizers) {
      SanitizerChecker.checkAddOrDeleteFunctionCallSanitizer(
        sanitizers,
        node,
        fclos,
        ret,
        effectiveCallInfo,
        scope,
        info?.callstack
      )
    }
    // precondition 打标：复用 sanitizer 匹配逻辑
    SanitizerChecker.checkAndTagPreconditions(node, fclos, ret, effectiveCallInfo, scope, info?.callstack)
  }

  /**
   * trigger at binary operation
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtBinaryOperation(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const sanitizers = SanitizerChecker.findAllSanitizers()
    if (sanitizers) {
      SanitizerChecker.checkAddOrDeleteBinaryOperationSanitizer(sanitizers, node, info.newNode, null, state?.callstack)
    }
  }

  /**
   * get sanitizers of current callstack
   * @returns {Set<any>}
   */
  static getCallstackSanitizerOfEntryPoint(): Set<any> {
    return callstackSanitizers
  }

  /**
   * check if function call match specified scenario. add tag if matched
   * @param sanitizers
   * @param node
   * @param fclos
   * @param ret
   * @param callInfo
   * @param scope
   * @param callstack
   */
  static checkAddOrDeleteFunctionCallSanitizer(
    sanitizers: any[],
    node: any,
    fclos: any,
    ret: any,
    callInfo: CallInfo | undefined,
    scope: any,
    callstack: any
  ): void {
    if (!sanitizers) {
      return
    }

    const matchedSanitizers = SanitizerChecker.findMatchedSanitizerOfFunctionCall(sanitizers, node, fclos, scope, callInfo)
    if (!matchedSanitizers) {
      return
    }

    for (const matchedSanitizer of matchedSanitizers) {
      if (!matchedSanitizer.sanitizerScenario) {
        matchedSanitizer.sanitizerScenario = SANITIZER.SANITIZER_SCENARIO.DEFAULT
      }
      switch (matchedSanitizer.sanitizerScenario) {
        case SANITIZER.SANITIZER_SCENARIO.FILTER_BY_FUNCTIONCALL:
          if (ret) {
            SanitizerChecker.addSanitizerInSymbolValue(matchedSanitizer, node, ret, callstack)
          }
          break
        case SANITIZER.SANITIZER_SCENARIO.VALIDATE_BY_FUNCTIONCALL:
          const args = BasicRuleHandler.prepareArgs(callInfo, fclos, matchedSanitizer)
          if (args) {
            for (const arg of args) {
              SanitizerChecker.addSanitizerInSymbolValue(matchedSanitizer, node, arg, callstack)
            }
          }
          break
        case SANITIZER.SANITIZER_SCENARIO.CONFIG_BY_FUNCTIONCALL:
          if (ret) {
            SanitizerChecker.addSanitizerInSymbolValue(matchedSanitizer, node, ret, callstack)
          }
          break
        case SANITIZER.SANITIZER_SCENARIO.CALLSTACK_HAS_FUNCTIONCALL:
          SanitizerChecker.addSanitizerInCallStack(matchedSanitizer, node, callstack)
          break
        case SANITIZER.SANITIZER_SCENARIO.DEFAULT:
          SanitizerChecker.addSanitizerInCallStack(matchedSanitizer, node, callstack)
          break
        default:
          break
      }
    }
  }

  /**
   * check if binary expression match specified sanitizer. add tag if matched
   * @param sanitizers
   * @param node
   * @param newNode
   * @param scope
   * @param callstack
   */
  static checkAddOrDeleteBinaryOperationSanitizer(
    sanitizers: any[],
    node: any,
    newNode: any,
    scope: any,
    callstack: any
  ): void {
    const binarySanitizers = sanitizers.filter(
      (sanitizer: any) => sanitizer.sanitizerType === SANITIZER.SANITIZER_TYPE.BINARY_OPERATION_SANITIZER
    )
    for (const binarySanitizer of binarySanitizers) {
      if (binarySanitizer.operator === node.operator) {
        let regex: RegExp
        if (binarySanitizer.targetValue) {
          try {
            const regexStr =
              (binarySanitizer.targetValue.startsWith('^') ? '' : '^') +
              binarySanitizer.targetValue +
              (binarySanitizer.targetValue.endsWith('$') ? '' : '$')
            regex = new RegExp(regexStr)
            if (newNode.left?.vtype === 'primitive') {
              const leftStr = String(prettyPrint(newNode.left))
              if (leftStr.match(regex)) {
                SanitizerChecker.addSanitizerInSymbolValue(binarySanitizer, node, newNode.right, callstack)
              }
            }
            if (newNode.right?.vtype === 'primitive') {
              const rightStr = String(prettyPrint(newNode.right))
              if (rightStr.match(regex)) {
                SanitizerChecker.addSanitizerInSymbolValue(binarySanitizer, node, newNode.left, callstack)
              }
            }
          } catch (e) {}
        }
      }
    }
  }

  /**
   * find matched sanitizer tag
   * @param sanitizers
   * @param tags
   * @returns {*[]}
   */
  static findMatchedSanitizerTag(sanitizers: any[], tags: any[]): any[] {
    const result: any[] = []
    if (!sanitizers || sanitizers.length === 0 || !tags) {
      return result
    }

    for (const tagObj of tags) {
      if (tagObj instanceof SanitizerTag) {
        for (const sanitizer of sanitizers) {
          if (tagObj.id && sanitizer.id && tagObj.id === sanitizer.id) {
            result.push(tagObj)
            break
          }
        }
      }
    }

    return result
  }

  /**
   * check if sanitizer tag exist
   * @param tags
   * @param sanitizer
   * @param node
   */
  static checkSanitizerTagExist(tags: any[], sanitizer: any, node: any): boolean {
    if (!tags || !sanitizer || !node) {
      return false
    }

    for (const tagObj of tags) {
      if (
        tagObj instanceof SanitizerTag &&
        tagObj.id &&
        sanitizer.id &&
        tagObj.id === sanitizer.id &&
        tagObj.node === node
      ) {
        return true
      }
    }

    return false
  }

  /**
   * load and store all sanitizers from rule
   */
  static loadAndStoreAllSanitizersFromRule() {
    if (!BasicRuleHandler.getPreprocessReady() || SanitizerChecker.sanitizerMap) {
      return
    }
    SanitizerChecker.sanitizerMap = new Map()
    if (Array.isArray(BasicRuleHandler.getRules()) && BasicRuleHandler.getRules().length > 0) {
      for (const rule of BasicRuleHandler.getRules()) {
        if (!rule.sanitizers || typeof rule.sanitizers !== 'object') {
          continue
        }
        if (Array.isArray(rule.sanitizers)) {
          // 旧格式：sanitizers 是扁平数组，每项已含 id/sanitizerType
          for (const sanitizer of rule.sanitizers) {
            SanitizerChecker.sanitizerMap.set(sanitizer.id, sanitizer)
          }
        } else {
          // 新格式：sanitizers 是 { sanitizerType: [...items] } 的 Object
          for (const [type, items] of Object.entries(rule.sanitizers)) {
            if (!Array.isArray(items)) {
              continue
            }
            for (const item of items as any[]) {
              const sanitizer = {
                ...item,
                sanitizerType: type,
                id: item.id || item.fsig,
                sanitizerScenario: item.sanitizerScenario || inferSanitizerScenario(item),
              }
              SanitizerChecker.sanitizerMap.set(sanitizer.id, sanitizer)
            }
          }
        }
      }
    }
  }

  /**
   * find all sanitizers from rule
   * @returns {*}
   */
  static findAllSanitizers(): any[] {
    if (!SanitizerChecker.sanitizerMap) {
      SanitizerChecker.loadAndStoreAllSanitizersFromRule()
    }
    if (!SanitizerChecker.sanitizerMap) {
      return []
    }
    return Array.from(SanitizerChecker.sanitizerMap.values())
  }

  /**
   * find sanitizer by id from rule
   * @param sanitizerIds
   * @returns {*[]}
   */
  static findSanitizerByIds(sanitizerIds: string[]): any[] {
    const result: any[] = []
    if (!sanitizerIds || sanitizerIds.length === 0) {
      return result
    }

    if (!SanitizerChecker.sanitizerMap) {
      SanitizerChecker.loadAndStoreAllSanitizersFromRule()
    }
    if (!SanitizerChecker.sanitizerMap) {
      return []
    }

    for (const sanitizerId of sanitizerIds) {
      if (SanitizerChecker.sanitizerMap.has(sanitizerId)) {
        result.push(SanitizerChecker.sanitizerMap.get(sanitizerId))
      }
    }

    return result
  }

  /**
   * format sanitizer tag for output
   * @param sanitizerTags
   * @returns {string}
   */
  static formatSanitizerTags(sanitizerTags: any[]): string {
    const resultArray: any[] = []
    if (!sanitizerTags || sanitizerTags.length === 0) {
      return ''
    }
    for (const sanitizerTag of sanitizerTags) {
      const sanitizerResult = new SanitizerResult()
      sanitizerResult.id = sanitizerTag.id
      sanitizerResult.sanitizerType = sanitizerTag.sanitizerType
      sanitizerResult.sanitizerScenario = sanitizerTag.sanitizerScenario
      if (sanitizerTag.node?.loc?.sourcefile) {
        sanitizerResult.fileName = shortenSourceFile(sanitizerTag.node?.loc?.sourcefile, Config.maindir_prefix)
      }
      if (sanitizerTag.node?.loc?.start?.line) {
        sanitizerResult.beginLine = sanitizerTag.node?.loc?.start?.line
      }
      if (sanitizerTag.node?.loc?.end?.line) {
        sanitizerResult.endLine = sanitizerTag.node?.loc?.end?.line
      }
      if (sanitizerTag.node?.loc?.start?.column) {
        sanitizerResult.beginColumn = sanitizerTag.node?.loc?.start?.column
      }
      if (sanitizerTag.node?.loc?.end?.column) {
        sanitizerResult.endColumn = sanitizerTag.node?.loc?.end?.column
      }
      sanitizerResult.codeSnippet = prettyPrint(sanitizerTag.node)

      const callstackElements: any[] = []
      if (sanitizerTag.callstack) {
        let index = 0
        for (const obj of sanitizerTag.callstack) {
          const callstackElement = new SanitizerCallstackElement()
          callstackElement.id = index
          if (obj.ast?.node?.loc?.sourcefile) {
            callstackElement.fileName = shortenSourceFile(obj.ast?.node?.loc?.sourcefile, Config.maindir_prefix)
          }
          if (obj.ast?.node?.loc?.start?.line) {
            callstackElement.beginLine = obj.ast?.node?.loc?.start?.line
          }
          if (obj.ast?.node?.loc?.end?.line) {
            callstackElement.endLine = obj.ast?.node?.loc?.end?.line
          }
          if (obj.ast?.node?.loc?.start?.column) {
            callstackElement.beginColumn = obj.ast?.node?.loc?.start?.column
          }
          if (obj.ast?.node?.loc?.end?.column) {
            callstackElement.endColumn = obj.ast?.node?.loc?.end?.column
          }
          if (obj.ast.node) {
            callstackElement.codeSnippet = prettyPrint(obj.ast.fdef ? obj.ast.fdef : obj.ast.node)
          }
          callstackElements.push(callstackElement)
          index += 1
        }
      }
      sanitizerResult.callstackElements = callstackElements

      resultArray.push(sanitizerResult)
    }

    return JSON.stringify(resultArray)
  }

  /**
   * find matched sanitizer of function call
   * @param sanitizers
   * @param node
   * @param fclos
   * @param scope
   * @returns {*[]}
   */
  static findMatchedSanitizerOfFunctionCall(sanitizers: any[], node: any, fclos: any, scope: any, callInfo: CallInfo | undefined, skipCache?: boolean): any[] {
    if (!BasicRuleHandler.getPreprocessReady()) {
      return []
    }

    // precondition 匹配复用此方法但传入不同规则列表，必须跳过缓存避免与 sanitizer 结果混淆
    if (!skipCache && node?._meta?.nodehash && SanitizerChecker.matchSanitizerResultMap.has(node._meta.nodehash)) {
      return SanitizerChecker.matchSanitizerResultMap.get(node._meta.nodehash)
    }

    const matchedSanitizers: any[] = []

    const sanitizersWithoutCalleeType = sanitizers.filter(
      (sanitizer: any) =>
        sanitizer.sanitizerType === SANITIZER.SANITIZER_TYPE.FUNCTION_CALL_SANITIZER &&
        (!sanitizer.calleeType || sanitizer.calleeType.length === 0)
    )
    const matchedSanitizersWithoutCalleeType = matchSinkAtFuncCall(node, fclos, sanitizersWithoutCalleeType, callInfo)
    if (matchedSanitizersWithoutCalleeType) {
      matchedSanitizers.push(...matchedSanitizersWithoutCalleeType)
    }

    const sanitizersWithCalleeType = sanitizers.filter(
      (sanitizer: any) =>
        sanitizer.sanitizerType === SANITIZER.SANITIZER_TYPE.FUNCTION_CALL_SANITIZER &&
        sanitizer.calleeType &&
        sanitizer.calleeType.length > 0
    )
    const matchedSanitizersWithCalleeType = matchSinkAtFuncCallWithCalleeType(
      node,
      fclos,
      sanitizersWithCalleeType,
      scope,
      callInfo
    )
    if (matchedSanitizersWithCalleeType) {
      matchedSanitizers.push(...matchedSanitizersWithCalleeType)
    }

    // 仅缓存 sanitizer 的结果，precondition 不写入缓存
    if (!skipCache && node?._meta?.nodehash) {
      SanitizerChecker.matchSanitizerResultMap.set(node._meta.nodehash, matchedSanitizers)
    }

    return matchedSanitizers
  }

  /**
   * assemble sanitizer tag
   * @param sanitizer
   * @param node
   * @param callstack
   * @returns {SanitizerTag|null}
   */
  static assembleSanitizerTag(sanitizer: any, node: any, callstack: any): any {
    if (!sanitizer || !sanitizer.id || !node) {
      return null
    }

    const sanitizerTag = new SanitizerTag()
    sanitizerTag.id = sanitizer.id
    sanitizerTag.sanitizerType = sanitizer.sanitizerType
    sanitizerTag.sanitizerScenario = sanitizer.sanitizerScenario
    sanitizerTag.callstack = callstack
    sanitizerTag.node = node

    return sanitizerTag
  }

  /**
   * add sanitizer in callstack
   * @param sanitizer
   * @param node
   * @param callstack
   */
  static addSanitizerInCallStack(sanitizer: any, node: any, callstack: any): void {
    if (!sanitizer || !sanitizer.id) {
      return
    }
    if (this.checkSanitizerTagExist(Array.from(callstackSanitizers), sanitizer, node)) {
      return
    }

    const newCallstack: any[] = []
    if (callstack) {
      for (const element of callstack) {
        newCallstack.push(element)
      }
    }

    const sanitizerTag = SanitizerChecker.assembleSanitizerTag(sanitizer, node, newCallstack)
    callstackSanitizers.add(sanitizerTag)
  }

  /**
   * add sanitizer in symbol value
   * @param sanitizer
   * @param node
   * @param val
   * @param callstack
   */
  static addSanitizerInSymbolValue(sanitizer: any, node: any, val: any, callstack: any): void {
    if (!sanitizer || !sanitizer.id || !val) {
      return
    }
    if (this.checkSanitizerTagExist(val.taint.getTags(), sanitizer, node)) {
      return
    }

    const newCallstack: any[] = []
    if (callstack) {
      for (const element of callstack) {
        newCallstack.push(element)
      }
    }

    const sanitizerTag = SanitizerChecker.assembleSanitizerTag(sanitizer, node, newCallstack)
    if (!Array.isArray(val)) {
      setTaint(val, sanitizerTag)
    } else {
      for (const element of val) {
        setTaint(element, sanitizerTag)
      }
    }
  }

  /**
   * find tag and matched sanitizer
   * @param node
   * @param fclos
   * @param args
   * @param scope
   * @param attribute
   * @param multiMatch
   * @param sanitizers
   */
  static findTagAndMatchedSanitizer(
    node: any,
    fclos: any,
    args: any,
    scope: any,
    attribute: any,
    multiMatch: any,
    sanitizers: any[]
  ): any[] {
    const resultArray: any[] = []
    const matchedSanitizerTagsForAllTrace: any[] = []

    const callstackSanitizerTags = SanitizerChecker.getCallstackSanitizerOfEntryPoint()
    const matchedCallstackSanitizerTags = SanitizerChecker.findMatchedSanitizerTag(
      sanitizers,
      Array.from(callstackSanitizerTags)
    )
    if (matchedCallstackSanitizerTags) {
      matchedSanitizerTagsForAllTrace.push(...matchedCallstackSanitizerTags)
    }

    const Configs = sanitizers.filter(
      (sanitizer: any) => sanitizer.sanitizerScenario === SANITIZER.SANITIZER_SCENARIO.CONFIG_BY_FUNCTIONCALL
    )
    const fConfig = (nd: any) => {
      const tags = nd?.taint ? nd.taint.getTags() : undefined
      return tags && SanitizerChecker.findMatchedSanitizerTag(Configs, tags)?.length > 0
    }

    const sanitizerNd = satisfy(fclos, fConfig, undefined, undefined, multiMatch, 30, undefined)
    if (sanitizerNd) {
      if (Array.isArray(sanitizerNd)) {
        for (const n of sanitizerNd) {
          const matchedConfigSanitizerTags = SanitizerChecker.findMatchedSanitizerTag(sanitizers, n.taint ? n.taint.getTags() : undefined)
          if (matchedConfigSanitizerTags) {
            matchedSanitizerTagsForAllTrace.push(...matchedConfigSanitizerTags)
          }
        }
      } else {
        const matchedConfigSanitizerTags = SanitizerChecker.findMatchedSanitizerTag(sanitizers, sanitizerNd.taint ? sanitizerNd.taint.getTags() : undefined)
        if (matchedConfigSanitizerTags) {
          matchedSanitizerTagsForAllTrace.push(...matchedConfigSanitizerTags)
        }
      }
    }

    const flowSanitizers = sanitizers.filter(
      (sanitizer: any) =>
        sanitizer.sanitizerScenario === SANITIZER.SANITIZER_SCENARIO.FILTER_BY_FUNCTIONCALL ||
        sanitizer.sanitizerScenario === SANITIZER.SANITIZER_SCENARIO.VALIDATE_BY_FUNCTIONCALL ||
        sanitizer.sanitizerScenario === SANITIZER.SANITIZER_SCENARIO.VALIDATE_BY_BINARYOPERATION
    )
    const fFlow = (nd: any) => {
      const tagTraceMap = nd?.taint ? nd.taint.getTagTracesMap() : undefined
      if (!tagTraceMap) return false
      return tagTraceMap.has(attribute)
    }
    const filter = defaultFilter
    const satisfyCallback = (nd: any, from: any, parentMap: any) => {
      if (!nd) {
        return
      }

      const matchedSanitizerTags: any[] = []
      matchedSanitizerTags.push(...matchedSanitizerTagsForAllTrace)

      const parentNdList: any[] = []
      if (parentMap) {
        let currentNd = nd
        do {
          if (parentNdList.includes(currentNd)) {
            break
          }
          parentNdList.push(currentNd)
          currentNd = parentMap.get(currentNd)
        } while (currentNd)
      }
      for (const parentNd of parentNdList) {
        const matchedFlowSanitizerTags = SanitizerChecker.findMatchedSanitizerTag(flowSanitizers, parentNd.taint ? parentNd.taint.getTags() : undefined)
        if (matchedFlowSanitizerTags) {
          matchedSanitizerTags.push(...matchedFlowSanitizerTags)
        }
      }

      const result = new NdResultWithMatchedSanitizerTag()
      result.nd = nd
      result.matchedSanitizerTags = matchedSanitizerTags
      resultArray.push(result)
    }

    satisfy(args, fFlow, filter, undefined, multiMatch, 30, satisfyCallback)

    return resultArray
  }

  /**
   * 获取所有 precondition（转换为 sanitizer 兼容格式），带缓存
   */
  static findAllPreconditionsAsSanitizers(): PreconditionAsSanitizer[] {
    if (preconditionAsSanitizerCache) {
      return preconditionAsSanitizerCache
    }
    const preconditions: Precondition[] = BasicRuleHandler.findAllPreconditions()
    preconditionAsSanitizerCache = preconditions.map(toPreconditionAsSanitizer)
    return preconditionAsSanitizerCache
  }

  /**
   * 检查函数调用是否匹配 precondition，匹配时在 taint 上打 tag
   * 复用 sanitizer 的函数匹配逻辑，scenario 为 VALIDATE_BY_FUNCTIONCALL 时标记参数
   */
  static checkAndTagPreconditions(
    node: any,
    fclos: any,
    ret: any,
    callInfo: CallInfo | undefined,
    scope: any,
    callstack: any
  ): void {
    const preconditionsAsSanitizer = SanitizerChecker.findAllPreconditionsAsSanitizers()
    if (preconditionsAsSanitizer.length === 0) {
      return
    }
    const matched = SanitizerChecker.findMatchedSanitizerOfFunctionCall(
      preconditionsAsSanitizer,
      node,
      fclos,
      scope,
      callInfo,
      true // skipCache：precondition 和 sanitizer 使用不同规则列表，不能共享缓存
    )
    if (!matched || matched.length === 0) {
      return
    }
    for (const matchedPrecondition of matched) {
      // precondition 场景目前只支持 VALIDATE_BY_FUNCTIONCALL
      const mappedScenario = matchedPrecondition.sanitizerScenario ?? SANITIZER.SANITIZER_SCENARIO.VALIDATE_BY_FUNCTIONCALL
      if (mappedScenario === SANITIZER.SANITIZER_SCENARIO.VALIDATE_BY_FUNCTIONCALL) {
        const args = BasicRuleHandler.prepareArgs(callInfo, fclos, matchedPrecondition)
        // precondition 语义：只有参数携带 taint 时才打 tag（arg + receiver）
        // 确保 taint 必须流经 precondition 函数的参数
        const argHasTaint = args?.some((arg: any) => arg?.taint?.isTaintedRec)
        if (argHasTaint) {
          if (args) {
            for (const arg of args) {
              SanitizerChecker.addSanitizerInSymbolValue(matchedPrecondition, node, arg, callstack)
            }
          }
          // 对 MemberAccess 调用（如 request.setStatement(userInput)），在 receiver 上也打 tag
          const receiver = typeof fclos?.getThisObj === 'function' ? fclos.getThisObj() : undefined
          if (receiver) {
            SanitizerChecker.addSanitizerInSymbolValue(matchedPrecondition, node, receiver, callstack)
          }
        }
      }
    }
  }

  /**
   * 在 taint tags 中查找匹配指定 precondition ids 的 tag
   * 返回匹配到的 tag 列表
   */
  static findMatchedPreconditionTags(preconditionIds: string[], tags: any[]): any[] {
    const result: any[] = []
    if (!preconditionIds || preconditionIds.length === 0 || !tags) {
      return result
    }
    const idSet = new Set(preconditionIds)
    for (const tagObj of tags) {
      if (tagObj instanceof SanitizerTag && tagObj.id && idSet.has(tagObj.id)) {
        result.push(tagObj)
      }
    }
    return result
  }
}

module.exports = SanitizerChecker
