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
const TaintChecker = require('../taint-checker')
const TaintOutputStrategy = require('../../common/output/taint-output-strategy')
const logger = require('../../../util/logger')(__filename)

const TAINT_TAG_NAME = 'PYTHON_INPUT'

/**
 *
 */
class PythonTaintChecker extends TaintChecker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager) {
    super(resultManager, 'taint_flow_python_input')
    this.entryPoints = []
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
    this.addSourceTagForSourceScope(TAINT_TAG_NAME, this.sourceScope.value)
    this.addSourceTagForcheckerRuleConfigContent(TAINT_TAG_NAME, this.checkerRuleConfigContent)
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
    const fileEntryPoints = []
    const { entrypoints: ruleConfigEntryPoints } = this.checkerRuleConfigContent

    if (config.entryPointMode !== 'ONLY_CUSTOM') {
      const pythonDefaultRule = this.loadPythonDefaultRule()
      if (pythonDefaultRule[0].checkerIds.includes(this.getCheckerId())) {
        this.checkerRuleConfigContent.sources = this.checkerRuleConfigContent.sources || {}
        this.checkerRuleConfigContent.sources.TaintSource = this.checkerRuleConfigContent.sources.TaintSource || []
        this.checkerRuleConfigContent.sources.TaintSource = Array.isArray(
          this.checkerRuleConfigContent.sources.TaintSource
        )
          ? this.checkerRuleConfigContent.sources.TaintSource
          : [this.checkerRuleConfigContent.sources.TaintSource]
        this.checkerRuleConfigContent.sources.TaintSource.push(...pythonDefaultRule[0].sources.TaintSource)
      }
      const { pyFcEntryPointArray, pyFcEntryPointSourceArray } = findPythonFcEntryPointAndSource(dir, fileManager)
      if (pyFcEntryPointArray) {
        funCallEntryPoints.push(...pyFcEntryPointArray)
      }
      if (pyFcEntryPointSourceArray) {
        this.checkerRuleConfigContent.sources = this.checkerRuleConfigContent.sources || {}
        this.checkerRuleConfigContent.sources.TaintSource = this.checkerRuleConfigContent.sources.TaintSource || []
        this.checkerRuleConfigContent.sources.TaintSource = Array.isArray(
          this.checkerRuleConfigContent.sources.TaintSource
        )
          ? this.checkerRuleConfigContent.sources.TaintSource
          : [this.checkerRuleConfigContent.sources.TaintSource]
        this.checkerRuleConfigContent.sources.TaintSource.push(...pyFcEntryPointSourceArray)
      }
    }

    if (config.entryPointMode !== 'SELF_COLLECT' && !_.isEmpty(ruleConfigEntryPoints)) {
      for (const entrypoint of ruleConfigEntryPoints) {
        if (entrypoint.functionName) {
          const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
          entryPoint.filePath = entrypoint.filePath
          entryPoint.functionName = entrypoint.functionName
          entryPoint.attribute = entrypoint.attribute
          funCallEntryPoints.push(entryPoint)
        } else {
          const entryPoint = new EntryPoint(constValue.ENGIN_START_FILE_BEGIN)
          entryPoint.filePath = entrypoint.filePath
          entryPoint.attribute = entrypoint.attribute
          fileEntryPoints.push(entryPoint)
        }
      }
    }

    for (const funCallEntryPoint of funCallEntryPoints) {
      let valFuncs = astUtil.satisfy(
        moduleManager,
        (n) =>
          n.vtype === 'fclos' &&
          extractRelativePath(n?.ast?.loc?.sourcefile, dir) === funCallEntryPoint.filePath &&
          n?.ast?.id?.name === funCallEntryPoint.functionName,
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

    for (const fileEntryPoint of fileEntryPoints) {
      const fullFilePath = `${config.maindir}${fileEntryPoint.filePath}`.replace('//', '/')
      const file = fileManager[fullFilePath]
      if (file?.ast?.type === 'CompileUnit') {
        const entryPoint = new EntryPoint(constValue.ENGIN_START_FILE_BEGIN)
        entryPoint.scopeVal = file
        entryPoint.argValues = undefined
        entryPoint.functionName = undefined
        entryPoint.filePath = file?.ast?.sourcefile || file?.ast?.loc?.sourcefile
        entryPoint.attribute = fileEntryPoint.attribute
        entryPoint.packageName = undefined
        entryPoint.entryPointSymVal = file
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

    commonUtil.initSourceScopeByTaintSourceWithLoc(this.sourceScope, this.checkerRuleConfigContent.sources?.TaintSource)
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
    const funcCallArgTaintSource = this.checkerRuleConfigContent.sources?.FuncCallArgTaintSource
    IntroduceTaint.introduceFuncArgTaintByRuleConfig(fclos?.object, node, argvalues, funcCallArgTaintSource)

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
    const funcCallReturnValueTaintSource = this.checkerRuleConfigContent.sources?.FuncCallReturnValueTaintSource

    IntroduceTaint.introduceTaintAtFuncCallReturnValue(fclos, node, ret, funcCallReturnValueTaintSource)
  }

  /**
   * check sink by name
   * @param node
   * @param fclos
   * @param argvalues
   * @returns {boolean}
   */
  checkByNameMatch(node, fclos, argvalues) {
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (_.isEmpty(rules)) {
      return
    }
    let rule = matchSinkAtFuncCall(node, fclos, rules)
    rule = rule.length > 0 ? rule[0] : null

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
          const taintFlowFinding = this.buildTaintFinding(
            this.getCheckerId(),
            this.desc,
            node,
            nd,
            fclos,
            TAINT_TAG_NAME,
            ruleName,
            matchedSanitizerTags
          )
          if (!TaintOutputStrategy.isNewFinding(this.resultManager, taintFlowFinding)) continue
          this.resultManager.newFinding(taintFlowFinding, TaintOutputStrategy.outputStrategyId)
        }
        return true
      }
    }
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
