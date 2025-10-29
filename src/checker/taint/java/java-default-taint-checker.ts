const _ = require('lodash')
const JavaTaintAbstractChecker = require('./java-taint-abstract-checker')
const Config = require('../../../config')
const logger = require('../../../util/logger')(__filename)
const CommonUtil = require('../../../util/common-util')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
const Constant = require('../../../util/constant')
const Loader = require('../../../util/loader')
const {
  valueUtil: {
    ValueUtil: { Scoped },
  },
} = require('../../../engine/analyzer/common')
const MainEntryPoint = require('../../../engine/analyzer/java/common/entrypoint-collector/java-default-entrypoint')
const FullCallGraphFileEntryPoint = require('../../common/full-callgraph-file-entrypoint')
const springEntryPoint = require('../../../engine/analyzer/java/spring/entrypoint-collector/spring-default-entrypoint')

/**
 * Java taint flow checker
 */
class JavaDefaultTaintChecker extends JavaTaintAbstractChecker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_java_input')
    this.entryPoints = []
  }

  /**
   * set entry points for Java application
   * @param analyzer
   * @param topScope
   */
  prepareEntryPoints(analyzer: any, topScope: any) {
    const { entrypoints: ruleConfigEntryPoints, sources: ruleConfigSources } = this.checkerRuleConfigContent
    if (Config.entryPointMode !== 'ONLY_CUSTOM') {
      logger.info('YASA will collect Entrypoint and Source')

      const selfCollectEntryPoints: any[] = []
      const selfCollectTaintSource: any[] = []
      const { selfCollectMainEntryPoints, selfCollectMainTaintSource } = MainEntryPoint.getJavaMainEntryPointAndSource(
        topScope.packageManager
      )
      selfCollectEntryPoints.push(...selfCollectMainEntryPoints)
      selfCollectTaintSource.push(...selfCollectMainTaintSource)

      const { selfCollectSpringEntryPoints, selfCollectSpringTaintSource } =
        springEntryPoint.getSpringEntryPointAndSource(topScope.packageManager)
      selfCollectEntryPoints.push(...selfCollectSpringEntryPoints)
      selfCollectTaintSource.push(...selfCollectSpringTaintSource)

      if (!_.isEmpty(selfCollectTaintSource)) {
        this.checkerRuleConfigContent.sources = this.checkerRuleConfigContent.sources || {}
        this.checkerRuleConfigContent.sources.TaintSource = this.checkerRuleConfigContent.sources.TaintSource || []
        this.checkerRuleConfigContent.sources.TaintSource = Array.isArray(
          this.checkerRuleConfigContent.sources.TaintSource
        )
          ? this.checkerRuleConfigContent.sources.TaintSource
          : [this.checkerRuleConfigContent.sources.TaintSource]
        this.checkerRuleConfigContent.sources.TaintSource.push(...selfCollectTaintSource)
        CommonUtil.initSourceScopeByTaintSourceWithLoc(
          this.sourceScope,
          this.checkerRuleConfigContent.sources.TaintSource
        )
      }
      if (!_.isEmpty(selfCollectEntryPoints)) {
        selfCollectEntryPoints.forEach((main: any) => {
          if (main) {
            const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
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

      FullCallGraphFileEntryPoint.makeFullCallGraph(analyzer)
      const fullCallGraphEntrypoint = FullCallGraphFileEntryPoint.getAllEntryPointsUsingCallGraph(
        analyzer.ainfo?.callgraph
      )
      const fullFileEntrypoint = FullCallGraphFileEntryPoint.getAllFileEntryPointsUsingFileManager(analyzer.fileManager)
      this.entryPoints.push(...fullCallGraphEntrypoint)
      this.entryPoints.push(...fullFileEntrypoint)
    }

    if (!_.isEmpty(ruleConfigEntryPoints) && Config.entryPointMode !== 'SELF_COLLECT') {
      for (const entrypoint of ruleConfigEntryPoints) {
        let targetPackage = entrypoint.packageName
        if (targetPackage === null || targetPackage === undefined) {
          continue
        }
        targetPackage = targetPackage.startsWith('.') ? targetPackage.slice(1) : targetPackage
        const arr = Loader.getPackageNameProperties(targetPackage)
        let packageManagerT = topScope.packageManager
        arr.forEach((path: any) => {
          packageManagerT = packageManagerT?.field[path]
        })
        if (!packageManagerT || packageManagerT.vtype === 'undefine') {
          continue
        }

        const func = entrypoint.functionName
        const valExport = packageManagerT
        const entryPointSymVal = CommonUtil.getFclosFromScope(valExport, func)
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

        const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
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

module.exports = JavaDefaultTaintChecker
