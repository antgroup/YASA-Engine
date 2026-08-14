const _ = require('lodash')
const { PythonTaintAbstractChecker } = require('./python-taint-abstract-checker')
const CommonUtil = require('../../../util/common-util')
const { lodashCloneWithTag } = require('../../../util/clone-util')
const {
  findPythonFcEntryPointAndSource,
  buildFclosIndex,
  lookupFclos,
} = require('../../../engine/analyzer/python/common/entrypoint-collector/python-entrypoint')
const Constant = require('../../../util/constant')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint/entrypoint')
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
      const { pyFcEntryPointArray, pyFcEntryPointSourceArray, lifespanGlobalAssignments } = findPythonFcEntryPointAndSource(
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
      // 在模块作用域执行 lifespan 回调中的全局变量赋值，使类型正确解析
      if (Array.isArray(lifespanGlobalAssignments) && lifespanGlobalAssignments.length > 0) {
        for (const { filename, assignmentNode } of lifespanGlobalAssignments) {
          const modClos = moduleManager.members?.get(filename)
          if (!modClos) continue
          const savedEntryFclos = analyzer.entry_fclos
          const savedThisFClos = analyzer.thisFClos
          analyzer.entry_fclos = modClos
          analyzer.thisFClos = modClos
          try {
            const state = analyzer.initState(modClos)
            analyzer.processInstruction(modClos, assignmentNode, state)
          } catch (e) {
            // 赋值执行失败不阻塞分析
            logger.info(`lifespan global assignment failed for ${filename}`)
          }
          analyzer.entry_fclos = savedEntryFclos
          analyzer.thisFClos = savedThisFClos
        }
      }
    }
    if (Config.entryPointMode !== 'SELF_COLLECT' && !_.isEmpty(ruleConfigEntryPoints)) {
      for (const entrypoint of ruleConfigEntryPoints) {
        if (entrypoint.functionName) {
          const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
          entryPoint.filePath = entrypoint.filePath
          entryPoint.functionName = entrypoint.functionName
          entryPoint.attribute = entrypoint.attribute
          // 透传函数定义行号，用于精确匹配 overloaded 同名函数
          entryPoint.funcLocStart = entrypoint.funcLocStart
          entryPoint.funcLocEnd = entrypoint.funcLocEnd
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

    // 累加未匹配 EP 数，循环后聚合输出一行，避免逐条刷日志
    let unmatchedEntryPointCount = 0
    for (const funCallEntryPoint of funCallEntryPoints) {
      // 使用索引查找，O(1) 操作
      let valFuncs = lookupFclos(fclosIndex, funCallEntryPoint.filePath, funCallEntryPoint.functionName)

      if (_.isEmpty(valFuncs)) {
        unmatchedEntryPointCount++
        continue
      }

      // 去重，并过滤掉 ast.node 为 null 的 fclos（防止 executeSingleCall 崩溃）
      valFuncs = _.uniqBy(valFuncs, (value: any) => value.ast?.fdef)
      valFuncs = valFuncs.filter((value: any) => value?.ast?.node != null)

      for (const valFunc of valFuncs) {
        // 当 entrypoint 携带函数行号且 fclos 存在 overloaded 时，精确匹配对应的函数体
        const overloaded = valFunc.overloaded
        if (funCallEntryPoint.funcLocStart != null && overloaded != null && overloaded.length > 0) {
          // overloaded 可能是 AstRefList（无 find 方法），用 filter 查找行号匹配的函数体
          const matched = overloaded.filter(
            (ol: any) => ol.loc?.start?.line === funCallEntryPoint.funcLocStart
          )
          const matchedOverload = matched.length > 0 ? matched[0] : null
          // 也检查主函数体是否匹配
          const mainMatches = valFunc.ast?.node?.loc?.start?.line === funCallEntryPoint.funcLocStart
          if (matchedOverload) {
            // overloaded 列表中找到匹配，用匹配的函数体创建精确 entrypoint
            const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
            entryPoint.filePath = funCallEntryPoint.filePath
            entryPoint.functionName = funCallEntryPoint.functionName
            entryPoint.attribute = funCallEntryPoint.attribute
            entryPoint.skipDecorators = funCallEntryPoint.skipDecorators
            // 使用与 python-analyzer.ts symbolInterpret 相同的克隆模式
            const cloned = lodashCloneWithTag(valFunc)
            const clonedDef = _.clone(matchedOverload)
            cloned.ast.fdef = clonedDef
            cloned.ast = clonedDef
            cloned.overloaded = []
            entryPoint.entryPointSymVal = cloned
            this.entryPoints.push(entryPoint)
          } else if (mainMatches) {
            // 主函数体匹配，清空 overloaded 避免遍历其他同名函数
            const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
            entryPoint.filePath = funCallEntryPoint.filePath
            entryPoint.functionName = funCallEntryPoint.functionName
            entryPoint.attribute = funCallEntryPoint.attribute
            entryPoint.skipDecorators = funCallEntryPoint.skipDecorators
            const cloned = lodashCloneWithTag(valFunc)
            cloned.overloaded = []
            entryPoint.entryPointSymVal = cloned
            this.entryPoints.push(entryPoint)
          } else {
            // 行号不匹配任何函数体，回退到原有行为
            const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
            entryPoint.filePath = funCallEntryPoint.filePath
            entryPoint.functionName = funCallEntryPoint.functionName
            entryPoint.attribute = funCallEntryPoint.attribute
            entryPoint.skipDecorators = funCallEntryPoint.skipDecorators
            entryPoint.entryPointSymVal = valFunc
            this.entryPoints.push(entryPoint)
          }
        } else {
          // 无行号信息或无 overloaded，保持原有行为（向后兼容）
          const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
          entryPoint.filePath = funCallEntryPoint.filePath
          entryPoint.functionName = funCallEntryPoint.functionName
          entryPoint.attribute = funCallEntryPoint.attribute
          entryPoint.skipDecorators = funCallEntryPoint.skipDecorators
          entryPoint.entryPointSymVal = valFunc
          this.entryPoints.push(entryPoint)
        }
      }
    }
    if (unmatchedEntryPointCount > 0) {
      logger.info(`${unmatchedEntryPointCount} entrypoints unmatched`)
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
