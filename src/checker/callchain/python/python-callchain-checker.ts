import type { CallInfo } from '../../../engine/analyzer/common/call-args'

const _ = require('lodash')
const QidUnifyUtil = require('../../../util/qid-unify-util')
const CallchainChecker = require('../callchain-checker')
const { matchSinkAtFuncCall, matchRegex } = require('../../taint/common-kit/sink-util')
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
const { loadPythonDefaultRule } = require('../../taint/python/python-taint-abstract-checker')

/**
 * Python callchain checker
 * Only detects sink matches and outputs call chains without checking for taint
 */
class PythonCallchainChecker extends CallchainChecker {
  entryPoints: any[]

  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'callchain_python')
    this.entryPoints = []
  }

  /**
   * starter trigger - 完全复制 PythonTaintChecker 的实现
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
  }

  /**
   * prepare entrypoint - 完全复制 PythonTaintChecker 的逻辑
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
      valFuncs = _.uniqBy(valFuncs, (value: any) => value.ast?.fdef)

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
  }

  /**
   * FunctionCall trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { fclos, callInfo } = info
    this.checkByNameMatch(node, fclos, callInfo, state)
    this.checkByFieldMatch(node, fclos, callInfo, state)
  }

  /**
   * check if sink matches by name
   * @param node
   * @param fclos
   * @param callInfo
   * @param state
   */
  checkByNameMatch(node: any, fclos: any, callInfo: CallInfo | undefined, state: any) {
    if (fclos === undefined) {
      return
    }
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink

    if (!rules || !callInfo) return
    let rule = matchSinkAtFuncCall(node, fclos, rules, callInfo)
    rule = rule.length > 0 ? rule[0] : null

    if (rule) {
      this.findArgsAndAddNewFinding(node, callInfo, fclos, rule, state)
    }
  }

  /**
   *
   * @param node
   * @param fclos
   * @param callInfo
   * @param scope
   * @param state
   */
  checkByFieldMatch(node: any, fclos: any, callInfo: CallInfo | undefined, state: any) {
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (_.isEmpty(rules)) {
      return
    }
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
          this.findArgsAndAddNewFinding(node, callInfo, fclos, rule, state)
          return true
        }
      } else {
        if (!rule.fregex) {
          return false
        }
        if (callFull.type === 'MemberAccess' && matchRegex(rule.fregex, fclos.qid)) {
          this.findArgsAndAddNewFinding(node, callInfo, fclos, rule, state)
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
    if (typeof fclos?.sid !== 'undefined' && typeof fclos?.qid === 'undefined' && typeof fclos?._this === 'undefined') {
      const index = fclos?.sid.indexOf('>.')
      const result = index !== -1 ? fclos?.sid.substring(index + 2) : fclos?.sid
      return QidUnifyUtil.removeParenthesesFromString(result)
    }
    if (typeof fclos?.qid !== 'undefined' && typeof fclos.qid === 'string') {
      const index = fclos.qid.indexOf('>.')
      const result = index !== -1 ? fclos?.qid.substring(index + 2) : fclos?.qid
      return QidUnifyUtil.removeParenthesesFromString(QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(result))
    }
    if (!(fclos === fclos?._this)) {
      return this.getObj(fclos._this)
    }
    if (typeof fclos?.sid === 'string') {
      const index = fclos?.sid.indexOf('>.')
      const result = index !== -1 ? fclos?.sid.substring(index + 2) : fclos?.sid
      if (result) {
        return QidUnifyUtil.removeParenthesesFromString(QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(result))
      }
    }
  }

}

module.exports = PythonCallchainChecker
