import type { CallInfo } from '../../../engine/analyzer/common/call-args'

const _ = require('lodash')
const Config = require('../../../config')
const BasicRuleHandler = require('../../common/rules-basic-handler')
const AstUtil = require('../../../util/ast-util')
const FileUtil = require('../../../util/file-util')
const EntryPoint = require('../../../engine/analyzer/common/entrypoint')
const Constant = require('../../../util/constant')
const IntroduceTaint = require('../common-kit/source-util')
const { matchSinkAtFuncCallWithCalleeType } = require('../common-kit/sink-util')
const { getOrBuildCallInfo } = require('../common-kit/call-info-util')
const SanitizerChecker = require('../../sanitizer/sanitizer-checker')
const FullCallGraphFileEntryPoint = require('../../common/full-callgraph-file-entrypoint')
const CommonUtil = require('../../../util/common-util')
const TaintChecker = require('../taint-checker')
const {
  findSpartaEntryPoints,
} = require('../../../engine/analyzer/php/sparta/entrypoint-collector/sparta-default-entrypoint')
const {
  findSoaServiceEntryPoints,
} = require('../../../engine/analyzer/php/soa/entrypoint-collector/soa-service-entrypoint')
const {
  findCustomMvcControllerEntryPoints,
} = require('../../../engine/analyzer/php/custom/entrypoint-collector/custom-mvc-controller-entrypoint')
const {
  findCustomDataBucketEntryPoints,
} = require('../../../engine/analyzer/php/custom/entrypoint-collector/custom-databucket-entrypoint')
const TaintOutputStrategy = require('../../common/output/taint-output-strategy')
const entryPointConfig = require('../../../engine/analyzer/common/current-entrypoint')

const TAINT_TAG_NAME = 'PHP_INPUT'

/**
 * PHP 默认污点分析 checker，使用 CallGraph 边界 + 文件级 entrypoint
 */
class PhpDefaultTaintChecker extends TaintChecker {
  entryPoints: any[]

  /**
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_php_input')
    this.entryPoints = []
  }

  /**
   * 分析开始时加载 entrypoint 并标记 source scope
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any): void {
    this.prepareEntryPoints(analyzer)
    analyzer.mainEntryPoints = this.entryPoints
    this.addSourceTagForSourceScope(TAINT_TAG_NAME, this.sourceScope.value)
    this.addSourceTagForcheckerRuleConfigContent(TAINT_TAG_NAME, this.checkerRuleConfigContent)
    // PHP 超全局变量 source 需要带 loc 信息初始化
    CommonUtil.initSourceScopeByTaintSourceWithLoc(this.sourceScope, this.checkerRuleConfigContent.sources?.TaintSource)
  }

  /**
   * 准备 entrypoint：callGraph 边界 + 文件级 + ruleconfig 自定义
   * @param analyzer
   */
  prepareEntryPoints(analyzer: any): void {
    if (Config.entryPointMode === 'ONLY_CUSTOM') {
      this.prepareRuleConfigEntryPoints(analyzer)
      return
    }

    // 优先：Sparta 框架 Controller action entrypoint
    const spartaEntryPoints = findSpartaEntryPoints(analyzer, Config.maindirPrefix || Config.maindir)
    if (spartaEntryPoints.length > 0) {
      // 框架 entrypoints 需要解析 symVal，复用 ruleconfig entrypoint 的解析逻辑
      this.resolveFrameworkEntryPoints(analyzer, spartaEntryPoints)
    }

    // SOA Service entrypoint：类名以 Svc/Service 结尾的服务类方法
    // SOA collector 直接返回带 symVal 的完整 EntryPoint（PHP 类方法 fclos 不在 context.funcs 中）
    if (this.entryPoints.length === 0) {
      const soaEntryPoints = findSoaServiceEntryPoints(analyzer, Config.maindirPrefix || Config.maindir)
      if (soaEntryPoints.length > 0) {
        this.entryPoints.push(...soaEntryPoints)
      }
    }

    // 自定义 MVC 框架：基于类签名约定识别
    // - CustomMvcController：controllers/ 下 Controller 后缀/继承 + public + params>=1 action
    // - CustomDataBucket：通过 __call 转发的 DataBucket 后缀/继承 + public + params>=1
    // 两者合并 append（单个项目可能同时出现两类，例如既有 Controller 又有 DataBucket 子目录）
    if (this.entryPoints.length === 0) {
      const mvcEntryPoints = findCustomMvcControllerEntryPoints(analyzer, Config.maindirPrefix || Config.maindir)
      if (mvcEntryPoints.length > 0) {
        this.entryPoints.push(...mvcEntryPoints)
      }
      const dataBucketEntryPoints = findCustomDataBucketEntryPoints(analyzer, Config.maindirPrefix || Config.maindir)
      if (dataBucketEntryPoints.length > 0) {
        this.entryPoints.push(...dataBucketEntryPoints)
      }
    }

    // 兜底：callGraph 边界 + 文件级 entrypoint（仅在没有框架 entrypoint 时使用）
    // if (this.entryPoints.length === 0) {
    //   FullCallGraphFileEntryPoint.makeFullCallGraph(analyzer)
    //   const fullCallGraphEntrypoint = FullCallGraphFileEntryPoint.getAllEntryPointsUsingCallGraph(
    //     analyzer.ainfo?.callgraph,
    //     analyzer
    //   )
    //   this.entryPoints.push(...fullCallGraphEntrypoint)
    //
    //   const fullFileEntrypoint = FullCallGraphFileEntryPoint.getAllFileEntryPointsUsingFileManager(analyzer)
    //   this.entryPoints.push(...fullFileEntrypoint)
    // }

    // ruleconfig 中的自定义 entrypoint
    if (Config.entryPointMode !== 'SELF_COLLECT') {
      this.prepareRuleConfigEntryPoints(analyzer)
    }
  }

  /**
   * 加载 ruleconfig 中指定的 entrypoint
   * @param analyzer
   */
  prepareRuleConfigEntryPoints(analyzer: any): void {
    const { entrypoints: ruleConfigEntryPoints } = this.checkerRuleConfigContent
    if (_.isEmpty(ruleConfigEntryPoints)) return

    const { topScope } = analyzer
    for (const entrypoint of ruleConfigEntryPoints) {
      // PHP 函数是全局的，无包前缀，直接用函数名匹配
      const entryPointSymVal = AstUtil.satisfy(
        topScope.context.packages || topScope.context.funcs,
        (n: any) =>
          n.vtype === 'fclos' &&
          FileUtil.extractAfterSubstring(n?.ast?.node?.loc?.sourcefile, Config.maindirPrefix) === entrypoint.filePath &&
          n?.ast?.node?.id?.name === entrypoint.functionName,
        (node: any, prop: any) => prop === '_field',
        null,
        false
      )

      if (_.isEmpty(entryPointSymVal)) continue

      const symVals = Array.isArray(entryPointSymVal)
        ? _.uniqBy(entryPointSymVal, (value: any) => value.ast.fdef)
        : [entryPointSymVal]

      const ep = new EntryPoint(Constant.ENGIN_START_FUNCALL)
      ep.scopeVal = symVals[0].parent
      ep.argValues = []
      ep.functionName = entrypoint.functionName
      ep.filePath = entrypoint.filePath
      ep.attribute = entrypoint.attribute
      ep.packageName = undefined
      ep.entryPointSymVal = symVals[0]
      analyzer.ruleEntrypoints = analyzer.ruleEntrypoints || []
      analyzer.ruleEntrypoints.push(ep)
    }
  }

  /**
   * 解析框架 entrypoint 的 symVal（函数 scope value）
   * 框架 entrypoint collector 只收集 filePath + functionName 元数据，
   * 这里通过 AST 查找将其解析为完整的 entrypoint（带 scopeVal + entryPointSymVal）
   * @param analyzer
   * @param frameworkEntryPoints
   */
  resolveFrameworkEntryPoints(analyzer: any, frameworkEntryPoints: any[]): void {
    const { topScope } = analyzer
    for (const fep of frameworkEntryPoints) {
      const entryPointSymVal = AstUtil.satisfy(
        topScope.context.packages || topScope.context.funcs,
        (n: any) =>
          n.vtype === 'fclos' &&
          FileUtil.extractAfterSubstring(n?.ast?.node?.loc?.sourcefile, Config.maindirPrefix) === fep.filePath &&
          n?.ast?.node?.id?.name === fep.functionName,
        (n: any, prop: any) => prop === '_field',
        null,
        false
      )

      if (_.isEmpty(entryPointSymVal)) continue

      const symVals = Array.isArray(entryPointSymVal)
        ? _.uniqBy(entryPointSymVal, (value: any) => value.ast?.fdef)
        : [entryPointSymVal]

      const ep = new EntryPoint(Constant.ENGIN_START_FUNCALL)
      ep.scopeVal = symVals[0].parent
      ep.argValues = []
      ep.functionName = fep.functionName
      ep.filePath = fep.filePath
      ep.attribute = fep.attribute || 'SpartaHTTP'
      ep.entryPointSymVal = symVals[0]
      this.entryPoints.push(ep)
    }
  }

  /**
   * 函数调用前：匹配 sink，引入 FuncCallArgTaintSource
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const { fclos, callInfo } = info
    const calleeObject = fclos?.object
    this.checkByNameAndClassMatch(node, fclos, callInfo, scope, state)
    const funcCallArgTaintSource = this.checkerRuleConfigContent.sources?.FuncCallArgTaintSource
    IntroduceTaint.introduceFuncArgTaintByRuleConfig(calleeObject, node, callInfo, funcCallArgTaintSource)
  }

  /**
   * 函数调用后：处理返回值 source（如 file_get_contents 等）
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallAfter(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const { fclos, ret } = info
    const funcCallReturnValueTaintSource = this.checkerRuleConfigContent.sources?.FuncCallReturnValueTaintSource
    IntroduceTaint.introduceTaintAtFuncCallReturnValue(fclos, node, ret, funcCallReturnValueTaintSource)
  }

  /**
   * NewExpression 构造器调用后触发 sink 匹配，语义对齐 triggerAtFunctionCallBefore。
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtNewExprAfter(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const { fclos } = info
    const callInfo = getOrBuildCallInfo(info)
    this.checkByNameAndClassMatch(node, fclos, callInfo, scope, state)
  }

  /**
   * sink 匹配：按函数名和 calleeType 匹配
   * @param node
   * @param fclos
   * @param callInfo
   * @param scope
   * @param state
   */
  checkByNameAndClassMatch(
    node: any,
    fclos: any,
    callInfo: CallInfo | undefined,
    scope: any,
    state?: any
  ): boolean | undefined {
    if (fclos === undefined) return
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (!rules || !callInfo) return

    let rule = matchSinkAtFuncCallWithCalleeType(node, fclos, rules, scope, callInfo)
    rule = rule.length > 0 ? rule[0] : null
    if (!rule) return

    const args = BasicRuleHandler.prepareArgs(callInfo, fclos, rule)
    const sanitizers = SanitizerChecker.findSanitizerByIds((rule as any).sanitizerIds)
    const ndResultWithMatchedSanitizerTagsArray = SanitizerChecker.findTagAndMatchedSanitizer(
      node,
      fclos,
      args,
      scope,
      TAINT_TAG_NAME,
      true,
      sanitizers
    )

    if (!ndResultWithMatchedSanitizerTagsArray) return

    for (const ndResultWithMatchedSanitizerTags of ndResultWithMatchedSanitizerTagsArray) {
      const { nd, matchedSanitizerTags } = ndResultWithMatchedSanitizerTags
      let ruleName = (rule as any).fsig
      if (typeof (rule as any).attribute !== 'undefined') {
        const attrStr = Array.isArray((rule as any).attribute)
          ? (rule as any).attribute.join(',')
          : (rule as any).attribute
        ruleName += `\nSINK Attribute: ${attrStr}`
      }

      const taintFlowFinding = this.buildTaintFinding(
        this.getCheckerId(),
        this.desc,
        node,
        nd,
        fclos,
        TAINT_TAG_NAME,
        ruleName,
        matchedSanitizerTags,
        state?.callstack,
        state?.callsites
      )

      if (!TaintOutputStrategy.isNewFinding(this.resultManager, taintFlowFinding)) continue
      this.resultManager.newFinding(taintFlowFinding, TaintOutputStrategy.outputStrategyId)
    }
    return true
  }

  /**
   * Entrypoint 参数 taint 注入：所有 PHP entrypoint 的入参统一全部标 source
   * - SOAService / CustomDataBucket / CustomMvcController：所有参数都视为外部输入
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtSymbolInterpretOfEntryPointBefore(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const currentEntryPoint = entryPointConfig.getCurrentEntryPoint()
    const attr = currentEntryPoint?.attribute
    const TAINT_ATTRS = new Set(['SOAService', 'CustomDataBucket', 'CustomMvcController'])
    if (!TAINT_ATTRS.has(attr)) return
    const epSym = currentEntryPoint.entryPointSymVal
    const parameters = epSym?.ast?.fdef?.parameters
    if (!parameters) return
    for (const para of parameters) {
      // 使用 para.id（Identifier）而非 para（VariableDeclaration），避免 processInstruction 重建值
      const paramId = para.id || para
      const argv = analyzer.processInstruction(epSym, paramId, state)
      IntroduceTaint.markTaintSource(argv, { path: para, kind: TAINT_TAG_NAME })
    }
  }

  /**
   * Identifier 触发：标记超全局变量等 source
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtIdentifier(analyzer: any, scope: any, node: any, state: any, info: any): void {
    IntroduceTaint.introduceTaintAtIdentifierDirect(analyzer, scope, node, info.res, this.sourceScope.value)
  }
}

module.exports = PhpDefaultTaintChecker
