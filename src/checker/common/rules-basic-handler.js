const _ = require('lodash')
const config = require('../../config')
const FileUtil = require('../../util/file-util')
const { handleException } = require('../../engine/analyzer/common/exception-handler')
const logger = require('../../util/logger')(__filename)

let rulesMap = new Map()
let rules
let preprocessReady = false

/**
 *
 * @param ruleConfigPath
 */
function getRules(ruleConfigPath) {
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
    rules = {}
  }
  return rules
}

/**
 *
 * @param argvalues
 * @param fclos
 * @param rule
 */
function prepareArgs(argvalues, fclos, rule) {
  let { args } = rule
  let res = argvalues.concat()
  args = args.map((item) => {
    if (item !== '*') {
      return parseInt(item)
    }
    return item
  })
  if (!args.some((v) => v === '*')) {
    args = args.filter((v) => typeof v === 'number')
    res = argvalues.filter((value, index) => {
      return args.indexOf(index) !== -1
    })
  }

  // check whether receiver is tainted
  if (args.some((v) => v === -1)) {
    res.push(fclos.getThis())
  }
  return res
}

/**
 *
 * @param ruleConfigPath
 */
function initRulesMap(ruleConfigPath) {
  const localRules = getRules(ruleConfigPath)
  if (localRules && localRules.Rules) {
    rulesMap = new Map()
    for (const rule of localRules.Rules) {
      rulesMap[rule.type] = rule
    }
  }
}

/**
 *
 */
function initRules() {
  if (config.ruleConfigFile && config.ruleConfigFile !== '') {
    rules = FileUtil.loadJSONfile(FileUtil.getAbsolutePath(config.ruleConfigFile))
    initRulesMap(config.ruleConfigFile)
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
function matchField(node, marray, i) {
  /**
   *
   * @param el
   * @param name
   */
  function matchPrefix(el, name) {
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
function splitAndPrefix(input) {
  // 首先，使用split方法以点（.）为分隔符分割字符串
  const parts = input.split('.')

  // 然后，使用map方法转换数组的每个元素，为除了第一个元素外的所有元素添加前缀"."
  return parts.map((part, index) =>
    index !== 0 && index !== parts.length - 1 ? `.${part}(` : index === 0 ? `${part}.` : `.${part}`
  )
}

/**
 *
 * @param fsig
 * @param qid
 */
function matchPackageValueSink(fsig, qid) {
  const funcs = splitAndPrefix(fsig)
  if (qid && typeof qid === 'string') {
    return funcs.every((func) => qid.includes(func))
  }
  return false
}

/**
 *
 * @param i
 */
function setPreprocessReady(i) {
  preprocessReady = i
}

/**
 *
 */
function getPreprocessReady() {
  return preprocessReady
}

/**
 *
 * @param type
 * @param node
 * @param argNode
 */
function getRule(type, node, argNode) {
  let rule = rulesMap[type]
  if (!rule) rule = {}
  rule = _.clone(rule)
  rule.node = node
  rule.argNode = argNode
  rule.line = node.loc.start.line
  return rule
}

/**
 *
 * @type {{getRule: (function(*, *): *), compileAttackTrace: *, introduceTaint: introduceTaint}}
 */
module.exports = {
  getRule,
  getRules,
  initRules,
  matchField,
  setPreprocessReady,
  getPreprocessReady,
  initRulesMap,
  prepareArgs,
  matchPackageValueSink,
}
