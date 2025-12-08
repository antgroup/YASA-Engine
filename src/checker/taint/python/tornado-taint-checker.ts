import type { FileCache, RoutePair } from './tornado-util'

const PythonTaintAbstractChecker = require('./python-taint-abstract-checker')
const { extractRelativePath } = require('../../../util/file-util')
const AstUtil = require('../../../util/ast-util')
const Config = require('../../../config')
const completeEntryPoint = require('../common-kit/entry-points-util')
const logger = require('../../../util/logger')(__filename)
const {
  isTornadoCall,
  parseRoutePair,
  resolveImportPath,
  extractImportEntries,
  extractParamsFromAst,
  tornadoSourceAPIs,
  passthroughFuncs,
} = require('./tornado-util')

/**
 * Tornado Taint Checker Base Class
 */
class TornadoTaintChecker extends PythonTaintAbstractChecker {
  private fileCache = new Map<string, FileCache>()

  /**
   * Helper function to mark a value as tainted
   * @param value
   */
  private markAsTainted(value: any): void {
    if (!value) return
    if (!value._tags) {
      value._tags = new Set()
    }
    value._tags.add('PYTHON_INPUT')
    value.hasTagRec = true
  }

  /**
   *
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_python_tornado_input')
  }

  /**
   * trigger at start of analyze
   * Register sourceScope values as sources
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any): void {
    // 重新加载规则配置（因为可能在构造函数时还没有设置 ruleConfigFile）
    const BasicRuleHandler = require('../../common/rules-basic-handler')
    // 尝试从命令行参数获取 ruleConfigFile
    let { ruleConfigFile } = Config
    if (!ruleConfigFile || ruleConfigFile === '') {
      const args = process.argv
      const ruleConfigIndex = args.indexOf('--ruleConfigFile')
      if (ruleConfigIndex >= 0 && ruleConfigIndex < args.length - 1) {
        ruleConfigFile = args[ruleConfigIndex + 1]
        const path = require('path')
        ruleConfigFile = path.isAbsolute(ruleConfigFile) ? ruleConfigFile : path.resolve(process.cwd(), ruleConfigFile)
      }
    }
    try {
      let ruleConfigContent: any[] = []
      if (ruleConfigFile && ruleConfigFile !== '') {
        const FileUtil = require('../../../util/file-util')
        ruleConfigContent = FileUtil.loadJSONfile(ruleConfigFile)
      } else {
        ruleConfigContent = BasicRuleHandler.getRules()
      }
      if (Array.isArray(ruleConfigContent) && ruleConfigContent.length > 0) {
        for (const ruleConfig of ruleConfigContent) {
          if (
            ruleConfig.checkerIds &&
            ((Array.isArray(ruleConfig.checkerIds) &&
              ruleConfig.checkerIds.length > 0 &&
              ruleConfig.checkerIds.includes(this.getCheckerId())) ||
              ruleConfig.checkerIds === this.getCheckerId())
          ) {
            const { mergeAToB } = require('../../../util/common-util')
            mergeAToB(ruleConfig, this.checkerRuleConfigContent)
          }
        }
      }
    } catch (e: any) {
      logger.warn(`Error reloading rule config: ${e?.message || e}`)
    }
    // 注册 sourceScope 中的 source
    this.addSourceTagForSourceScope('PYTHON_INPUT', this.sourceScope.value)
    // 注册规则配置中的 source
    this.addSourceTagForcheckerRuleConfigContent('PYTHON_INPUT', this.checkerRuleConfigContent)
  }

  /**
   * Build a light-weight file cache for quick lookup.
   * @param analyzer
   * @param scope
   * @param node
   * @param _state
   * @param _info
   */
  triggerAtCompileUnit(analyzer: any, scope: any, node: any, _state: any, _info: any): boolean | undefined {
    const fileName = node.loc?.sourcefile
    if (!fileName) return

    const cache: FileCache = {
      vars: new Map(),
      classes: new Map(),
      importedSymbols: new Map(),
    }

    AstUtil.visit(node, {
      AssignmentExpression: (n: any) => {
        if (n.left?.type === 'Identifier' && n.left.name) {
          cache.vars.set(n.left.name, { value: n.right, file: fileName })
        }
        return true
      },
      VariableDeclaration: (n: any) => {
        const localName = n.id?.name
        if (!localName) return true
        if (n.init?.type === 'ImportExpression') {
          const modulePath = n.init.from?.value || n.init.from?.name
          if (!modulePath) return true
          const resolved = resolveImportPath(modulePath, fileName)
          if (!resolved) return true
          const entries = extractImportEntries(n)
          for (const entry of entries) {
            if (!entry.local) continue
            cache.importedSymbols.set(entry.local, {
              file: resolved,
              originalName: entry.imported,
            })
          }
          return true
        }
        if (n.init) {
          cache.vars.set(localName, { value: n.init, file: fileName })
        }
        return true
      },
      ClassDefinition: (n: any) => {
        const name = n.name?.name || n.id?.name
        if (name) {
          cache.classes.set(name, { value: n, file: fileName })
        }
        return true
      },
    })

    this.fileCache.set(fileName, cache)
  }

  /**
   * On function calls, detect tornado Application/add_handlers and collect routes.
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param _info
   */
  triggerAtFuncCallSyntax(analyzer: any, scope: any, node: any, state: any, _info: any): boolean | undefined {
    const fileName = node.loc?.sourcefile
    if (!fileName) return

    // Application(...) -> first arg is routes
    if (isTornadoCall(node, 'Application')) {
      const routeList = node.arguments?.[0]
      if (routeList) {
        this.collectTornadoEntrypointAndSource(analyzer, scope, state, routeList, fileName)
      }
    }

    // add_handlers(host, routes) -> second arg is routes
    if (isTornadoCall(node, 'add_handlers')) {
      const routeList = node.arguments?.[1]
      if (routeList) {
        this.collectTornadoEntrypointAndSource(analyzer, scope, state, routeList, fileName)
      }
    }
  }

  /**
   * Override triggerAtIdentifier to mark path parameters as sources
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtIdentifier(analyzer: any, scope: any, node: any, state: any, info: any): void {
    // 先调用基类方法
    super.triggerAtIdentifier(analyzer, scope, node, state, info)
    // 如果基类方法没有标记（因为 preprocessReady=false），直接标记
    const { res } = info
    if (res && this.sourceScope.value && this.sourceScope.value.length > 0) {
      for (const val of this.sourceScope.value) {
        if (val.path === node.name || res._sid === val.path || res._qid === val.path) {
          // 检查作用域匹配
          const nodeStart = node.loc?.start?.line
          const nodeEnd = node.loc?.end?.line
          const valStart = val.locStart
          const valEnd = val.locEnd
          let shouldMark = false
          if (valStart === 'all' && valEnd === 'all' && val.scopeFile === 'all' && val.scopeFunc === 'all') {
            shouldMark = true
          } else if (
            valStart === 'all' &&
            valEnd === 'all' &&
            val.scopeFile !== 'all' &&
            val.scopeFunc === 'all' &&
            typeof node.loc?.sourcefile === 'string' &&
            node.loc.sourcefile.includes(val.scopeFile)
          ) {
            shouldMark = true
          } else if (
            node.loc?.sourcefile &&
            val.scopeFile &&
            node.loc.sourcefile.includes(val.scopeFile) &&
            typeof nodeStart === 'number' &&
            typeof valStart === 'number' &&
            typeof nodeEnd === 'number' &&
            typeof valEnd === 'number' &&
            nodeStart >= valStart &&
            nodeEnd <= valEnd
          ) {
            shouldMark = true
          }
          if (shouldMark && (!res._tags || !res._tags.has('PYTHON_INPUT'))) {
            if (!res._tags) {
              res._tags = new Set()
            }
            res._tags.add('PYTHON_INPUT')
            res.hasTagRec = true
          }
        }
      }
    }
  }

  /**
   * Override checkByNameMatch to support partial matching (e.g., os.system matches syslib_from.os.system)
   * @param node
   * @param fclos
   * @param argvalues
   */
  checkByNameMatch(node: any, fclos: any, argvalues: any) {
    const rules = this.checkerRuleConfigContent.sinks?.FuncCallTaintSink
    if (!rules || rules.length === 0) {
      return
    }
    const callFull = this.getObj(fclos)
    if (!callFull) {
      super.checkByNameMatch(node, fclos, argvalues)
      return
    }
    // 检查是否有匹配的规则（支持部分匹配）
    const matchedRule = rules.find((rule: any) => {
      if (typeof rule.fsig !== 'string') return false
      return rule.fsig === callFull || callFull.endsWith(`.${rule.fsig}`) || callFull.endsWith(rule.fsig)
    })
    // 如果有匹配的规则，调用基类方法处理
    if (matchedRule) {
      super.checkByNameMatch(node, fclos, argvalues)
    }
  }

  /**
   * Handle API calls like self.get_argument()
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallAfter(analyzer: any, scope: any, node: any, state: any, info: any): void {
    // 先调用基类方法处理规则配置中的 source
    super.triggerAtFunctionCallAfter(analyzer, scope, node, state, info)

    const { fclos, ret } = info
    if (!fclos || !ret) {
      return
    }

    // 从 node.callee 获取方法名（对于 MemberAccess 调用，如 self.get_argument）
    let funcName: string | null = null
    if (node.callee?.type === 'MemberAccess') {
      funcName = node.callee.property?.name
    } else if (node.callee?.type === 'Identifier') {
      funcName = node.callee.name
    }

    // 检查是否是 tornado source API 调用（如 get_argument）
    if (funcName && tornadoSourceAPIs.has(funcName)) {
      this.markAsTainted(ret)
    }

    // 处理 passthrough 函数（如 decode, strip 等）
    if (funcName && passthroughFuncs.has(funcName)) {
      // 检查是否是 self.request.body.decode 等 source
      // 对于 self.request.body.decode('utf-8')，AST 结构：
      // node.callee.object.type = 'MemberAccess' (body)
      // node.callee.object.object.type = 'MemberAccess' (request)
      // node.callee.object.object.object.name = 'self'
      if (node.callee?.type === 'MemberAccess' && node.callee.object) {
        const bodyNode = node.callee.object
        if (
          bodyNode.type === 'MemberAccess' &&
          bodyNode.property?.name === 'body' &&
          bodyNode.object?.type === 'MemberAccess' &&
          bodyNode.object.property?.name === 'request' &&
          bodyNode.object.object?.name === 'self'
        ) {
          // 直接标记返回值为 source（因为 self.request.body 是 source）
          this.markAsTainted(ret)
          return // 已经标记，不需要再检查 receiver
        }
      }
      // 检查 receiver 是否被污染
      const receiver = fclos?.object || fclos?._this
      if (receiver && (receiver.taint || receiver.hasTagRec || receiver._tags?.has('PYTHON_INPUT'))) {
        this.markAsTainted(ret)
      }
    }
  }

  /**
   * Handle Member Access Sources like self.request.body
   * [Fixed]: Now checks AST node structure instead of symbolic result
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtMemberAccess(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const { res } = info

    if (node.type === 'MemberAccess' && node.object?.type === 'MemberAccess') {
      const propName = node.property?.name
      const subPropName = node.object?.property?.name
      const baseObjName = node.object?.object?.name

      if (
        baseObjName === 'self' &&
        subPropName === 'request' &&
        ['body', 'query', 'headers', 'cookies'].includes(propName)
      ) {
        this.markAsTainted(res)
      }
    }
  }

  /**
   * Resolve symbol cross-file
   * @param name
   * @param currentFile
   */
  private resolveSymbol(name: string, currentFile: string): any | null {
    if (!name || !currentFile) return null
    const cache = this.fileCache.get(currentFile)
    if (!cache) return null
    const { vars, classes, importedSymbols } = cache
    if (vars.has(name)) {
      const entry = vars.get(name)
      if (entry?.value) {
        entry.value.loc = entry.value.loc || {}
        entry.value.loc.sourcefile = entry.file
        return entry.value
      }
    }
    if (classes.has(name)) {
      const entry = classes.get(name)
      if (entry?.value) {
        entry.value.loc = entry.value.loc || {}
        entry.value.loc.sourcefile = entry.file
        return entry.value
      }
    }

    const importInfo = importedSymbols.get(name)
    if (!importInfo) return null
    const targetCache = this.fileCache.get(importInfo.file)
    if (!targetCache) return null
    const targetName = importInfo.originalName || name
    if (targetCache.vars.has(targetName)) {
      const entry = targetCache.vars.get(targetName)
      if (entry?.value) {
        entry.value.loc = entry.value.loc || {}
        entry.value.loc.sourcefile = entry.file
        return entry.value
      }
    }
    if (targetCache.classes.has(targetName)) {
      const entry = targetCache.classes.get(targetName)
      if (entry?.value) {
        entry.value.loc = entry.value.loc || {}
        entry.value.loc.sourcefile = entry.file
        return entry.value
      }
    }
    return null
  }

  /**
   * Flatten route lists (handles BinaryExpression +)
   * @param node
   * @param currentFile
   */
  private normalizeRoutes(node: any, currentFile: string): RoutePair[] {
    if (!node) return []

    if (node.type === 'ListExpression' || node.type === 'ArrayExpression') {
      const elements = node.elements || []
      return elements.flatMap((element: any) => this.normalizeRoutes(element, currentFile))
    }

    if (node.type === 'BinaryExpression') {
      return [...this.normalizeRoutes(node.left, currentFile), ...this.normalizeRoutes(node.right, currentFile)]
    }

    if (node.type === 'ObjectExpression') {
      const values = node.properties?.map((prop: any) => prop.value).filter(Boolean) || []
      return values.flatMap((value: any) => this.normalizeRoutes(value, node.loc?.sourcefile || currentFile))
    }

    if (node.type === 'Identifier') {
      const target = this.resolveSymbol(node.name, currentFile)
      if (!target) return []
      const targetFile = target.loc?.sourcefile || currentFile
      return this.normalizeRoutes(target, targetFile)
    }

    const pair = parseRoutePair(node)
    return pair ? [{ ...pair, file: currentFile }] : []
  }

  /**
   * Analyze routes and emit entrypoints & sources
   * @param analyzer
   * @param scope
   * @param state
   * @param routeList
   * @param currentFile
   */
  private collectTornadoEntrypointAndSource(
    analyzer: any,
    scope: any,
    state: any,
    routeList: any,
    currentFile: string
  ) {
    const processed = new Set<string>()
    const normalizedRoutes = this.normalizeRoutes(routeList, currentFile)
    for (const pair of normalizedRoutes) {
      if (!pair.path || !pair.handlerName) {
        continue
      }
      const dedupKey = `${pair.file || currentFile}::${pair.handlerName}::${pair.path}`
      if (processed.has(dedupKey)) {
        continue
      }
      processed.add(dedupKey)
      const classAst = this.resolveSymbol(pair.handlerName, pair.file || currentFile)
      if (!classAst || classAst.type !== 'ClassDefinition') {
        continue
      }
      const classFile = classAst.loc?.sourcefile || pair.file || currentFile
      // 使用 analyzer.processInstruction 来处理类对象，确保有正确的结构
      let handlerSymVal: any
      try {
        handlerSymVal = analyzer.processInstruction(scope, classAst, state)
        if (!handlerSymVal || handlerSymVal.vtype !== 'class') {
          handlerSymVal = this.buildClassSymbol(classAst)
          if (!handlerSymVal.field) {
            handlerSymVal.field = {}
          }
        }
      } catch (e) {
        handlerSymVal = this.buildClassSymbol(classAst)
        if (!handlerSymVal.field) {
          handlerSymVal.field = {}
        }
      }
      // 确保 handlerSymVal 有 field 结构
      if (handlerSymVal && handlerSymVal.vtype === 'class' && !handlerSymVal.field) {
        handlerSymVal.field = {}
      }
      this.emitHandlerEntrypoints(analyzer, handlerSymVal, pair.path, classAst, scope, state)
    }
  }

  /**
   * Register EntryPoints and Path Param Sources
   * [Fixed]: Removed Config check to forcefully register parameters as sources
   * @param analyzer
   * @param handlerSymVal
   * @param urlPattern
   * @param classAst
   * @param scope
   * @param state
   */
  private emitHandlerEntrypoints(
    analyzer: any,
    handlerSymVal: any,
    urlPattern: string,
    classAst: any,
    scope?: any,
    state?: any
  ) {
    if (!handlerSymVal || handlerSymVal.vtype !== 'class') {
      return
    }
    const httpMethods = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options'])
    const entrypoints = Object.entries(handlerSymVal.value)
      .filter(([key, value]: [string, any]) => httpMethods.has(key) && value.vtype === 'fclos')
      .map(([, value]: [string, any]) => value)

    for (const ep of entrypoints as any[]) {
      // ignore init files
      if (ep.fdef?.loc?.sourcefile?.endsWith('__init__.py')) {
        continue
      }

      // 尝试使用 analyzer.processInstruction 获取正确的 fclos 对象
      let finalEp = ep
      if (scope && state && ep.fdef) {
        try {
          const processedFclos = analyzer.processInstruction(scope, ep.fdef, state)
          if (processedFclos && processedFclos.vtype === 'fclos') {
            processedFclos.parent = handlerSymVal
            processedFclos.params = ep.params || extractParamsFromAst(ep.fdef)
            if (!processedFclos.value) {
              processedFclos.value = {}
            }
            finalEp = processedFclos
          }
        } catch (e) {
          // fallback to original ep
        }
      }
      // 确保 ep 有 value 属性
      if (!finalEp.value) {
        finalEp.value = {}
      }

      // 确保 finalEp.parent 正确设置，并且 handlerSymVal 有 field 结构
      if (handlerSymVal && handlerSymVal.vtype === 'class') {
        if (!handlerSymVal.field) {
          handlerSymVal.field = {}
        }
        finalEp.parent = handlerSymVal
      }

      try {
        // 确保 finalEp 有 completeEntryPoint 需要的属性
        if (!finalEp.ast && finalEp.fdef) {
          finalEp.ast = finalEp.fdef
        }
        if (!finalEp.functionName) {
          finalEp.functionName = finalEp.fdef?.name?.name || finalEp.fdef?.id?.name || finalEp.name || ''
        }
        // 确保 finalEp 有 filePath
        if (!finalEp.filePath && finalEp.fdef?.loc?.sourcefile) {
          const FileUtil = require('../../../util/file-util')
          const { sourcefile } = finalEp.fdef.loc
          if (Config.maindir && typeof Config.maindir === 'string') {
            finalEp.filePath = FileUtil.extractRelativePath(sourcefile, Config.maindir)
          } else {
            finalEp.filePath = sourcefile
          }
        }
        const entryPoint = completeEntryPoint(finalEp)
        // 确保 entryPoint.entryPointSymVal.parent 有 field 结构
        if (
          entryPoint.entryPointSymVal?.parent &&
          entryPoint.entryPointSymVal.parent.vtype === 'class' &&
          !entryPoint.entryPointSymVal.parent.field
        ) {
          entryPoint.entryPointSymVal.parent.field = {}
        }
        analyzer.entryPoints.push(entryPoint)
      } catch (e: any) {
        logger.warn(`Error in completeEntryPoint: ${e?.message || e}`)
        continue
      }
      // 注册参数为 source
      const funcName = finalEp.fdef?.name?.name || finalEp.fdef?.id?.name || finalEp.name || ''
      const sourceFile = finalEp.fdef?.loc?.sourcefile || classAst?.loc?.sourcefile || ''
      let scopeFile: string | null = null
      if (sourceFile) {
        if (Config.maindir && typeof Config.maindir === 'string') {
          scopeFile = extractRelativePath(sourceFile, Config.maindir)
        } else {
          scopeFile = sourceFile
        }
      }

      const paramMetas =
        (Array.isArray((finalEp as any).params) && (finalEp as any).params.length
          ? (finalEp as any).params
          : extractParamsFromAst(finalEp.fdef)) || []
      if (paramMetas.length > 0) {
        for (const meta of paramMetas) {
          if (meta.name === 'self') continue

          this.sourceScope.value.push({
            path: meta.name,
            kind: 'PYTHON_INPUT',
            scopeFile,
            scopeFunc: funcName || 'all',
            locStart: meta.locStart,
            locEnd: meta.locEnd,
          })
        }
      }
    }
  }

  /**
   *
   * @param classNode
   */
  private buildClassSymbol(classNode: any): any {
    const value: any = {}
    const members = classNode.body || []
    members.forEach((member: any) => {
      if (member.type !== 'FunctionDefinition') return
      const memberName = member.name?.name || member.name?.id?.name || member.id?.name
      if (memberName) {
        value[memberName] = {
          vtype: 'fclos',
          fdef: member,
          ast: member,
          params: extractParamsFromAst(member),
        }
      }
    })
    return { vtype: 'class', value }
  }
}

export = TornadoTaintChecker
