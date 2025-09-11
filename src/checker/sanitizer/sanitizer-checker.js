const _ = require('lodash')
const Rules = require('../common/rules-basic-handler')
const SanitizerTag = require('../common/value/sanitizer-tag')
const SanitizerResult = require('../common/value/sanitizer-result')
const { prettyPrint, defaultFilter } = require('../../util/ast-util')
const SanitizerCallstackElement = require('../common/value/sanitizer-callstack-element')
const { matchSinkAtFuncCall, matchSinkAtFuncCallWithCalleeType } = require('../taint/common-kit/sink-util')
const { setTaint } = require('../taint/common-kit/source-util')
const { satisfy } = require('../../util/ast-util')
const config = require('../../config')
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
const callstackSanitizers = new Set()

/**
 *
 */
class SanitizerChecker extends Checker {
  /**
   *
   * @param mng
   */
  constructor(mng) {
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
  triggerAtSymbolInterpretOfEntryPointBefore(analyzer, scope, node, state, info) {
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
  triggerAtSymbolInterpretOfEntryPointAfter(analyzer, scope, node, state, info) {}

  /**
   * trigger after function call
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallAfter(analyzer, scope, node, state, info) {
    const { fclos, ret, argvalues } = info
    const sanitizers = SanitizerChecker.findAllSanitizers()
    if (sanitizers) {
      SanitizerChecker.checkAddOrDeleteFunctionCallSanitizer(
        sanitizers,
        node,
        fclos,
        ret,
        argvalues,
        scope,
        info?.callstack
      )
    }
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
  triggerAtNewExprAfter(analyzer, scope, node, state, info) {
    const { fclos, ret, argvalues } = info
    const sanitizers = SanitizerChecker.findAllSanitizers()
    if (sanitizers) {
      SanitizerChecker.checkAddOrDeleteFunctionCallSanitizer(
        sanitizers,
        node,
        fclos,
        ret,
        argvalues,
        scope,
        info?.callstack
      )
    }
  }

  /**
   * trigger at binary operation
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtBinaryOperation(analyzer, scope, node, state, info) {
    const sanitizers = SanitizerChecker.findAllSanitizers()
    if (sanitizers) {
      SanitizerChecker.checkAddOrDeleteBinaryOperationSanitizer(sanitizers, node, info.newNode, null, state?.callstack)
    }
  }

  /**
   * get sanitizers of current callstack
   * @returns {Set<any>}
   */
  static getCallstackSanitizerOfEntryPoint() {
    return callstackSanitizers
  }

  /**
   * check if function call match specified scenario. add tag if matched
   * @param sanitizers
   * @param node
   * @param fclos
   * @param ret
   * @param argvalues
   * @param scope
   * @param callstack
   */
  static checkAddOrDeleteFunctionCallSanitizer(sanitizers, node, fclos, ret, argvalues, scope, callstack) {
    if (!sanitizers) {
      return
    }

    const matchedSanitizers = SanitizerChecker.findMatchedSanitizerOfFunctionCall(sanitizers, node, fclos, scope)
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
          const args = Rules.prepareArgs(argvalues, fclos, matchedSanitizer)
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
  static checkAddOrDeleteBinaryOperationSanitizer(sanitizers, node, newNode, scope, callstack) {
    const binarySanitizers = sanitizers.filter(
      (sanitizer) => sanitizer.sanitizerType === SANITIZER.SANITIZER_TYPE.BINARY_OPERATION_SANITIZER
    )
    for (const binarySanitizer of binarySanitizers) {
      if (binarySanitizer.operator === node.operator) {
        let regex
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
  static findMatchedSanitizerTag(sanitizers, tags) {
    const result = []
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
  static checkSanitizerTagExist(tags, sanitizer, node) {
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
   * find all sanitizers from rule
   * @returns {*}
   */
  static findAllSanitizers() {
    const sanitizers = []
    if (Array.isArray(Rules.getRules()) && Rules.getRules().length > 0) {
      for (const rule of Rules.getRules()) {
        if (Array.isArray(rule.sanitizers)) {
          sanitizers.push(...rule.sanitizers)
        }
      }
    }
    return sanitizers
  }

  /**
   * find sanitizer by id from rule
   * @param sanitizerIds
   * @returns {*[]}
   */
  static findSanitizerByIds(sanitizerIds) {
    const result = []
    if (!sanitizerIds || sanitizerIds.length === 0) {
      return result
    }

    if (Array.isArray(Rules.getRules()) && Rules.getRules().length > 0) {
      for (const rule of Rules.getRules()) {
        if (Array.isArray(rule.sanitizers)) {
          for (const sanitizer of rule.sanitizers) {
            if (sanitizerIds.includes(sanitizer.id)) {
              result.push(sanitizer)
            }
          }
        }
      }
    }
    return result
  }

  /**
   * format sanitizer tag for output
   * @param sanitizerTags
   * @returns {string}
   */
  static formatSanitizerTags(sanitizerTags) {
    const resultArray = []
    if (!sanitizerTags || sanitizerTags.length === 0) {
      return ''
    }
    for (const sanitizerTag of sanitizerTags) {
      const sanitizerResult = new SanitizerResult()
      sanitizerResult.id = sanitizerTag.id
      sanitizerResult.sanitizerType = sanitizerTag.sanitizerType
      sanitizerResult.sanitizerScenario = sanitizerTag.sanitizerScenario
      if (sanitizerTag.node?.loc?.sourcefile) {
        sanitizerResult.fileName = shortenSourceFile(sanitizerTag.node?.loc?.sourcefile, config.maindir_prefix)
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

      const callstackElements = []
      if (sanitizerTag.callstack) {
        let index = 0
        for (const obj of sanitizerTag.callstack) {
          const callstackElement = new SanitizerCallstackElement()
          callstackElement.id = index
          if (obj.ast?.loc?.sourcefile) {
            callstackElement.fileName = shortenSourceFile(obj.ast?.loc?.sourcefile, config.maindir_prefix)
          }
          if (obj.ast?.loc?.start?.line) {
            callstackElement.beginLine = obj.ast?.loc?.start?.line
          }
          if (obj.ast?.loc?.end?.line) {
            callstackElement.endLine = obj.ast?.loc?.end?.line
          }
          if (obj.ast?.loc?.start?.column) {
            callstackElement.beginColumn = obj.ast?.loc?.start?.column
          }
          if (obj.ast?.loc?.end?.column) {
            callstackElement.endColumn = obj.ast?.loc?.end?.column
          }
          if (obj.ast) {
            callstackElement.codeSnippet = prettyPrint(obj.fdef ? obj.fdef : obj.ast)
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
  static findMatchedSanitizerOfFunctionCall(sanitizers, node, fclos, scope) {
    const matchedSanitizers = []

    const sanitizersWithoutCalleeType = sanitizers.filter(
      (sanitizer) =>
        sanitizer.sanitizerType === SANITIZER.SANITIZER_TYPE.FUNCTION_CALL_SANITIZER &&
        (!sanitizer.calleeType || sanitizer.calleeType.length === 0)
    )
    const matchedSanitizersWithoutCalleeType = matchSinkAtFuncCall(node, fclos, sanitizersWithoutCalleeType)
    if (matchedSanitizersWithoutCalleeType) {
      matchedSanitizers.push(...matchedSanitizersWithoutCalleeType)
    }

    const sanitizersWithCalleeType = sanitizers.filter(
      (sanitizer) =>
        sanitizer.sanitizerType === SANITIZER.SANITIZER_TYPE.FUNCTION_CALL_SANITIZER &&
        sanitizer.calleeType &&
        sanitizer.calleeType.length > 0
    )
    const matchedSanitizersWithCalleeType = matchSinkAtFuncCallWithCalleeType(
      node,
      fclos,
      sanitizersWithCalleeType,
      scope
    )
    if (matchedSanitizersWithCalleeType) {
      matchedSanitizers.push(...matchedSanitizersWithCalleeType)
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
  static assembleSanitizerTag(sanitizer, node, callstack) {
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
  static addSanitizerInCallStack(sanitizer, node, callstack) {
    if (!sanitizer || !sanitizer.id) {
      return
    }
    if (this.checkSanitizerTagExist(callstackSanitizers, sanitizer, node)) {
      return
    }

    const newCallstack = []
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
  static addSanitizerInSymbolValue(sanitizer, node, val, callstack) {
    if (!sanitizer || !sanitizer.id || !val) {
      return
    }
    if (this.checkSanitizerTagExist(val._tags, sanitizer, node)) {
      return
    }

    const newCallstack = []
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
  static findTagAndMatchedSanitizer(node, fclos, args, scope, attribute, multiMatch, sanitizers) {
    const resultArray = []
    const matchedSanitizerTagsForAllTrace = []

    const callstackSanitizerTags = SanitizerChecker.getCallstackSanitizerOfEntryPoint()
    const matchedCallstackSanitizerTags = SanitizerChecker.findMatchedSanitizerTag(sanitizers, callstackSanitizerTags)
    if (matchedCallstackSanitizerTags) {
      matchedSanitizerTagsForAllTrace.push(...matchedCallstackSanitizerTags)
    }

    const configSanitizers = sanitizers.filter(
      (sanitizer) => sanitizer.sanitizerScenario === SANITIZER.SANITIZER_SCENARIO.CONFIG_BY_FUNCTIONCALL
    )
    const fConfig = (nd) => {
      const tags = nd?._tags
      return tags && SanitizerChecker.findMatchedSanitizerTag(configSanitizers, tags)?.length > 0
    }

    const sanitizerNd = satisfy(fclos, fConfig, undefined, undefined, multiMatch, 30, undefined)
    if (sanitizerNd) {
      if (Array.isArray(sanitizerNd)) {
        for (const n of sanitizerNd) {
          const matchedConfigSanitizerTags = SanitizerChecker.findMatchedSanitizerTag(sanitizers, n._tags)
          if (matchedConfigSanitizerTags) {
            matchedSanitizerTagsForAllTrace.push(...matchedConfigSanitizerTags)
          }
        }
      } else {
        const matchedConfigSanitizerTags = SanitizerChecker.findMatchedSanitizerTag(sanitizers, sanitizerNd._tags)
        if (matchedConfigSanitizerTags) {
          matchedSanitizerTagsForAllTrace.push(...matchedConfigSanitizerTags)
        }
      }
    }

    const flowSanitizers = sanitizers.filter(
      (sanitizer) =>
        sanitizer.sanitizerScenario === SANITIZER.SANITIZER_SCENARIO.FILTER_BY_FUNCTIONCALL ||
        sanitizer.sanitizerScenario === SANITIZER.SANITIZER_SCENARIO.VALIDATE_BY_FUNCTIONCALL ||
        sanitizer.sanitizerScenario === SANITIZER.SANITIZER_SCENARIO.VALIDATE_BY_BINARYOPERATION
    )
    const fFlow = (nd) => {
      const tags = nd?._tags
      return _.isFunction(tags?.has) && tags.has(attribute)
    }
    const filter = defaultFilter
    const satisfyCallback = (nd, from, parentMap) => {
      if (!nd) {
        return
      }

      const matchedSanitizerTags = []
      matchedSanitizerTags.push(...matchedSanitizerTagsForAllTrace)

      const parentNdList = []
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
        const matchedFlowSanitizerTags = SanitizerChecker.findMatchedSanitizerTag(flowSanitizers, parentNd._tags)
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
}

module.exports = SanitizerChecker
