const _ = require('lodash')
const loader = require('../../../util/loader')
const commonUtil = require('../../../util/common-util')
const springEntryPoint = require('../../../engine/analyzer/java/spring/entrypoint-collector/spring-default-entrypoint')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
const constValue = require('../../../util/constant')
const {
  valueUtil: {
    ValueUtil: { Scoped },
  },
} = require('../../../engine/analyzer/common')
const config = require('../../../config')
const logger = require('../../../util/logger')(__filename)
const JavaTaintAbstractChecker = require('./java-taint-abstract-checker')

/**
 * Java taint flow checker
 */
class JavaTaintChecker extends JavaTaintAbstractChecker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager) {
    super(resultManager, 'taint_flow_java_input_inner')
    this.entryPoints = []
  }

  /**
   * set entry points for Java application
   * @param analyzer
   * @param topScope
   */
  prepareEntryPoints(analyzer, topScope) {
    const { entrypoints: ruleConfigEntryPoints, sources: ruleConfigSources } = this.checkerRuleConfigContent
    if (config.entryPointMode !== 'ONLY_CUSTOM') {
      logger.info('YASA will collect Entrypoint and Source')
      const { selfCollectSpringEntryPoints, selfCollectSpringTaintSource } =
        springEntryPoint.getSpringEntryPointAndSource(topScope.packageManager)

      if (!_.isEmpty(selfCollectSpringTaintSource)) {
        this.checkerRuleConfigContent.sources = this.checkerRuleConfigContent.sources || {}
        this.checkerRuleConfigContent.sources.TaintSource = this.checkerRuleConfigContent.sources.TaintSource || []
        this.checkerRuleConfigContent.sources.TaintSource = Array.isArray(
          this.checkerRuleConfigContent.sources.TaintSource
        )
          ? this.checkerRuleConfigContent.sources.TaintSource
          : [this.checkerRuleConfigContent.sources.TaintSource]
        this.checkerRuleConfigContent.sources.TaintSource.push(...selfCollectSpringTaintSource)
        commonUtil.initSourceScopeByTaintSourceWithLoc(
          this.sourceScope,
          this.checkerRuleConfigContent.sources.TaintSource
        )
      }
      if (!_.isEmpty(selfCollectSpringEntryPoints)) {
        selfCollectSpringEntryPoints.forEach((main) => {
          if (main) {
            const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
            entryPoint.scopeVal = main.parent
            entryPoint.argValues = []
            entryPoint.entryPointSymVal = main
            entryPoint.filePath = main.filePath
            entryPoint.functionName = main.functionName
            entryPoint.attribute = main.attribute
            entryPoint.funcReceiverType = main.funcReceiverType
            this.entryPoints.push(entryPoint)
          }
        })
      }
    }

    if (!_.isEmpty(ruleConfigEntryPoints) && config.entryPointMode !== 'SELF_COLLECT') {
      for (const entrypoint of ruleConfigEntryPoints) {
        let targetPackage = entrypoint.packageName
        if (targetPackage === null || targetPackage === undefined) {
          continue
        }
        targetPackage = targetPackage.startsWith('.') ? targetPackage.slice(1) : targetPackage
        const arr = loader.getPackageNameProperties(targetPackage)
        let packageManagerT = topScope.packageManager
        arr.forEach((path) => {
          packageManagerT = packageManagerT?.field[path]
        })
        if (!packageManagerT || packageManagerT.vtype === 'undefine') {
          continue
        }

        const func = entrypoint.functionName
        const valExport = packageManagerT
        const entryPointSymVal = commonUtil.getFclosFromScope(valExport, func)
        if (entryPointSymVal?.vtype !== 'fclos') {
          continue
        }

        const scopeVal = Scoped({
          vtype: 'scope',
          _sid: 'mock',
          _id: 'mock',
          field: {},
          parent: null,
        })

        const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
        entryPoint.scopeVal = scopeVal
        entryPoint.argValues = []
        entryPoint.functionName = entrypoint.functionName
        entryPoint.filePath = entrypoint.filePath
        entryPoint.attribute = entrypoint.attribute
        entryPoint.packageName = entrypoint.packageName
        entryPoint.entryPointSymVal = entryPointSymVal
        this.entryPoints.push(entryPoint)
      }
    }
  }
}

module.exports = JavaTaintChecker
