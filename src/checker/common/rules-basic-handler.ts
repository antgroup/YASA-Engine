import type { TaintFinding } from '../../engine/analyzer/common/common-types'

const _ = require('lodash')
const config = require('../../config')
const FileUtil = require('../../util/file-util')
const { handleException } = require('../../engine/analyzer/common/exception-handler')
const logger = require('../../util/logger')(__filename)

interface Rule {
  args?: (string | number)[]
  [key: string]: any
}

let rules: any[]
let preprocessReady: boolean = false

/**
 *
 * @param ruleConfigPath
 */
function getRules(ruleConfigPath?: string): any[] {
  // 如果传入了 ruleConfigPath，或者 config.ruleConfigFile 已设置但 rules 未加载，则重新加载
  const currentRuleConfigFile = ruleConfigPath || config.ruleConfigFile
  if (!rules || (currentRuleConfigFile && !rules)) {
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
 * @param argvalues
 * @param fclos
 * @param rule
 */
function prepareArgs(argvalues: any[], fclos: any, rule: Rule): any[] {
  let { args } = rule
  let res = argvalues.concat()
  args = (args || []).map((item: string | number) => {
    if (item !== '*') {
      return parseInt(String(item))
    }
    return item
  })
  if (!args.some((v: string | number) => v === '*')) {
    args = args.filter((v: string | number) => typeof v === 'number')
    res = argvalues.filter((value: any, index: number) => {
      return (args as number[]).indexOf(index) !== -1
    })
  }

  // check whether receiver is tainted
  if (args.some((v: string | number) => v === -1)) {
    res.push(fclos.getThis())
  }
  return res
}

/**
 *
 */
function initRules(): void {
  const configPath = require.resolve('../../config')
  logger.info(`rules-basic-handler [CONFIG] Loaded from: ${configPath}`)

  if (config.ruleConfigFile && config.ruleConfigFile !== '') {
    rules = FileUtil.loadJSONfile(FileUtil.getAbsolutePath(config.ruleConfigFile))
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
    line: node.loc.start.line,
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
  matchPackageValueSink,
  getFinding,
}
