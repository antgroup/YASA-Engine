const _ = require('lodash')
const { sync } = require('fast-glob')
const commonUtil = require('../../../util/common-util')
const config = require('../../../config')

const done = new Set()
const syncOnceDoQid = 'sync.Once<instance>.Do'

const CheckerId = 'sync.Once.Do-builtIn'

/**
 * sync.Once.Do bulitIn checker
 * 为Go内置库方法sync.Once.Do做建模，执行且只执行一次传给Do方法的funcDef
 */
class syncOnceDoChecker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager) {
    this.entryPoints = []
    this.sourceScope = {
      complete: false,
      value: [],
    }
    this.resultManager = resultManager
    commonUtil.initSourceScope(this.sourceScope)
  }

  /**
   * @returns {string}
   * @constructor
   */
  static GetCheckerId() {
    return CheckerId
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer, scope, node, state, info) {
    const { fclos, argvalues } = info
    if (fclos._qid !== syncOnceDoQid) return
    const hash = JSON.stringify(node.loc)
    if (done.has(hash)) return
    done.add(hash)
    if (argvalues.length !== 1 && argvalues[0].vtype !== 'fclos') return

    const fDef = node.arguments[0]
    const fClos = argvalues[0]
    analyzer.processAndCallFuncDef(scope, fDef, fClos, state)
  }
}

module.exports = syncOnceDoChecker
