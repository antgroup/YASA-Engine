import type { EntryPoint } from '../../../engine/analyzer/common/entrypoint'

const _ = require('lodash')
const completeEntryPoint = require('../common-kit/entry-points-util')
const config = require('../../../config')
const Checker = require('../../common/checker')

const processedBuiltInRegistry = new Set<string>()
const cobraCommandQid = /github\.com\/spf13\/cobra\.Command<instance_.*?>/
const preAction: string[] = ['PreRun', 'PreRunE']
const postAction: string[] = ['RunE', 'Run']

/**
 * cobra.Command bulitIn checker
 * 为第三方库方法cobra.command做建模，添加entryPoints
 */
class cobraCommandChecker extends Checker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager: any) {
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
  ifIgnoreEntryPoint(fClos: any): boolean {
    if (!fClos.ast.fdef?.loc) return true
    // todo：this.func{call this.f1()}，this.f1依赖于this的符号值，但注册this.func时，目前的hash无法反映不同this符号值的区别，如alarm_center/pkg/app/app.go的#173行
    const hash = JSON.stringify(fClos.ast.fdef.loc)
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
  triggerAtVariableDeclaration(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const { initVal } = info
    if (config.entryPointMode === 'ONLY_CUSTOM') return
    if (!cobraCommandQid.test(initVal?.qid) || !initVal.members || initVal.members.size === 0) return
    const initField = initVal.value

    const preEntryPoints: EntryPoint[] = []
    const postEntryPoints: EntryPoint[] = []

    const processActions = (actions: string[], targetEntryPoints: EntryPoint[]) => {
      actions.forEach((action: string) => {
        if (initField.hasOwnProperty(action) && initField[action]?.vtype === 'fclos') {
          const ep = initField[action]
          if (this.ifIgnoreEntryPoint(ep)) return
          targetEntryPoints.push(completeEntryPoint(ep, true))
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
  triggerAtAssignment(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const { lvalue, rvalue } = info
    if (config.entryPointMode === 'ONLY_CUSTOM') {
      return // 不路由自采集
    }
    if (!lvalue?.qid || rvalue?.vtype !== 'fclos') {
      return
    }
    if (!cobraCommandQid.test(lvalue.qid) || ![...preAction, ...postAction].includes(lvalue.sid)) {
      return
    }
    if (this.ifIgnoreEntryPoint(rvalue)) {
      return
    }
    analyzer.entryPoints.push(completeEntryPoint(rvalue, true))
  }

  /**
   * 每次运行完main后清空hash
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtSymbolInterpretOfEntryPointAfter(analyzer: any, scope: any, node: any, state: any, info: any): void {
    if (info?.entryPoint.functionName === 'main') processedBuiltInRegistry.clear()
  }
}

module.exports = cobraCommandChecker
