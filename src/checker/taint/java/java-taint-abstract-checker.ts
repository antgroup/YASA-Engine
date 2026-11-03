import type { CallInfo } from '../../../engine/analyzer/common/call-args'
import type { AstSourceLocation, EntryPointRuleConfig } from '../../../engine/analyzer/common/entrypoint/entrypoint'
import type { Invocation } from '../../../resolver/common/value/invocation'
import type { TaintFinding } from '../../../engine/analyzer/common/common-types'

const QidUnifyUtil = require('../../../util/qid-unify-util')
const TaintCheckerJava = require('../taint-checker')
const IntroduceTaintJava = require('../common-kit/source-util')
const commonUtilJavaAbstract = require('../../../util/common-util')
const {
  matchSinkAtFuncCallWithCalleeType: matchSinkAtFuncCallWithCalleeTypeJava,
  checkInvocationMatchSink,
} = require('../common-kit/sink-util')
const { getOrBuildCallInfo: getOrBuildCallInfoJava } = require('../common-kit/call-info-util')
const RulesJava = require('../../common/rules-basic-handler')
const SanitizerCheckerJava = require('../../sanitizer/sanitizer-checker')
const TaintOutputStrategyJava = require('../../common/output/taint-output-strategy')

const { satisfy, defaultFilter } = require('../../../util/ast-util')
const Config = require('../../../config')
const logger = require('../../../util/logger')(__filename)
const { lodashCloneWithTag } = require('../../../util/clone-util')
const { FunctionValue } = require('../../../engine/analyzer/common/value/function') as typeof import('../../../engine/analyzer/common/value/function')
const { ClassValue } = require('../../../engine/analyzer/common/value/class') as typeof import('../../../engine/analyzer/common/value/class')
const { getEntryPointOwnerKey } = require('../../../engine/analyzer/common/entrypoint/current-entrypoint') as { getEntryPointOwnerKey: () => string | undefined }
const { getJavaFindingSignature, isJavaCandidateFinding } = require('./java-finding-candidate') as typeof import('./java-finding-candidate')
const { getJavaEntrypointFindingCollector } = require('./java-entrypoint-finding-collector') as typeof import('./java-entrypoint-finding-collector')

const TAINT_TAG_NAME_JAVA = 'JAVA_INPUT'

type JavaEntrypointConfig = EntryPointRuleConfig & {
  packageName?: string
  paramTypes?: string[]
  signature?: string
  funcLoc?: { start?: number; end?: number }
}

type JavaTypeParamNode = {
  varType?: { id?: { name?: string } }
}

type FunctionLikeNode<TParam = unknown> = {
  id?: { name?: string }
  name?: string
  loc?: AstSourceLocation
  parameters?: TParam[]
}

type JavaEntrypointFunctionNode = FunctionLikeNode<JavaTypeParamNode>

type CallableAstLike = JavaEntrypointFunctionNode & {
  fdef?: JavaEntrypointFunctionNode
  node?: JavaEntrypointFunctionNode
}

type JavaOwnerLike = {
  vtype?: string
  logicalQid?: string
  qid?: string
  sid?: string
  ast?: CallableAstLike & { node?: { loc?: AstSourceLocation & { sourcefile?: string } } }
  parent?: JavaOwnerLike
  _this?: JavaOwnerLike
  members?: Map<string, unknown>
  value?: Record<string, unknown>
}
type FunctionClosureLike = {
  vtype?: string
  ast?: CallableAstLike
  overloaded?: JavaEntrypointFunctionNode[]
  parent?: JavaOwnerLike
}

type JavaSymbolTableLike = {
  get: (key: unknown) => unknown
}

type JavaClassMapLike = {
  values: () => Iterable<unknown>
}

type JavaAnalyzerLike = {
  classMap?: JavaClassMapLike
  symbolTable?: JavaSymbolTableLike
}

type JavaTypeResolverLike = {
  classHierarchyMap?: Map<string, unknown>
  findBaseTypes: (classHierarchy: unknown) => string[]
}

type JavaAnalyzerWithTypeResolver = {
  typeResolver?: JavaTypeResolverLike
}

function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

/**
 *
 * @param node
 */
function getSourceLineLoc(node: FunctionLikeNode): { start?: number; end?: number } {
  return {
    start: toOptionalNumber(node.loc?.start?.line),
    end: toOptionalNumber(node.loc?.end?.line),
  }
}

/**
 *
 * @param typeName
 */
function normalizeJavaType(typeName: string | undefined): string | undefined {
  if (!typeName) return undefined
  const withoutArray = typeName.endsWith('[]') ? typeName.slice(0, -2) : typeName
  const parts = withoutArray.split('.')
  return parts[parts.length - 1]
}

/**
 *
 * @param node
 */
function getParamTypeNames(node: JavaEntrypointFunctionNode): string[] {
  if (!Array.isArray(node.parameters)) return []
  return node.parameters.map((param) => normalizeJavaType(param.varType?.id?.name) ?? '')
}

/**
 *
 * @param node
 * @param expectedTypes
 */
function matchParamTypes(node: JavaEntrypointFunctionNode, expectedTypes: string[] | undefined): boolean {
  if (!Array.isArray(expectedTypes) || expectedTypes.length === 0) return false
  const actualTypes = getParamTypeNames(node)
  if (actualTypes.length !== expectedTypes.length) return false
  return expectedTypes.every((expectedType, index) => {
    const expected = normalizeJavaType(expectedType)
    const actual = actualTypes[index]
    return expected !== undefined && expected !== '' && (actual === expected || expectedType.endsWith(`.${actual}`))
  })
}

/**
 *
 * @param node
 * @param signature
 */
function matchSignature(node: JavaEntrypointFunctionNode, signature: string | undefined): boolean {
  if (!signature) return false
  const methodName = node.id?.name ?? node.name
  const paramTypes = getParamTypeNames(node).join(',')
  const compactSignature = signature.replace(/\s+/g, '')
  return compactSignature.includes(`${methodName}(${paramTypes})`)
}

/**
 *
 * @param value
 */
function isFunctionClosureLike(value: unknown): value is FunctionClosureLike {
  return Boolean(value && typeof value === 'object' && (value as { vtype?: unknown }).vtype === 'fclos')
}

/**
 * java taint base checker
 */
class JavaTaintAbstractChecker extends TaintCheckerJava {
  /**
   *
   * @param node
   * @param entrypoint
   */
  matchEntrypointFunction(node: JavaEntrypointFunctionNode, entrypoint: JavaEntrypointConfig): boolean {
    const funcLocStart = entrypoint.funcLocStart ?? entrypoint.funcLoc?.start
    const funcLocEnd = entrypoint.funcLocEnd ?? entrypoint.funcLoc?.end
    if (funcLocStart != null || funcLocEnd != null) {
      const loc = getSourceLineLoc(node)
      const startMatches = funcLocStart == null || loc.start === funcLocStart
      const endMatches = funcLocEnd == null || loc.end === funcLocEnd
      return startMatches && endMatches
    }
    if (Array.isArray(entrypoint.paramTypes) && entrypoint.paramTypes.length > 0) {
      return matchParamTypes(node, entrypoint.paramTypes)
    }
    if (typeof entrypoint.signature === 'string') {
      return matchSignature(node, entrypoint.signature)
    }
    return true
  }

  /**
   *
   * @param entryPointSymVal
   * @param entrypoint
   */
  resolveOverloadedEntryPoint(entryPointSymVal: unknown, entrypoint: JavaEntrypointConfig): unknown {
    const hasDisambiguator =
      entrypoint.funcLocStart != null ||
      entrypoint.funcLocEnd != null ||
      entrypoint.funcLoc?.start != null ||
      entrypoint.funcLoc?.end != null ||
      (Array.isArray(entrypoint.paramTypes) && entrypoint.paramTypes.length > 0) ||
      typeof entrypoint.signature === 'string'
    if (!hasDisambiguator || !isFunctionClosureLike(entryPointSymVal)) {
      return entryPointSymVal
    }

    const candidates = [entryPointSymVal.ast?.node, ...(entryPointSymVal.overloaded ?? [])].filter(
      (node): node is JavaEntrypointFunctionNode => Boolean(node)
    )
    const matchedNode = candidates.find((node) => this.matchEntrypointFunction(node, entrypoint))
    if (!matchedNode) {
      return undefined
    }

    const cloned = lodashCloneWithTag(entryPointSymVal) as FunctionClosureLike
    cloned.ast = matchedNode
    cloned.ast.fdef = matchedNode
    cloned.ast.node = matchedNode
    cloned.overloaded = [matchedNode]
    return cloned
  }

  /**
   * 从方法 AST 中收集匿名内部类或局部类里的同名方法。
   * @param root - 外层方法 AST
   * @param functionName - 方法名
   * @param ownerClosure - 外层方法闭包
   * @returns 匿名或嵌套方法闭包
   */
  collectNestedEntryPointClosures(
    root: JavaEntrypointFunctionNode,
    functionName: string,
    ownerClosure: FunctionClosureLike
  ): FunctionClosureLike[] {
    const result: FunctionClosureLike[] = []
    const visited = new Set<object>()
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      const record = value as Record<string, unknown>
      if (visited.has(record)) return
      visited.add(record)
      if (record !== root && record.type === 'FunctionDefinition') {
        const node = record as JavaEntrypointFunctionNode
        const nodeName = node.id?.name ?? node.name
        if (nodeName === functionName) {
          const owner = this.createNestedEntryPointOwner(ownerClosure, node)
          result.push(this.createNestedEntryPointClosure(ownerClosure, owner, node))
        }
      }
      for (const [key, child] of Object.entries(record)) {
        if (key === 'parent' || key === 'loc' || key === '_meta') continue
        if (Array.isArray(child)) child.forEach(visit)
        else visit(child)
      }
    }
    visit(root)
    return result
  }

  /**
   * 创建嵌套方法的独立 owner，保持其 parent、this 和限定名与外层方法隔离。
   * @param ownerClosure - 外层方法闭包
   * @param node - 嵌套方法 AST
   * @returns 嵌套方法 owner
   */
  createNestedEntryPointOwner(ownerClosure: FunctionClosureLike, node: JavaEntrypointFunctionNode): JavaOwnerLike {
    const parent = ownerClosure.parent
    const parentQid = parent?.logicalQid ?? parent?.qid ?? ''
    const loc = getSourceLineLoc(node)
    const suffix = `<anonymousFunc_${loc.start ?? 0}_${loc.end ?? 0}>`
    const owner = new ClassValue(parentQid, suffix, parent as never)
    owner.ast = node
    const nestedOwner = owner as unknown as JavaOwnerLike & { ast: { hasDecl: (key: string) => boolean } }
    if (typeof nestedOwner.ast.hasDecl !== 'function') {
      throw new TypeError('Nested entry point owner AST must be AstBinding')
    }
    return owner as unknown as JavaOwnerLike
  }

  /**
   * 创建嵌套方法闭包，绑定到独立 owner。
   * @param ownerClosure - 外层方法闭包
   * @param owner - 嵌套方法 owner
   * @param node - 嵌套方法 AST
   * @returns 嵌套方法闭包
   */
  createNestedEntryPointClosure(
    ownerClosure: FunctionClosureLike,
    owner: JavaOwnerLike,
    node: JavaEntrypointFunctionNode
  ): FunctionClosureLike {
    const parent = ownerClosure.parent
    const qid = owner.logicalQid ?? owner.qid ?? owner.sid ?? '<anonymous>'
    const closure = new FunctionValue(parent?.logicalQid ?? parent?.qid ?? '', {
      sid: node.id?.name ?? node.name ?? owner.sid ?? '<anonymous>',
      qid: `${qid}.${node.id?.name ?? node.name ?? 'function'}`,
      parent: owner as never,
      ast: node,
      overloaded: [node],
      _this: owner as never,
    }) as FunctionClosureLike
    closure.ast = node
    closure.ast.fdef = node
    closure.ast.node = node
    closure.parent = owner
    return closure
  }

  /**
   * 收集指定文件和包下的所有 owner 方法，包含外层类及匿名内部类。
   * @param entrypoint - 自定义入口配置
   * @param analyzer - Java analyzer
   * @param functionName - 方法名
   * @returns 所有匹配的方法闭包
   */
  resolveAllMatchingEntryPoints(
    entrypoint: JavaEntrypointConfig,
    analyzer: JavaAnalyzerLike,
    functionName: string
  ): FunctionClosureLike[] {
    const configuredFilePath = entrypoint.filePath
    const configuredPackageName = entrypoint.packageName
    const configuredOwnerName = configuredPackageName?.startsWith('.')
      ? configuredPackageName.slice(1)
      : configuredPackageName
    if (!configuredFilePath || !configuredOwnerName || !analyzer.classMap || !analyzer.symbolTable) return []

    const matched: FunctionClosureLike[] = []
    const seen = new Set<FunctionClosureLike>()
    for (const classRef of analyzer.classMap.values()) {
      const classValue = analyzer.symbolTable.get(classRef)
      if (!classValue || typeof classValue !== 'object') continue
      const owner = classValue as JavaOwnerLike
      const classNode = owner.ast?.node
      const sourceFile = classNode?.loc?.sourcefile
      const normalizedFile = this.normalizeAstSourceFilePath(sourceFile)
      const isTargetFile = normalizedFile === configuredFilePath || sourceFile === configuredFilePath ||
        (typeof sourceFile === 'string' && sourceFile.endsWith(configuredFilePath))
      const ownerQid = owner.logicalQid ?? owner.qid ?? ''
      const isTargetOwner = isTargetFile &&
        (ownerQid === configuredOwnerName || ownerQid.startsWith(`${configuredOwnerName}.`) || ownerQid.startsWith(`${configuredOwnerName}$`) || ownerQid.startsWith(`${configuredOwnerName}<`))
      if (!isTargetOwner) continue
      const method = owner.members?.get(functionName) ?? owner.value?.[functionName]
      if (isFunctionClosureLike(method) && !seen.has(method)) {
        seen.add(method)
        matched.push(method)
        matched.push(...this.collectNestedEntryPointClosures(method.ast?.node ?? {}, functionName, method))
      }
    }
    return matched
  }

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
      const locStart =
        implAstNode?.parameters?.length > 0 ? implAstNode.parameters[0].loc?.start?.line : implAstNode?.loc?.start?.line
      const locEnd = implAstNode?.loc?.end?.line

      const getParamName = (paramNode: unknown): string | undefined => {
        if (!paramNode || typeof paramNode !== 'object') return undefined
        const paramRecord = paramNode as Record<string, unknown>
        const idRecord =
          paramRecord.id && typeof paramRecord.id === 'object' ? (paramRecord.id as Record<string, unknown>) : undefined
        return typeof paramRecord.name === 'string'
          ? paramRecord.name
          : typeof idRecord?.name === 'string'
            ? idRecord.name
            : undefined
      }

      const interfaceParams = interfaceSymVal?.ast?.node?.parameters
      const implParams = implAstNode?.parameters
      const interfaceParamToImplParam = new Map<string, string>()
      if (Array.isArray(interfaceParams) && Array.isArray(implParams)) {
        const length = Math.min(interfaceParams.length, implParams.length)
        for (let i = 0; i < length; i++) {
          const interfaceParamName = getParamName(interfaceParams[i])
          const implParamName = getParamName(implParams[i])
          if (interfaceParamName && implParamName) {
            interfaceParamToImplParam.set(interfaceParamName, implParamName)
          }
        }
      }

      const newSources: any[] = []
      for (const source of taintSources) {
        if (source.scopeFile === interfacePath && source.scopeFunc === funcName) {
          const mappedPath =
            typeof source.path === 'string' ? (interfaceParamToImplParam.get(source.path) ?? source.path) : source.path
          const mappedSource = { ...source, scopeFile: implPath, path: mappedPath }
          const key = buildSourceKey(mappedSource)
          if (!existingKeys.has(key)) {
            newSources.push(mappedSource)
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
   * @param entryPointSymVal
   * @param entrypoint
   * @param func
   * @param analyzer
   * @param Scoped
   * @param EntryPoint
   * @param Constant
   */
  resolveAndPushEntryPoint(
    entryPointSymVal: any,
    entrypoint: JavaEntrypointConfig,
    func: string,
    analyzer: any,
    Scoped: any,
    EntryPoint: any,
    Constant: any
  ): void {
    const matchedEntryPoints = this.resolveAllMatchingEntryPoints(entrypoint, analyzer, func)
    const hasExplicitFilePath = typeof entrypoint.filePath === 'string' && entrypoint.filePath.length > 0
    if (matchedEntryPoints.length === 0 && hasExplicitFilePath) return
    const candidates = matchedEntryPoints.length > 0 ? matchedEntryPoints : [entryPointSymVal]
    const resolvedSymVals: unknown[] = []
    for (const candidate of candidates) {
      const exactCandidate = this.resolveOverloadedEntryPoint(candidate, entrypoint)
      if (!exactCandidate) continue
      const resolvedCandidates = this.resolveInterfaceEntryPoint(exactCandidate, func, analyzer)
      if (resolvedCandidates.length > 0 && resolvedCandidates[0] !== exactCandidate) {
        this.augmentSourcesForInterfaceResolution(exactCandidate, resolvedCandidates, func)
      }
      resolvedSymVals.push(...resolvedCandidates)
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
      entryPoint.funcLocStart = entrypoint.funcLocStart
      entryPoint.funcLocEnd = entrypoint.funcLocEnd
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
   * NewExpression 构造器调用后触发 sink 匹配，语义对齐 triggerAtFunctionCallBefore。
   * 兼容 legacy payload（argvalues）：common analyzer 已传 callInfo，其它 analyzer 兜底转换。
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtNewExprAfter(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { fclos } = info
    const callInfo = getOrBuildCallInfoJava(info)
    this.checkByNameAndClassMatch(node, fclos, callInfo, scope, state, info, analyzer)
  }

  /**
   * check if sink or not by name and class
   * @param node
   * @param fclos
   * @param argvalues
   * @param callInfo
   * @param scope
   * @param state
   * @param info
   * @param analyzer
   */
  checkByNameAndClassMatch(
    node: any,
    fclos: any,
    callInfo: CallInfo | undefined,
    scope: any,
    state: any,
    info: any,
    analyzer: any
  ) {
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
          rules = matchSinkAtFuncCallWithCalleeTypeJava(node, fclos, sinkRules, scope, callInfo)
          this.appendCgRules(rules, node, scope, sinkRules, analyzer)
          this.matchSinkRuleResultMap.set(node._meta.nodehash, rules)
        }
      } else {
        rules = matchSinkAtFuncCallWithCalleeTypeJava(node, fclos, sinkRules, scope, callInfo)
        this.appendCgRules(rules, node, scope, sinkRules, analyzer)
      }
    } else {
      rules = matchSinkAtFuncCallWithCalleeTypeJava(node, fclos, sinkRules, scope, callInfo)
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
        // precondition 检查：sink rule 声明了 preconditionIds 时，taint 上命中任一 precondition tag（OR 语义）即保留 finding
        const { preconditionIds } = rule
        if (preconditionIds && preconditionIds.length > 0) {
          // 从 args 的 taint flow 中收集所有 tags，用于 precondition 匹配
          const allTaintTags: unknown[] = []
          // 先收集 args 自身的 tags：args 起点可能不被 fCollectTags 过滤捕获，
          // 例如 receiver 被 checkAndTagPreconditions.addSanitizerInSymbolValue 直接打了
          // SanitizerTag 但本身没 JAVA_INPUT 时，satisfy BFS 会跳过起点进子节点找含
          // JAVA_INPUT 的 buffer 项，导致 args 自身 SanitizerTag 被漏
          const argsArrForTags = Array.isArray(args) ? args : [args]
          for (const a of argsArrForTags) {
            // R37 W11：SanitizerTag 对象走旁路 sanitizerTags，必须用 getSanitizerTags()
            const sanitizerTags = a?.taint?.getSanitizerTags?.()
            if (sanitizerTags && sanitizerTags.length > 0) {
              allTaintTags.push(...sanitizerTags)
            }
          }
          const fCollectTags = (nd: { taint?: { tags?: unknown[]; tagTraces?: Map<string, unknown> } }): boolean => {
            const tagTraceMap = nd?.taint?.tagTraces
            if (!(tagTraceMap instanceof Map)) return false
            return tagTraceMap.has(TAINT_TAG_NAME_JAVA)
          }
          const collectCallback = (
            nd: { taint?: { getSanitizerTags?: () => unknown[] } },
            _from: unknown,
            parentMap: WeakMap<object, object>
          ): void => {
            // 收集当前 nd 及其 parent 链上所有节点的 SanitizerTag 对象
            const parentNdList: Array<{ taint?: { getSanitizerTags?: () => unknown[] } }> = []
            let currentNd: { taint?: { getSanitizerTags?: () => unknown[] } } | undefined = nd
            while (currentNd) {
              if (parentNdList.includes(currentNd)) break
              parentNdList.push(currentNd)
              currentNd = parentMap.get(currentNd as object) as
                { taint?: { getSanitizerTags?: () => unknown[] } } | undefined
            }
            for (const parentNd of parentNdList) {
              // getSanitizerTags() 返回旁路的 SanitizerTagValue 对象集合
              const sanitizerTags = parentNd.taint?.getSanitizerTags?.()
              if (sanitizerTags && sanitizerTags.length > 0) {
                allTaintTags.push(...sanitizerTags)
              }
            }
          }
          satisfy(args, fCollectTags, defaultFilter, undefined, true, 30, collectCallback)

          const matchedPreconditionTags = SanitizerCheckerJava.findMatchedPreconditionTags(
            preconditionIds,
            allTaintTags
          )
          // 多个 preconditionIds 采用 OR 语义：任一命中即保留 finding
          const matchedIds = new Set(matchedPreconditionTags.map((t: { id?: string }) => t.id))
          if (matchedIds.size === 0) {
            continue
          }
        }

        for (const ndResultWithMatchedSanitizerTags of ndResultWithMatchedSanitizerTagsArray) {
          const { nd } = ndResultWithMatchedSanitizerTags
          const { matchedSanitizerTags } = ndResultWithMatchedSanitizerTags
          let ruleName = rule.fsig
          if (typeof rule.attribute !== 'undefined') {
            const attrStr = Array.isArray(rule.attribute) ? rule.attribute.join(',') : rule.attribute
            ruleName += `\nSINK Attribute: ${attrStr}`
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
            state.callstack,
            state.callsites
          )
          if (!taintFlowFinding) continue
          const javaFinding = taintFlowFinding as TaintFinding
          const signature = getJavaFindingSignature(javaFinding)
          const logicalEntrypointKey = getEntryPointOwnerKey()
          const collector = logicalEntrypointKey ? getJavaEntrypointFindingCollector(logicalEntrypointKey) : undefined
          if (isJavaCandidateFinding(javaFinding)) {
            if (collector && signature) collector.registerCandidate(signature, javaFinding)
            continue
          }
          if (collector && signature) collector.registerNormal(signature)
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
   * 检查 subTypeName 是否是 superTypeName 的子类或实现类
   * 通过 typeResolver 的 classHierarchyMap 沿继承链向上查找
   * @param subTypeName 子类全限定名
   * @param superTypeName 父类/接口全限定名
   * @param analyzer 分析器实例
   */
  isSubTypeOf(subTypeName: string, superTypeName: string, analyzer?: JavaAnalyzerWithTypeResolver): boolean {
    if (!subTypeName || !superTypeName || subTypeName === superTypeName) {
      return subTypeName === superTypeName
    }
    const typeResolver = analyzer?.typeResolver
    if (!typeResolver?.classHierarchyMap) {
      return false
    }
    const classHierarchy = typeResolver.classHierarchyMap.get(subTypeName)
    if (!classHierarchy) {
      return false
    }
    const baseTypes: string[] = typeResolver.findBaseTypes(classHierarchy)
    return baseTypes.includes(superTypeName)
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
