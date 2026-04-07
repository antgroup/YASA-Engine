/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-unused-vars, @typescript-eslint/no-use-before-define */
import JavaTypeRelatedInfoResolver from '../../../../resolver/java/java-type-related-info-resolver'
import type { Invocation } from '../../../../resolver/common/value/invocation'
import type { ClassHierarchy } from '../../../../resolver/common/value/class-hierarchy'
import { InnerFuncDefVisitor } from '../../common/ast-visitor'
import type {
  Scope,
  State,
  Value,
  SymbolValue as SymbolValueType,
  VoidValue as VoidValueType,
  BinaryExprValue,
  UnaryExprValue,
} from '../../../../types/analyzer'
import type {
  CompileUnit,
  VariableDeclaration,
  Identifier,
  MemberAccess,
  ClassDefinition,
  AssignmentExpression,
  BinaryExpression,
  CallExpression,
  NewExpression,
  UnaryExpression,
  TryStatement,
  RangeStatement,
  FunctionDefinition,
} from '../../../../types/uast'
import type { PrimitiveValue as PrimitiveValueType } from '../../../../types/value'

const _ = require('lodash')
const fs = require('fs')
const path = require('path')
const UastSpec = require('@ant-yasa/uast-spec')
const QidUnifyUtil = require('../../../../util/qid-unify-util')
const FileUtil = require('../../../../util/file-util')
const logger: import('../../../../util/logger').Logger = require('../../../../util/logger')(__filename)
const ScopeClass = require('../../common/scope')
const Parser = require('../../../parser/parser')
const JavaInitializer = require('./java-initializer')
const BasicRuleHandler = require('../../../../checker/common/rules-basic-handler')
const {
  ValueUtil: { FunctionValue, Scoped, PackageValue, PrimitiveValue, SymbolValue, VoidValue },
} = require('../../../util/value-util')
const Analyzer: typeof import('../../common/analyzer').Analyzer = require('../../common/analyzer')
const CheckerManager = require('../../common/checker-manager')
const CurrentEntryPoint = require('../../common/current-entrypoint')
const Constant = require('../../../../util/constant')
const Config = require('../../../../config')
const { handleException } = require('../../common/exception-handler')
const {
  ValueUtil: { UndefinedValue },
} = require('../../../util/value-util')
const FullCallGraphFileEntryPoint = require('../../../../checker/common/full-callgraph-file-entrypoint')
const AstUtil = require('../../../../util/ast-util')
const SourceLine = require('../../common/source-line')
const { checkInvocationMatchSink } = require('../../../../checker/taint/common-kit/sink-util')
const { filterDataFromScope } = require('../../../../util/common-util')
import type { CallInfo } from '../../common/call-args'
const { getLegacyArgValues } = require('../../common/call-args')

/**
 * Java 代码分析器
 */
class JavaAnalyzer extends Analyzer {
  private unprocessedFileScopes?: Set<Scope>

  /**
   * 构造函数
   * @param options - 分析器选项
   */
  constructor(options: any) {
    const checkerManager = new CheckerManager(
      options,
      options.checkerIds,
      options.checkerPackIds,
      options.printers,
      BasicRuleHandler
    )
    super(checkerManager, options)
    this.classMap = new Map()
    this.typeResolver = new JavaTypeRelatedInfoResolver()
    this.entryPointSymValArray = []
    this.globalState = {}
    this.enableLibArgToThis = true
    this.enablePruneDuringInterpret = true
    this.pruneInfoMap = {
      aggressiveMode: false,
      sinkArray: [],
      funcCallSourceSinkSanitizerArray: [],
      otherSourceArray: [],
      otherSanitizerArray: [],
      matchSinkCacheMap: new Map(),
      matchSinkNoRecurseCacheMap: new Map(),
      matchFuncCallSourceSinkSanitizerCacheMap: new Map(),
      dynamicClassArray: [
        'Class',
        'Thread',
        'Runnable',
        'java.util.Timer',
        'java.util.TimerTask',
        'org.springframework.util.ReflectionUtils',
      ],
      dynamicPackageArray: [
        'java.util.concurrent',
        'java.lang.reflect',
        'java.util.function',
        'org.springframework.core.task',
        'org.springframework.scheduling',
        'org.springframework.util.function',
        'org.springframework.retry',
        'org.springframework.web.reactive.function',
        'org.springframework.web.servlet.function',
        'org.springframework.integration.dsl',
        'org.springframework.cloud.function',
        'org.springframework.kafka.listener',
        'reactor.core',
      ],
    }
    this.timeoutEntryPoints = []
    this.extraClassHierarchyByNameMap = new Map()
  }

  /**
   * 预处理单个文件
   * @param source - 源代码内容
   * @param fileName - 文件名
   */
  preProcess4SingleFile(source: any, fileName: any) {
    JavaInitializer.initGlobalScope(this.topScope)
    JavaInitializer.initPackageScope(this.topScope.context.packages)

    this.preloadFileToPackage(source, fileName)
    for (const unprocessedFileScope of this.unprocessedFileScopes!) {
      if (unprocessedFileScope.isProcessed) continue
      const state = this.initState(unprocessedFileScope)
      this.processInstruction(unprocessedFileScope, unprocessedFileScope.ast?.node, state)
    }
    this.unprocessedFileScopes?.clear()
    this.unprocessedFileScopes = undefined

    this.assembleClassMap(this.topScope.context.packages)

    JavaInitializer.addClassProto(this.classMap, this.topScope.context.packages, this)
  }

  /**
   * 扫描项目目录，解析 Java 文件并预构建包作用域
   *
   * @param dir - 项目目录
   */
  // eslint-disable-next-line complexity
  async scanPackages(dir: any) {
    this.unprocessedFileScopes = new Set()
    const PARSE_CODE_STAGE = 'preProcess.parseCode'
    const PRELOAD_STAGE = 'preProcess.preload'

    // 开始解析阶段：解析源代码为 AST
    this.performanceTracker.start(PARSE_CODE_STAGE)
    const astMap = await Parser.parseProject(dir, this.options, this.sourceCodeCache)
    this.performanceTracker.end(PARSE_CODE_STAGE)

    // 防御性检查：确保 astMap 不为 null 或 undefined
    if (!astMap) {
      handleException(
        null,
        'JavaAnalyzer.scanPackages: parseProject returned null or undefined',
        'JavaAnalyzer.scanPackages: parseProject returned null or undefined'
      )
      return
    }

    // 开始预加载阶段：预构建包作用域
    this.performanceTracker.start(PRELOAD_STAGE)
    for (const filename in astMap) {
      const ast = astMap[filename]
      if (ast) {
        // sourceCodeCache 已在 parseProject 中自动填充，不需要重新读取
        const code = this.sourceCodeCache.get(filename)
        this.preloadFileToPackage(code ? code.join('\n') : '', filename, ast)
      }
    }
    this.performanceTracker.end(PRELOAD_STAGE)
    // 开始 ProcessModule 阶段：处理所有文件作用域（分析 AST）
    const PROCESS_MODULE_STAGE = 'preProcess.processModule'
    this.performanceTracker.start(PROCESS_MODULE_STAGE)
    for (const unprocessedFileScope of this.unprocessedFileScopes!) {
      if (unprocessedFileScope.isProcessed) continue
      // unprocessedFileScope.isProcessed = true;
      const state = this.initState(unprocessedFileScope)
      this.processInstruction(unprocessedFileScope, unprocessedFileScope.ast?.node, state)
    }
    this.unprocessedFileScopes?.clear()
    this.unprocessedFileScopes = undefined
    this.performanceTracker.end('preProcess.processModule')

    // 输出时间统计（performanceTracker 已自动输出各阶段耗时）
  }

  /**
   * preload built-in packages
   */
  preloadBuiltinToPackage() {
    // this._preloadBuiltinToPackage('java.util', 'ArrayList', (arrayList as any))
  }

  /**
   * 预加载内置包到包管理器
   * @param packageName - 包名
   * @param className - 类名
   * @param methods - 方法集合
   */
  _preloadBuiltinToPackage(packageName: string, className: string, methods: any) {
    const packageScope = this.topScope.context.packages.getSubPackage(packageName, true)
    const qualifiedName = ScopeClass.joinQualifiedName(packageScope.qid, className)
    const classScope = ScopeClass.createSubScope(className, packageScope, 'class', qualifiedName)
    if (!packageScope.scope.exports) {
      packageScope.scope.exports = new Scoped(packageScope.qid, {
        sid: 'exports',
        parent: packageScope,
      })
    }
    packageScope.scope.exports.value[className] = classScope
    for (const prop in methods) {
      const method = methods[prop]
      const targetQid = `${classScope.qid}.${prop}`
      classScope.value[prop] = new FunctionValue('', {
        sid: prop,
        qid: targetQid,
        parent: classScope,
        runtime: { execute: method.bind(this) },
        _this: classScope,
      })
      this.funcSymbolTable[QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(targetQid)] = classScope.value[prop]
    }
  }

  /**
   * 解析文件并预加载到包管理器
   *
   * 注意：此方法在循环中被调用多次，每个文件的 parseCode 和 preload 时间都会累加到总时间中。
   * 如果提供了 preParsedAst，直接使用，避免重复解析。
   *
   * @param source - 源代码内容
   * @param filename - 文件名
   * @param preParsedAst - 可选的预解析 AST（来自 parseProject，如果提供则直接使用，避免重复解析）
   * @returns {any} 包作用域和文件作用域
   */
  preloadFileToPackage(source: any, filename: any, preParsedAst?: any) {
    const { options } = this
    options.sourcefile = filename

    const ast = preParsedAst || Parser.parseSingleFile(filename, options, this.sourceCodeCache)

    if (!ast) {
      handleException(
        null,
        `JavaAnalyzer.preloadFileToPackage: parse failed: ${filename}`,
        `JavaAnalyzer.preloadFileToPackage: parse failed: ${filename}`
      )
      return
    }
    if (!ast || ast.type !== 'CompileUnit') {
      handleException(
        null,
        `JavaAnalyzer.preloadFileToPackage: node type should be CompileUnit, but ${ast?.type}`,
        `JavaAnalyzer.preloadFileToPackage: node type should be CompileUnit, but ${ast?.type}`
      )
      // 清理 parse 失败时的 sourceCodeCache，避免后续代码误认为文件已处理
      if (this.sourceCodeCache && this.sourceCodeCache.get(filename)) {
        this.sourceCodeCache.delete(filename)
      }
      return undefined
    }
    const packageName = ast._meta.qualifiedName ?? ''

    const packageScope = this.topScope.context.packages.getSubPackage(packageName, true)

    // 开始记录 preload 时间：初始化文件作用域、处理类定义等
    this.performanceTracker.record('preProcess.preload')?.start()

    // file scope init
    // value specifies what module exports, closure specifies file closure
    const fileScope = this.initFileScope(ast, filename, packageScope)
    this.unprocessedFileScopes = this.unprocessedFileScopes ?? new Set()
    this.unprocessedFileScopes.add(fileScope)

    const { body } = ast
    this.entry_fclos = fileScope
    this.thisFClos = fileScope

    const state = this.initState(fileScope)
    // prebuild
    body.forEach((childNode: any) => {
      if (childNode.type === 'ExportStatement') {
        // the argument of ExportStatement is must be a ClassDefinition
        const classDef = childNode.argument
        if (classDef?.type !== 'ClassDefinition') {
          logger.fatal(`the argument of ExportStatement must be a ClassDefinition, check violation in ${filename}`)
        }
        const { className, classClos } = this.preprocessClassDefinitionRec(classDef, fileScope, fileScope, packageScope)
        if (classDef._meta.isPublic) {
          packageScope.scope.exports =
            packageScope.scope.exports ??
            new Scoped(packageScope.qid, {
              sid: 'export',
              parent: packageScope,
            })
          packageScope.scope.exports.setFieldValue(className, classClos)
        }
        packageScope.setFieldValue(className, classClos)
      } else if (childNode.type === 'ClassDefinition') {
        const { className, classClos } = this.preprocessClassDefinitionRec(childNode, fileScope, fileScope)
        packageScope.setFieldValue(className, classClos)
      }
    })

    // post handle module for module export
    // const moduleExports = modClos.getFieldValue('module.exports');
    // if (moduleExports !== {}) {
    //     modScope.value = moduleExports;
    // }

    if (this.checkerManager && this.checkerManager.checkAtEndOfCompileUnit) {
      this.checkerManager.checkAtEndOfCompileUnit(this, null, null, state, null)
    }
    this.fileManager[filename] = fileScope.uuid

    // 记录 preload 时间：累加到总 preload 时间中
    this.performanceTracker.record('preProcess.preload')?.end()

    return { packageScope, fileScope }
  }

  /**
   * 递归预处理类定义
   * @param node - AST 节点
   * @param scope - 作用域
   * @param fileScope - 文件作用域
   * @param packageScope - 包作用域
   * @returns {any} 类作用域
   */
  preprocessClassDefinitionRec(node: any, scope: any, fileScope: any, packageScope?: any) {
    const className = node.id?.name

    const classClos = ScopeClass.createSubScope(
      className,
      scope,
      'class',
      ScopeClass.joinQualifiedName(scope.qid, className)
    )
    classClos.scope.exports = new Scoped(classClos.qid, {
      sid: 'exports',
      parent: classClos,
    })
    if (node._meta.isPublic) {
      scope.scope.exports =
        scope.scope.exports ??
        new Scoped(classClos.qid, {
          sid: 'exports',
          parent: classClos,
        })
      scope.scope.exports.setFieldValue(className, classClos)
    }
    classClos.ast = node
    classClos.ast.fdef = node
    classClos.scope.fileScope = fileScope
    classClos.packageScope = packageScope
    const { body } = node
    if (!body) {
      return { className, classClos }
    }
    body.forEach((child: any) => {
      if (child.type === 'ClassDefinition') {
        this.preprocessClassDefinitionRec(child, classClos, fileScope, packageScope)
      }
    })
    return { className, classClos }
  }

  /**
   * process instruction
   * @param scope
   * @param node
   * @param state
   * @param prePostFlag
   * @returns {*}
   */
  override processInstruction(scope: any, node: any, state: any, prePostFlag?: any): any {
    if (
      state.entryPointStartTimestamp &&
      Config.entryPointTimeoutMs &&
      Date.now() - state.entryPointStartTimestamp > Config.entryPointTimeoutMs
    ) {
      this.globalState.entryPointTimeout = true
      return new UndefinedValue()
    }
    let hasException: boolean = false
    if (state?.throwstackScopeAndState) {
      for (const element of state.throwstackScopeAndState) {
        if (element.scope === scope && element.state === state) {
          hasException = true
        }
      }
    }
    if (hasException) {
      return new UndefinedValue()
    }
    return super.processInstruction(scope, node, state, prePostFlag)
  }

  /**
   * 处理编译单元
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 处理结果
   */
  override processCompileUnit(scope: Scope, node: CompileUnit, state: State): Value {
    scope.isProcessed = true
    return super.processCompileUnit(scope, node, state)
  }

  /**
   * 处理变量声明
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 变量值
   */
  override processVariableDeclaration(scope: Scope, node: VariableDeclaration, state: State): SymbolValueType {
    const initVal = super.processVariableDeclaration(scope, node, state)
    if (initVal && node.varType !== null && node.varType !== undefined) {
      initVal.rtype = { type: undefined }
      const val = this.getMemberValueNoCreate(scope, node.varType.id, state)
      if (val?.vtype === 'class') {
        initVal.rtype.definiteType = UastSpec.identifier(val.logicalQid)
      } else {
        initVal.rtype.definiteType = node.varType.id
      }
    }
    return initVal
  }

  /**
   * 处理标识符
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 标识符值
   */
  override processIdentifier(scope: Scope, node: Identifier, state: State): SymbolValueType {
    let res = super.processIdentifier(scope, node, state)

    if (res && !res.rtype) {
      res.rtype = { type: undefined }
      if ((res as any).vtype === 'class') {
        res.rtype.definiteType = UastSpec.identifier(res.logicalQid)
      }
    }

    const resFileScope = res.scope.fileScope
    if (resFileScope && !resFileScope.isProcessed) {
      this.processInstruction(resFileScope, resFileScope.ast?.node, this.initState(resFileScope))
    }

    if (
      res &&
      (res as any)?.vtype !== 'fclos' &&
      (res as any)?.vtype !== 'class' &&
      res?.parent?.vtype === 'class' &&
      this.thisFClos &&
      this.thisFClos.vtype === 'symbol'
    ) {
      if (this.thisFClos.members?.get(node.name)) {
        res = this.thisFClos.members.get(node.name)
      } else {
        const vCopy = this.thisFClos.cloneAlias()
        res = res.cloneAlias ? res.cloneAlias() : _.clone(res)
        res._this = vCopy
        res.parent = vCopy
        res.object = vCopy
        if (vCopy.taint?.isTaintedRec) {
          res.taint?.markSource()
        }
      }
    }

    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  /**
   * 处理成员访问
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 成员值
   */
  // eslint-disable-next-line complexity
  override processMemberAccess(scope: Scope, node: MemberAccess, state: State): SymbolValueType {
    const defscope = this.processInstruction(scope, node.object, state)
    const prop = node.property
    let resolvedProp = prop
    // important, prop should be eval by scope rather than defscope
    if (node.computed || (prop.type !== 'Identifier' && prop.type !== 'Literal')) {
      resolvedProp = this.processInstruction(scope, prop, state)
    }
    let res
    if (resolvedProp?.type === 'Identifier' && resolvedProp.name === 'length' && defscope.length) {
      res = new PrimitiveValue(scope.qid, '<defscope_length>', defscope.length, 'number', 'Literal', node.loc)
    } else {
      res = this.getMemberValue(defscope, resolvedProp, state)
    }
    if (this.checkerManager && this.checkerManager.checkAtMemberAccess) {
      this.checkerManager.checkAtMemberAccess(this, defscope, node, state, { res })
    }

    if (
      Number.isInteger(res?.object?.length) &&
      res?.property?.vtype === 'primitive' &&
      res?.property?.literalType === 'number'
    ) {
      const index = Number(res.property.value)
      if (index >= res.object.length) {
        state.throwstack = state.throwstack ?? []
        let throwValue = res.object
        throwValue = SourceLine.addSrcLineInfo(
          throwValue,
          node.object,
          node.object.loc && node.object.loc.sourcefile,
          'Throw Pass: ',
          AstUtil.prettyPrint(node.object)
        )
        state.throwstack.push(throwValue)

        state.throwstackScopeAndState = state.throwstackScopeAndState ?? []
        state.throwstackScopeAndState.push({ scope, state })
      }
    }

    if (node.property.type === 'ThisExpression' && defscope.vtype === 'class' && defscope.qid) {
      const ancestorInstance = this.getAncestorScopeByQid(scope, `${defscope.qid}`)
      if (ancestorInstance) {
        res = ancestorInstance
      }
    }
    if (defscope.vtype === 'fclos' && defscope.sid?.includes('anonymous') && res.vtype === 'symbol') {
      res = defscope
    }

    if (defscope.rtype && defscope.rtype !== 'DynamicType' && res.rtype === undefined) {
      res.rtype = { type: undefined }
      res.rtype.definiteType = defscope.rtype.type ? defscope.rtype.type : defscope.rtype.definiteType
      res.rtype.vagueType = defscope.rtype.vagueType
        ? `${defscope.rtype.vagueType}.${resolvedProp.name}`
        : resolvedProp.name
    }
    const { fileScope } = res
    if (fileScope && !fileScope.isProcessed) {
      this.processInstruction(fileScope, fileScope.ast?.node, this.initState(fileScope))
    }

    if (node.object?.type !== 'SuperExpression') {
      if (res.vtype !== 'union' || !Array.isArray(res.value)) {
        res._this = defscope
      } else {
        const _thisUnion = defscope
        if (_thisUnion?.value && Array.isArray(_thisUnion?.value)) {
          for (const f of res.value) {
            for (const _thisObj of _thisUnion.value) {
              if (!f.sid || !_thisObj.value) {
                continue
              }
              if (f === _thisObj.value[f.sid]) {
                f._this = _thisObj
              }
            }
          }
        }
      }
      res._this = defscope
    } else {
      // For super.method() calls, bind this to the current instance.
      // In Java semantics, super only affects method dispatch (which class's implementation to call),
      // not this binding. this inside the parent method should still refer to the current instance.
      if (this.thisFClos) {
        res._this = this.thisFClos
      }
    }

    return res
  }

  /**
   * 处理模块导入：import "module"
   * @param scope - 作用域
   * @param node - AST 节点
   * @param _state - 状态（未使用）
   * @param state
   * @returns {any} 导入结果
   */
  processImportDirect(scope: any, node: any, state: any) {
    const importNode = node
    node = node.from
    const fromName = node?.value
    const importedName = importNode?.imported?.name || importNode?.local?.name

    // check cached imports first
    let packageName = ''
    const classNames: string[] = []
    let lastName: string = ''
    if (fromName || importedName) {
      const fullName = importedName ? `${fromName}.${importedName}` : fromName
      if (fullName?.includes('.')) {
        const lastDotIndex = fullName.lastIndexOf('.')
        packageName = fullName.substring(0, lastDotIndex)
        lastName = fullName.substring(lastDotIndex + 1)
        classNames.push(fullName.substring(lastDotIndex + 1))
      } else {
        lastName = fullName
        classNames.push(fullName)
      }
    }
    packageName = packageName.replace('<global>.packageManager.', '')
    let packageScope = this.topScope.context.packages.getSubPackage(packageName, true)
    // if package is not created from import statement, but from full qualified name access
    if (packageScope.vtype !== 'package') {
      packageScope = new PackageValue('', {
        vtype: 'package',
        sid: lastName,
        qid: packageName,
        parent: this,
      })
      const exports = new Scoped(packageScope.qid, {
        sid: 'exports',
        parent: packageScope,
      })
      packageScope.scope.exports = exports
    }
    let classScope = packageScope
    for (const className of classNames) {
      classScope = ScopeClass.createSubScope(
        className,
        packageScope,
        'class',
        ScopeClass.joinQualifiedName(packageScope.qid, className)
      )
      packageScope.scope.exports.value[className] = classScope
    }

    return classScope
  }

  /**
   * 处理类定义
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 类定义结果
   */
  // eslint-disable-next-line complexity
  override processClassDefinition(scope: Scope, node: ClassDefinition, state: State): SymbolValueType {
    const { annotations } = node._meta as any
    const annotationValues: any[] = []
    annotations?.forEach((annotation: any) => {
      annotationValues.push(this.processInstruction(scope, annotation, state))
    })

    // adjust the order of the class body, so that static field comes last
    const { body } = node
    let bodyStmt: any
    if (body && !Array.isArray(body) && (body as any).type === 'ScopedStatement') {
      bodyStmt = (body as any).body
    } else if (Array.isArray(body)) {
      bodyStmt = body
    }
    bodyStmt?.sort((a: any, b: any) => {
      return (a._meta?.isStatic ? 1 : 0) - (b._meta?.isStatic ? 1 : 0)
    })

    const res = super.processClassDefinition(scope, node, state)
    // TODO
    res.annotations = annotationValues
    for (const annotation of annotationValues) {
      if (annotation.qid.includes('lombok.Data')) {
        const value = res.members
        for (const prop of value.keys()) {
          const fieldValue = value.get(prop)
          if (fieldValue.vtype !== 'fclos') {
            const getterName = `get${getUpperCase(prop)}`
            if (!value.has(getterName)) {
              const targetQid = `${scope.qid}.${getterName}`
              value.set(
                getterName,
                new FunctionValue('', {
                  sid: getterName,
                  qid: targetQid,
                  parent: scope,
                  runtime: { execute: JavaInitializer.builtin.lombok.processGetter(getterName, prop) },
                })
              )
              this.funcSymbolTable[QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(targetQid)] = value.get(getterName)
            }
            const setterName = `set${getUpperCase(prop)}`
            if (!value.has(setterName)) {
              const targetQid = `${scope.qid}.${setterName}`
              value.set(
                setterName,
                new FunctionValue('', {
                  sid: setterName,
                  qid: targetQid,
                  parent: scope,
                  runtime: { execute: JavaInitializer.builtin.lombok.processSetter(setterName, prop) },
                })
              )
              this.funcSymbolTable[QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(targetQid)] = value.get(getterName)
            }
          }
        }
      } else if (annotation.qid.includes('lombok.AllArgsConstructor')) {
        const value = res.members
        if (!value.has('_CTOR_')) {
          value.set(
            '_CTOR_',
            new FunctionValue('', {
              sid: '_CTOR_',
              qid: `${res.qid}._CTOR_`,
              parent: scope,
              runtime: { execute: JavaInitializer.builtin.lombok._CTOR_ },
            })
          )
        }
      }
    }
    return res
  }

  /**
   * 处理赋值表达式
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 赋值结果
   */
  override processAssignmentExpression(scope: Scope, node: AssignmentExpression, state: State): SymbolValueType {
    const { left } = node
    const oldVal = this.processInstruction(scope, left, state)

    const res = super.processAssignmentExpression(scope, node, state)

    if (
      node.operator === '=' &&
      oldVal?.parent === this.thisFClos &&
      this.thisFClos?.members?.get('super') &&
      !this.checkFieldDefinedInClass(oldVal.sid, this.thisFClos.qid)
    ) {
      this.saveVarInScopeRec(
        this.thisFClos.members.get('super')!,
        left.type === 'MemberAccess' ? left.property : left,
        res,
        state
      )
    }

    return res
  }

  /**
   * 处理二元表达式
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 表达式结果
   */
  override processBinaryExpression(scope: Scope, node: BinaryExpression, state: State): BinaryExprValue {
    let res = super.processBinaryExpression(scope, node, state)

    if (
      res?.left?.vtype === 'primitive' &&
      res?.right?.vtype === 'primitive' &&
      res?.operator &&
      ['>', '<', '==', '!=', '>=', '<='].includes(res.operator)
    ) {
      const leftPrim = res.left as PrimitiveValueType
      const rightPrim = res.right as PrimitiveValueType
      let leftPrimitive = leftPrim.value
      if (leftPrim.literalType === 'string' && leftPrimitive != null && typeof leftPrimitive === 'string') {
        leftPrimitive = `'${leftPrimitive.replaceAll("'", "\\'")}'`
      }
      let rightPrimitive = rightPrim.value
      if (rightPrim.literalType === 'string' && rightPrimitive != null && typeof rightPrimitive === 'string') {
        rightPrimitive = `'${rightPrimitive.replaceAll("'", "\\'")}'`
      }
      if (leftPrimitive != null && rightPrimitive != null) {
        const expr = leftPrimitive + res.operator + rightPrimitive
        try {
          // eslint-disable-next-line no-eval
          const result = eval(expr)
          if (result != null) {
            res = new PrimitiveValue(
              scope.qid,
              `<operatorExp_${node.operator}_${node.loc.start?.line}_${node.loc.start?.column}_${node.loc.end?.line}_${node.loc.end?.column}>`,
              result,
              null,
              'Literal',
              node.loc
            )
          }
        } catch (e) {
          // 忽略 eval 错误
        }
      }
    } else if (res?.operator === 'instanceof') {
      if (res?.left?.vtype === 'primitive' && (res.left as PrimitiveValueType).literalType === 'null') {
        res = new PrimitiveValue(scope.qid, '<bool_false>', false, null, 'Literal', node.loc)
      } else if (res?.right?.vtype === 'class') {
        if (res.right.qid === 'java.lang.Object' || res.right.logicalQid === 'java.lang.Object') {
          // eslint-disable-next-line sonarjs/no-duplicate-string
          res = new PrimitiveValue(scope.qid, '<bool_true>', true, null, 'Literal', node.loc)
        } else if ((res?.left as any)?.rtype?.definiteType && !(res.left as any).rtype.vagueType) {
          const leftWithRtype = res.left as any
          const resType = AstUtil.prettyPrint(leftWithRtype.rtype.definiteType)
          if (resType === res.right.qid) {
            res = new PrimitiveValue(scope.qid, '<bool_true>', true, null, 'Literal', node.loc)
          } else {
            const classHierarchy: ClassHierarchy | undefined = this.typeResolver.classHierarchyMap.get(resType)
            if (classHierarchy) {
              const baseTypes: string[] = this.typeResolver.findBaseTypes(classHierarchy)
              for (const baseType of baseTypes) {
                if (baseType === res.right.qid) {
                  res = new PrimitiveValue(scope.qid, '<bool_true>', true, 'boolean', 'Literal', node.loc)
                  break
                }
              }
            }
          }
        }
      }
    }

    return res
  }

  /**
   * 处理函数调用表达式
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 调用结果
   */
  // eslint-disable-next-line complexity
  override processCallExpression(scope: Scope, node: CallExpression, state: State): SymbolValueType {
    /* { callee,
        arguments,
      }
   */
    if (this.checkerManager && this.checkerManager.checkAtFuncCallSyntax)
      this.checkerManager.checkAtFuncCallSyntax(node, {
        pcond: state.pcond,
        einfo: state.einfo,
      })

    let fclos = this.processInstruction(scope, node.callee, state)

    if (!fclos) {
      return new UndefinedValue()
    }
    if (this.entryPointSymValArray.includes(fclos) && !Config.makeAllCG) {
      this.globalState.meetOtherEntryPoint = true
      return new UndefinedValue()
    }
    if (node.callee.type === 'ThisExpression' && fclos.qid.includes('<instance')) {
      if (fclos.members.get('_CTOR_')) {
        fclos = fclos.members.get('_CTOR_')!
      } else {
        return new UndefinedValue()
      }
    }

    // prepare the function arguments
    let argvalues: any[] = []
    let sameArgs = true // minor optimization to save memory
    let argExecuted = false
    for (const arg of node.arguments) {
      let argv = this.processInstruction(scope, arg, state)
      // 处理参数是 箭头函数或匿名函数
      // 参数类型必须是函数定义,且fclos找不到定义或未建模适配
      // 如果参数适配建模，则会进入相应的逻辑模拟执行，例如array.push
      if (arg.type === 'FunctionDefinition') {
        const funcDef = arg as FunctionDefinition
        const funcName = funcDef.id?.type === 'Identifier' ? funcDef.id.name : ''
        if (funcName.includes('<anonymous') && !fclos?.ast.fdef && !fclos?.runtime?.execute) {
          // let subscope = ScopeClass.createSubScope(argv.sid + '_scope', scope,'scope')
          let anonymousArgValues
          const _this = fclos.getThisObj()
          if (_this && funcDef.parameters && funcDef.parameters.length > 0) {
            anonymousArgValues = []
            let i = 0
            while (i < funcDef.parameters.length) {
              anonymousArgValues.push(_this)
              i++
            }
          }
          argv = this.processAndCallFuncDef(scope, funcDef, argv, state, anonymousArgValues)
          argExecuted = true
        }
      }
      if (argv !== arg) sameArgs = false
      if (logger.isTraceEnabled()) logger.trace(`arg: ${this.formatScope(argv)}`)
      if (Array.isArray(argv)) {
        argvalues.push(...argv)
      } else {
        this.addRtypeToArg(arg, argv)
        argvalues.push(argv)
      }
    }
    if (sameArgs) argvalues = node.arguments

    let res
    let meetSameFuncInCallstack = false

    const invocations: Invocation[] = this.findNodeInvocations(scope, node)
    const executedInvocations: Invocation[] = []
    let fclosExecuted = false
    let sofaDispatched = false

    /* SOFA 分发：接口调用优先通过 SOFA 服务映射分发到实现类 */
    let sofaInterfaceName: string | undefined
    let sofaImplList: Array<{ uniqueId: string; ref: string }> | undefined

    if (fclos.vtype === 'fclos' && this.checkFclosInInterfaceOrAbstractClass(fclos)) {
      sofaInterfaceName = fclos.parent?.logicalQid
      sofaImplList = sofaInterfaceName
        ? this.topScope.spring?.sofaServiceInterfaceMap?.get(sofaInterfaceName)
        : undefined
    }

    /* 当 fclos 为 symbol（如 Map.get() 返回值的方法调用），从 invocations 目标推断 SOFA 接口 */
    if (
      !sofaImplList &&
      fclos.vtype === 'symbol' &&
      invocations.length > 10 &&
      this.topScope.spring?.sofaServiceInterfaceMap
    ) {
      const sofaMap = this.topScope.spring.sofaServiceInterfaceMap as Map<
        string,
        Array<{ uniqueId: string; ref: string }>
      >
      for (const [iface, implList] of sofaMap) {
        if (implList.length > 10 && implList.length <= invocations.length * 2) {
          /* 验证：SOFA 映射的 ref 能否匹配到 invocations 的目标类 */
          let matchCount = 0
          for (const impl of implList) {
            const beanInfo = this.topScope.spring.beanMap?.get(impl.ref)
            if (!beanInfo?.className) continue
            const classUuid = this.classMap.get(beanInfo.className)
            if (!classUuid) continue
            const classObj = this.symbolTable.get(classUuid)
            if (!classObj) continue
            const implFclos = classObj.members?.get(fclos.sid)
            if (
              implFclos &&
              invocations.some(
                (inv: Invocation) =>
                  inv.toScope === implFclos ||
                  (inv.toScope?.qid && inv.toScope.qid === implFclos.qid) ||
                  (inv.toScope?.logicalQid && inv.toScope.logicalQid === implFclos.logicalQid)
              )
            ) {
              matchCount++
            }
            if (matchCount >= 3) break
          }
          if (matchCount >= 3) {
            sofaInterfaceName = iface
            sofaImplList = implList
            break
          }
        }
      }
    }

    if (sofaImplList && sofaImplList.length > 0) {
      const methodName = fclos.sid
      const { sinkArray } = this.pruneInfoMap
      /* 复用全局 pruning 缓存：strict 模式（checkUseDynamicFeature=false）的结果是 dynamic 模式的子集，安全复用 */
      const { matchSinkCacheMap } = this.pruneInfoMap

      /* 获取 this 对象：fclos 可能是 symbol（Map.get() 返回值），需要安全处理 */
      const thisObj = typeof fclos.getThisObj === 'function' ? fclos.getThisObj() : fclos._this

      /* 只收集严格匹配 sink 的实现，跳过不匹配的（不再收集 dynamicMatched） */
      let strictMatchCount = 0
      for (const sofaImpl of sofaImplList) {
        const beanInfo = this.topScope.spring.beanMap?.get(sofaImpl.ref)
        if (!beanInfo?.className) continue
        const classUuid = this.classMap.get(beanInfo.className)
        if (!classUuid) continue
        const classObj = this.symbolTable.get(classUuid)
        if (!classObj) continue
        const implFclos = classObj.members?.get(methodName)
        if (!implFclos || implFclos.vtype !== 'fclos') continue
        const implFdef = implFclos.ast?.fdef
        if (!implFdef || implFdef.body?.type === 'Noop') continue

        /* 严格匹配：callgraph 中静态可达 sink 才执行 */
        const matchSink = this.checkFclosMatchSink(implFclos, [], sinkArray, matchSinkCacheMap, false)
        if (!matchSink) continue

        strictMatchCount++
        implFclos.ast.fdef = implFdef
        const oldThis = implFclos._this
        implFclos._this = thisObj
        res = this.executeCall(node, implFclos, state, scope, { callArgs: this.buildCallArgs(node, argvalues, implFclos) })
        if (res?.type === 'FunctionCall') {
          meetSameFuncInCallstack = true
        }
        implFclos._this = oldThis
      }

      if (strictMatchCount > 0) {
        sofaDispatched = true
        fclosExecuted = true
      }
    }

    if (!sofaDispatched && (fclos.vtype !== 'fclos' || this.checkFclosInInterfaceOrAbstractClass(fclos))) {
      // execute fclos found by callgraph
      for (const invocation of invocations) {
        if (
          invocation.toScope?.vtype === 'fclos' &&
          (invocation.toScopeAst || invocation.toScope.runtime?.execute) &&
          invocation.toScopeAst?.body?.type !== 'Noop' &&
          !this.checkFclosCanPruneDuringInterpret(invocation.toScope, node, argvalues, state, true)
        ) {
          if (invocation.toScope.qid === fclos.qid) {
            fclosExecuted = true
          }
          let executed: boolean = false
          for (const executedInvocation of executedInvocations) {
            if (
              (invocation.toScopeAst &&
                executedInvocation.toScopeAst &&
                invocation.toScopeAst._meta?.nodehash === executedInvocation.toScopeAst._meta?.nodehash) ||
              (invocation.toScope.runtime?.execute &&
                executedInvocation.toScope.runtime?.execute &&
                invocation.toScope.runtime.execute === executedInvocation.toScope.runtime.execute)
            ) {
              executed = true
              break
            }
          }
          if (executed) {
            continue
          }
          executedInvocations.push(invocation)
          invocation.toScope.ast.fdef = invocation.toScopeAst
          const oldThis = invocation.toScope._this
          invocation.toScope._this = fclos.getThisObj()
          res = this.executeCall(node, invocation.toScope, state, scope, { callArgs: this.buildCallArgs(node, argvalues, invocation.toScope) })
          if (res?.type === 'FunctionCall') {
            meetSameFuncInCallstack = true
          }
          invocation.toScope._this = oldThis
        }
      }
    }

    // analyze the resolved function closure and the function arguments
    if (!sofaDispatched && ((fclos.vtype === 'fclos' && !fclosExecuted) || executedInvocations.length === 0)) {
      if (
        this.checkFclosCanPruneDuringInterpret(fclos, node, argvalues, state, false) ||
        fclos?.ast?.fdef?.body?.type === 'Noop'
      ) {
        if (!res) {
          res = this.processLibArgToRet(node, fclos, argvalues, scope, state, { callArgs: this.buildCallArgs(node, argvalues, fclos) })
        }
      } else {
        res = this.executeCall(node, fclos, state, scope, { callArgs: this.buildCallArgs(node, argvalues, fclos) })
      }
      if (res?.type === 'FunctionCall') {
        meetSameFuncInCallstack = true
      }
    }
    if (res) {
      const resolvedRes = this.resolveRuntimeValueRef(res)
      if (resolvedRes && typeof resolvedRes === 'object') {
        resolvedRes.rtype = fclos.rtype
      }
    }

    if (
      res?.constructor?.name === 'UndefinedValue' &&
      fclos.sid?.includes('<anonymous') &&
      fclos.ast.fdef?.body?.body?.length === 1
    ) {
      const oldBodyExpr = fclos.ast.fdef.body.body[0]
      try {
        fclos.ast.fdef.body.body[0] = UastSpec.returnStatement(fclos.ast.fdef.body.body[0])
        res = this.executeCall(node, fclos, state, scope, { callArgs: this.buildCallArgs(node, argvalues, fclos) })
      } catch (e) {
        // 忽略错误
      } finally {
        fclos.ast.fdef.body.body[0] = oldBodyExpr
      }
    }

    // function definition not found
    if (fclos.vtype !== 'fclos') {
      // examine possible call-back functions in the arguments
      if (Config.invokeCallbackOnUnknownFunction) {
        this.executeFunctionInArguments(scope, fclos, node, argvalues, state)
      }

      // execute function not found callback
      if (fclos._this?.members?.get('_functionNotFoundCallback_')?.vtype === 'fclos') {
        this.executeCall(node, fclos._this.members.get('_functionNotFoundCallback_')!, state, scope, { callArgs: this.buildCallArgs(node, argvalues, fclos._this.members.get('_functionNotFoundCallback_')!) })
      }

      // evaluate default equals result
      if (
        fclos.sid === 'equals' &&
        fclos.getThisObj()?.vtype === 'primitive' &&
        argvalues.length > 0 &&
        argvalues[0]?.vtype === 'primitive' &&
        fclos.getThisObj().value !== argvalues[0].value
      ) {
        res = new PrimitiveValue(scope.qid, '<bool_false>', false, null, 'Literal', node.loc)
      }
    }

    // execute fclos of this
    if (fclos?._this?.vtype === 'fclos') {
      if (['accept', 'apply', 'call', 'run', 'get'].includes(fclos.sid)) {
        this.executeCall(node, fclos._this, state, scope, { callArgs: this.buildCallArgs(node, argvalues, fclos._this) })
      } else if (fclos.sid === 'invoke' && argvalues.length >= 1) {
        fclos._this._this = argvalues[0]
        this.executeCall(node, fclos._this, state, scope, { callArgs: this.buildCallArgs(node, argvalues.slice(1), fclos._this) })
      }
    }

    if (meetSameFuncInCallstack && !argExecuted && node.arguments?.length === argvalues.length) {
      for (let i = 0; i < node.arguments.length; i++) {
        const arg = node.arguments[i]
        const argv = argvalues[i]
        const argNode = arg as { type?: string; name?: string; parameters?: Array<any> }
        if (argNode?.type === 'FunctionDefinition' && argNode?.name?.includes('<anonymous')) {
          const funcDef = arg as unknown as FunctionDefinition
          let anonymousArgValues
          const _this = fclos.getThisObj()
          if (_this && argNode.parameters && argNode.parameters.length > 0) {
            anonymousArgValues = []
            let j = 0
            while (j < argNode.parameters.length) {
              anonymousArgValues.push(_this)
              j++
            }
          }
          this.processAndCallFuncDef(scope, funcDef, argv, state, anonymousArgValues)
          argExecuted = true
        }
      }
    }

    if (res && this.checkerManager?.checkAtFunctionCallAfter) {
      this.checkerManager.checkAtFunctionCallAfter(this, scope, node, state, {
        argvalues,
        fclos,
        ret: res,
        pcond: state.pcond,
        einfo: state.einfo,
        callstack: state.callstack,
      })
    }

    if (!res) {
      res = new UndefinedValue()
    }
    return res
  }

  /**
   * 处理 new 表达式
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} new 表达式结果
   */
  override processNewExpression(scope: Scope, node: NewExpression, state: State): SymbolValueType {
    if (node._meta && node._meta.isEnumImpl) {
      return this.processInstruction(scope, node.callee, state)
    }
    return super.processNewExpression(scope, node, state)
  }

  /**
   * 处理一元表达式
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @returns {any} 一元表达式结果
   */
  override processUnaryExpression(scope: Scope, node: UnaryExpression, state: State): UnaryExprValue {
    let res = super.processUnaryExpression(scope, node, state)

    if (res.argument?.vtype === 'primitive' && res.argument?.literalType === 'number') {
      const argValueNum = Number(res.argument.value)
      if (node.operator === '++') {
        res = new PrimitiveValue(
          scope.qid,
          `<operatorExp_${node.operator}_${node.loc.start?.line}_${node.loc.start?.column}_${node.loc.end?.line}_${node.loc.end?.column}>`,
          argValueNum + 1,
          null,
          'Literal',
          node.loc
        )
        this.saveVarInScope(scope, node.argument, res, state)
      } else if (node.operator === '--') {
        res = new PrimitiveValue(
          scope.qid,
          `<operatorExp_${node.operator}_${node.loc.start?.line}_${node.loc.start?.column}_${node.loc.end?.line}_${node.loc.end?.column}>`,
          argValueNum - 1,
          null,
          'Literal',
          node.loc
        )
        this.saveVarInScope(scope, node.argument, res, state)
      }
    }

    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processTryStatement(scope: Scope, node: TryStatement, state: State): VoidValueType {
    state.throwstack = state.throwstack ?? []

    this.processInstruction(scope, node.body, state)

    const { handlers } = node
    if (handlers) {
      for (const clause of handlers) {
        const subScope = ScopeClass.createSubScope(
          `<block_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}>`,
          scope
        )
        if (clause && state?.throwstack?.length > 0) {
          const throw_value = state.throwstack[0]
          for (const param of clause.parameter) {
            if (param && param.type === 'VariableDeclaration' && param.init === null) {
              param._meta.isCatchParam = true
              param.init = {
                type: 'Identifier',
                name: throw_value.sid,
                _meta: param._meta,
                loc: param.loc,
                parent: param.parent,
              } as any
            }
          }
        }
        if (clause) {
          clause.parameter.forEach((param: any) => this.processInstruction(subScope, param, state))
          this.processInstruction(subScope, clause.body, state)
        }
      }
    }

    if (node.finalizer) {
      this.processInstruction(scope, node.finalizer, state)
    }

    if (state?.throwstack?.length === 0) {
      delete state.throwstack
    }

    return new UndefinedValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processRangeStatement(scope: Scope, node: RangeStatement, state: State): any {
    const { key, value, right, body } = node
    scope = ScopeClass.createSubScope(
      `<block_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}>`,
      scope
    )
    const rightVal = this.processInstruction(scope, right, state)
    let executed = false
    if (
      !Array.isArray(rightVal) &&
      (this.inRange ||
        rightVal?.vtype === 'primitive' ||
        Object.keys(rightVal.getRawValue()).filter((key) => !key.startsWith('__yasa')).length === 0 ||
        rightVal?.vtype === 'union' ||
        !rightVal?.getMisc('precise'))
    ) {
      if (value) {
        if (value.type === 'VariableDeclaration') {
          this.saveVarInCurrentScope(scope, value.id, rightVal, state)
        } else if (value.type === 'TupleExpression') {
          for (const ele of value.elements) {
            const eleName = ele && ele.type === 'Identifier' ? ele.name : ele?.name || 'unknown'
            this.saveVarInCurrentScope(scope, eleName, rightVal, state)
          }
        } else {
          this.saveVarInScope(scope, value, rightVal, state)
        }
      }
      if (key) {
        // TODO js存到value，go存到key。且需要考虑既有key 又有value的场景
        this.saveVarInScope(scope, key, rightVal, state)
      }
      this.processInstruction(scope, body, state)
      executed = true
    } else {
      this.inRange = true
      if (this.isNullLiteral(rightVal)) {
        this.inRange = false
        return undefined
      }
      const itr = this.getValueIterator(rightVal, filterDataFromScope)
      let countLimit = 30
      for (let { value: field, done } = itr.next(); !done; { value: field, done } = itr.next()) {
        if (countLimit-- === 0) {
          break
        }
        if (!field) continue
        let { k, v } = field
        if (key) {
          if (key.type === 'VariableDeclaration') {
            this.saveVarInCurrentScope(scope, key.id, k, state)
          } else {
            // 如果是string，将其构造出符号值再存储
            // TODO 250731 将符号的字面量(而非符号值)作为key存储是否合适，有待商榷。
            if (_.isString(k)) k = new PrimitiveValue(scope.qid, k, k, undefined, key.type, key.loc, key)
            this.saveVarInScope(scope, key, k, state)
          }
        }
        if (value) {
          if (value.type === 'VariableDeclaration') {
            this.saveVarInCurrentScope(scope, value.id, v, state)
          } else {
            this.saveVarInScope(scope, value, v, state)
          }
        }
        this.processInstruction(scope, body, state)
        executed = true
      }
      this.inRange = false
    }

    if (!executed && rightVal?._this?.vtype === 'class' && this.thisFClos && this.thisFClos.vtype === 'symbol') {
      this.inRange = true
      this.processInstruction(scope, body, state)
      this.inRange = false
    }
    return new VoidValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processCastExpression(scope: any, node: any, state: any) {
    const exprVal = this.processInstruction(scope, node.expression, state)
    if (exprVal?.vtype === 'fclos' && node?.expression?.type === 'FunctionDefinition') {
      this.processAndCallFuncDef(scope, node.expression, exprVal, state)
    }
    return exprVal
  }

  /**
   * 预处理项目目录
   * @param dir - 项目目录
   */
  // eslint-disable-next-line complexity
  async preProcess(dir: any) {
    JavaInitializer.initGlobalScope(this.topScope)
    JavaInitializer.initPackageScope(this.topScope.context.packages)

    await this.scanPackages(dir)
    if (!Config.miniSaveContextEnvironment) {
      this.assembleClassMap(this.topScope.context.packages)
      if (!Config.loadContextEnvironment) {
        JavaInitializer.addClassProto(this.classMap, this.topScope.context.packages, this)
      }
    }
  }

  /**
   * 加载缓存后的初始化阶段，会创建一些全局builtin
   */
  initAfterUsingCache() {
    JavaInitializer.initGlobalScope(this.topScope)
    JavaInitializer.initPackageScope(this.topScope.context.packages)
    this.assembleClassMap(this.topScope.context.packages)
  }

  /**
   *
   */
  override startAnalyze() {
    super.startAnalyze()
    FullCallGraphFileEntryPoint.makeFullCallGraphByType(this, this.typeResolver)
  }

  /**
   * 符号解释
   * @returns {boolean} 是否成功
   */
  // eslint-disable-next-line complexity
  symbolInterpret() {
    const { entryPoints } = this
    const state = this.initState(this.topScope)
    if (_.isEmpty(entryPoints)) {
      logger.info('[symbolInterpret]：EntryPoints are not found')
      return true
    }

    for (const entryPoint of entryPoints) {
      this.entryPointSymValArray.push(entryPoint.entryPointSymVal)
    }

    this.pruneInfoMap.sinkArray = this.loadAllSink()
    this.pruneInfoMap.funcCallSourceSinkSanitizerArray.push(...this.pruneInfoMap.sinkArray)

    const allSources = this.loadAllSource()
    this.pruneInfoMap.funcCallSourceSinkSanitizerArray.push(...allSources[0])
    this.pruneInfoMap.otherSourceArray = allSources[1]

    const allSanitizers = this.loadAllSanitizer()
    this.pruneInfoMap.funcCallSourceSinkSanitizerArray.push(...allSanitizers[0])
    this.pruneInfoMap.otherSanitizerArray = allSanitizers[1]

    const pruneSupported = this.checkPruneSupported(entryPoints.length, this.pruneInfoMap.sinkArray.length)
    if (pruneSupported) {
      logger.info('EntryPoint Pruning is enabled')
    }

    const oldEntryPointTimeoutMs = Config.entryPointTimeoutMs
    Config.entryPointTimeoutMs = Config.entryPointTimeoutQuickMs
    const hasAnalysised: any[] = []
    // 自定义source入口方式，并根据入口自主加载source
    for (const entryPoint of entryPoints) {
      this.symbolTable.clear()
      entryPoint.entryPointSymVal = this.tmpSymbolTable.tmpTableCopyUnit(entryPoint.entryPointSymVal)
      entryPoint.scopeVal = this.tmpSymbolTable.tmpTableCopyUnit(entryPoint.scopeVal)
      if (entryPoint.type === Constant.ENGIN_START_FUNCALL) {
        if (
          hasAnalysised.includes(
            `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?.qid}#${entryPoint.entryPointSymVal.ast.node.parameters}.${entryPoint.attribute}`
          )
        ) {
          continue
        }

        if (pruneSupported) {
          const entrypointCanPrune = this.checkFclosCanPrune(entryPoint.entryPointSymVal)
          if (entrypointCanPrune) {
            logger.info(
              'EntryPoint [%s.%s] is pruned',
              entryPoint.filePath?.substring(0, entryPoint.filePath?.lastIndexOf('.')),
              entryPoint.functionName ||
                `<anonymousFunc_${entryPoint.entryPointSymVal?.ast?.node?.loc.start.line}_$${
                  entryPoint.entryPointSymVal?.ast?.node?.loc.end.line
                }>`
            )
            continue
          }
        }

        hasAnalysised.push(
          `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?.qid}#${entryPoint.entryPointSymVal.ast.node.parameters}.${entryPoint.attribute}`
        )
        CurrentEntryPoint.setCurrentEntryPoint(entryPoint)
        logger.info(
          'EntryPoint [%s.%s] is executing',
          entryPoint.filePath?.substring(0, entryPoint.filePath?.lastIndexOf('.')),
          entryPoint.functionName ||
            `<anonymousFunc_${entryPoint.entryPointSymVal?.ast?.node?.loc.start?.line}_$${
              entryPoint.entryPointSymVal?.ast?.node?.loc.end?.line
            }>`
        )

        const overloadedList = entryPoint.entryPointSymVal?.overloaded
        if (!overloadedList?.length) {
          continue
        }

        for (const overloadFuncDef of overloadedList.filter(() => true)) {
          this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)
          ;(state as any).entryPointStartTimestamp = Date.now()
          const argValues: any[] = []
          try {
            for (const key in overloadFuncDef?.parameters) {
              let argValue = this.processInstruction(
                entryPoint.entryPointSymVal,
                overloadFuncDef?.parameters[key]?.id,
                state
              )
              if (argValue.vtype !== 'symbol') {
                argValue.taint.sanitize()
                const tmpVal = new SymbolValue(entryPoint.entryPointSymVal.qid, {
                  sid: overloadFuncDef?.parameters[key]?.id?.name,
                  parent: entryPoint.entryPointSymVal,
                })
                entryPoint.entryPointSymVal.value[tmpVal.sid] = tmpVal
                argValue = this.processInstruction(
                  entryPoint.entryPointSymVal,
                  overloadFuncDef?.parameters[key]?.id,
                  state
                )
              }
              if (overloadFuncDef?.parameters[key]?.varType?.id) {
                const val = this.getMemberValueNoCreate(
                  entryPoint.entryPointSymVal,
                  overloadFuncDef.parameters[key]?.varType.id,
                  state
                )
                if (val?.vtype === 'class') {
                  argValue.rtype.definiteType = UastSpec.identifier(val.logicalQid)
                } else {
                  argValue.rtype.definiteType = overloadFuncDef.parameters[key].varType.id
                }
              }
              argValues.push(argValue)
            }
          } catch (e) {
            handleException(
              e,
              'Error occurred in JavaAnalyzer.symbolInterpret: process argValue err',
              'Error occurred in JavaAnalyzer.symbolInterpret: process argValue err'
            )
          }

          try {
            this.executeCall(overloadFuncDef, entryPoint.entryPointSymVal, state, entryPoint.scopeVal, { callArgs: this.buildCallArgs(overloadFuncDef, argValues, entryPoint.entryPointSymVal) })
          } catch (e) {
            handleException(
              e,
              `[${overloadFuncDef?.id?.name} symbolInterpret failed. Exception message saved in error log file`,
              `[${overloadFuncDef?.id?.name} symbolInterpret failed. Exception message saved in error log file`
            )
            if (this.globalState.meetOtherEntryPoint) {
              delete this.globalState.meetOtherEntryPoint
            }
            if (this.globalState.entryPointTimeout) {
              delete this.globalState.entryPointTimeout
            }
          }

          if (this.globalState.meetOtherEntryPoint) {
            logger.info(
              'EntryPoint [%s.%s] is interrupted because encountered other entrypoint during execution',
              entryPoint.filePath?.substring(0, entryPoint.filePath?.lastIndexOf('.')),
              entryPoint.functionName ||
                `<anonymousFunc_${overloadFuncDef.loc.start.line}_$${overloadFuncDef.loc.end.line}>`
            )
            delete this.globalState.meetOtherEntryPoint
          }
          if (this.globalState.entryPointTimeout) {
            logger.info(
              'EntryPoint [%s.%s] is interrupted because timeout',
              entryPoint.filePath?.substring(0, entryPoint.filePath?.lastIndexOf('.')),
              entryPoint.functionName ||
                `<anonymousFunc_${overloadFuncDef.loc.start.line}_$${overloadFuncDef.loc.end.line}>`
            )
            delete this.globalState.entryPointTimeout
            this.timeoutEntryPoints.push({
              entryPoint,
              overloadFuncDef,
              argValues,
            })
          }

          this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
        }
      }
    }
    Config.entryPointTimeoutMs = oldEntryPointTimeoutMs

    if (this.timeoutEntryPoints.length > 0) {
      this.outputAnalyzerExistResult()
      logger.info('Rerun timeout entryPoint with aggressive prune mode')
      this.pruneInfoMap.aggressiveMode = true
      for (const timeoutEntryPoint of this.timeoutEntryPoints) {
        this.symbolTable.clear()
        this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)

        try {
          CurrentEntryPoint.setCurrentEntryPoint(timeoutEntryPoint.entryPoint)
          logger.info(
            'EntryPoint [%s.%s] is executing',
            timeoutEntryPoint.entryPoint.filePath?.substring(
              0,
              timeoutEntryPoint.entryPoint.filePath?.lastIndexOf('.')
            ),
            timeoutEntryPoint.entryPoint.functionName ||
              `<anonymousFunc_${timeoutEntryPoint.entryPoint.entryPointSymVal?.ast?.node?.loc.start.line}_$${
                timeoutEntryPoint.entryPoint.entryPointSymVal?.ast?.node?.loc.end.line
              }>`
          )
          const newState = state as any
          newState.entryPointStartTimestamp = Date.now()
          this.executeCall(
            timeoutEntryPoint.overloadFuncDef,
            timeoutEntryPoint.entryPoint.entryPointSymVal,
            state,
            timeoutEntryPoint.entryPoint.scopeVal,
            { callArgs: this.buildCallArgs(timeoutEntryPoint.overloadFuncDef, timeoutEntryPoint.argValues, timeoutEntryPoint.entryPoint.entryPointSymVal) }
          )
        } catch (e) {
          handleException(
            e,
            `[${timeoutEntryPoint.overloadFuncDef?.id?.name} symbolInterpret failed. Exception message saved in error log file`,
            `[${timeoutEntryPoint.overloadFuncDef?.id?.name} symbolInterpret failed. Exception message saved in error log file`
          )
          if (this.globalState.meetOtherEntryPoint) {
            delete this.globalState.meetOtherEntryPoint
          }
          if (this.globalState.entryPointTimeout) {
            delete this.globalState.entryPointTimeout
          }
        }

        if (this.globalState.meetOtherEntryPoint) {
          delete this.globalState.meetOtherEntryPoint
        }
        if (this.globalState.entryPointTimeout) {
          logger.info(
            'EntryPoint [%s.%s] is interrupted because timeout',
            timeoutEntryPoint.entryPoint.filePath?.substring(
              0,
              timeoutEntryPoint.entryPoint.filePath?.lastIndexOf('.')
            ),
            timeoutEntryPoint.entryPoint.functionName ||
              `<anonymousFunc_${timeoutEntryPoint.overloadFuncDef.loc.start.line}_$${timeoutEntryPoint.overloadFuncDef.loc.end.line}>`
          )
          delete this.globalState.entryPointTimeout
          this.outputAnalyzerExistResult()
        }

        this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
      }
      this.pruneInfoMap.aggressiveMode = false
    }

    return true
  }

  /**
   * 判断值是否为 null 字面量
   * @param val - 值
   * @returns {boolean} 是否为 null 字面量
   */
  override isNullLiteral(val: any) {
    return val.getRawValue() === 'null' && val.type === 'Literal'
  }

  /**
   * 从模块作用域获取导出作用域
   * @param scope - 作用域
   * @returns {any[]} 导出作用域数组
   */
  override getExportsScope(scope: any) {
    return [scope.scope.exports, scope]
  }

  /**
   * 组装类映射
   * @param obj - 对象
   */
  assembleClassMap(obj: any) {
    if (!obj) {
      return
    }
    if (obj.vtype === 'class' && obj.qid && typeof obj.qid === 'string') {
      this.classMap.set(obj.logicalQid, obj.uuid)
    } else if (obj.members?.size > 0) {
      for (const key of obj.members.keys()) {
        this.assembleClassMap(obj.members.get(key))
      }
    }
  }

  /**
   * 检查字段是否在类中定义
   * @param fieldName - 字段名
   * @param fullClassName - 完整类名
   * @returns {boolean} 是否定义
   */
  checkFieldDefinedInClass(fieldName: string, fullClassName: string) {
    fullClassName = QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(fullClassName)
    if (!fieldName || !fullClassName || !this.classMap.has(fullClassName)) {
      return false
    }

    const classObj = this.symbolTable.get(this.classMap.get(fullClassName))
    if (!classObj.ast.node || !classObj.ast.node.body) {
      return false
    }
    for (const bodyItem of classObj.ast.node.body) {
      if (bodyItem.type !== 'VariableDeclaration') {
        continue
      }
      if (bodyItem.id.name === fieldName) {
        return true
      }
    }

    return false
  }

  /**
   * 根据 qid 获取祖先作用域
   * @param scope - 作用域
   * @param qid - 限定标识符
   * @returns {any} 祖先作用域
   */
  getAncestorScopeByQid(scope: any, qid: string) {
    if (!qid) {
      return null
    }
    while (scope) {
      if (QidUnifyUtil.removeInstanceFromString(scope.qid) === QidUnifyUtil.removeInstanceFromString(qid)) {
        return scope
      }
      scope = scope.parent
    }
    return null
  }

  /**
   * find invocations in scope by node hash
   * @param scope
   * @param node
   * @returns {Invocation[]}
   */
  findNodeInvocations(scope: any, node: any): Invocation[] {
    const resultArray: Invocation[] = []
    const nodeHash = node?._meta?.nodehash
    if (!nodeHash) {
      return resultArray
    }

    let targetScope = scope
    while (targetScope) {
      if (targetScope.invocationMap?.has(nodeHash)) {
        resultArray.push(...targetScope.invocationMap.get(nodeHash))
        break
      }
      targetScope = targetScope.parent
    }
    return resultArray
  }

  /**
   * build new object
   * @param fdef
   * @param argvalues
   * @param fclos
   * @param state
   * @param node
   * @param scope
   */
  override buildNewObject(fdef: any, fclos: any, state: any, node: any, scope: any, callInfo: CallInfo) {
    const obj = super.buildNewObject(fdef, fclos, state, node, scope, callInfo)
    if (obj && node.callee?.type === 'MemberAccess' && /^[1-9]\d*$/.test(node.callee.property.name)) {
      obj.length = Number(node.callee.property.name)
    }
    delete obj.value.class
    return obj
  }

  /**
   * load all sink from rule
   */
  loadAllSink() {
    const resultArray = []
    const ruleConfigArray = BasicRuleHandler.getRules()
    for (const ruleConfig of ruleConfigArray) {
      if (!ruleConfig.sinks) {
        continue
      }
      for (const sinkArray of Object.values(ruleConfig.sinks)) {
        if (Array.isArray(sinkArray)) {
          resultArray.push(...sinkArray)
        }
      }
    }
    return resultArray
  }

  /**
   * load all source from rule
   */
  loadAllSource() {
    const funcCallSourceArray = []
    const otherSourceArray = []
    const ruleConfigArray = BasicRuleHandler.getRules()
    for (const ruleConfig of ruleConfigArray) {
      if (!ruleConfig.sources) {
        continue
      }
      for (const key of Object.keys(ruleConfig.sources)) {
        if (key.startsWith('FuncCall')) {
          funcCallSourceArray.push(...ruleConfig.sources[key])
        } else {
          otherSourceArray.push(...ruleConfig.sources[key])
        }
      }
    }
    return [funcCallSourceArray, otherSourceArray]
  }

  /**
   * load all sanitizer from rule
   */
  loadAllSanitizer() {
    const funcCallSanitizerArray = []
    const otherSanitizerArray = []
    const ruleConfigArray = BasicRuleHandler.getRules()
    for (const ruleConfig of ruleConfigArray) {
      if (!ruleConfig.sanitizers) {
        continue
      }
      for (const sanitizer of ruleConfig.sanitizers) {
        if (sanitizer.sanitizerType === 'FunctionCallSanitizer') {
          funcCallSanitizerArray.push(sanitizer)
        } else {
          otherSanitizerArray.push(sanitizer)
        }
      }
    }
    return [funcCallSanitizerArray, otherSanitizerArray]
  }

  /**
   * check if prune is supported
   * @param entryPointNum
   * @param sinkNum
   */
  checkPruneSupported(entryPointNum: number, sinkNum: number) {
    if (entryPointNum < Config.minEntryPointToEnablePrune || sinkNum <= 0 || Config.makeAllCG) {
      return false
    }
    return !!(this.typeResolver.resolveFinish && this.ainfo?.callgraph)
  }

  /**
   * check if prune is supported during symbol interpret
   * @param sinkNum
   * @param otherSanitizerNum
   */
  checkPruneSupportedDuringInterpret(sinkNum: number, otherSanitizerNum: number) {
    if (sinkNum <= 0 || otherSanitizerNum > 0 || Config.makeAllCG) {
      return false
    }
    return !!(this.typeResolver.resolveFinish && this.ainfo?.callgraph)
  }

  /**
   * check if fclos can be pruned
   * @param fclos
   */
  checkFclosCanPrune(fclos: any) {
    if (!fclos) {
      return false
    }
    const matchSink = this.checkFclosMatchSink(
      fclos,
      [],
      this.pruneInfoMap.sinkArray,
      this.pruneInfoMap.matchSinkCacheMap,
      true
    )
    return !matchSink
  }

  /**
   * check if fclos can be pruned during executing
   * @param fclos
   * @param node
   * @param argvalues
   * @param state
   * @param fromCallGraph
   */
  checkFclosCanPruneDuringInterpret(fclos: any, node: any, argvalues: any, state: any, fromCallGraph: boolean) {
    if (this.pruneInfoMap.aggressiveMode && state?.callstack?.length >= Config.maxCallstackDepth) {
      return true
    }

    if (Array.isArray(node.arguments)) {
      for (const argument of node.arguments) {
        if (argument.type === 'Sequence' || argument.type === 'FunctionDefinition') {
          return false
        }
      }
    }
    if (Array.isArray(argvalues)) {
      for (const argvalue of argvalues) {
        if (argvalue.vtype === 'class' || argvalue.vtype === 'fclos') {
          return false
        }
      }
    }

    if (
      !this.enablePruneDuringInterpret ||
      !fclos ||
      !fclos.ast.fdef ||
      !this.checkPruneSupportedDuringInterpret(
        this.pruneInfoMap.sinkArray.length,
        this.pruneInfoMap.otherSanitizerArray.length
      )
    ) {
      return false
    }
    const matchSourceSinkSanitizer = this.checkFclosMatchSink(
      fclos,
      [],
      this.pruneInfoMap.funcCallSourceSinkSanitizerArray,
      this.pruneInfoMap.matchFuncCallSourceSinkSanitizerCacheMap,
      true
    )
    if (matchSourceSinkSanitizer) {
      return false
    }

    if (fromCallGraph) {
      return !matchSourceSinkSanitizer
    }
    return false
  }

  /**
   * check if fclos match any sink, ignore sub fclos
   * @param fclos
   * @param sinkArray
   * @param matchSinkCacheMap
   * @param checkUseDynamicFeature
   */
  checkFclosMatchSinkNoRecurse(
    fclos: any,
    sinkArray: any[],
    matchSinkCacheMap: Map<any, any>,
    checkUseDynamicFeature: boolean
  ) {
    if (!fclos || !fclos.invocationMap || !sinkArray) {
      matchSinkCacheMap.set(fclos, false)
      return false
    }

    if (matchSinkCacheMap.has(fclos)) {
      return matchSinkCacheMap.get(fclos)
    }

    for (const invocationArray of fclos.invocationMap.values()) {
      for (const invocation of invocationArray) {
        if (checkUseDynamicFeature) {
          for (const dynamicClass of this.pruneInfoMap.dynamicClassArray) {
            if (dynamicClass === invocation.calleeType || invocation.calleeType?.endsWith(`.${dynamicClass}`)) {
              matchSinkCacheMap.set(fclos, true)
              return true
            }
          }
          for (const dynamicPackage of this.pruneInfoMap.dynamicPackageArray) {
            if (invocation.calleeType?.startsWith(`${dynamicPackage}.`)) {
              matchSinkCacheMap.set(fclos, true)
              return true
            }
          }
        }

        for (const sink of sinkArray) {
          const invocationMatchSink: boolean = checkInvocationMatchSink(invocation, sink, this.typeResolver)
          if (invocationMatchSink) {
            matchSinkCacheMap.set(fclos, true)
            return true
          }
        }
      }
    }

    matchSinkCacheMap.set(fclos, false)
    return false
  }

  /**
   * check if fclos match any sink
   * @param fclos
   * @param fclosStack
   * @param sinkArray
   * @param matchSinkCacheMap
   * @param checkUseDynamicFeature
   */
  checkFclosMatchSink(
    fclos: any,
    fclosStack: any[],
    sinkArray: any[],
    matchSinkCacheMap: Map<any, any>,
    checkUseDynamicFeature: boolean
  ) {
    if (!fclos || !fclos.invocationMap || !sinkArray) {
      matchSinkCacheMap.set(fclos, false)
      return false
    }

    if (matchSinkCacheMap.has(fclos)) {
      return matchSinkCacheMap.get(fclos)
    }

    // if (checkUseDynamicFeature) {
    //   const innerFuncDefVisitor = new InnerFuncDefVisitor()
    //   if (Array.isArray(fclos.overloaded)) {
    //     for (const funcDef of fclos.overloaded) {
    //       innerFuncDefVisitor.matchFuncDefCount = 0
    //       AstUtil.visit(funcDef, innerFuncDefVisitor)
    //       if (innerFuncDefVisitor.matchFuncDefCount > 1) {
    //         matchSinkCacheMap.set(fclos, true)
    //         return true
    //       }
    //     }
    //   }
    // }

    const toScopeArray = []
    for (const invocationArray of fclos.invocationMap.values()) {
      for (const invocation of invocationArray) {
        if (checkUseDynamicFeature) {
          for (const dynamicClass of this.pruneInfoMap.dynamicClassArray) {
            if (dynamicClass === invocation.calleeType || invocation.calleeType?.endsWith(`.${dynamicClass}`)) {
              matchSinkCacheMap.set(fclos, true)
              return true
            }
          }
          for (const dynamicPackage of this.pruneInfoMap.dynamicPackageArray) {
            if (invocation.calleeType?.startsWith(`${dynamicPackage}.`)) {
              matchSinkCacheMap.set(fclos, true)
              return true
            }
          }
        }

        for (const sink of sinkArray) {
          const invocationMatchSink: boolean = checkInvocationMatchSink(invocation, sink, this.typeResolver)
          if (invocationMatchSink) {
            matchSinkCacheMap.set(fclos, true)
            return true
          }
        }

        if (invocation.toScope?.vtype === 'fclos') {
          toScopeArray.push(invocation.toScope)
        }
      }
    }

    fclosStack.push(fclos)
    const analysedScopeArray: any[] = []
    for (const toScope of toScopeArray) {
      if (analysedScopeArray.includes(toScope) || fclosStack.includes(toScope)) {
        continue
      }
      analysedScopeArray.push(toScope)
      const subResult = this.checkFclosMatchSink(
        toScope,
        fclosStack,
        sinkArray,
        matchSinkCacheMap,
        checkUseDynamicFeature
      )
      if (subResult) {
        matchSinkCacheMap.set(fclos, true)
        return true
      }
    }
    fclosStack.pop()

    matchSinkCacheMap.set(fclos, false)
    return false
  }

  /**
   * Resolve UUID-backed values before mutating them during transitional storage migration.
   * @param value
   */
  private resolveRuntimeValueRef<T>(value: T): T | any {
    if (typeof value === 'string' && value.startsWith('symuuid_')) {
      return this.symbolTable.get(value) ?? value
    }
    return value
  }

  /**
   * add rtype to arg
   * @param argAst
   * @param argValue
   */
  addRtypeToArg(argAst: any, argValue: any) {
    const resolvedArgValue = this.resolveRuntimeValueRef(argValue)
    if (
      !argAst ||
      !argAst._meta ||
      !argAst._meta.nodehash ||
      !resolvedArgValue ||
      typeof resolvedArgValue !== 'object' ||
      (resolvedArgValue.rtype?.definiteType && !resolvedArgValue.rtype.vagueType) ||
      !(this.typeResolver?.typeResultCacheMap instanceof Map) ||
      !this.typeResolver.typeResultCacheMap.has(argAst._meta.nodehash)
    ) {
      return
    }

    const resolvedTypeArray = this.typeResolver.typeResultCacheMap.get(argAst._meta.nodehash)
    for (const resolvedType of resolvedTypeArray) {
      if (resolvedType?.type !== '') {
        if (!resolvedArgValue.rtype) {
          resolvedArgValue.rtype = { type: undefined }
        }
        resolvedArgValue.rtype.definiteType = UastSpec.identifier(resolvedType.type)
        return
      }
    }
  }

  /**
   * check if fclos in interface or abstract class
   * @param fclos
   */
  checkFclosInInterfaceOrAbstractClass(fclos: any) {
    return !!(
      (fclos?.parent?.vtype === 'class' &&
        (fclos.parent.ast?.node?._meta?.isAbstract || fclos.parent.ast?.node?._meta?.isInterface)) ||
      (fclos?.ast.fdef?.parent?.type === 'ClassDefinition' &&
        (fclos.ast.fdef.parent._meta?.isAbstract || fclos.ast.fdef.parent._meta?.isInterface))
    )
  }

  /**
   *
   * @param className
   * @param baseClassName
   */
  addExtraClassHierarchyByName(className: string, baseClassName: string) {
    if (!this.extraClassHierarchyByNameMap.has(className)) {
      this.extraClassHierarchyByNameMap.set(className, [])
    }
    if (!this.extraClassHierarchyByNameMap.get(className).includes(baseClassName)) {
      this.extraClassHierarchyByNameMap.get(className).push(baseClassName)
    }
  }
}

;(JavaAnalyzer as any).prototype.initFileScope = JavaInitializer.initFileScope

export = JavaAnalyzer

/**
 * 将字符串首字母转为大写
 * @param str - 输入字符串
 * @returns {string} 首字母大写的字符串
 */
function getUpperCase(str: string) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}
