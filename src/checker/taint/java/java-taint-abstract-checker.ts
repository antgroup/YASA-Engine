import type { CallInfo } from '../../../engine/analyzer/common/call-args'
import type { Invocation } from '../../../resolver/common/value/invocation'

const QidUnifyUtil = require('../../../util/qid-unify-util')
const TaintCheckerJava = require('../taint-checker')
const IntroduceTaintJava = require('../common-kit/source-util')
const commonUtilJavaAbstract = require('../../../util/common-util')
const {
  matchSinkAtFuncCallWithCalleeType: matchSinkAtFuncCallWithCalleeTypeJava,
  checkInvocationMatchSink,
} = require('../common-kit/sink-util')
const RulesJava = require('../../common/rules-basic-handler')
const SanitizerCheckerJava = require('../../sanitizer/sanitizer-checker')
const TaintOutputStrategyJava = require('../../common/output/taint-output-strategy')

const Config = require('../../../config')
const logger = require('../../../util/logger')(__filename)

const TAINT_TAG_NAME_JAVA = 'JAVA_INPUT'

/**
 * java taint base checker
 */
class JavaTaintAbstractChecker extends TaintCheckerJava {
  /**
   * When the entrypoint resolves to an interface/abstract method with no body,
   * find implementation classes and return their overriding methods instead.
   * @param entryPointSymVal - the resolved entrypoint function closure
   * @param funcName - the function name to look for
   * @param analyzer - the analyzer instance with classMap and symbolTable
   * @returns array of resolved function closures (may contain multiple implementations)
   */
  resolveInterfaceEntryPoint(entryPointSymVal: any, funcName: string, analyzer: any): any[] {
    const parentScope = entryPointSymVal?.parent
    const isInterface = parentScope?.ast?.node?._meta?.isInterface
    const isAbstract = parentScope?.ast?.node?._meta?.isAbstract

    if (!(isInterface || isAbstract) || !analyzer?.classMap) {
      return [entryPointSymVal]
    }

    const parentQid = parentScope?.qid

    const implSymVals: any[] = []
    for (const [, classRef] of analyzer.classMap) {
      const classVal = analyzer.symbolTable?.get(classRef) ?? classRef
      if (!classVal || typeof classVal !== 'object' || classVal === parentScope) {
        continue
      }

      // Check all supers (both extends and implements) via the AST supers array,
      // because classVal.super only holds the last resolved super reference.
      const fdefSupers = classVal.ast?.fdef?.supers
      let isImpl = false
      if (Array.isArray(fdefSupers)) {
        for (const superId of fdefSupers) {
          if (!superId) continue
          const superName = superId.name ?? superId.id?.name
          if (superName && parentScope?.sid && superName === parentScope.sid) {
            isImpl = true
            break
          }
          if (parentQid && (superId.qid === parentQid || superId.logicalQid === parentQid)) {
            isImpl = true
            break
          }
        }
      }
      // Fallback: also check the runtime super chain for cases already resolved
      if (!isImpl) {
        let superRef = classVal.super
        while (superRef) {
          if (superRef === parentScope || (parentQid && superRef.qid === parentQid)) {
            isImpl = true
            break
          }
          superRef = superRef.super
        }
      }
      if (!isImpl) continue

      const implMethod = classVal.members?.get(funcName) ?? classVal.value?.[funcName]
      if (implMethod?.vtype === 'fclos' && !implMethod.inherited) {
        implSymVals.push(implMethod)
        logger.info(
          'Resolved interface entrypoint [%s.%s] to implementation [%s.%s]',
          parentScope?.sid,
          funcName,
          classVal?.sid,
          funcName
        )
      }
    }

    return implSymVals.length > 0 ? implSymVals : [entryPointSymVal]
  }

  /**
   * When entrypoint is resolved from interface to implementation, augment TaintSource
   * entries so that sources configured for the interface file also apply to the
   * implementation class file.
   * @param interfaceSymVal - the original interface method fclos
   * @param implSymVals - the resolved implementation method fclos array
   * @param funcName - the function name
   */
  augmentSourcesForInterfaceResolution(interfaceSymVal: any, implSymVals: any[], funcName: string): void {
    const taintSources = this.checkerRuleConfigContent.sources?.TaintSource
    if (!Array.isArray(taintSources) || taintSources.length === 0) return

    const interfacePath = this.normalizeAstSourceFilePath(interfaceSymVal?.ast?.node?.loc?.sourcefile)
    if (!interfacePath) return

    // Track full source identity so repeated interface resolution does not append the
    // same implementation source twice, while still allowing multiple distinct sources
    // inside the same function.
    const buildSourceKey = (source: any): string =>
      `${source.scopeFile}::${source.scopeFunc}::${source.path}::${source.kind}::${source.attribute || ''}`
    const existingKeys = new Set<string>(taintSources.map((s: any) => buildSourceKey(s)))

    for (const implSymVal of implSymVals) {
      const implPath = this.normalizeAstSourceFilePath(implSymVal?.ast?.node?.loc?.sourcefile)
      if (!implPath || implPath === interfacePath) continue

      const implAstNode = implSymVal?.ast?.node
      // locStart: use the first parameter's start line when available so that the
      // source scope covers the parameter list rather than the method keyword itself.
      // This matches how initSourceScopeByTaintSourceWithLoc computes effective ranges.
      const locStart = implAstNode?.parameters?.length > 0
        ? implAstNode.parameters[0].loc?.start?.line
        : implAstNode?.loc?.start?.line
      const locEnd = implAstNode?.loc?.end?.line

      const newSources: any[] = []
      for (const source of taintSources) {
        if (source.scopeFile === interfacePath && source.scopeFunc === funcName) {
          const key = buildSourceKey({ ...source, scopeFile: implPath })
          if (!existingKeys.has(key)) {
            newSources.push({ ...source, scopeFile: implPath })
            existingKeys.add(key)
          }
        }
      }

      if (newSources.length > 0) {
        taintSources.push(...newSources)
        for (const ns of newSources) {
          const scopeEntry = {
            path: ns.path,
            kind: ns.kind,
            scopeFile: ns.scopeFile,
            scopeFunc: ns.scopeFunc,
            attribute: ns.attribute,
            locStart,
            locEnd,
          }
          this.sourceScope.value.push(scopeEntry)
          this.sourceScope.fillLineValues.push(scopeEntry)
        }
        logger.info(
          'Augmented TaintSource for implementation [%s] (loc %s-%s) from interface [%s.%s]',
          implPath,
          locStart,
          locEnd,
          interfacePath,
          funcName
        )
      }
    }
  }

  /**
   * 将接口/抽象类 entrypoint 解析为实现类，并推入 this.entryPoints。
   * 两个子类（JavaTaintChecker / JavaDefaultTaintChecker）的 prepareEntryPoints
   * 共用此方法，避免重复代码。
   */
  resolveAndPushEntryPoint(entryPointSymVal: any, entrypoint: any, func: string, analyzer: any, Scoped: any, EntryPoint: any, Constant: any): void {
    const resolvedSymVals = this.resolveInterfaceEntryPoint(entryPointSymVal, func, analyzer)
    if (resolvedSymVals.length > 0 && resolvedSymVals[0] !== entryPointSymVal) {
      this.augmentSourcesForInterfaceResolution(entryPointSymVal, resolvedSymVals, func)
    }
    for (const resolvedSymVal of resolvedSymVals) {
      const scopeVal = new Scoped('', {
        vtype: 'scope',
        sid: 'mock',
        qid: 'mock',
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
      entryPoint.entryPointSymVal = resolvedSymVal
      this.entryPoints.push(entryPoint)
    }
  }

  /**
   * Normalize an AST sourcefile path to the format used by ruleconfig scopeFile.
   * @param astPath - the full path from ast.loc.sourcefile
   * @returns normalized relative path (e.g. "/app/biz/.../Foo.java") or null
   */
  normalizeAstSourceFilePath(astPath: string | undefined): string | null {
    if (!astPath) return null
    try {
      const prefixIdx = astPath.indexOf(Config.maindirPrefix)
      if (prefixIdx === -1) return null
      let relativePath = astPath.substring(prefixIdx + Config.maindirPrefix.length)
      const slashIdx = relativePath.indexOf('/')
      if (slashIdx === -1) return null
      relativePath = relativePath.substring(slashIdx)
      return relativePath
    } catch {
      return null
    }
  }

  /**
   * starter trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { topScope } = analyzer
    this.prepareEntryPoints(analyzer, topScope)
    analyzer.entryPoints.push(...this.entryPoints)
    this.addSourceTagForSourceScope(TAINT_TAG_NAME_JAVA, this.sourceScope.value)
    this.addSourceTagForcheckerRuleConfigContent(TAINT_TAG_NAME_JAVA, this.checkerRuleConfigContent)
  }

  /**
   * Identifier trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtIdentifier(analyzer: any, scope: any, node: any, state: any, info: any) {
    IntroduceTaintJava.introduceTaintAtIdentifier(analyzer, scope, node, info.res, this.sourceScope.value)
  }

  /**
   * FunctionDefinition trigger
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionDefinition(analyzer: any, scope: any, node: any, state: any, info: any) {
    commonUtilJavaAbstract.fillSourceScope(info.fclos, this.sourceScope)
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
    const funcCallArgTaintSource = this.checkerRuleConfigContent.sources?.FuncCallArgTaintSource
    IntroduceTaintJava.introduceFuncArgTaintByRuleConfig(fclos?.object, node, callInfo, funcCallArgTaintSource)
    this.checkByNameAndClassMatch(node, fclos, callInfo, scope, state, info, analyzer)
    // this.checkByFieldMatch(node, fclos, callInfo, scope, state, info)
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

    IntroduceTaintJava.introduceTaintAtFuncCallReturnValue(fclos, node, ret, funcCallReturnValueTaintSource)
  }

  /**
   * check if sink or not by name and class
   * @param node
   * @param fclos
   * @param argvalues
   * @param scope
   * @param state
   * @param info
   * @param analyzer
   */
  checkByNameAndClassMatch(node: any, fclos: any, callInfo: CallInfo | undefined, scope: any, state: any, info: any, analyzer: any) {
    let sinkRules
    if (RulesJava.getPreprocessReady()) {
      if (!this.sinkRuleArray) {
        this.sinkRuleArray = this.assembleFunctionCallSinkRule()
        this.sinkArray = analyzer?.loadAllSink()
      }
      sinkRules = this.sinkRuleArray
    } else {
      sinkRules = this.assembleFunctionCallSinkRule()
    }

    let rules
    if (RulesJava.getPreprocessReady()) {
      if (node?._meta?.nodehash) {
        if (this.matchSinkRuleResultMap.has(node._meta.nodehash)) {
          rules = this.matchSinkRuleResultMap.get(node._meta.nodehash)
        } else {
          rules = matchSinkAtFuncCallWithCalleeTypeJava(node, fclos, sinkRules, scope)
          this.appendCgRules(rules, node, scope, sinkRules, analyzer)
          this.matchSinkRuleResultMap.set(node._meta.nodehash, rules)
        }
      } else {
        rules = matchSinkAtFuncCallWithCalleeTypeJava(node, fclos, sinkRules, scope)
        this.appendCgRules(rules, node, scope, sinkRules, analyzer)
      }
    } else {
      rules = matchSinkAtFuncCallWithCalleeTypeJava(node, fclos, sinkRules, scope)
      this.appendCgRules(rules, node, scope, sinkRules, analyzer)
    }

    for (const rule of rules) {
      let args
      if (rule._sinkType === 'FuncCallTaintSink') {
        if (rule.args) {
          args = RulesJava.prepareArgs(callInfo, fclos, rule)
        } else if (rule.argTypes) {
          args = RulesJava.prepareArgsByType(callInfo, fclos, rule)
        }
      } else if (rule._sinkType === 'ObjectTaintFuncCallSink') {
        args = fclos.getThisObj()
      }
      if (!args) {
        continue
      }

      const sanitizers = SanitizerCheckerJava.findSanitizerByIds(rule.sanitizerIds)
      const ndResultWithMatchedSanitizerTagsArray = SanitizerCheckerJava.findTagAndMatchedSanitizer(
        node,
        fclos,
        args,
        scope,
        TAINT_TAG_NAME_JAVA,
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
            TAINT_TAG_NAME_JAVA,
            ruleName,
            matchedSanitizerTags,
            state.callstack
          )
          if (!TaintOutputStrategyJava.isNewFinding(this.resultManager, taintFlowFinding)) continue
          this.resultManager.newFinding(taintFlowFinding, TaintOutputStrategyJava.outputStrategyId)
        }
      }
    }

    return true
  }

  /**
   * append matched rules find by callgraph
   * @param rules
   * @param node
   * @param scope
   * @param sinkRules
   * @param analyzer
   */
  appendCgRules(rules: any[], node: any, scope: any, sinkRules: any[], analyzer: any) {
    if (rules.length > 0) {
      return
    }
    const cgRules = this.findMatchedRuleByCallGraph(node, scope, sinkRules, analyzer)
    for (const cgRule of cgRules) {
      rules.push(cgRule)
    }
  }

  /**
   * find matched rule by CallGraph
   * @param node
   * @param scope
   * @param analyzer
   * @param sinkRules
   */
  findMatchedRuleByCallGraph(node: any, scope: any, sinkRules: any[], analyzer: any) {
    const resultArray: any[] = []

    if (!node || !scope || !sinkRules || !analyzer || !analyzer.findNodeInvocations) {
      return resultArray
    }

    const invocations: Invocation[] = analyzer.findNodeInvocations(scope, node)
    if (!invocations) {
      return resultArray
    }

    for (const invocation of invocations) {
      for (const sink of sinkRules) {
        const matchSink: boolean = checkInvocationMatchSink(invocation, sink, analyzer.typeResolver)
        if (matchSink) {
          resultArray.push(sink)
        }
      }
    }

    return resultArray
  }

  /**
   * check if sink or not by obj value
   * @param node
   * @param fclos
   * @param argvalues
   * @param scope
   * @param state
   * @param info
   */
  checkByFieldMatch(node: any, fclos: any, callInfo: CallInfo | undefined, scope: any, state: any, info: any) {
    let rules
    if (RulesJava.getPreprocessReady()) {
      if (!this.sinkRuleArray) {
        this.sinkRuleArray = this.assembleFunctionCallSinkRule()
      }
      rules = this.sinkRuleArray
    } else {
      rules = this.assembleFunctionCallSinkRule()
    }
    if (!rules) return

    let matched = false
    rules.some((rule: any) => {
      if (typeof rule.fsig !== 'string') {
        return false
      }
      if (!rule.fsig.includes('.') && rule.calleeType === undefined) {
        return false // 不包含.的使用checkByNameMatch
      }
      const paths = rule.fsig.split('.')
      const lastIndex = rule.fsig.lastIndexOf('.')
      let RuleObj
      if (rule.calleeType) {
        RuleObj = rule.calleeType
      } else {
        RuleObj = rule.fsig.substring(0, lastIndex)
      }

      if (RuleObj === undefined && lastIndex === -1) {
        RuleObj = rule.fsig
      }
      const ruleCallName = paths[paths.length - 1]
      let callName
      const { callee } = node
      if (!callee) return false
      if (callee.type === 'MemberAccess') {
        callName = callee.property.name
      } else {
        // Identifier
        callName = callee.name
      }
      const CallFull = this.getObj(fclos)
      if (typeof CallFull === 'undefined') {
        return false
      }
      const lastIndexofCall = CallFull.lastIndexOf('.')
      if (ruleCallName !== '*' && ruleCallName !== callName) {
        if (lastIndexofCall >= 0) {
          // 补偿获取一次callName
          callName = CallFull.substring(lastIndexofCall + 1)
          if (ruleCallName !== callName && rule.fsig.includes('.')) {
            return false
          }
        }
      }

      let CallObj = CallFull
      if (lastIndexofCall >= 0) {
        CallObj = CallFull.substring(0, lastIndexofCall)
      }
      if (CallObj !== RuleObj && RuleObj !== '*') {
        return false
      }

      const create = false

      IntroduceTaintJava.matchAndMark(
        paths,
        scope,
        rule,
        () => {
          matched = true
        },
        create
      )
      if (matched) {
        const args = RulesJava.prepareArgs(callInfo, fclos, rule)
        const sanitizers = SanitizerCheckerJava.findSanitizerByIds(rule.sanitizerIds)
        const ndResultWithMatchedSanitizerTagsArray = SanitizerCheckerJava.findTagAndMatchedSanitizer(
          node,
          fclos,
          args,
          scope,
          TAINT_TAG_NAME_JAVA,
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
              TAINT_TAG_NAME_JAVA,
              ruleName,
              matchedSanitizerTags,
              state.callstack
            )

            if (!TaintOutputStrategyJava.isNewFinding(this.resultManager, taintFlowFinding)) continue
            this.resultManager.newFinding(taintFlowFinding, TaintOutputStrategyJava.outputStrategyId)
          }
          return true
        }
      }
      matched = false
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
      return QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(result)
    }
    if (typeof fclos?.qid !== 'undefined') {
      const index = fclos.qid.indexOf('>.')
      const result = index !== -1 ? fclos?.qid.substring(index + 2) : fclos?.qid
      return QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(result)
    }
    if (!(fclos === fclos?._this)) {
      return this.getObj(fclos._this)
    }
    const index = fclos?.sid.indexOf('>.')
    const result = index !== -1 ? fclos?.sid.substring(index + 2) : fclos?.sid
    if (result) {
      return QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(result)
    }
  }

  /**
   * assemble function call sink rule
   */
  assembleFunctionCallSinkRule() {
    const sinkRules: any[] = []
    const funcCallTaintSinkRules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (Array.isArray(funcCallTaintSinkRules)) {
      for (const funcCallTaintSinkRule of funcCallTaintSinkRules) {
        funcCallTaintSinkRule._sinkType = 'FuncCallTaintSink'
      }
      sinkRules.push(...funcCallTaintSinkRules)
    }
    const objectTaintFuncCallSinkRules = this.checkerRuleConfigContent.sinks?.ObjectTaintFuncCallSink
    if (Array.isArray(objectTaintFuncCallSinkRules)) {
      for (const objectTaintFuncCallSinkRule of objectTaintFuncCallSinkRules) {
        objectTaintFuncCallSinkRule._sinkType = 'ObjectTaintFuncCallSink'
      }
      sinkRules.push(...objectTaintFuncCallSinkRules)
    }

    return sinkRules
  }
}

module.exports = JavaTaintAbstractChecker
