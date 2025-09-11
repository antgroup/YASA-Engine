const _ = require('lodash')
const commonUtil = require('../../../util/common-util')
const goEntryPoint = require('../../../engine/analyzer/golang/common/entrypoint-collector/go-default-entrypoint')
const { completeEntryPoint } = require('./entry-points-util')
const config = require('../../../config')
const Checker = require('../../common/checker')

/**
 * Go taint_flow checker
 */
class MainEntrypointCollectChecker extends Checker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager) {
    super(resultManager, 'go-main-entryPoints-collection')
    this.entryPoints = []
  }

  /**
   * starter trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtStartOfAnalyze(analyzer, scope, node, state, info) {
    const { topScope } = analyzer
    this.prepareEntryPoints(topScope)
    analyzer.mainEntryPoints = this.entryPoints
  }

  /**
   * 添加main entryPoints
   * @param topScope
   */
  prepareEntryPoints(topScope) {
    if (config.entryPointMode === 'ONLY_CUSTOM') return
    // 添加main入口
    let mainEntryPoints = goEntryPoint.getMainEntryPoints(topScope.packageManager)
    if (_.isEmpty(mainEntryPoints)) {
      return
    }
    if (Array.isArray(mainEntryPoints)) {
      mainEntryPoints = _.uniqBy(mainEntryPoints, (value) => value.fdef)
    } else {
      mainEntryPoints = [mainEntryPoints]
    }
    mainEntryPoints.forEach((main) => {
      if (main) {
        const entryPoint = completeEntryPoint(main)
        this.entryPoints.push(entryPoint)
      }
    })
  }
}

module.exports = MainEntrypointCollectChecker
