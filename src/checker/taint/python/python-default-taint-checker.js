const _ = require('lodash')
const IntroduceTaint = require('../common-kit/source-util')
const Rules = require('../../common/rules-basic-handler')
const commonUtil = require('../../../util/common-util')
const {
  findPythonFcEntryPointAndSource,
} = require('../../../engine/analyzer/python/common/entrypoint-collector/python-entrypoint')
const constValue = require('../../../util/constant')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
const astUtil = require('../../../util/ast-util')
const SanitizerChecker = require('../../sanitizer/sanitizer-checker')
const { matchSinkAtFuncCall } = require('../common-kit/sink-util')
const config = require('../../../config')
const FileUtil = require('../../../util/file-util')
const { extractRelativePath } = require('../../../util/file-util')
const varUtil = require('../../../util/variable-util')
const { initRules } = require('../../common/rules-basic-handler')
const logger = require('../../../util/logger')(__filename)

const CheckerId = 'default_taint_flow_python_input'
const TARGET_RULES_KIND = 'PYTHON_INPUT'
const TAINT_TAG_NAME = 'PYTHON_INPUT'

/**
 *
 */
class PythonTaintChecker {
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
    initRules()
    commonUtil.initSourceScope(this.sourceScope)
  }

  /**
   * get checkerId
   */
  static GetCheckerId() {
    return CheckerId
  }

  /**
   * trigger at start of analyze
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtStartOfAnalyze(analyzer, scope, node, state, info) {
    const { moduleManager, fileManager } = analyzer
    this.prepareEntryPoints(analyzer, config.maindir, moduleManager, fileManager)
    analyzer.entryPoints.push(...this.entryPoints)
  }

  /**
   * prepare entrypoint
   * @param analyzer
   * @param dir
   * @param moduleManager
   * @param fileManager
   */
  prepareEntryPoints(analyzer, dir, moduleManager, fileManager) {
    const funCallEntryPoints = []
    const { RouterPath: routers } = Rules.getRules() || {}

    if (config.entryPointMode !== 'ONLY_CUSTOM') {
      const pythonDefaultRule = this.loadPythonDefaultRule()
      if (pythonDefaultRule?.TaintSource) {
        Rules.getRules().TaintSource = Rules.getRules().TaintSource || []
        Rules.getRules().TaintSource.push(...pythonDefaultRule.TaintSource)
      }
      const { pyFcEntryPointArray, pyFcEntryPointSourceArray } = findPythonFcEntryPointAndSource(dir, fileManager)
      if (pyFcEntryPointArray) {
        funCallEntryPoints.push(...pyFcEntryPointArray)
      }
      if (pyFcEntryPointSourceArray) {
        if (Array.isArray(Rules.getRules().TaintSource)) {
          Rules.getRules().TaintSource.push(...pyFcEntryPointSourceArray)
        } else {
          Rules.getRules().TaintSource = pyFcEntryPointSourceArray
        }
      }
    }
    if (config.entryPointMode !== 'SELF_COLLECT' && !_.isEmpty(routers)) {
      for (const router of routers) {
        const routerEntryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
        routerEntryPoint.filePath = router.routerFile
        routerEntryPoint.functionName = router.routerFunc
        routerEntryPoint.attribute = router.routerAttribute
        funCallEntryPoints.push(routerEntryPoint)
      }
    }

    for (const funCallEntryPoint of funCallEntryPoints) {
      let valFuncs = astUtil.satisfy(
        moduleManager,
        (n) =>
          n.vtype === 'fclos' &&
          extractRelativePath(n?.ast?.loc?.sourcefile, dir) === funCallEntryPoint.filePath &&
          n?.ast?.id.name === funCallEntryPoint.functionName,
        (node, prop) => prop === 'field',
        null,
        true
      )
      if (_.isEmpty(valFuncs)) {
        logger.info('match entryPoint fail')
        continue
      }
      if (Array.isArray(valFuncs)) {
        valFuncs = _.uniqBy(valFuncs, (value) => value.fdef)
      } else {
        valFuncs = [valFuncs]
      }

      for (const valFunc of valFuncs) {
        const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
        entryPoint.filePath = funCallEntryPoint.filePath
        entryPoint.functionName = funCallEntryPoint.functionName
        entryPoint.attribute = funCallEntryPoint.attribute
        entryPoint.entryPointSymVal = valFunc
        entryPoint.scopeVal = valFunc.parent
        this.entryPoints.push(entryPoint)
      }
    }

    // 使用callgraph边界+file作为entrypoint
    const fullCallGraphFileEntryPoint = require('../../common/full-callgraph-file-entrypoint')
    if (config.entryPointMode !== 'ONLY_CUSTOM') {
      fullCallGraphFileEntryPoint.makeFullCallGraph(analyzer)
      const fullCallGraphEntrypoint = fullCallGraphFileEntryPoint.getAllEntryPointsUsingCallGraph(
        analyzer.ainfo?.callgraph
      )
      const fullFileEntrypoint = fullCallGraphFileEntryPoint.getAllFileEntryPointsUsingFileManager(analyzer.fileManager)
      this.entryPoints.push(...fullCallGraphEntrypoint)
      this.entryPoints.push(...fullFileEntrypoint)
    }

    commonUtil.initSourceScopeByTaintSourceWithLoc(this.sourceScope)
  }

  /**
   * trigger at identifier
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtIdentifier(analyzer, scope, node, state, info) {
    IntroduceTaint.introduceTaintAtIdentifier(node, info.res, this.sourceScope.value)
  }

  /**
   * trigger before function call
   * @param analyzer
   * @param node
   * @param scope
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer, scope, node, state, info) {
    const { fclos, argvalues } = info
    IntroduceTaint.introduceFuncArgTaintByRuleConfig(fclos?.object, node, argvalues)

    this.checkByNameMatch(node, fclos, argvalues)
  }

  /**
   * FunctionCallAfter trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallAfter(analyzer, scope, node, state, info) {
    const { fclos, ret } = info
    IntroduceTaint.introduceTaintAtFuncCallReturnValue(fclos, node, ret)
  }

  /**
   * check sink by name
   * @param node
   * @param fclos
   * @param argvalues
   * @returns {boolean}
   */
  checkByNameMatch(node, fclos, argvalues) {
    const rules = this.loadFuncCallTaintSinkRules()
    if (!rules) return
    const rule = matchSinkAtFuncCall(node, fclos, rules).find((v) => v.kind === TARGET_RULES_KIND)

    if (rule) {
      const args = Rules.prepareArgs(argvalues, fclos, rule)
      const sanitizers = SanitizerChecker.findSanitizerByIds(rule.sanitizerIds)
      const ndResultWithMatchedSanitizerTagsArray = SanitizerChecker.findTagAndMatchedSanitizer(
        node,
        fclos,
        args,
        null,
        TAINT_TAG_NAME,
        true,
        sanitizers
      )
      if (ndResultWithMatchedSanitizerTagsArray) {
        for (const ndResultWithMatchedSanitizerTags of ndResultWithMatchedSanitizerTagsArray) {
          const { nd } = ndResultWithMatchedSanitizerTags
          const { matchedSanitizerTags } = ndResultWithMatchedSanitizerTags
          let ruleName = rule.fsig
          if (typeof rule.attribute !== 'undefined') {
            ruleName += `\nSINK Attribute: ${rule.attribute}`
          }
          const finding = Rules.getRule(CheckerId, node)
          this.resultManager.addNewFinding(nd, node, fclos, TAINT_TAG_NAME, finding, ruleName, matchedSanitizerTags)
        }
        return true
      }
    }
  }

  /**
   * load sink
   * @returns {*}
   */
  loadFuncCallTaintSinkRules() {
    let rules = Rules.getRules()?.FuncCallTaintSink
    if (_.isEmpty(rules)) {
      return
    }
    rules = _.clone(rules)
    rules = rules.filter((v) => v.kind === TARGET_RULES_KIND)
    return rules
  }

  /**
   * load python default rule
   */
  loadPythonDefaultRule() {
    let pythonDefaultRule
    try {
      const rulePath = FileUtil.getAbsolutePath('./resource/python/python-default-rule.json')
      pythonDefaultRule = FileUtil.loadJSONfile(rulePath)
    } catch (e) {}
    return pythonDefaultRule
  }
}

module.exports = PythonTaintChecker
