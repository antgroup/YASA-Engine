import type { TaintFinding } from '../../engine/analyzer/common/common-types'
import {
  getLegacyArgValues,
  getCallArgsFromInfo,
  getBoundCallFromInfo,
  type CallInfo,
} from '../../engine/analyzer/common/call-args'

const _ = require('lodash')
const config = require('../../config')
const FileUtil = require('../../util/file-util')
const { handleException } = require('../../engine/analyzer/common/exception-handler')
const logger = require('../../util/logger')(__filename)

interface Rule {
  selectors?: Array<{ type?: string; index?: number | '*'; name?: string }>
  args?: (string | number)[]
  positions?: (string | number)[]
  paramNames?: string[]
  keywordNames?: string[]
  includeReceiver?: boolean
  [key: string]: any
}

/**
 * 将 rule 中的多种选择器格式统一为 { type, index?, name? } 数组
 */
function normalizeSelectors(
  rule: Rule
): Array<{ type: 'position' | 'keyword' | 'all'; index?: number; name?: string }> {
  const selectors: Array<{ type: 'position' | 'keyword' | 'all'; index?: number; name?: string }> = []

  if (Array.isArray(rule.selectors)) {
    for (const selector of rule.selectors) {
      if (selector?.type === 'position' && selector.index === '*') {
        selectors.push({ type: 'all' })
      } else if (selector?.type === 'position' && Number.isInteger(selector.index)) {
        selectors.push({ type: 'position', index: selector.index as number })
      } else if (selector?.type === 'keyword' && typeof selector.name === 'string' && selector.name !== '') {
        selectors.push({ type: 'keyword', name: selector.name })
      }
    }
  }

  const positions = Array.isArray(rule.positions) ? rule.positions : Array.isArray(rule.args) ? rule.args : []
  for (const item of positions) {
    if (item === '*') {
      selectors.push({ type: 'all' })
      continue
    }
    const parsed = parseInt(String(item), 10)
    if (!Number.isNaN(parsed)) {
      selectors.push({ type: 'position', index: parsed })
    }
  }

  if (Array.isArray(rule.keywordNames)) {
    for (const item of rule.keywordNames) {
      if (typeof item === 'string' && item !== '') {
        selectors.push({ type: 'keyword', name: item })
      }
    }
  }

  if (rule.includeReceiver === true) {
    selectors.push({ type: 'position', index: -1 })
  }

  return selectors
}

let rules: any[]
let preprocessReady: boolean = false

function normalizeTraceStrategy(strategy: any): string | undefined {
  if (strategy === 'folded') return 'callstack-only'
  if (strategy === 'callstack-only' || strategy === 'full') return strategy
  return undefined
}

/**
 *
 * @param ruleConfigPath
 */
function getRules(ruleConfigPath: string): any[] {
  if (!rules) {
    try {
      if (ruleConfigPath) {
        rules = FileUtil.loadJSONfile(ruleConfigPath)
      } else if (!_.isEmpty(config.ruleConfigFile)) {
        rules = FileUtil.loadJSONfile(FileUtil.getAbsolutePath(config.ruleConfigFile))
      }
    } catch (e) {
      handleException(
        e,
        `Error in rule-basic-handler.getRules: json in ruleConfig is not correct, path is ${ruleConfigPath || config.ruleConfigFile}`,
        `Error in rule-basic-handler.getRules: json in ruleConfig is not correct, path is ${ruleConfigPath || config.ruleConfigFile}`
      )
      process.exit(1)
    }
  }
  if (!rules) {
    rules = []
  }
  return rules
}

/**
 *
 * @param callInfo
 * @param fclos
 * @param rule
 */
function prepareArgs(callInfo: CallInfo | undefined, fclos: any, rule: Rule): any[] {
  const res: any[] = []
  const callArgs = getCallArgsFromInfo(callInfo)
  const boundCall = getBoundCallFromInfo(callInfo)
  const legacyArgvalues = getLegacyArgValues(callInfo)
  const selectors = normalizeSelectors(rule)
  const paramNames = Array.isArray(rule.paramNames) ? rule.paramNames.filter((item: string) => typeof item === 'string') : []
  const explicitArgs =
    callArgs?.args && Array.isArray(callArgs.args)
      ? callArgs.args
      : legacyArgvalues.map((value: any, index: number) => ({ index, value }))

  const appendResult = (value: any) => {
    if (typeof value === 'undefined') return
    if (!res.includes(value)) {
      res.push(value)
    }
  }

  for (const selector of selectors) {
    if (selector.type === 'all') {
      explicitArgs.forEach((arg: any) => appendResult(arg.value))
      continue
    }
    if (selector.type === 'position') {
      if (selector.index === -1) {
        appendResult(callArgs?.receiver || fclos?.getThisObj?.())
      } else if (typeof selector.index === 'number' && selector.index >= 0) {
        explicitArgs.filter((arg: any) => arg.index === selector.index).forEach((arg: any) => appendResult(arg.value))
      }
      continue
    }
    if (selector.type === 'keyword') {
      explicitArgs
        .filter((arg: any) => arg.name && arg.name === selector.name)
        .forEach((arg: any) => appendResult(arg.value))
    }
  }

  // 兼容路径：通过形参名匹配
  if (paramNames.length > 0 && boundCall?.params?.length) {
    boundCall.params
      .filter((param: any) => paramNames.includes(param.name) && param.provided)
      .forEach((param: any) => appendResult(param.value))
  }

  if (paramNames.includes('self') || paramNames.includes('cls')) {
    appendResult(callArgs?.receiver || fclos?.getThisObj?.())
  }

  return res
}

/**
 * prepare args by type
 * @param callInfo
 * @param fclos
 * @param rule
 */
function prepareArgsByType(callInfo: CallInfo | undefined, fclos: any, rule: Rule): any[] {
  const resultArray: any[] = []
  const argvalues = getLegacyArgValues(callInfo)

  if (!Array.isArray(argvalues) || !rule || !Array.isArray(rule.argTypes)) {
    return resultArray
  }
  const { argTypes } = rule
  for (const argvalue of argvalues) {
    if (!argvalue.rtype || !argvalue.rtype.definiteType || argvalue.rtype.vagueType) {
      continue
    }
    for (const argType of argTypes) {
      if (argvalue.rtype.definiteType.name === argType || argvalue.rtype.definiteType.name.endsWith(`.${argType}`)) {
        resultArray.push(argvalue)
        break
      }
    }
  }

  return resultArray
}

/**
 *
 */
function initRules(): void {
  if (config.ruleConfigFile && config.ruleConfigFile !== '') {
    rules = FileUtil.loadJSONfile(FileUtil.getAbsolutePath(config.ruleConfigFile))
    // Extract taint trace output strategy from ruleConfig
    if (Array.isArray(rules)) {
      for (const rule of rules) {
        const traceStrategy = normalizeTraceStrategy(rule.outputAtTaint?.traceStrategy)
        if (traceStrategy) {
          config.taintTraceOutputStrategy = traceStrategy
          break
        }
      }
    }
  } else {
    logger.info('Attention: no ruleConfig found')
  }
}

/**
 * match AST node with "xx.yy.zz..."
 * @param node
 * @param marray
 * @param i
 * @returns {boolean}
 */
function matchField(node: any, marray: string[], i: number): boolean {
  /**
   *
   * @param el
   * @param name
   */
  function matchPrefix(el: string, name: string): boolean {
    if (name && el && el.endsWith('*')) {
      try {
        return name.startsWith(el.substring(0, el.length - 1))
      } catch (e) {
        return false
      }
    } else return name === el
  }

  const el = marray[i]
  if (el === '**') return true
  switch (node.type) {
    case 'MemberAccess': {
      if (!matchPrefix(el, node.property.name)) return false
      return matchField(node.object, marray, i - 1)
    }
    case 'Identifier': {
      return matchPrefix(el, node.name) && i == 0 // ensure no prefix to be matched
    }
    case 'Literal': {
      return matchPrefix(el, node.value) && i == 0 // ensure no prefix to be matched
    }
    case 'ThisExpression': {
      return matchPrefix(el, 'this') && i === 0
    }
  }
  return false
}

/**
 *
 * @param input
 */
function splitAndPrefix(input: string): string[] {
  // 首先，使用split方法以点（.）为分隔符分割字符串
  const parts = input.split('.')

  // 然后，使用map方法转换数组的每个元素，为除了第一个元素外的所有元素添加前缀"."
  return parts.map((part: string, index: number) =>
    index !== 0 && index !== parts.length - 1 ? `.${part}(` : index === 0 ? `${part}.` : `.${part}`
  )
}

/**
 *
 * @param fsig
 * @param qid
 */
function matchPackageValueSink(fsig: string, qid: string): boolean {
  const funcs = splitAndPrefix(fsig)
  if (qid && typeof qid === 'string') {
    return funcs.every((func: string) => qid.includes(func))
  }
  return false
}

/**
 *
 * @param i
 */
function setPreprocessReady(i: boolean): void {
  preprocessReady = i
}

/**
 *
 */
function getPreprocessReady(): boolean {
  return preprocessReady
}

/**
 *
 * @param type
 * @param description
 * @param node
 * @param argNode
 */
function getFinding(type: string, description: string, node: any, argNode?: any): TaintFinding {
  const finding: TaintFinding = {
    type,
    desc: description,
    node,
    line: node.loc.start?.line,
  }
  if (argNode) {
    finding.argNode = argNode
  }
  return finding
}

/**
 *
 * @type {{getRule: (function(*, *): *), compileAttackTrace: *, introduceTaint: introduceTaint}}
 */
module.exports = {
  getRules,
  initRules,
  matchField,
  setPreprocessReady,
  getPreprocessReady,
  prepareArgs,
  prepareArgsByType,
  matchPackageValueSink,
  getFinding,
}
