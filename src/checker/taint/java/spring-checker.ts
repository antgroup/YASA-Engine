const _ = require('lodash')
const Loader = require('../../../util/loader')
const CommonUtil = require('../../../util/common-util')
const SpringEntryPoint = require('../../../engine/analyzer/java/spring/entrypoint-collector/spring-default-entrypoint')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
const Constant = require('../../../util/constant')
const {
  valueUtil: {
    ValueUtil: { Scoped },
  },
} = require('../../../engine/analyzer/common')
const Config = require('../../../config')
const logger = require('../../../util/logger')(__filename)
const JavaTaintAbstractChecker = require('./java-taint-abstract-checker')

/**
 * Spring taint flow checker
 */
class SpringTaintChecker extends JavaTaintAbstractChecker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_spring_input')
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
      const { selfCollectSpringEntryPoints, selfCollectSpringTaintSource } =
        SpringEntryPoint.getSpringEntryPointAndSource(topScope.packageManager)

      if (!_.isEmpty(selfCollectSpringTaintSource)) {
        this.checkerRuleConfigContent.sources = this.checkerRuleConfigContent.sources || {}
        this.checkerRuleConfigContent.sources.TaintSource = this.checkerRuleConfigContent.sources.TaintSource || []
        this.checkerRuleConfigContent.sources.TaintSource = Array.isArray(
          this.checkerRuleConfigContent.sources.TaintSource
        )
          ? this.checkerRuleConfigContent.sources.TaintSource
          : [this.checkerRuleConfigContent.sources.TaintSource]
        this.checkerRuleConfigContent.sources.TaintSource.push(...selfCollectSpringTaintSource)
        CommonUtil.initSourceScopeByTaintSourceWithLoc(
          this.sourceScope,
          this.checkerRuleConfigContent.sources.TaintSource
        )
      }
      if (!_.isEmpty(selfCollectSpringEntryPoints)) {
        selfCollectSpringEntryPoints.forEach((main: any) => {
          if (main) {
            const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
            entryPoint.scopeVal = main.parent
            entryPoint.argValues = []
            entryPoint.entryPointSymVal = main
            entryPoint.filePath = main.filePath
            entryPoint.functionName = main.functionName
            entryPoint.attribute = main.attribute
            entryPoint.funcReceiverType = main.funcReceiverType
            entryPoint.urlPath = this.extractUrlPath(main.ast._meta)
            this.entryPoints.push(entryPoint)
          }
        })
      }
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

  /**
   * extract URL path from meta info
   * @param meta
   * @returns URL path
   */
  extractUrlPath(meta: any) {
    if (!meta || !meta['modifiers']) {
      return ''
    }

    const defaultSpringAnnotations = [ // copy from spring-default-entrypoint.ts
      'RequestMapping',
      'GetMapping',
      'PostMapping',
      'PutMapping',
      'DeleteMapping',
      'PatchMapping',
      'Path',
    ]

    for (const modifier of meta['modifiers']) {
      for (const annotation of defaultSpringAnnotations) {
        if (modifier.includes(annotation)) {
          const contentMatch = modifier.match(/\((.*)\)/)
          if (!contentMatch) {
            return ''
          }

          const content = contentMatch[1].trim();
          const explicitMatch = content.match(/(?:value|path)\s*=\s*["']([^"']+)["']/)
          if (explicitMatch) {
            return explicitMatch[1]
          }

          const implicitMatch = content.match(/^\s*["']([^"']+)["']/)
          if (implicitMatch) {
            return implicitMatch[1]
          }
        }
      }
    }
  }
}

module.exports = SpringTaintChecker