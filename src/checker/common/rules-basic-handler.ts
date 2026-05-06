import type { TaintFinding } from '../../engine/analyzer/common/common-types'
import {
  getLegacyArgValues,
  getCallArgsFromInfo,
  getBoundCallFromInfo,
  type CallInfo,
} from '../../engine/analyzer/common/call-args'
import type { Precondition } from './value/precondition'

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

/** 全局 precondition 存储，按 id 索引 */
let preconditionMap: Map<string, Precondition> | undefined

function normalizeTraceStrategy(strategy: any): string | undefined {
  if (strategy === 'folded') return 'callstack-only'
  if (strategy === 'callstack-only' || strategy === 'full') return strategy
  return undefined
}

/**
 *
 * @param ruleConfigPath
 */
function getRules(ruleConfigPath?: string): any[] {
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
      throw new Error(`Failed to parse ruleConfig JSON: ${ruleConfigPath || config.ruleConfigFile}`)
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
export function matchField(node: any, marray: string[], i: number): boolean {
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

  /**
   * CallExpression 分支：链式调用中段匹配
   * callee 是 MemberAccess 时，匹配方法名后 i===0 即成功（根对象任意），否则递归 callee.object
   * callee 是 Identifier 时，匹配名称并要求 i===0
   * @param el 当前待匹配的 fsig 段
   * @param callNode CallExpression 节点
   * @param segments fsig 段数组
   * @param idx 当前段索引
   * @returns {boolean} 是否匹配
   */
  function matchCallExpression(el: string, callNode: any, segments: string[], idx: number): boolean {
    const { callee } = callNode
    if (callee?.type === 'MemberAccess') {
      if (!matchPrefix(el, callee.property?.name)) return false
      if (idx === 0) return true
      return matchField(callee.object, segments, idx - 1)
    }
    if (callee?.type === 'Identifier') {
      return matchPrefix(el, callee.name) && idx === 0
    }
    return false
  }

  /**
   * NewExpression 分支：构造器调用
   * `new` 本身不占 fsig 段，直接把 callee（类名 Identifier 或 FQN MemberAccess）透传给 matchField
   * 语义：fsig "Foo" 匹配 `new Foo(x)` 里的 Foo；fsig "java.io.File" 匹配 `new java.io.File(x)`
   * @param el 当前待匹配的 fsig 段（由被调用方读取，本函数不消费）
   * @param newNode NewExpression 节点
   * @param segments fsig 段数组
   * @param idx 当前段索引（透传，不 -1）
   * @returns {boolean} 是否匹配
   */
  function matchNewExpression(el: string, newNode: any, segments: string[], idx: number): boolean {
    return matchField(newNode.callee, segments, idx)
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
    case 'CallExpression': {
      return matchCallExpression(el, node, marray, i)
    }
    case 'NewExpression': {
      return matchNewExpression(el, node, marray, i)
    }
    default:
      return false
  }
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
 * 从所有规则中加载 preconditions 配置，构建全局索引
 */
function loadAndStoreAllPreconditions(): void {
  if (preconditionMap) {
    return
  }
  preconditionMap = new Map()
  if (Array.isArray(getRules()) && getRules().length > 0) {
    for (const rule of getRules()) {
      if (Array.isArray(rule.preconditions)) {
        for (const precondition of rule.preconditions) {
          if (precondition.id) {
            preconditionMap.set(precondition.id, precondition as Precondition)
          }
        }
      }
    }
  }
}

/**
 * 根据 id 列表查找 precondition 定义
 */
function findPreconditionByIds(ids: string[]): Precondition[] {
  const result: Precondition[] = []
  if (!ids || ids.length === 0) {
    return result
  }
  if (!preconditionMap) {
    loadAndStoreAllPreconditions()
  }
  if (!preconditionMap) {
    return result
  }
  for (const id of ids) {
    const p = preconditionMap.get(id)
    if (p) {
      result.push(p)
    }
  }
  return result
}

/**
 * 获取所有已加载的 preconditions
 */
function findAllPreconditions(): Precondition[] {
  if (!preconditionMap) {
    loadAndStoreAllPreconditions()
  }
  if (!preconditionMap) {
    return []
  }
  return Array.from(preconditionMap.values())
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
  loadAndStoreAllPreconditions,
  findPreconditionByIds,
  findAllPreconditions,
}
