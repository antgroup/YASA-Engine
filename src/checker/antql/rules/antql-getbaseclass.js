const LocationUtil = require('../util/location-util')
const QidUnifyUtil = require('../util/qid-unify-util')
const Config = require('../../../config')
const Checker = require('../../common/checker')
const InteractiveOutputStrategy = require('../../common/output/interactive-output-strategy')

/**
 *
 */
class AntqlGetBaseClass extends Checker {
  /**
   *
   * @param mng
   */
  constructor(mng) {
    super(mng, 'antql_getbaseclass')
    this.mng = mng
    this.status = false
    this.output = []
    this.symbolMap = new Map()
    this.classToBaseMap = new Map()
  }

  /**
   * 配置输出策略
   */
  getStrategyId() {
    return [InteractiveOutputStrategy.outputStrategyId]
  }

  /**
   * 处理输入，0 = functioncall
   * @param args
   */
  handleInput(args) {
    // {
    //    command:"getsubclass"
    //    arguments:["flask.views.View"]
    // }
    if (args.length !== 1) {
      console.error('args 不合法')
      return
    }
    this.input = args[0]
    this.status = true
  }

  /**
   * 处理输出
   * @param success
   * @param message
   * @param body
   */
  handleOutput() {
    this.status = false
    const result = this.classToBaseMap.get(this.input)
    const finding = {
      output: result,
    }
    this.resultManager.newFinding(finding, InteractiveOutputStrategy.outputStrategyId)
  }

  /**
   * 更新基类的类型，记录全类名
   * @param analyzer
   * @param node
   * @param res
   * @param scope
   * @param state
   * @param info
   */
  triggerAtEndOfNode(analyzer, scope, node, state, info) {
    if (node?.type === 'ClassDefinition') {
      // 获取基类
      const superSymbol = info?.val?.super
      if (superSymbol && (superSymbol?.vtype === 'object' || superSymbol?.vtype === 'class')) {
        const superClassId = QidUnifyUtil.unify(superSymbol)
        const classId = QidUnifyUtil.unify(info?.val)

        const nodeLoc = LocationUtil.convertUastLocationToString(node.loc, Config.prefixPath)

        // 记录class和基类，key为全限定名
        this.classToBaseMap.set(classId, superClassId)

        // 记录每个class的位置信息
        this.symbolMap.set(classId, nodeLoc)
      }
    }
  }
}

module.exports = AntqlGetBaseClass
