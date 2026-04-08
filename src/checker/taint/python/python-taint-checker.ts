const _ = require('lodash')
const { PythonTaintAbstractChecker } = require('./python-taint-abstract-checker')
const CommonUtil = require('../../../util/common-util')
const {
  findPythonFcEntryPointAndSource,
  buildFclosIndex,
  lookupFclos,
} = require('../../../engine/analyzer/python/common/entrypoint-collector/python-entrypoint')
const Constant = require('../../../util/constant')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
const Config = require('../../../config')
const { extractRelativePath } = require('../../../util/file-util')
const logger = require('../../../util/logger')(__filename)
const { loadPythonDefaultRule } = require('./python-taint-abstract-checker')

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
    const moduleManager = analyzer.topScope.context.modules
    const fileManager = analyzer.topScope.context.files
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
      const pythonDefaultRule = loadPythonDefaultRule()
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
      const { pyFcEntryPointArray, pyFcEntryPointSourceArray } = findPythonFcEntryPointAndSource(
        dir,
        fileManager,
        analyzer
      )
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

    // 构建 fclos 索引，一次遍历替代多次查找
    const fclosIndex = buildFclosIndex(moduleManager, dir, extractRelativePath)

    for (const funCallEntryPoint of funCallEntryPoints) {
      // 使用索引查找，O(1) 操作
      let valFuncs = lookupFclos(fclosIndex, funCallEntryPoint.filePath, funCallEntryPoint.functionName)

      if (_.isEmpty(valFuncs)) {
        logger.info('match entryPoint fail')
        continue
      }

      // 去重
      valFuncs = _.uniqBy(valFuncs, (value: any) => value.ast.fdef)

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
      const fileUuid = fileManager[fullFilePath]
      const file = analyzer.symbolTable.get(fileUuid)
      if (file?.ast?.node?.type === 'CompileUnit') {
        const entryPoint = new EntryPoint(Constant.ENGIN_START_FILE_BEGIN)
        entryPoint.scopeVal = file
        entryPoint.argValues = undefined
        entryPoint.functionName = undefined
        entryPoint.filePath = file?.ast?.node?.loc?.sourcefile
        entryPoint.attribute = fileEntryPoint.attribute
        entryPoint.packageName = undefined
        entryPoint.entryPointSymVal = file
        this.entryPoints.push(entryPoint)
      }
    }

    CommonUtil.initSourceScopeByTaintSourceWithLoc(this.sourceScope, this.checkerRuleConfigContent.sources?.TaintSource)
  }
}

module.exports = PythonTaintChecker
