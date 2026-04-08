import { getLegacyArgValues, type CallInfo } from '../../../engine/analyzer/common/call-args'

const Checker = require('../../common/checker')

const done: Set<string> = new Set()
const syncOnceDoQidRegex: RegExp = /sync\.Once<instance_.*?>\.Do/

interface TriggerInfo {
  fclos: any
  callInfo: CallInfo | undefined
  [key: string]: any
}

/**
 * sync.Once.Do bulitIn checker
 * 为Go内置库方法sync.Once.Do做建模，执行且只执行一次传给Do方法的funcDef
 */
class syncOnceDoChecker extends Checker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'sync.Once.Do-builtIn')
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: TriggerInfo): void {
    const { fclos, callInfo } = info
    if (!syncOnceDoQidRegex.test(fclos.qid)) return
    const hash: string = JSON.stringify(node.loc)
    if (done.has(hash)) return
    done.add(hash)
    const argvalues = getLegacyArgValues(callInfo)
    if (argvalues.length !== 1 || argvalues[0].vtype !== 'fclos') return

    const fDef = node.arguments[0]
    const fClos = argvalues[0]
    analyzer.processAndCallFuncDef(scope, fDef, fClos, state)
  }
}

module.exports = syncOnceDoChecker
