const _ = require('lodash')
const IntroduceTaint = require('../common-kit/source-util')
const BasicRuleHandler = require('../../common/rules-basic-handler')
const CommonUtil = require('../../../util/common-util')
const {
  findPythonFcEntryPointAndSource,
} = require('../../../engine/analyzer/python/common/entrypoint-collector/python-entrypoint')
const Constant = require('../../../util/constant')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
const AstUtil = require('../../../util/ast-util')
const SanitizerChecker = require('../../sanitizer/sanitizer-checker')
const { matchSinkAtFuncCall, matchRegex } = require('../common-kit/sink-util')
const Config = require('../../../config')
const FileUtil = require('../../../util/file-util')
const { extractRelativePath } = require('../../../util/file-util')
const TaintChecker = require('../taint-checker')
const TaintOutputStrategy = require('../../common/output/taint-output-strategy')
const logger = require('../../../util/logger')(__filename)

const TAINT_TAG_NAME_PYTHON_DEFAULT = 'PYTHON_INPUT'

/**
 *
 */
class PythonDefaultTaintChecker extends TaintChecker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager: any) {
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
  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { moduleManager, fileManager } = analyzer
    this.prepareEntryPoints(analyzer, Config.maindir, moduleManager, fileManager)
    analyzer.entryPoints.push(...this.entryPoints)
    this.addSourceTagForSourceScope(TAINT_TAG_NAME_PYTHON_DEFAULT, this.sourceScope.value)
    this.addSourceTagForcheckerRuleConfigContent(TAINT_TAG_NAME_PYTHON_DEFAULT, this.checkerRuleConfigContent)
  }

  /**
   * prepare entrypoint
   * @param analyzer
   * @param dir
   * @param moduleManager
   * @param fileManager
   */
  prepareEntryPoints(analyzer: any, dir: any, moduleManager: any, fileManager: any) {
    const funCallEntryPoints: any[] = []
    const fileEntryPoints: any[] = []
    const { entrypoints: ruleConfigEntryPoints } = this.checkerRuleConfigContent

    if (Config.entryPointMode !== 'ONLY_CUSTOM') {
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

    if (Config.entryPointMode !== 'SELF_COLLECT' && !_.isEmpty(ruleConfigEntryPoints)) {
      for (const entrypoint of ruleConfigEntryPoints) {
        if (entrypoint.functionName) {
          const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
          entryPoint.filePath = entrypoint.filePath
          entryPoint.functionName = entrypoint.functionName
          entryPoint.attribute = entrypoint.attribute
          funCallEntryPoints.push(entryPoint)
        } else {
          const entryPoint = new EntryPoint(Constant.ENGIN_START_FILE_BEGIN)
          entryPoint.filePath = entrypoint.filePath
          entryPoint.attribute = entrypoint.attribute
          fileEntryPoints.push(entryPoint)
        }
      }
    }

    for (const funCallEntryPoint of funCallEntryPoints) {
      let valFuncs = AstUtil.satisfy(
        moduleManager,
        (n: any) =>
          n.vtype === 'fclos' &&
          extractRelativePath(n?.ast?.loc?.sourcefile, dir) === funCallEntryPoint.filePath &&
          n?.ast?.id?.name === funCallEntryPoint.functionName,
        (node: any, prop: any) => prop === 'field',
        null,
        true
      )
      if (_.isEmpty(valFuncs)) {
        logger.info('match entryPoint fail')
        continue
      }
      if (Array.isArray(valFuncs)) {
        valFuncs = _.uniqBy(valFuncs, (value: any) => value.fdef)
      } else {
        valFuncs = [valFuncs]
      }

      for (const valFunc of valFuncs) {
        const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
        entryPoint.filePath = funCallEntryPoint.filePath
        entryPoint.functionName = funCallEntryPoint.functionName
        entryPoint.attribute = funCallEntryPoint.attribute
        entryPoint.entryPointSymVal = valFunc
        entryPoint.scopeVal = valFunc.parent
        this.entryPoints.push(entryPoint)
      }
    }

    for (const fileEntryPoint of fileEntryPoints) {
      const fullFilePath = `${Config.maindir}${fileEntryPoint.filePath}`.replace('//', '/')
      const file = fileManager[fullFilePath]
      if (file?.ast?.type === 'CompileUnit') {
        const entryPoint = new EntryPoint(Constant.ENGIN_START_FILE_BEGIN)
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
    if (Config.entryPointMode !== 'ONLY_CUSTOM') {
      fullCallGraphFileEntryPoint.makeFullCallGraph(analyzer)
      const fullCallGraphEntrypoint = fullCallGraphFileEntryPoint.getAllEntryPointsUsingCallGraph(
        analyzer.ainfo?.callgraph
      )
      const fullFileEntrypoint = fullCallGraphFileEntryPoint.getAllFileEntryPointsUsingFileManager(analyzer.fileManager)
      this.entryPoints.push(...fullCallGraphEntrypoint)
      this.entryPoints.push(...fullFileEntrypoint)
    }

    CommonUtil.initSourceScopeByTaintSourceWithLoc(this.sourceScope, this.checkerRuleConfigContent.sources?.TaintSource)
  }

  /**
   * trigger at identifier
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtIdentifier(analyzer: any, scope: any, node: any, state: any, info: any) {
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
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { fclos, argvalues } = info
    const funcCallArgTaintSource = this.checkerRuleConfigContent.sources?.FuncCallArgTaintSource
    IntroduceTaint.introduceFuncArgTaintByRuleConfig(fclos?.object, node, argvalues, funcCallArgTaintSource)

    this.checkByNameMatch(node, fclos, argvalues)
    this.checkByFieldMatch(node, fclos, argvalues)
  }

  /**
   * FunctionCallAfter trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallAfter(analyzer: any, scope: any, node: any, state: any, info: any) {
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
  checkByNameMatch(node: any, fclos: any, argvalues: any) {
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (_.isEmpty(rules)) {
      return
    }
    let rule = matchSinkAtFuncCall(node, fclos, rules)
    rule = rule.length > 0 ? rule[0] : null

    if (rule) {
      this.findArgsAndAddNewFinding(node, argvalues, fclos, rule)
    }
  }

  /**
   * check sink by id
   * @param node
   * @param fclos
   * @param argvalues
   * @param scope
   */
  checkByFieldMatch(node: any, fclos: any, argvalues: any) {
    let rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (_.isEmpty(rules)) {
      return
    }
    rules = _.clone(rules)
    rules = rules.filter((v: any) => v.kind === TAINT_TAG_NAME_PYTHON_DEFAULT)
    if (!rules) return
    rules.some((rule: any): boolean => {
      if (typeof rule.fsig !== 'string') {
        return false
      }
      const callFull = this.getObj(fclos)
      if (typeof callFull === 'undefined') {
        return false
      }
      if (rule.fsig) {
        if (rule.fsig === callFull) {
          this.findArgsAndAddNewFinding(node, argvalues, fclos, rule)
          return true
        }
      } else {
        if (!rule.fregex) {
          return false
        }
        if (callFull.type === 'MemberAccess' && matchRegex(rule.fregex, fclos._qid)) {
          this.findArgsAndAddNewFinding(node, argvalues, fclos, rule)
          return true
        }
      }
      return false
    })
  }

  /**
   * get obj
   * @param fclos
   */
  getObj(fclos: any): any {
    if (
      typeof fclos?._sid !== 'undefined' &&
      typeof fclos?._qid === 'undefined' &&
      typeof fclos?._this === 'undefined'
    ) {
      const index = fclos?._sid.indexOf('>.')
      const result = index !== -1 ? fclos?._sid.substring(index + 2) : fclos?._sid
      return result.replace('<instance>', '').replace('()', '')
    }
    if (typeof fclos?._qid !== 'undefined') {
      const index = fclos._qid.indexOf('>.')
      const result = index !== -1 ? fclos?._qid.substring(index + 2) : fclos?._qid
      return result.replace('<instance>', '').replace('()', '')
    }
    if (!(fclos === fclos?._this)) {
      return this.getObj(fclos._this)
    }
    const index = fclos?._sid.indexOf('>.')
    const result = index !== -1 ? fclos?._sid.substring(index + 2) : fclos?._sid
    if (result) {
      return result.replace('<instance>', '').replace('()', '')
    }
  }

  /**
   *
   * @param node
   * @param argvalues
   * @param fclos
   * @param rule
   */
  findArgsAndAddNewFinding(node: any, argvalues: any, fclos: any, rule: any) {
    const args = BasicRuleHandler.prepareArgs(argvalues, fclos, rule)
    const sanitizers = SanitizerChecker.findSanitizerByIds(rule.sanitizerIds)
    const ndResultWithMatchedSanitizerTagsArray = SanitizerChecker.findTagAndMatchedSanitizer(
      node,
      fclos,
      args,
      null,
      TAINT_TAG_NAME_PYTHON_DEFAULT,
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
          TAINT_TAG_NAME_PYTHON_DEFAULT,
          ruleName,
          matchedSanitizerTags
        )
        if (!TaintOutputStrategy.isNewFinding(this.resultManager, taintFlowFinding)) continue
        this.resultManager.newFinding(taintFlowFinding, TaintOutputStrategy.outputStrategyId)
      }
      return true
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

module.exports = PythonDefaultTaintChecker
