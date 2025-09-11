const Checker = require('../../common/checker')

const done = new Set()
const syncOnceDoQid = 'sync.Once<instance>.Do'

/**
 * sync.Once.Do bulitIn checker
 * 为Go内置库方法sync.Once.Do做建模，执行且只执行一次传给Do方法的funcDef
 */
class syncOnceDoChecker extends Checker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager) {
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
