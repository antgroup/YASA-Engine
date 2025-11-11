import type { EntryPoint } from '../../../engine/analyzer/common/entrypoint'

const _ = require('lodash')
const GoEntryPoint = require('../../../engine/analyzer/golang/common/entrypoint-collector/go-default-entrypoint')
const { completeEntryPoint } = require('../common-kit/entry-points-util')
const Config = require('../../../config')
const Checker = require('../../common/checker')

/**
 * Go taint_flow checker
 */
class MainEntrypointCollectChecker extends Checker {
  entryPoints: EntryPoint[]

  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager: any) {
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
  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const { topScope } = analyzer
    this.prepareEntryPoints(topScope)
    analyzer.mainEntryPoints = this.entryPoints
  }

  /**
   * 添加main entryPoints
   * @param topScope
   */
  prepareEntryPoints(topScope: any): void {
    if (Config.entryPointMode === 'ONLY_CUSTOM') return
    // 添加main入口
    let mainEntryPoints = GoEntryPoint.getMainEntryPoints(topScope.packageManager)
    if (_.isEmpty(mainEntryPoints)) {
      return
    }
    if (Array.isArray(mainEntryPoints)) {
      mainEntryPoints = _.uniqBy(mainEntryPoints, (value: EntryPoint) => value.fdef)
    } else {
      mainEntryPoints = [mainEntryPoints]
    }
    mainEntryPoints.forEach((main: EntryPoint) => {
      if (main) {
        const entryPoint = completeEntryPoint(main)
        this.entryPoints.push(entryPoint)
      }
    })
  }
}

module.exports = MainEntrypointCollectChecker
