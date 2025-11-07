import { handleException } from '../../../engine/analyzer/common/exception-handler'

const _ = require('lodash')
const PythonTaintAbstractChecker = require('./python-taint-abstract-checker')
const CommonUtil = require('../../../util/common-util')
const {
  findPythonFcEntryPointAndSource,
} = require('../../../engine/analyzer/python/common/entrypoint-collector/python-entrypoint')
const Constant = require('../../../util/constant')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
const AstUtil = require('../../../util/ast-util')
const Config = require('../../../config')
const FileUtil = require('../../../util/file-util')
const { extractRelativePath } = require('../../../util/file-util')
const logger = require('../../../util/logger')(__filename)

const TAINT_TAG_NAME_PYTHON = 'PYTHON_INPUT'

/**
 *
 */
class PythonTaintChecker extends PythonTaintAbstractChecker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_python_input_inner')
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
    this.addSourceTagForSourceScope(TAINT_TAG_NAME_PYTHON, this.sourceScope.value)
    this.addSourceTagForcheckerRuleConfigContent(TAINT_TAG_NAME_PYTHON, this.checkerRuleConfigContent)
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
        entryPoint.filePath = file?.ast?.loc?.sourcefile
        entryPoint.attribute = fileEntryPoint.attribute
        entryPoint.packageName = undefined
        entryPoint.entryPointSymVal = file
        this.entryPoints.push(entryPoint)
      }
    }

    CommonUtil.initSourceScopeByTaintSourceWithLoc(this.sourceScope, this.checkerRuleConfigContent.sources?.TaintSource)
  }

  /**
   *
   */
  loadPythonDefaultRule() {
    let pythonDefaultRule
    try {
      const rulePath = FileUtil.getAbsolutePath('./resource/python/python-default-rule.json')
      pythonDefaultRule = FileUtil.loadJSONfile(rulePath)
    } catch (e) {
      handleException(e, 'Error occurred in load python default rule', 'Error occurred in load python default rule')
    }
    return pythonDefaultRule
  }
}

module.exports = PythonTaintChecker
