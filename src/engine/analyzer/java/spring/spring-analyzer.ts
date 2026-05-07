import JavaInitializer from '../common/java-initializer'
import { INTERNAL_CALL } from '../../common/call-args'
import { UnionValue } from '../../common/value/union'
import type { Invocation } from '../../../../resolver/common/value/invocation'

const UastSpec = require('@ant-yasa/uast-spec')
const Config = require('../../../../config')
const logger = require('../../../../util/logger')(__filename)
const JavaAnalyzer: typeof import('../common/java-analyzer') = require('../common/java-analyzer')
const AstUtil = require('../../../../util/ast-util')
const Initializer = require('./spring-initializer')
const _ = require('lodash')
const entryPointConfig = require('../../common/current-entrypoint')
const constValue = require('../../../../util/constant')
const { handleException } = require('../../common/exception-handler')
const FullCallGraphFileEntryPoint = require('../../../../checker/common/full-callgraph-file-entrypoint')
const Rules = require('../../../../checker/common/rules-basic-handler')
const { newInstance } = require('../common/builtins/object')
const {
  ValueUtil: { SymbolValue },
} = require('../../../util/value-util')
const QidUnifyUtil = require('../../../../util/qid-unify-util')
const { getLegacyArgValues } = require('../../common/call-args')
import type { Scope, State, Value } from '../../../../types/analyzer'
import type {
  VariableDeclaration,
  FunctionDefinition,
  ClassDefinition,
  Expr,
  Stmt,
  Decl,
  AssignmentExpression,
  Literal,
  ScopedStatement,
} from '../../../../types/uast'

type EntryPointSymVal = {
  qid?: string
  ast?: { node?: { parameters?: unknown; loc: { start: { line: number }; end: { line: number } } } }
  overloaded?: FunctionDefinition[]
  value?: Record<string, unknown>
}

type EntryPoint = {
  type?: string
  filePath?: string
  functionName?: string
  attribute?: string
  entryPointSymVal?: EntryPointSymVal
  scopeVal?: unknown
}

type SymbolValueType = ReturnType<typeof SymbolValue>

/**
 *
 */
class SpringAnalyzer extends JavaAnalyzer {
  /**
   *
   * @param options
   */
  constructor(options: Record<string, unknown>) {
    super(options)
    this.beanReferenceAnnotationByName = ['@SofaReference', '@OsgiReference', '@Qualifier', '@Resource']
    this.beanReferenceAnnotationByClass = ['@Autowired', '@Resource', '@TestBean']
    this.beanServiceAnnotationOnClass = ['@Component', '@Service', '@Repository', '@SofaService']
    this.beanServiceAnnotationOnFunction = ['@Bean']
  }

  /**
   * 预处理前的初始化阶段，会创建一些全局builtin
   */
  override initAfterUsingCache() {
    // init global scope
    Initializer.initGlobalScope(this.topScope)
    Initializer.initPackageScope(this.topScope.context.packages)
    this.assembleClassMap(this.topScope.context.packages)
  }

  /**
   *
   * @param dir
   */
  override async preProcess(dir: string) {
    Initializer.initGlobalScope(this.topScope)
    Initializer.initPackageScope(this.topScope.context.packages, this)

    await Initializer.initBeans(this.topScope, dir)

    await this.scanPackages(dir)

    if (!Config.miniSaveContextEnvironment) {
      this.assembleClassMap(this.topScope.context.packages)
      this.compensateDependencyInjection(this.classMap)
      if (!Config.loadContextEnvironment) {
        JavaInitializer.addClassProto(this.classMap, this.topScope.context.packages, this)
      }
    }
  }

  /**
   *
   */
  override startAnalyze() {
    super.startAnalyze()
    this.adJustDependencyInjection(this.classMap, this.topScope.context.packages)
  }

  /**
   *
   *
   */
  override symbolInterpret() {
    type EntryPoint = {
      type?: string
      filePath?: string
      functionName?: string
      attribute?: string
      entryPointSymVal?: {
        qid?: string
        ast?: { node?: { parameters?: unknown; loc: { start: { line: number }; end: { line: number } } } }
        overloaded?: unknown[]
        value?: Record<string, unknown>
      }
      scopeVal?: unknown
    }
    const entryPoints = (this as { entryPoints?: EntryPoint[] }).entryPoints ?? []
    const state = this.initState(this.topScope) as State & { entryPointStartTimestamp?: number | null }

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
    const hasAnalysised: string[] = []
    // 自定义source入口方式，并根据入口自主加载source
    for (const entryPoint of entryPoints) {
      this.symbolTable.clear()
      entryPoint.entryPointSymVal = this.tmpSymbolTable.tmpTableCopyUnit(entryPoint.entryPointSymVal)
      entryPoint.scopeVal = this.tmpSymbolTable.tmpTableCopyUnit(entryPoint.scopeVal)
      const symVal = entryPoint.entryPointSymVal
      if (!symVal || !symVal.ast?.node) {
        continue
      }
      if (entryPoint.type === constValue.ENGIN_START_FUNCALL) {
        if (
          hasAnalysised.includes(
            `${entryPoint.filePath}.${entryPoint.functionName}/${symVal.qid}#${symVal.ast?.node?.parameters}.${entryPoint.attribute}`
          )
        ) {
          continue
        }

        if (pruneSupported) {
          const entrypointCanPrune = this.checkFclosCanPrune(symVal)
          if (entrypointCanPrune) {
            logger.info(
              'EntryPoint [%s.%s] is pruned',
              entryPoint.filePath?.substring(0, entryPoint.filePath?.lastIndexOf('.')),
              entryPoint.functionName ||
                `<anonymousFunc_${symVal.ast?.node?.loc.start.line}_$${symVal.ast?.node?.loc.end.line
                }>`
            )
            continue
          }
        }

        hasAnalysised.push(
          `${entryPoint.filePath}.${entryPoint.functionName}/${symVal.qid}#${symVal.ast?.node?.parameters}.${entryPoint.attribute}`
        )
        entryPointConfig.setCurrentEntryPoint(entryPoint)
        logger.info(
          'EntryPoint [%s.%s] is executing',
          entryPoint.filePath?.substring(0, entryPoint.filePath?.lastIndexOf('.')),
          entryPoint.functionName ||
            `<anonymousFunc_${symVal.ast?.node?.loc.start?.line}_$${symVal.ast?.node?.loc.end?.line
            }>`
        )

        if (!(symVal as any).overloaded?.length) {
          continue
        }

        for (const overloadFuncDef of (symVal as any).overloaded.filter(() => true)) {
          const fdef = overloadFuncDef as FunctionDefinition
          this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)

          state.entryPointStartTimestamp = Date.now()
          const argValues: Value[] = []
          try {
            for (const param of fdef.parameters ?? []) {
              if (!param) continue
              let argValue = this.processInstruction(
                symVal,
                param.id,
                state
              )
              if (argValue.vtype !== 'symbol') {
                argValue.taint.sanitize()
                const sid = param.id?.type === 'Identifier' ? param.id.name : undefined
                const tmpVal = new SymbolValue(symVal.qid ?? '', {
                  sid,
                  parent: symVal,
                })
                if (symVal.value && tmpVal.sid) {
                  symVal.value[tmpVal.sid] = tmpVal
                }
                argValue = this.processInstruction(
                  symVal,
                  param.id,
                  state
                )
              }
              if (param.varType?.id) {
                const val = this.getMemberValueNoCreate(
                  symVal,
                  param.varType.id,
                  state
                )
                if (val?.vtype === 'class') {
                  argValue.rtype.definiteType = UastSpec.identifier(
                    val.logicalQid
                  )
                } else {
                  argValue.rtype.definiteType = param.varType.id
                }
              }
              argValues.push(argValue)
            }
          } catch (e) {
            handleException(
              e,
              'Error occurred in SpringAnalyzer.symbolInterpret: process argValue err',
              'Error occurred in SpringAnalyzer.symbolInterpret: process argValue err'
            )
          }

          try {
            this.executeCall(fdef, symVal, state, entryPoint.scopeVal, { callArgs: this.buildCallArgs(fdef, argValues, symVal) })
          } catch (e) {
            const fdefIdName = fdef.id?.name
            handleException(
              e,
              `[${fdefIdName} symbolInterpret failed. Exception message saved in error log file`,
              `[${fdefIdName} symbolInterpret failed. Exception message saved in error log file`
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
                `<anonymousFunc_${fdef.loc.start.line}_$${fdef.loc.end.line}>`
            )
            delete this.globalState.meetOtherEntryPoint
          }
          if (this.globalState.entryPointTimeout) {
            logger.info(
              'EntryPoint [%s.%s] is interrupted because timeout',
              entryPoint.filePath?.substring(0, entryPoint.filePath?.lastIndexOf('.')),
              entryPoint.functionName ||
                `<anonymousFunc_${fdef.loc.start.line}_$${fdef.loc.end.line}>`
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
          entryPointConfig.setCurrentEntryPoint(timeoutEntryPoint.entryPoint)
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
          state.entryPointStartTimestamp = Date.now()
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
   *
   * @param scope
   * @param node
   * @param state
   */
  override processVariableDeclaration(scope: Scope, node: VariableDeclaration, state: State) {
    const idName = node.id?.type === 'Identifier' ? node.id.name : undefined
    if (!node.init && !Rules.getPreprocessReady()) {
      let targetClassName = ''
      if (node.varType?.id?.type === 'Identifier') {
        const classRes = this.processIdentifier(scope, node.varType?.id, state)
        if (classRes && classRes?.vtype === 'symbol') {
          targetClassName = (classRes as any).name
        } else {
          targetClassName = classRes.logicalQid
        }
      }

      let hasBeanInject = false
      // bean注入注解形式
      if (node?._meta?.modifiers && Array.isArray(node?._meta?.modifiers)) {
        const decoratorArray = node?._meta?.modifiers.filter((item: string) => item.startsWith('@'))
        let isBeanReferenceByName = false
        let isBeanReferenceByClass = false
        let matchedDecorator = ''
        let decoratorMeta = ''
        const indexByName = this.beanReferenceAnnotationByName.findIndex((decorator: string) => {
          const matchingItem = decoratorArray.find((item: string) => item.includes(decorator))
          if (matchingItem) {
            if (matchingItem.includes('@Resource')) {
              const regex = /type\s*=\s*([^",]*)/
              const match = matchingItem.match(regex)
              if (match) {
                return false
              }
            }
            decoratorMeta = matchingItem
            return true
          }
          return false
        })
        if (indexByName !== -1) {
          isBeanReferenceByName = true
          matchedDecorator = this.beanReferenceAnnotationByName[indexByName]
        } else {
          const indexByClass = this.beanReferenceAnnotationByClass.findIndex((decorator: string) => {
            const matchingItem = decoratorArray.find((item: string) => item.includes(decorator))
            if (matchingItem) {
              decoratorMeta = matchingItem
              return true
            }
            return false
          })
          if (indexByClass !== -1) {
            isBeanReferenceByClass = true
            matchedDecorator = this.beanReferenceAnnotationByClass[indexByClass]
          }
        }
        if (isBeanReferenceByName && matchedDecorator !== '' && decoratorMeta !== '') {
          let beanName = idName ?? ''
          if (matchedDecorator === '@SofaReference' && decoratorMeta.includes('uniqueId')) {
            const regex = /uniqueId\s*=\s*"([^"]*)"/
            const match = decoratorMeta.match(regex)
            if (match) {
              beanName = match[1]
            }
          } else if (matchedDecorator === '@Qualifier' && decoratorMeta.includes('(') && decoratorMeta.includes('"')) {
            const qualifierValue = decoratorMeta
              .slice(decoratorMeta.indexOf('"') + 1, decoratorMeta.lastIndexOf('"'))
              .replace(/\s+/g, '')
            if (qualifierValue) {
              beanName = qualifierValue
            }
          } else if (matchedDecorator === '@Resource' && decoratorMeta.includes('name')) {
            const regex = /name\s*=\s*"([^"]*)"/
            const match = decoratorMeta.match(regex)
            if (match) {
              beanName = match[1]
            }
          }
          hasBeanInject = this.injectBeanByName(beanName, node, targetClassName)
        }
        if (isBeanReferenceByClass && matchedDecorator !== '' && decoratorMeta !== '' && !hasBeanInject) {
          if (node.varType?.id?.type === 'Identifier') {
            if (matchedDecorator === '@Resource') {
              const regex = /type\s*=\s*([^",)]*)/
              const match = decoratorMeta.match(regex)
              if (match) {
                node.varType.id.name = match[1].split('.')[0]
              }
            }
            const classRes = this.processIdentifier(scope, node.varType?.id, state)
            if (classRes && classRes?.vtype === 'symbol') {
              targetClassName = (classRes as any).name || classRes.qid || ''
            } else {
              targetClassName = classRes.logicalQid
            }
          }
          if (targetClassName) {
            hasBeanInject = this.injectBeanByClass(targetClassName, node) || false
          }
        }
      }
      // 同package下无注解形式
      if (!hasBeanInject) {
        const beanName = idName || ''
        hasBeanInject = this.injectBeanByName(beanName, node, targetClassName)
      }
      if (!hasBeanInject) {
        this.injectBeanByClass(targetClassName, node)
      }
    }

    return super.processVariableDeclaration(scope, node, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processFunctionDefinition(scope: Scope, node: FunctionDefinition, state: State) {
    // bean发布@Bean
    let isBeanService = false
    let isPrimary = false
    let beanName = ''
    if (node._meta?.modifiers && Array.isArray(node._meta?.modifiers)) {
      // TODO 后续UAST需要统一到Annotation
      for (const modifier of node._meta?.modifiers) {
        if (AstUtil.prettyPrintAST(modifier).includes('Primary')) {
          isPrimary = true
        }
        if (
          typeof modifier === 'string' &&
          this.beanServiceAnnotationOnFunction.some((anno: string) => modifier.includes(anno))
        ) {
          isBeanService = true
          const regex = /name\s*=\s*"([^"]*)"/
          const match = modifier.match(regex)
          const funcIdName = node.id?.type === 'Identifier' ? node.id.name : ''
          beanName = this.transformBeanNameVariable(funcIdName)
          if (match && beanName && beanName !== '') {
            beanName = match[1]
          }
        }
      }
    }
    const res = super.processFunctionDefinition(scope, node, state)
    if (isBeanService && beanName && beanName !== '') {
      let returnType = ''
      if (node.returnType?.id?.type === 'Identifier') {
        const returnClass = node.returnType?.id
        const returnTypeIdentifier = this.processIdentifier(scope, returnClass, state)
        returnType = returnTypeIdentifier.qid
      }
      this.topScope.spring.beanMap.set(beanName, {
        initFClos: res,
        className: QidUnifyUtil.qidUnifyByRemoveAngleAndPrefix(returnType),
        isPrimary,
      })
    }
    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processClassDefinition(scope: Scope, node: ClassDefinition, state: State) {
    let isBeanService = false
    let beanName = ''
    let isPrimary = false
    const annotations = (node._meta as { annotations?: unknown[] }).annotations
    if (annotations && Array.isArray(annotations)) {
      for (const rawAnnotation of annotations) {
        const annotation = rawAnnotation as any
        if (AstUtil.prettyPrintAST(annotation).includes('Primary')) {
          isPrimary = true
        }
        // TODO 后续这里UAST节点需要优化，现在prettyPrintAST出来结果不对
        if (
          this.beanServiceAnnotationOnClass.some((anno: string) =>
            AstUtil.prettyPrintAST(annotation).includes(anno.slice(1))
          )
        ) {
          isBeanService = true
          beanName = this.transformBeanNameVariable(node.id?.name ?? '')
          if (annotation.type === 'Sequence' && annotation.expressions && Array.isArray(annotation.expressions)) {
            for (const expr of annotation.expressions) {
              const exprBeanName = this.findBeanNameFromSequenceExpr(expr)
              if (exprBeanName) {
                beanName = exprBeanName
                break
              }
            }
          }
        }
      }
    }
    const res = super.processClassDefinition(scope, node, state)
    if (isBeanService) {
      this.topScope.spring.beanMap.set(beanName, {
        className: res.logicalQid,
        isPrimary,
      })
    }
    /* 收集 @Handler 注解映射：识别 @Handler(value) 并建立 value → className 映射。
       @Handler 的 value 通常是常量引用（如 HandlerConstants.XXX），在 processModule 阶段
       常量已被解析到 scope 中，通过 scope 查找获取字面量值，避免调用 processInstruction */
    if (annotations && Array.isArray(annotations) && res.logicalQid) {
      for (const rawAnnotation of annotations) {
        const annotationStr = AstUtil.prettyPrintAST(rawAnnotation)
        if (!annotationStr?.includes('Handler')) continue
        const annotation = rawAnnotation as { type?: string; body?: Array<{ type?: string }> }
        if (annotation.type !== 'ScopedStatement' || !Array.isArray(annotation.body)) continue
        /* ScopedStatement: body[0] 是注解类型声明，body[1+] 是注解参数值 */
        for (let i = 1; i < annotation.body.length; i++) {
          const candidate = annotation.body[i]
          /* 尝试解析常量引用（MemberAccess 如 HandlerConstants.XXX）*/
          const candidateStr = AstUtil.prettyPrintAST(candidate)
          if (!candidateStr) continue
          /* 从 scope 中查找常量值：遍历 scope 链找到常量定义 */
          let handlerValue: string | undefined
          const val = this.processInstruction(scope, candidate as Expr, state)
          if (val?.vtype === 'primitive' && typeof val.value === 'string') {
            handlerValue = val.value
          }
          if (handlerValue) {
            if (!this.topScope.spring.handlerAnnotationMap) {
              this.topScope.spring.handlerAnnotationMap = new Map<string, string>()
            }
            this.topScope.spring.handlerAnnotationMap.set(handlerValue, res.logicalQid)
          }
          break
        }
        break
      }
    }
    return res
  }

  /**
   *
   * @param beanName
   * @param node
   * @param targetClassName
   */
  injectBeanByName(beanName: string, node: VariableDeclaration, targetClassName?: string) {
    if (
      beanName &&
      beanName !== '' &&
      this.topScope.spring.beanMap?.has(beanName) &&
      this.topScope.spring.beanMap?.get(beanName)?.className
    ) {
      const implValue = this.topScope.spring.beanMap?.get(beanName).className
      if (node.varType?.id?.type === 'Identifier' && node.varType?.id?.name) {
        node.varType.id.name = implValue?.split('.').pop()
      }
      const nodeParent = node.parent
      const fromLiteral = {
        type: 'Literal',
        value: implValue,
        literalType: 'string',
        _meta: {},
        loc: node.loc,
        parent: node.init,
      } as unknown as Literal
      const importExpr = {
        type: 'ImportExpression',
        from: fromLiteral,
        arguments: [],
        _meta: node._meta,
        loc: node.loc,
        parent: nodeParent,
      } as unknown as Expr
      node.init = importExpr
      if (implValue && targetClassName && implValue !== targetClassName) {
        this.addExtraClassHierarchyByName(implValue, targetClassName)
      }
      return true
    }
    // spring reference场景
    if (beanName && beanName !== '' && this.topScope.spring.springReferenceMap.has(beanName)) {
      const { interfaceName } = this.topScope.spring.springReferenceMap.get(beanName)
      if (interfaceName && this.topScope.spring.springServiceMap.has(interfaceName)) {
        const beanRef = this.topScope.spring.springServiceMap.get(interfaceName)
        const implValue = this.topScope.spring.beanMap?.get(beanRef.ref)?.className
        if (implValue) {
          if (node.varType?.id?.type === 'Identifier' && node.varType?.id?.name) {
            node.varType.id.name = implValue?.split('.').pop()
          }
          const nodeParent = node.parent
          const fromLiteral = {
            type: 'Literal',
            value: implValue,
            literalType: 'string',
            _meta: {},
            loc: node.loc,
            parent: node.init,
          } as unknown as Literal
          const importExpr = {
            type: 'ImportExpression',
            from: fromLiteral,
            arguments: [],
            _meta: node._meta,
            loc: node.loc,
            parent: nodeParent,
          } as unknown as Expr
          node.init = importExpr
          if (implValue && targetClassName && implValue !== targetClassName) {
            this.addExtraClassHierarchyByName(implValue, targetClassName)
          }
          return true
        }
      }
    }
    return false
  }

  /**
   *
   * @param targetClassName
   * @param node
   */
  injectBeanByClass(targetClassName: string, node: VariableDeclaration) {
    let hasFindPrimary = false
    for (const beanValue of this.topScope.spring.beanMap.values()) {
      if (beanValue.isPrimary && beanValue.className === targetClassName) {
        hasFindPrimary = true
        const nodeParent = node.parent
        const fromLiteral = {
          type: 'Literal',
          value: targetClassName,
          literalType: 'string',
          _meta: {},
          loc: node.loc,
          parent: node.init,
        } as unknown as Literal
        const importExpr = {
          type: 'ImportExpression',
          from: fromLiteral,
          arguments: [],
          _meta: node._meta,
          loc: node.loc,
          parent: nodeParent,
        } as unknown as Expr
        node.init = importExpr
        return true
      }
    }
    if (!hasFindPrimary) {
      for (const beanValue of this.topScope.spring.beanMap.values()) {
        if (beanValue.className === targetClassName) {
          hasFindPrimary = true
          const nodeParent = node.parent
          const fromLiteral = {
            type: 'Literal',
            value: targetClassName,
            literalType: 'string',
            _meta: {},
            loc: node.loc,
            parent: node.init,
          } as unknown as Literal
          const importExpr = {
            type: 'ImportExpression',
            from: fromLiteral,
            arguments: [],
            _meta: node._meta,
            loc: node.loc,
            parent: nodeParent,
          } as unknown as Expr
          node.init = importExpr
          return true
        }
      }
    }

    // 接口→实现类匹配：通过 AST supers 检查 bean 的类是否 implements targetClassName
    // 只注册 classHierarchy 继承关系，不修改 AST 节点
    // 原因：修改 varType/init 会导致接口 default 方法在 callgraph 中丢失
    if (!hasFindPrimary && this.classMap && this.symbolTable && targetClassName) {
      const targetShortName = targetClassName.split('.').pop() || targetClassName
      let matchedBean: { className: string; isPrimary: boolean } | undefined
      for (const beanValue of this.topScope.spring.beanMap.values()) {
        if (!beanValue.className) {
          continue
        }
        const classUuid = this.classMap.get(beanValue.className)
        if (!classUuid) {
          continue
        }
        const classVal = this.symbolTable.get(classUuid)
        if (!classVal?.ast?.node?.supers || !Array.isArray(classVal.ast.node.supers)) {
          continue
        }
        const implementsTarget = classVal.ast.node.supers.some(
          (superAst: { name?: string }) => superAst?.name === targetShortName
        )
        if (implementsTarget) {
          if (beanValue.isPrimary) {
            matchedBean = beanValue
            break
          }
          if (!matchedBean) {
            matchedBean = beanValue
          }
        }
      }
      if (matchedBean) {
        const implClassName = matchedBean.className
        this.addExtraClassHierarchyByName(implClassName, targetClassName)
        return true
      }
    }
  }

  /**
   *
   * @param variable
   */
  transformBeanNameVariable(variable: string) {
    // 检查是否是字符串
    if (typeof variable !== 'string') {
      handleException(
        new TypeError('SpringAnalyzer:transformBeanNameVariable.The input variable must be a string.'),
        'Error in SpringAnalyzer:transformBeanNameVariable.The input variable must be a string.',
        'Error in SpringAnalyzer:transformBeanNameVariable.The input variable must be a string.'
      )
      return ''
    }

    // 如果是连续多个大写字母开头（如"HELLO"），直接返回
    if (/^[A-Z]{2,}/.test(variable)) {
      return variable
    }

    // 如果是单个大写字母开头，将第一个字母转换为小写
    if (/^[A-Z]/.test(variable)) {
      return variable.charAt(0).toLowerCase() + variable.slice(1)
    }

    // 如果不是以大写字母开头，直接返回原变量
    return variable
  }

  /**
   *
   * @param classMap
   */
  compensateDependencyInjection(classMap: Map<string, string>) {
    if (!classMap) {
      return
    }
    for (const classUuid of classMap.values()) {
      const classVal = this.symbolTable.get(classUuid)
      if (
        classVal.vtype !== 'class' ||
        !classVal.ast.node ||
        !Array.isArray(classVal.ast.node.body) ||
        !classVal.members
      ) {
        continue
      }
      for (const bodyAst of classVal.ast.node.body) {
        if (
          bodyAst.type !== 'VariableDeclaration' ||
          !bodyAst.id ||
          !bodyAst.id.name ||
          !classVal.members.has(bodyAst.id.name) ||
          classVal.members.get(bodyAst.id.name)?.vtype !== 'uninitialized'
        ) {
          continue
        }
        const state = this.initState(classVal)
        this.processVariableDeclaration(classVal, bodyAst, state)
      }
    }
  }

  /**
   * inject object instead of class
   * @param classMap
   * @param packageManager
   */
  adJustDependencyInjection(classMap: Map<string, string>, packageManager: unknown) {
    if (!classMap) {
      return
    }
    for (const classValUUid of classMap.values()) {
      const classVal = this.symbolTable.get(classValUUid)
      if (
        classVal.vtype !== 'class' ||
        !classVal.ast.node ||
        !Array.isArray(classVal.ast.node.body) ||
        classVal.members.size === 0
      ) {
        continue
      }
      for (const bodyAst of classVal.ast.node.body) {
        if (
          bodyAst.type !== 'VariableDeclaration' ||
          !bodyAst.id ||
          !bodyAst.id.name ||
          !bodyAst.init ||
          bodyAst.init.type !== 'ImportExpression' ||
          !classVal.members.has(bodyAst.id.name) ||
          classVal.members.get(bodyAst.id.name)?.vtype !== 'class'
        ) {
          continue
        }
        const memberVal = classVal.members.get(bodyAst.id.name)
        const objVal = newInstance(this, packageManager, memberVal.qid, bodyAst)
        objVal.injected = true
        objVal.rtype = { type: undefined }
        objVal.rtype.definiteType = UastSpec.identifier(
          memberVal.logicalQid
        )
        const memberValues = objVal?.members ? objVal.members.entries().map(([_, v]: [string, any]) => v) : []
        for (const fieldVal of memberValues) {
          const val = fieldVal as { vtype?: string; ast?: { node?: { _meta?: { modifiers?: string[] } } }; sid?: string }
          if (val.vtype !== 'fclos' || !val.ast?.node) {
            continue
          }
          if (val.sid === 'afterPropertiesSet' || val.ast?.node?._meta?.modifiers?.includes('@PostConstruct')) {
            const state = this.initState(objVal)
            this.executeCall(val.ast?.node, val as unknown as SymbolValueType, state, objVal, INTERNAL_CALL)
          }
        }
        classVal.members.set(bodyAst.id.name, objVal)

        /* @Handler dispatch：对有 initApplicationContext 方法的 bean（如 HandlerFactory），
           在 CLASS 级别覆盖 getHandler 方法，使其返回所有 @Handler 注解 bean 的联合体。
           必须修改 memberVal（CLASS 值，被 parent/child 共享），而非 objVal（仅在当前类可见的新实例）。
           注意：引擎的 member access 使用 scope.value[key]，不是 scope.members.get(key） */
        const handlerMap = this.topScope.spring.handlerAnnotationMap as Map<string, string> | undefined
        if (handlerMap && handlerMap.size > 0 && memberVal.members?.has('initApplicationContext')) {
          /* 从 value 和 members 两处获取 getHandler，确保修改生效 */
          const classGetHandler = memberVal.value?.['getHandler'] || memberVal.members?.get('getHandler')
          if (classGetHandler?.vtype === 'fclos') {
            /* 收集所有 handler 实例联合体 */
            const handlerInstances: any[] = []
            for (const [, handlerClassName] of handlerMap) {
              const handlerClassUuid = classMap.get(handlerClassName)
              if (!handlerClassUuid) continue
              const handlerClassVal = this.symbolTable.get(handlerClassUuid)
              if (!handlerClassVal) continue
              const handlerObj = newInstance(this, packageManager, handlerClassVal.qid, bodyAst)
              handlerObj.injected = true
              handlerObj.rtype = { type: undefined }
              handlerObj.rtype.definiteType = UastSpec.identifier(handlerClassName)
              handlerInstances.push(handlerObj)
            }
            if (handlerInstances.length > 0) {
              const handlerUnion = new UnionValue(
                undefined,
                'handler-dispatch-union',
                `${memberVal.qid}.handler-union`,
                bodyAst
              )
              handlerUnion.parent = memberVal
              for (const instance of handlerInstances) {
                handlerUnion.appendValue(instance)
              }
              /* 在 CLASS 的 getHandler 上设置 runtime.execute（同时设置 value 和 members）
                 同时清除 fdef，确保引擎走 runtime.execute 而非原始函数体 */
              if (!classGetHandler.runtime) classGetHandler.runtime = {}
              /* 捕获 analyzer 引用，用于精确 dispatch + lazy 剪枝 */
              const analyzer = this as any
              /* handlerValue → handler instance 的精确映射 */
              const handlerInstanceMap = new Map<string, any>()
              for (const [handlerValue, handlerClassName] of handlerMap) {
                const matchingInstance = handlerInstances.find((inst: any) =>
                  inst.rtype?.definiteType?.name === handlerClassName
                )
                if (matchingInstance) {
                  handlerInstanceMap.set(handlerValue, matchingInstance)
                }
              }
              let prunedUnion: any = null
              classGetHandler.runtime.execute = (_fclos: any, _argvalues: any[], _state: any, _node: any, _scope: any) => {
                /* 精确 dispatch：如果参数是已解析的字符串常量，直接返回对应的 handler 实例 */
                const arg = _argvalues?.[0]
                if (arg?.vtype === 'primitive' && typeof arg.value === 'string') {
                  const exactMatch = handlerInstanceMap.get(arg.value)
                  if (exactMatch) {
                    logger.info('@Handler dispatch exact: "%s" → %s', arg.value, exactMatch.rtype?.definiteType?.name)
                    return exactMatch
                  }
                }
                /* 回退：lazy 剪枝，首次调用时过滤只保留 sink-reachable 的 handler */
                if (prunedUnion) return prunedUnion
                const { sinkArray, sofaStrictMatchSinkCacheMap } = analyzer.pruneInfoMap || {}
                if (!sinkArray || sinkArray.length === 0) {
                  prunedUnion = handlerUnion
                  return prunedUnion
                }
                const reachableInstances: any[] = []
                for (const instance of handlerInstances) {
                  const executeFclos = instance.members?.get('execute') || instance.value?.['execute']
                  const doExecuteFclos = instance.members?.get('doExecute') || instance.value?.['doExecute']
                  const targetFclos = doExecuteFclos || executeFclos
                  if (!targetFclos || !targetFclos.invocationMap) {
                    reachableInstances.push(instance)
                    continue
                  }
                  if (analyzer.checkFclosMatchSink(targetFclos, [], sinkArray, sofaStrictMatchSinkCacheMap, false)) {
                    reachableInstances.push(instance)
                  }
                }
                if (reachableInstances.length === 0) {
                  prunedUnion = handlerUnion
                } else {
                  prunedUnion = new UnionValue(
                    undefined,
                    'handler-dispatch-union-pruned',
                    `${memberVal.qid}.handler-union-pruned`,
                    bodyAst
                  )
                  prunedUnion.parent = memberVal
                  for (const instance of reachableInstances) {
                    prunedUnion.appendValue(instance)
                  }
                }
                logger.info(
                  '@Handler dispatch lazy prune fallback: %d/%d handler sink-reachable',
                  reachableInstances.length,
                  handlerInstances.length
                )
                return prunedUnion
              }
              if (classGetHandler.ast) classGetHandler.ast.fdef = undefined
              /* 确保 value 和 members 都指向同一个有 runtime.execute 的 fclos */
              if (memberVal.value) memberVal.value['getHandler'] = classGetHandler
              if (memberVal.members) memberVal.members.set('getHandler', classGetHandler)
              /* 为静态剪枝注入虚拟 invocation：getHandler fclos 指向每个 handler 实例的 execute/doExecute fclos。
                 目的：checkFclosMatchSink 只递归 invocationMap 的静态 invocation，看不到 runtime.execute；
                 注入后剪枝可沿 getHandler → handler.execute/doExecute 自然递归到 sink。
                 calleeType/fsig/callSiteLiteral 使用特殊前缀，确保不误命中 sink 精确匹配或 dynamic feature。 */
              if (!(classGetHandler.invocationMap instanceof Map)) {
                classGetHandler.invocationMap = new Map()
              }
              const virtualInvocations: Invocation[] = []
              for (const instance of handlerInstances) {
                for (const sid of ['execute', 'doExecute']) {
                  const targetFclos = instance.members?.get(sid) || instance.value?.[sid]
                  if (targetFclos?.vtype !== 'fclos') continue
                  const targetFdef =
                    targetFclos.ast?.fdef ||
                    (Array.isArray(targetFclos.overloaded) && targetFclos.overloaded[0]) ||
                    targetFclos.ast?.node
                  virtualInvocations.push({
                    callSiteLiteral: `<@Handler dispatch virtual>.${sid}`,
                    calleeType: '<@Handler dispatch virtual>',
                    fsig: `<@Handler dispatch virtual>.${sid}`,
                    argTypes: [],
                    callSite: bodyAst,
                    fromScope: memberVal,
                    fromScopeAst: memberVal.ast?.node,
                    toScope: targetFclos,
                    toScopeAst: targetFdef,
                  })
                }
              }
              if (virtualInvocations.length > 0) {
                const virtualNodeHash = `${memberVal.qid}.handler-dispatch-virtual`
                classGetHandler.invocationMap.set(virtualNodeHash, virtualInvocations)
              }
              logger.info(
                '@Handler dispatch virtual invocation: CLASS [%s] getHandler 注入 %d 个虚拟 invocation (execute/doExecute handler fclos) 供静态剪枝递归',
                memberVal.logicalQid || memberVal.qid,
                virtualInvocations.length
              )
              logger.info(
                '@Handler dispatch: 在 CLASS [%s] 的 getHandler 方法上设置 runtime.execute，返回 %d 个 handler 联合体',
                memberVal.logicalQid || memberVal.qid,
                handlerInstances.length
              )
            }
          }
        }
      }
    }
  }

  /**
   * find bean name from sequence expr
   * @param expr
   */
  findBeanNameFromSequenceExpr(expr: Expr | Stmt | Decl): string | undefined {
    let beanName: string | undefined
    if (expr.type === 'Literal' && (expr as Literal).value) {
      beanName = (expr as Literal).value as string
    } else if (expr.type === 'AssignmentExpression' && (expr as AssignmentExpression).right?.type === 'Literal') {
      const leftStr = AstUtil.prettyPrintAST((expr as AssignmentExpression).left)
      if (leftStr?.endsWith('value') || leftStr?.endsWith('uniqueId')) {
        beanName = ((expr as AssignmentExpression).right as Literal).value as string
      }
    } else if (expr.type === 'ScopedStatement' && Array.isArray((expr as ScopedStatement).body)) {
      for (const subExpr of (expr as ScopedStatement).body) {
        beanName = this.findBeanNameFromSequenceExpr(subExpr)
        if (beanName) {
          break
        }
      }
    }
    return beanName
  }
}

export = SpringAnalyzer
