import JavaInitializer from '../common/java-initializer'
import { INTERNAL_CALL } from '../../common/call-args'

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
