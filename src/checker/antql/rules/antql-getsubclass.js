const LocationUtil = require('../util/location-util')
const Checker = require('../../common/checker')
const Config = require('../../../config')
const InteractiveOutputStrategy = require('../../common/output/interactive-output-strategy')

/**
 *
 */
class AntqlGetSubClass extends Checker {
  /**
   *
   * @param mng
   */
  constructor(mng) {
    super(mng, 'antql_getsubclass')
    this.mng = mng
    this.status = false
    this.output = []
    this.symbolMap = new Map()
    this.classToBaseMap = new Map() // 记录继承链
    this.baseToSubClassMap = new Map()
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
    if (args.length !== 2) {
      console.error('args 不合法')
      return
    }
    this.input = args[0]
    this.output = []
    this.indirect = args[1] === 'true'
    this.status = true
  }

  /**
   * 获取所有子类（直接+间接），返回全限定名数组
   * @param baseClassName
   * @returns {any[]}
   */
  getAllSubClasses(baseClassName) {
    const result = new Set()
    const visited = new Set()

    const dfs = (base) => {
      if (visited.has(base)) return
      visited.add(base)

      const subClasses = this.baseToSubClassMap.get(base) || []
      for (const sub of subClasses) {
        if (!result.has(sub)) {
          result.add(sub)
          dfs(sub)
        }
      }
    }

    dfs(baseClassName)
    return Array.from(result).join(',')
  }

  /**
   * 处理输出
   * @param success
   * @param message
   * @param body
   */
  handleOutput(success, message, body) {
    this.status = false

    const finding = {
      output: '',
    }
    if (this.indirect) {
      finding.output = this.getAllSubClasses(this.input)
    } else if (this.baseToSubClassMap.has(this.input)) {
      finding.output = this.baseToSubClassMap.get(this.input)
    }
    this.resultManager.newFinding(finding, InteractiveOutputStrategy.outputStrategyId)
  }

  /**
   *
   * @param analyzer
   * @param node
   * @param scope
   * @param state
   * @param info
   */
  triggerAtEndOfNode(analyzer, scope, node, state, info) {
    if (node?.type === 'ClassDefinition') {
      // 获取基类
      const superSymbol = info?.val?.super
      if (superSymbol) {
        let superClassId = superSymbol?.qid
        let classId = info?.val?.qid
        // 将"/"替换成"."
        superClassId = superClassId?.replace(/^\//, '').replace(/\//g, '.')
        superClassId = superClassId?.replace('syslib_from.', '')
        classId = classId?.replace(/^\//, '').replace(/\//g, '.')

        const nodeLoc = LocationUtil.convertUastLocationToString(node.loc, Config.prefixPath)

        // 记录class和基类，key为全限定名
        this.classToBaseMap.set(classId, superClassId)

        // 记录基类和class，key为全限定名
        if (!this.baseToSubClassMap.has(superClassId)) {
          this.baseToSubClassMap.set(superClassId, [])
        }
        if (!this.baseToSubClassMap.get(superClassId).includes(classId)) {
          this.baseToSubClassMap.get(superClassId).push(classId)
        }

        // 记录每个class的位置信息
        this.symbolMap.set(classId, nodeLoc)
      }
    }
  }
}

module.exports = AntqlGetSubClass
