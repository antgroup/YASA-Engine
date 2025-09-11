const _ = require('lodash')
const commonUtil = require('../../../util/common-util')
const { completeEntryPoint } = require('./entry-points-util')
const config = require('../../../config')
const Checker = require('../../common/checker')

const processedBuiltInRegistry = new Set()
const cobraCommandQid = 'github.com/spf13/cobra.Command<instance>'
const preAction = ['PreRun', 'PreRunE']
const postAction = ['RunE', 'Run']

/**
 * cobra.Command bulitIn checker
 * 为第三方库方法cobra.command做建模，添加entryPoints
 */
class cobraCommandChecker extends Checker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager) {
    super(resultManager, 'cobra.Command-builtIn')
    this.entryPoints = []
    this.sourceScope = {
      complete: false,
      value: [],
    }
    this.resultManager = resultManager
  }

  /**
   *
   * @param fClos
   */
  ifIgnoreEntryPoint(fClos) {
    if (!fClos.fdef?.loc) return true
    // todo：this.func{call this.f1()}，this.f1依赖于this的符号值，但注册this.func时，目前的hash无法反映不同this符号值的区别，如alarm_center/pkg/app/app.go的#173行
    const hash = JSON.stringify(fClos.fdef.loc)
    if (processedBuiltInRegistry.has(hash)) return true
    processedBuiltInRegistry.add(hash)
    return false
  }

  /**
   *
   * @param analyzer
   * @param node
   * @param scope
   * @param state
   * @param info
   */
  triggerAtVariableDeclaration(analyzer, scope, node, state, info) {
    const { initVal } = info
    if (config.entryPointMode === 'ONLY_CUSTOM') return
    if (initVal?._qid !== cobraCommandQid || _.isEmpty(initVal.field)) return
    const initField = initVal.field

    const preEntryPoints = []
    const postEntryPoints = []

    const processActions = (actions, targetEntryPoints) => {
      actions.forEach((action) => {
        if (initField.hasOwnProperty(action) && initField[action]?.vtype === 'fclos') {
          const ep = initField[action]
          if (this.ifIgnoreEntryPoint(ep)) return
          targetEntryPoints.push(completeEntryPoint(ep))
        }
      })
    }
    processActions(preAction, preEntryPoints)
    processActions(postAction, postEntryPoints)
    analyzer.entryPoints.push(...preEntryPoints, ...postEntryPoints)
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtAssignment(analyzer, scope, node, state, info) {
    const { lvalue, rvalue } = info
    if (config.entryPointMode === 'ONLY_CUSTOM') return // 不路由自采集
    if (!lvalue?._qid || rvalue?.vtype !== 'fclos') return
    if (!lvalue._qid.startsWith(cobraCommandQid) || ![...preAction, ...postAction].includes(lvalue._sid)) return
    if (this.ifIgnoreEntryPoint(rvalue)) return
    analyzer.entryPoints.push(completeEntryPoint(rvalue))
  }

  /**
   * 每次运行完main后清空hash
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtSymbolInterpretOfEntryPointAfter(analyzer, scope, node, state, info) {
    if (info?.entryPoint.functionName === 'main') processedBuiltInRegistry.clear()
  }
}

module.exports = cobraCommandChecker
