import type TypeRelatedInfoResolver from '../../resolver/common/type-related-info-resolver'
import type { ClassHierarchy } from '../../resolver/common/value/class-hierarchy'
import type { Invocation } from '../../resolver/common/value/invocation'
import symAddressCallgraph from '../../engine/analyzer/common/sym-address'

const config = require('../../config')
const EntryPoint = require('../../engine/analyzer/common/entrypoint/entrypoint')
const constValue = require('../../util/constant')
const CheckerManager = require('../../engine/analyzer/common/checker-manager')
const BasicRuleHandler = require('./rules-basic-handler')
const callGraphRule = require('../callgraph/callgraph-checker')
const options = require('../../config')
const { Graph } = require('../../util/graph')
const logger = require('../../util/logger')(__filename)
const sourceLine = require('../../engine/analyzer/common/source-line')
const { performanceTracker } = require('../../util/performance-tracker')

/**
 *
 * @param ast
 */
function printLoc(ast: any): string {
  let sourcefile: string
  sourcefile = ast?.loc?.sourcefile
  if (sourcefile) {
    const splits = sourcefile.split('/')
    sourcefile = splits[splits.length - 1]
  }
  const startLine = ast && ast?.loc?.start.line
  const endLine = ast && ast?.loc?.end.line

  return ` \\n[${sourcefile} : ${startLine}_${endLine}]`
}

/**
 *
 * @param fclos fclos
 * @param fdef function definition
 * @param callSiteNode call site node
 * @param callSiteLiteral
 * @param calleeType
 * @param fsig
 */
function prettyPrint(
  fclos: any,
  fdef: any,
  callSiteNode: any,
  callSiteLiteral: string,
  calleeType: string,
  fsig: string
): string {
  let ret: string = ''
  let name: string
  if (!fdef || !fdef.name || fdef.name === '<anonymous>') {
    if (calleeType !== '' && fsig !== '') {
      ret = `${calleeType}.${fsig}`
    } else if (callSiteLiteral !== '') {
      ret = callSiteLiteral
    } else {
      ret = symAddressCallgraph.toStringID(callSiteNode) || ''
    }
  } else {
    // pretty print fdef
    name = fdef.name || '<anonymous>'
    // try to attach namespace
    if (fclos && fclos.__proto__.constructor.name !== 'BVTValue') {
      if (fclos.vtype === 'class') {
        // e.g. javascript function class
        name = `new ${name}`
      } else if (fclos.parent?.vtype === 'class' || fclos.parent?.ast.fdef?.type === 'ClassDefinition') {
        const nsDef = fclos.parent.ast.fdef
        let nsName = nsDef?.name || '<anonymous>'
        if (fclos.parent.qid) {
          nsName = fclos.parent.qid
        }
        if (name === '_CTOR_') {
          name = `new ${nsName}`
        } else {
          name = `${nsName} :: ${name}`
        }
      }
    }

    ret = name
  }
  if (!ret) {
    ret = 'undefined'
  }
  ret = ret.split('\n')[0]
  ret = ret.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'")
  if (ret.length > 500) {
    ret = `${ret.slice(0, 500)}...`
  }
  // attach loc
  if (fdef && fdef?.loc) {
    ret += printLoc(fdef)
  }
  return ret
}

/**
 * 从 nodehash 和 UUID 还原 funcDef 和 funcSymbol
 * @param node callgraph 节点
 * @param astManager AST 管理器
 * @param symbolTable 符号表管理器
 * @returns 包含 funcDef 和 funcSymbol 的对象
 */
function restoreNodeFromReferences(node: any, astManager?: any, symbolTable?: any): { funcDef: any; funcSymbol: any } {
  const funcDef =
    node.opts?.funcDefNodehash && astManager ? astManager.get(node.opts.funcDefNodehash) : node.opts?.funcDef
  const funcSymbol =
    node.opts?.funcSymbolUuid && symbolTable ? symbolTable.get(node.opts.funcSymbolUuid) : node.opts?.funcSymbol
  return { funcDef, funcSymbol }
}

/**
 * generate full callGraph by funcSymbolTable
 * @param analyzer
 */
function makeFullCallGraph(analyzer: any): void {
  performanceTracker.start(`startAnalyze.makeFullCallGraph(BySymbolInterpret)`)
  config.loadDefaultRule = false
  config.loadExternalRule = false
  config.makeAllCG = true
  const newCheckerManager = new CheckerManager(undefined, undefined, undefined, undefined, BasicRuleHandler)
  newCheckerManager.doRegister(callGraphRule, newCheckerManager)
  config.loadDefaultRule = true
  config.loadExternalRule = true
  const backupCheckerManager = analyzer.checkerManager
  analyzer.checkerManager = newCheckerManager
  analyzer.ainfo.callgraph = analyzer.ainfo.callgraph || new Graph()
  if (analyzer.ainfo.callgraph && Object.keys(analyzer.topScope.context.funcs).length > 0) {
    const alreadyCheckList: any[] = [] // 分析过的callnode一定会出现在nodes中
    for (const node of analyzer.ainfo.callgraph.nodes.values()) {
      // 从 UUID 还原 funcSymbol
      if (node.opts?.funcSymbolUuid) {
        const funcSymbol = analyzer.symbolTable.get(node.opts.funcSymbolUuid)
        if (funcSymbol) {
          alreadyCheckList.push(funcSymbol)
        }
      }
    }
    let totalCount = 0
    Object.entries(analyzer.topScope.context.funcs).forEach(([key, funcSymbol]) => {
      const funcSymbolAny = funcSymbol as any
      if (
        !alreadyCheckList.includes(funcSymbolAny) &&
        funcSymbolAny.ast.fdef &&
        funcSymbolAny.ast.fdef.type === 'FunctionDefinition'
      ) {
        totalCount += 1
      }
    })
    let analyzedCount = 0
    let already10Percent = false
    let already30Percent = false
    let already70Percent = false
    logger.info('makeAllCG-start')
    Object.entries(analyzer.topScope.context.funcs).forEach(([key, funcSymbol]) => {
      analyzedCount += 1
      if (analyzedCount > totalCount * 0.1 && !already10Percent) {
        logger.info('\tmakeAllCG-10%')
        already10Percent = true
      }
      if (analyzedCount > totalCount * 0.3 && !already30Percent) {
        logger.info('\tmakeAllCG-30%')
        already30Percent = true
      }

      if (analyzedCount > totalCount * 0.7 && !already70Percent) {
        logger.info('\tmakeAllCG-70%')
        already70Percent = true
      }
      const funcSymbolAny2 = funcSymbol as any
      if (
        !alreadyCheckList.includes(funcSymbolAny2) &&
        funcSymbolAny2.ast.fdef &&
        funcSymbolAny2.ast.fdef.type === 'FunctionDefinition'
      ) {
        alreadyCheckList.push(funcSymbolAny2)
        analyzer.executeCall(
          funcSymbolAny2.ast.fdef,
          funcSymbolAny2,
          analyzer.initState(funcSymbolAny2.parent),
          funcSymbolAny2.parent
        )
      }
    })
    logger.info('\tmakeAllCG-100%')
  }
  analyzer.checkerManager = backupCheckerManager
  config.makeAllCG = false
  performanceTracker.end(`startAnalyze.makeFullCallGraph(BySymbolInterpret)`)
}

/**
 * generate full callGraph by funcSymbolTable without symbol interpret
 * @param analyzer
 * @param resolver
 */
function makeFullCallGraphByType(analyzer: any, resolver: TypeRelatedInfoResolver) {
  if (!resolver || (resolver.resolveFinish && analyzer?.ainfo?.callgraph)) {
    return
  }

  performanceTracker.start('startAnalyze.makeFullCallGraphByType')

  if (!resolver.resolveFinish) {
    resolver.resolve(analyzer)
  }

  // Helper function to extract only location and name from AST to reduce memory usage
  const extractFuncDefInfo = (ast: any): { loc?: any; name?: any; id?: any } | null => {
    if (!ast) return null
    return {
      loc: ast.loc,
      name: ast.name,
      id: ast.id, // Store id for functionName access
    }
  }

  // Helper function to extract only location from callSite AST to reduce memory usage
  const extractCallSiteInfo = (callSite: any): { loc?: any } | null => {
    if (!callSite) return null
    return {
      loc: callSite.loc,
    }
  }

  const graph = new Graph()
  Object.entries(analyzer.funcSymbolTable).forEach(([, funcSymbol]) => {
    const funcSymbolAny = funcSymbol as any
    if (funcSymbolAny.invocationMap instanceof Map) {
      for (const invocationArray of funcSymbolAny.invocationMap.values()) {
        for (const invocation of invocationArray) {
          const fromNode = graph.addNode(
            prettyPrint(
              invocation.fromScope,
              invocation.fromScopeAst,
              invocation.callSite,
              invocation.callSiteLiteral,
              invocation.calleeType,
              invocation.fsig
            ),
            {
              funcDef: extractFuncDefInfo(invocation.fromScopeAst),
              funcSymbol: invocation.fromScope,
            }
          )
          const toNode = graph.addNode(
            prettyPrint(
              invocation.toScope,
              invocation.toScopeAst,
              invocation.callSite,
              invocation.callSiteLiteral,
              invocation.calleeType,
              invocation.fsig
            ),
            {
              funcDef: extractFuncDefInfo(invocation.toScopeAst),
              funcSymbol: invocation.toScope,
            }
          )
          graph.addEdge(fromNode, toNode, { callSite: extractCallSiteInfo(invocation.callSite) })
        }
      }
    }
  })

  // caller-aware specialization：在 callgraph 落盘前做 receiver-sensitive 收敛
  // 当 abstract base method 的所有 caller 都是具体子类时，删除被 specialized 覆盖的 may-dispatch 假扇出
  applyCallerAwareSpecialization(analyzer, resolver, graph, extractFuncDefInfo, extractCallSiteInfo)

  analyzer.ainfo.callgraph = graph

  performanceTracker.end('startAnalyze.makeFullCallGraphByType')
}

/**
 * 判断 callsite callee 是否为 self-dispatch 形态（裸 Identifier 或 this.X）
 * 不处理 SuperExpression（super 走 invokeSuper 分支，由 resolveCallExpression 单独处理）
 *
 * @param callSite CallExpression AST
 */
function isSelfDispatchCallee(callSite: any): boolean {
  const callee = callSite?.callee
  if (!callee) return false
  if (callee.type === 'Identifier') return true
  if (callee.type === 'MemberAccess' && callee.object?.type === 'ThisExpression') return true
  return false
}

/**
 * funcSymbol 的 owner class scope（vtype='class'），找不到返回 undefined
 *
 * @param funcSymbol
 */
function getOwnerClassScope(funcSymbol: any): any | undefined {
  const parent = funcSymbol?.parent
  if (parent && parent.vtype === 'class') return parent
  return undefined
}

/**
 * 从 class scope AST 读取 _meta.modifiers 判断是否为 abstract class
 * finalization 层独立读，避免跨 resolver / checker 耦合
 * 非 Java 语言无 abstract 概念，_meta 缺失时返回 false
 *
 * @param classScope
 */
function isAbstractClassScope(classScope: any): boolean {
  const modifiers = classScope?.ast?.node?._meta?.modifiers
  if (!Array.isArray(modifiers)) return false
  return modifiers.includes('abstract')
}

/**
 * 从 funcSymbol（toScope）提取 owner class qid（logicalQid 优先）
 * logicalQid 与 classHierarchyMap key 一致（见 JavaTypeRelatedInfoResolver.findClassHierarchy）
 *
 * @param funcSymbol
 */
function getOwnerClassQid(funcSymbol: any): string | undefined {
  const ownerClass = getOwnerClassScope(funcSymbol)
  if (!ownerClass) return undefined
  return ownerClass.logicalQid ?? ownerClass.qid
}

/**
 * 判断静态类型 qid 是否为"concrete class"
 *   - interface → false（保留全扇出，接口多态合理）
 *   - abstract class → false（abstract base 自身无法收敛，保留全扇出）
 *   - classHierarchyMap miss → false（receiver 不可解析，保留全扇出）
 *   - Object / java.lang.Object → false（顶级类型无收敛收益）
 *
 * @param qid
 * @param classHierarchyMap
 */
function isConcreteClassByHierarchy(
  qid: string | undefined,
  classHierarchyMap: Map<string, ClassHierarchy>
): boolean {
  if (!qid) return false
  if (qid === 'Object' || qid === 'java.lang.Object') return false
  let h = classHierarchyMap.get(qid)
  // 短名 fallback：inv.calleeType 在某些场景是短名（如 import 后的简单引用），
  // hierarchyMap 用 fqn 作 key 时会 miss。遍历 map 找唯一 endsWith('.qid') 候选；
  // 多于 1 个保守视为不可解析，返回 false（不删扇出）。
  if (!h && !qid.includes('.')) {
    let candidate: ClassHierarchy | undefined
    let count = 0
    const suffix = `.${qid}`
    for (const [k, v] of classHierarchyMap) {
      if (k === qid || k.endsWith(suffix)) {
        candidate = v
        count += 1
        if (count > 1) break
      }
    }
    if (count === 1) h = candidate
  }
  if (!h) return false
  if (h.typeDeclaration !== 'class') return false
  const modifiers = h.value?.ast?.node?._meta?.modifiers
  if (Array.isArray(modifiers) && modifiers.includes('abstract')) return false
  return true
}

/**
 * 反查 funcSymbolTable 构建 incomingMap
 * key = toScope（funcSymbol reference，identity 比较，规避 qid 冲突 / cloneAlias）
 * value = 调用该 toScope 的所有 caller invocation（callerCalleeType = 静态 receiver 类型）
 *
 * inherited 处理：当 caller 的 invocation.toScope 是子类继承 copy（func.inherited=true，
 * _base 指向 base class fclos），同时把该 caller 也注册到 base class 同名 method funcSymbol 的
 * incoming entry——这样 base class abstract method 才能在 applyCallerAwareSpecialization
 * 阶段找到 caller，按 caller 的具体子类 receiver 做 specialization。
 *
 * @param analyzer
 */
function buildIncomingInvocationMap(
  analyzer: any
): Map<any, Array<{ callerInvocation: Invocation; callerCalleeType: string }>> {
  const incoming = new Map<any, Array<{ callerInvocation: Invocation; callerCalleeType: string }>>()
  const funcSymbolTable = analyzer?.funcSymbolTable
  if (!funcSymbolTable) return incoming
  for (const funcSymbol of Object.values(funcSymbolTable)) {
    const funcSymbolAny = funcSymbol as any
    if (!(funcSymbolAny.invocationMap instanceof Map)) continue
    for (const invocationArray of funcSymbolAny.invocationMap.values()) {
      for (const inv of invocationArray as Invocation[]) {
        if (!inv.toScope) continue
        let arr = incoming.get(inv.toScope)
        if (!arr) {
          arr = []
          incoming.set(inv.toScope, arr)
        }
        arr.push({ callerInvocation: inv, callerCalleeType: inv.calleeType })
        // 如果 toScope 是子类 inherited copy，把同 caller 也聚合到 base class 同名 method
        // _base = base class fclos, fsig = method 名；base class fclos.value[fsig] = base method funcSymbol
        const inherited = (inv.toScope as any)?.func?.inherited
        if (inherited) {
          const baseClassFclos = (inv.toScope as any)?._base
          const fsig = inv.fsig
          if (baseClassFclos && fsig && baseClassFclos.value) {
            const baseMethod = baseClassFclos.value[fsig]
            if (baseMethod && baseMethod !== inv.toScope) {
              let baseArr = incoming.get(baseMethod)
              if (!baseArr) {
                baseArr = []
                incoming.set(baseMethod, baseArr)
              }
              baseArr.push({ callerInvocation: inv, callerCalleeType: inv.calleeType })
            }
          }
        }
      }
    }
  }
  return incoming
}

/**
 * caller-aware specialization：在 callgraph 落盘前做 receiver-sensitive 收敛
 *
 * 算法分两阶段：
 *
 * 采集阶段 扫描：对每个 funcSymbol M（owner class 是 abstract）的 fan-out callsite，
 *   反查 incomingMap[M]。安全门槛——**全部** caller 的 callerCalleeType 必须是
 *   concrete class（hierarchy 命中 + 非 abstract + 非 interface + 非 Object）。
 *   任一不满足 → 整 callsite skip（保留 CHA 全 fan-out 作保守 fallback）。
 *   全满足时 receiverSet = 所有 caller calleeType。在 fan-out invocations 中筛
 *   toScope.ownerClass ∈ receiverSet 的为 keepTargets；keepTargets 为空 → skip
 *   （不能 wipe-out 整个 callsite）。
 *
 * 离线阶段 删边：对 safeToDelete 集合，遍历 graph.edges，删除属于该 (fromNode,
 *   sharedCallSite) 但 toScope 不在 keepTargets 内的边。
 *
 * 设计要点：
 *   - 安全门槛保证不删反射 / 框架回调 / interface caller 场景的合理 fan-out
 *   - 不写 specialized 字段——callgraph.json 直接呈现 caller-aware 真图
 *   - inherited copy 的 caller 通过 buildIncomingInvocationMap 中的 _base 反查聚合到
 *     base method funcSymbol 的 incoming entry，保证 abstract base method 能找到 caller
 *
 * @param analyzer
 * @param resolver
 * @param graph 已填充原 fan-out 边的 Graph 实例
 * @param extractFuncDefInfo 主循环同款 helper（保留入参签名兼容；离线阶段 不再 addNode）
 * @param extractCallSiteInfo 主循环同款 helper（保留入参签名兼容；离线阶段 不再 addEdge）
 */
function applyCallerAwareSpecialization(
  analyzer: any,
  resolver: TypeRelatedInfoResolver,
  graph: any,
  extractFuncDefInfo: (ast: any) => { loc?: any; name?: any; id?: any } | null,
  extractCallSiteInfo: (callSite: any) => { loc?: any } | null
): void {
  // 占位引用避免 lint 报未用参数（保留入参签名兼容主循环调用 + 单测 fixture）
  void extractFuncDefInfo
  void extractCallSiteInfo

  const classHierarchyMap = resolver.classHierarchyMap
  if (!(classHierarchyMap instanceof Map) || classHierarchyMap.size === 0) return

  const incomingMap = buildIncomingInvocationMap(analyzer)

  // 采集阶段 收集 deletePlans
  type DeletePlan = {
    fromScope: any
    sharedCallSite: any
    keepTargetSet: Set<any>
  }
  const deletePlans: DeletePlan[] = []

  for (const funcSymbol of Object.values(analyzer.funcSymbolTable ?? {})) {
    const funcSymbolAny = funcSymbol as any
    if (!(funcSymbolAny.invocationMap instanceof Map)) continue

    // M 的 owner class 必须是 abstract class（C4）
    const ownerClass = getOwnerClassScope(funcSymbolAny)
    if (!ownerClass || !isAbstractClassScope(ownerClass)) continue

    const incoming = incomingMap.get(funcSymbolAny)
    if (!incoming || incoming.length === 0) continue

    for (const invocationArray of funcSymbolAny.invocationMap.values()) {
      const invocations = invocationArray as Invocation[]
      // C1：fan-out 数 >= 2
      if (!Array.isArray(invocations) || invocations.length < 2) continue
      // C2：所有 invocation 共享同一 callsite AST
      const sharedCallSite = invocations[0].callSite
      if (!sharedCallSite) continue
      if (!invocations.every((inv) => inv.callSite === sharedCallSite)) continue
      // C3：callsite 是 self-dispatch 形态
      if (!isSelfDispatchCallee(sharedCallSite)) continue

      // 安全门槛：**全部** caller callerCalleeType 必须是 concrete class，任一不满足 → skip
      let allConcrete = true
      const receiverSet = new Set<string>()
      for (const entry of incoming) {
        if (!isConcreteClassByHierarchy(entry.callerCalleeType, classHierarchyMap)) {
          allConcrete = false
          break
        }
        receiverSet.add(entry.callerCalleeType)
      }
      if (!allConcrete || receiverSet.size === 0) continue

      // 在 fan-out invocations 中筛 toScope.ownerClass ∈ receiverSet 的 keepTargets
      const keepTargetSet = new Set<any>()
      for (const inv of invocations) {
        const subOwnerQid = getOwnerClassQid(inv.toScope)
        if (subOwnerQid && receiverSet.has(subOwnerQid)) {
          keepTargetSet.add(inv.toScope)
        }
      }
      // 边界 C5：keepTargets 集合为空（receiver 类型与 fan-out toScope.ownerClass 不交集）
      // 不能 wipe-out 整 callsite，回退保留 fan-out
      if (keepTargetSet.size === 0) continue

      deletePlans.push({
        fromScope: invocations[0].fromScope,
        sharedCallSite,
        keepTargetSet,
      })
    }
  }

  if (deletePlans.length === 0) return

  // 离线阶段：删除被 specialized 覆盖的扇出边
  // 边归属判定：edge.opts.callSite.loc 与 sharedCallSite.loc 三元组（sourcefile + start.line + end.line）相等
  // 主循环灌图通过 extractCallSiteInfo 把 AST callSite 浅拷贝成 { loc } 后存入 edge.opts.callSite，
  // 所以必须用 loc 字段比较，AST 节点引用已不可用
  // keepTarget 判定：targetNode opts.funcSymbol identity ∈ keepTargetSet
  const edgesToDelete: string[] = []
  for (const [edgeId, edge] of graph.edges.entries()) {
    const edgeAny = edge as any
    const csLoc = edgeAny.opts?.callSite?.loc
    if (!csLoc) continue
    const targetNode = graph.nodes.get(edgeAny.targetNodeId)
    if (!targetNode) continue
    const toFs = targetNode.opts?.funcSymbol
    if (!toFs) continue
    for (const plan of deletePlans) {
      const planLoc = plan.sharedCallSite?.loc
      if (!planLoc) continue
      if (csLoc.sourcefile !== planLoc.sourcefile) continue
      if (csLoc.start?.line !== planLoc.start?.line) continue
      if (csLoc.end?.line !== planLoc.end?.line) continue
      if (csLoc.start?.column !== planLoc.start?.column) continue
      if (plan.keepTargetSet.has(toFs)) continue
      edgesToDelete.push(edgeId as string)
      break
    }
  }
  for (const id of edgesToDelete) {
    graph.edges.delete(id)
  }
}

/**
 * 从CallGraph中拿取边界作为全func类型的Entrypoint
 * @param callGraph
 * @param analyzer
 */
function getAllEntryPointsUsingCallGraph(callGraph: any, analyzer?: any): any[] {
  const entryPoints = {
    fclosEntryPoints: new Map<string, any>(),
  }
  const astManager = analyzer?.astManager
  const symbolTable = analyzer?.symbolTable

  for (const f of callGraph.nodes.keys()) {
    const thisNode = callGraph.nodes.get(f)
    // 从 nodehash 和 UUID 还原 funcDef 和 funcSymbol
    const thisNodeFuncDef =
      thisNode.opts?.funcDefNodehash && astManager
        ? astManager.get(thisNode.opts.funcDefNodehash)
        : thisNode.opts?.funcDef
    const thisNodeFuncSymbol =
      thisNode.opts?.funcSymbolUuid && symbolTable
        ? symbolTable.get(thisNode.opts.funcSymbolUuid)
        : thisNode.opts?.funcSymbol

    if (!thisNodeFuncDef) {
      continue
    }
    let hasCalled = false
    for (const ek of callGraph.edges.keys()) {
      // 需要准确比较ast上的loc，因为函数符号值由于有new等问题不一定是同一个
      const targetNode = callGraph.nodes.get(callGraph.edges.get(ek).targetNodeId)
      if (thisNode && targetNode && !callGraph.edges.get(ek)?.sourceNodeId.includes('entry_point')) {
        // 从 nodehash 还原 targetNode 的 funcDef
        const targetNodeFuncDef =
          targetNode.opts?.funcDefNodehash && astManager
            ? astManager.get(targetNode.opts.funcDefNodehash)
            : targetNode.opts?.funcDef

        if (
          targetNodeFuncDef?.loc?.sourcefile &&
          targetNodeFuncDef?.loc?.start?.line &&
          targetNodeFuncDef?.loc?.end?.line &&
          targetNodeFuncDef?.loc?.sourcefile === thisNodeFuncDef?.loc?.sourcefile &&
          targetNodeFuncDef?.loc?.start?.line === thisNodeFuncDef?.loc?.start?.line &&
          targetNodeFuncDef?.loc?.end?.line === thisNodeFuncDef?.loc?.end?.line
        ) {
          hasCalled = true
          break
        }
      }
    }
    if (!hasCalled && thisNodeFuncSymbol) {
      entryPoints.fclosEntryPoints.set(thisNode.id, thisNodeFuncSymbol)
    }
  }
  const newEntryPointList: any[] = []
  for (const entry of entryPoints.fclosEntryPoints.values()) {
    const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
    entryPoint.scopeVal = entry.parent
    entryPoint.argValues = []
    entryPoint.functionName = entry.ast.fdef?.id?.name
    entryPoint.filePath = entry.ast.fdef?.loc?.sourcefile?.startsWith(config.maindirPrefix)
      ? entry.ast.fdef?.loc?.sourcefile?.substring(config.maindirPrefix.length)
      : entry.ast.fdef?.loc?.sourcefile
    entryPoint.attribute = 'fullCallGraphMade'
    entryPoint.packageName = undefined
    entryPoint.entryPointSymVal = entry
    newEntryPointList.push(entryPoint)
  }
  return newEntryPointList
}

/**
 * 若为弱类型脚本语言，则加入所有文件作为EntryPoint
 * @param analyzer
 */
function getAllFileEntryPointsUsingFileManager(analyzer: any): any[] {
  const entryPoints: any[] = []
  if (options.language === 'python' || options.language === 'javascript') {
    if (analyzer?.fileManager) {
      Object.values(analyzer?.fileManager).forEach((fileEntry: any) => {
        const fileUuid = typeof fileEntry === 'string' ? fileEntry : fileEntry.uuid
        const file = analyzer.symbolTable.get(fileUuid)
        if (!file?.ast?.node || file.ast.node.type !== 'CompileUnit') return
        const entryPoint = new EntryPoint(constValue.ENGIN_START_FILE_BEGIN)
        entryPoint.scopeVal = file
        entryPoint.argValues = undefined
        entryPoint.functionName = undefined
        entryPoint.filePath = file?.ast?.node?.loc?.sourcefile
        entryPoint.attribute = 'fullfileManagerMade'
        entryPoint.packageName = undefined
        entryPoint.entryPointSymVal = file
        entryPoints.push(entryPoint)
      })
    }
  }
  return entryPoints
}

/**
 * 当函数内存在关键词时，推导函数对应的callGraph边界当Entrypoint（函数类型），不在函数内，就拿相应文件当Entrypoint（文件类型）
 * @param keywords need an array
 * @param callGraph
 * @param fileManager
 * @param analyzer
 */
function getEntryPointsUsingCallGraphByKeyWords(
  keywords: string[],
  callGraph: any,
  fileManager: any,
  analyzer?: any
): any[] {
  const newEntryPointList: any[] = []
  if (!callGraph || !keywords || !Array.isArray(keywords)) {
    return newEntryPointList
  }
  const astManager = analyzer?.astManager
  const symbolTable = analyzer?.symbolTable

  for (const keyword of keywords) {
    const alreadyCalculate: any[] = []
    const nodes = getNodeInCallGraphByKeyword(keyword, callGraph.nodes, astManager)
    for (const node of nodes) {
      // const node = getNodeInCallGraphByKeyword(keyword, callGraph.nodes)
      if (node) {
        const fclosNodes = getFclosEntryPointsUsingCallGraphByTargetNode(
          node.id,
          callGraph,
          alreadyCalculate,
          astManager,
          symbolTable
        )
        if (fclosNodes && Array.isArray(fclosNodes) && fclosNodes.length > 0) {
          for (const f of fclosNodes) {
            const { funcSymbol: entry } = restoreNodeFromReferences(f, astManager, symbolTable)
            if (!entry) continue
            const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
            entryPoint.scopeVal = entry.parent
            entryPoint.argValues = []
            entryPoint.functionName = entry.ast.fdef?.id?.name
            entryPoint.filePath = entry.ast.fdef?.loc?.sourcefile?.startsWith(config.maindirPrefix)
              ? entry.ast.fdef?.loc?.sourcefile?.substring(config.maindirPrefix.length)
              : entry.ast.fdef?.loc?.sourcefile
            entryPoint.attribute = 'FuncEntryPointByLoc'
            entryPoint.packageName = undefined
            entryPoint.entryPointSymVal = entry
            newEntryPointList.push(entryPoint)
          }
        }
      }
    }

    for (const fileEntry of Object.values(fileManager)) {
      const fileUuid = typeof fileEntry === 'string' ? fileEntry : (fileEntry as any).uuid
      const file = symbolTable?.get(fileUuid)
      if (!file) continue
      const content = sourceLine.getCodeBySourceFile(file?.ast?.node?.loc?.sourcefile)
      if (content.includes(keyword)) {
        const entryPoint = new EntryPoint(constValue.ENGIN_START_FILE_BEGIN)
        entryPoint.scopeVal = file
        entryPoint.argValues = undefined
        entryPoint.functionName = undefined
        entryPoint.filePath = file?.ast?.node?.sourcefile || file?.ast?.node?.loc?.sourcefile
        entryPoint.attribute = 'FileEntryPointByLoc'
        entryPoint.packageName = undefined
        entryPoint.entryPointSymVal = file
        newEntryPointList.push(entryPoint)
      }
    }
  }
  return newEntryPointList
}

/**
 * 当loc在函数内，推导函数对应的callGraph边界当Entrypoint（函数类型），不在函数内，就拿相应文件当Entrypoint（文件类型）
 * @param locs need an array
 * @param callGraph
 * @param fileManager
 * @param analyzer
 */
function getEntryPointsUsingCallGraphByLoc(locs: any[], callGraph: any, fileManager: any, analyzer?: any): any[] {
  const newEntryPointList: any[] = []
  if (!callGraph || !locs || !Array.isArray(locs)) {
    return newEntryPointList
  }
  const astManager = analyzer?.astManager
  const symbolTable = analyzer?.symbolTable

  for (const loc of locs) {
    if (!loc.sourcefile || !loc.start?.line || !loc.end?.line) {
      continue
    }
    const alreadyCalculate: any[] = []
    const node = getNodeInCallGraphByLoc(loc, callGraph.nodes, astManager)
    if (node) {
      const fclosNodes = getFclosEntryPointsUsingCallGraphByTargetNode(
        node.id,
        callGraph,
        alreadyCalculate,
        astManager,
        symbolTable
      )
      if (fclosNodes && Array.isArray(fclosNodes) && fclosNodes.length > 0) {
        for (const f of fclosNodes) {
          const { funcSymbol: entry } = restoreNodeFromReferences(f, astManager, symbolTable)
          if (!entry) continue
          const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
          entryPoint.scopeVal = entry.parent
          entryPoint.argValues = []
          entryPoint.functionName = entry.ast.fdef?.id?.name
          entryPoint.filePath = entry.ast.fdef?.loc?.sourcefile?.startsWith(config.maindirPrefix)
            ? entry.ast.fdef?.loc?.sourcefile?.substring(config.maindirPrefix.length)
            : entry.ast.fdef?.loc?.sourcefile
          entryPoint.attribute = 'FuncEntryPointByLoc'
          entryPoint.packageName = undefined
          entryPoint.entryPointSymVal = entry
          newEntryPointList.push(entryPoint)
        }
      }
    } else {
      const fileEntry = fileManager[loc.sourcefile]
      if (fileEntry) {
        const fileUuid = typeof fileEntry === 'string' ? fileEntry : (fileEntry as any).uuid
        const file = symbolTable?.get(fileUuid)
        if (file) {
          const entryPoint = new EntryPoint(constValue.ENGIN_START_FILE_BEGIN)
          entryPoint.scopeVal = file
          entryPoint.argValues = undefined
          entryPoint.functionName = undefined
          entryPoint.filePath = file?.ast?.node?.sourcefile || file?.ast?.node?.loc?.sourcefile
          entryPoint.attribute = 'FileEntryPointByLoc'
          entryPoint.packageName = undefined
          entryPoint.entryPointSymVal = file
          newEntryPointList.push(entryPoint)
        }
      }
    }
  }
  return newEntryPointList
}

/**
 *
 * @param key
 * @param callGraph
 * @param alreadyCalculate
 * @param astManager
 * @param symbolTable
 */
function getFclosEntryPointsUsingCallGraphByTargetNode(
  key: any,
  callGraph: any,
  alreadyCalculate: any[],
  astManager?: any,
  symbolTable?: any
): any[] | null {
  if (
    !key ||
    !callGraph ||
    !callGraph.nodes ||
    !callGraph.edges ||
    callGraph.nodes.size === 0 ||
    callGraph.edges.size === 0
  ) {
    return null
  }
  const targetNodes: any[] = [key]
  const circularDetected: any[] = []
  const res: any[] = []
  while (targetNodes.length > 0) {
    const n = targetNodes.shift()
    if (alreadyCalculate.includes(n)) {
      continue
    }
    if (circularDetected.includes(n)) {
      const node = callGraph.nodes.get(n)
      const { funcDef } = restoreNodeFromReferences(node, astManager, symbolTable)
      if (funcDef) {
        res.push(node)
      }
      continue
    }
    circularDetected.push(n)
    alreadyCalculate.push(n)
    let hasFind = false
    for (const ek of callGraph.edges.keys()) {
      // 需要准确比较ast上的loc，因为函数符号值由于有new等问题不一定是同一个
      const targetNode = callGraph.nodes.get(callGraph.edges.get(ek).targetNodeId)
      const thisNode = callGraph.nodes.get(n)
      const { funcDef: targetNodeAST } = restoreNodeFromReferences(targetNode, astManager, symbolTable)
      const { funcDef: thisNodeAST } = restoreNodeFromReferences(thisNode, astManager, symbolTable)
      if (
        thisNodeAST &&
        targetNodeAST &&
        callGraph.edges.get(ek)?.sourceNodeId &&
        !callGraph.edges.get(ek)?.sourceNodeId.includes('entry_point') &&
        targetNodeAST.loc?.sourcefile &&
        targetNodeAST.loc?.start?.line &&
        targetNodeAST.loc?.end?.line &&
        targetNodeAST.loc?.sourcefile === thisNodeAST.loc?.sourcefile &&
        targetNodeAST.loc?.start?.line === thisNodeAST.loc?.start?.line &&
        targetNodeAST.loc?.end?.line === thisNodeAST.loc?.end?.line
      ) {
        targetNodes.push(callGraph.edges.get(ek)?.sourceNodeId)
        hasFind = true
      }
    }
    if (!hasFind) {
      const node = callGraph.nodes.get(n)
      const { funcDef } = restoreNodeFromReferences(node, astManager, symbolTable)
      if (funcDef) {
        res.push(node)
      }
    }
  }
  return res
}

/**
 *
 * @param loc
 * @param nodes
 * @param astManager
 */
function getNodeInCallGraphByLoc(loc: any, nodes: any, astManager?: any): any {
  let tempStartLine = -1
  let tempEndLine = Number.MAX_VALUE
  let tempKey
  if (!loc.sourcefile || !loc.start?.line || !loc.end?.line || !nodes || nodes.length === 0) {
    return null
  }
  for (const key of nodes.keys()) {
    if (key.includes('\\n[')) {
      const node = nodes.get(key)
      const { funcDef } = restoreNodeFromReferences(node, astManager)
      const filename = funcDef?.loc?.sourcefile
      const startLine = funcDef?.loc?.start?.line
      const endLine = funcDef?.loc?.end?.line
      if (loc.sourcefile === filename && loc.start?.line >= startLine && loc.end?.line <= endLine) {
        if (startLine > tempStartLine && endLine < tempEndLine) {
          tempStartLine = startLine
          tempEndLine = endLine
          tempKey = key
        }
      }
    }
  }
  if (tempKey) return nodes.get(tempKey)
  return null
}

/**
 * 判断函数中是否包含关键字
 * @param keyword
 * @param nodes
 * @param astManager
 */
function getNodeInCallGraphByKeyword(keyword: string, nodes: any, astManager?: any): any[] {
  const result: any[] = []
  if (keyword === '') {
    return result
  }
  for (const key of nodes.keys()) {
    if (key.includes('\\n[')) {
      const node = nodes.get(key)
      const { funcDef } = restoreNodeFromReferences(node, astManager)
      if (funcDef) {
        const content = sourceLine.getCodeByLocation(funcDef?.loc)
        if (content.includes(keyword)) {
          result.push(node)
        }
      }
    }
  }
  return result
}

module.exports = {
  makeFullCallGraph,
  makeFullCallGraphByType,
  getAllEntryPointsUsingCallGraph,
  getAllFileEntryPointsUsingFileManager,
  getEntryPointsUsingCallGraphByLoc,
  getFclosEntryPointsUsingCallGraphByTargetNode,
  getEntryPointsUsingCallGraphByKeyWords,
  prettyPrint,
  // caller-aware specialization helpers（finalization 层各阶段 helper，单测引用）
  applyCallerAwareSpecialization,
  buildIncomingInvocationMap,
  isSelfDispatchCallee,
  isAbstractClassScope,
  isConcreteClassByHierarchy,
  getOwnerClassScope,
  getOwnerClassQid,
}
