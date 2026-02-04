const logger = require('../../../../util/logger')(__filename)
const JavaAnalyzer = require('../common/java-analyzer')
const AstUtil = require('../../../../util/ast-util')
const Initializer = require('./spring-initializer')
const _ = require('lodash')
const entryPointConfig = require('../../common/current-entrypoint')
const constValue = require('../../../../util/constant')
const UndefinedValue = require('../../common/value/undefine')
const { handleException } = require('../../common/exception-handler')

/**
 *
 */
class SpringAnalyzer extends (JavaAnalyzer as any) {
  /**
   *
   * @param options
   */
  constructor(options: any) {
    super(options)
    this.beanReferenceAnnotationByName = ['@SofaReference', '@OsgiReference', '@Qualifier', '@Resource']
    this.beanReferenceAnnotationByClass = ['@Autowired', '@Resource', '@TestBean']
    this.beanServiceAnnotationOnClass = ['@Component', '@Service', '@Repository']
    this.beanServiceAnnotationOnFunction = ['@Bean']
    this.AOPPointCutAnnotationOnFunction = ['@Pointcut']
    this.AOPLogicAnnotationOnFunction = ['@Around', '@Before', '@After', '@AfterReturning', '@AfterThrowing']
  }

  /**
   *
   * @param dir
   */
  async preProcess(dir: any) {
    // init global scope
    Initializer.initGlobalScope(this.topScope)

    // time-out control
    ;(this as any).thisIterationTime = 0
    ;(this as any).prevIterationTime = new Date().getTime()

    await Initializer.initBeans(this.topScope, dir)

    await Initializer.initAop(this.topScope)

    await this.scanPackages(dir)

    Initializer.initPackageScope(this.topScope.packageManager)

    this.assembleClassMap(this.topScope.packageManager)
  }

  /**
   *
   *
   */
  symbolInterpret() {
    const { entryPoints } = this as any
    const state = this.initState(this.topScope)

    if (_.isEmpty(entryPoints)) {
      logger.info('[symbolInterpret]：EntryPoints are not found')
      return true
    }
    const hasAnalysised: any[] = []
    // 自定义source入口方式，并根据入口自主加载source
    for (const entryPoint of entryPoints) {
      if (entryPoint.type === constValue.ENGIN_START_FUNCALL) {
        if (
          hasAnalysised.includes(
            `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?._qid}#${entryPoint.entryPointSymVal.ast.parameters}.${entryPoint.attribute}`
          )
        ) {
          continue
        }

        hasAnalysised.push(
          `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?._qid}#${entryPoint.entryPointSymVal.ast.parameters}.${entryPoint.attribute}`
        )
        entryPointConfig.setCurrentEntryPoint(entryPoint)
        logger.info(
          'EntryPoint [%s.%s] is executing',
          entryPoint.filePath?.substring(0, entryPoint.filePath?.lastIndexOf('.')),
          entryPoint.functionName ||
            `<anonymousFunc_${entryPoint.entryPointSymVal?.ast.loc.start.line}_$${
              entryPoint.entryPointSymVal?.ast.loc.end.line
            }>`
        )

        this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)

        const argValues: any[] = []
        try {
          for (const key in entryPoint.entryPointSymVal?.ast?.parameters) {
            argValues.push(
              this.processInstruction(
                entryPoint.entryPointSymVal,
                entryPoint.entryPointSymVal?.ast?.parameters[key].id,
                state
              )
            )
          }
        } catch (e) {
          handleException(
            e,
            'Error occurred in SpringAnalyzer.symbolInterpret: process argValue err',
            'Error occurred in SpringAnalyzer.symbolInterpret: process argValue err'
          )
        }

        try {
          this.executeCall(
            entryPoint.entryPointSymVal?.ast,
            entryPoint.entryPointSymVal,
            argValues,
            state,
            entryPoint.scopeVal
          )
        } catch (e) {
          handleException(
            e,
            `[${entryPoint.entryPointSymVal?.ast?.id?.name} symbolInterpret failed. Exception message saved in error log file`,
            `[${entryPoint.entryPointSymVal?.ast?.id?.name} symbolInterpret failed. Exception message saved in error log file`
          )
        }
        this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
      }
    }
    return true
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processVariableDeclaration(scope: any, node: any, state: any) {
    let hasBeanInject = false
    // bean注入注解形式
    if (node?._meta?.modifiers && Array.isArray(node?._meta?.modifiers)) {
      const decoratorArray = node?._meta?.modifiers.filter((item: any) => item.startsWith('@'))
      let isBeanReferenceByName = false
      let isBeanReferenceByClass = false
      let matchedDecorator = ''
      let decoratorMeta = ''
      const indexByName = this.beanReferenceAnnotationByName.findIndex((decorator: string) => {
        const matchingItem = decoratorArray.find((item: any) => item.includes(decorator))
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
          const matchingItem = decoratorArray.find((item: any) => item.includes(decorator))
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
        let beanName = node.id?.name
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
        hasBeanInject = this.injectBeanByName(beanName, node)
      }
      if (isBeanReferenceByClass && matchedDecorator !== '' && decoratorMeta !== '' && !hasBeanInject) {
        let targetClassName = ''
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
            targetClassName = classRes.name
          } else {
            targetClassName = classRes.sort ? classRes.sort : classRes._qid
          }
        }
        if (targetClassName) {
          hasBeanInject = this.injectBeanByClass(targetClassName, node) || false
        }
      }
    }
    // 同package下无注解形式
    if (!hasBeanInject) {
      const beanName = node.id?.name
      hasBeanInject = this.injectBeanByName(beanName, node)
    }
    if (!hasBeanInject) {
      let targetClassName = ''
      if (node.varType?.id?.type === 'Identifier') {
        const classRes = this.getMemberValueNoCreate(scope, node.varType?.id, state)
        if (classRes && classRes?.vtype === 'symbol') {
          targetClassName = classRes.name
        } else {
          targetClassName = classRes.sort ? classRes.sort : classRes._qid
        }
      }
      this.injectBeanByClass(targetClassName, node)
    }

    return super.processVariableDeclaration(scope, node, state)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  processFunctionDefinition(scope: any, node: any, state: any) {
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
          beanName = this.transformBeanNameVariable(node.id?.name)
          if (match && beanName && beanName !== '') {
            beanName = match[1]
          }
        }
      }
    }

    // 处理AOP切点@Pointcut
    let isPointCut = false
    let cutMethod = node.id?.name
    let cutTargetClass = ''
    let cutTargetMethod = ''
    let cutType = 'unknown'
    if (node._meta?.modifiers && Array.isArray(node._meta?.modifiers)) {
      for (const modifier of node._meta?.modifiers) {
        if (
          typeof modifier === 'string' &&
          this.AOPPointCutAnnotationOnFunction.some((anno: string) => modifier.includes(anno))
        ) {
          isPointCut = true
          let curTargetInfo = extractCutTargetInfoFromAnnotation(modifier)
          if (curTargetInfo && Object.keys(curTargetInfo).length > 0) {
            cutTargetClass = curTargetInfo['cutClass'] ?? ''
            cutTargetMethod = curTargetInfo['cutMethod'] ?? ''
            cutType = curTargetInfo['type']
          }
        }
      }
    }

    // 处理AOP具体处理逻辑
    let isCutLogic = false
    let cutAnnoMethod = ''
    let aopLogicTag: string | null = null
    if (node._meta?.modifiers && Array.isArray(node._meta?.modifiers)) {
      for (const modifier of node._meta?.modifiers) {
        const hasAopLogic = this.AOPLogicAnnotationOnFunction.some((anno: string) => {
          if (modifier.includes(anno)) {
            aopLogicTag = anno; 
            return true;
          }
          return false;
        });

        if (typeof modifier === 'string' && hasAopLogic) {
          isCutLogic = true
          let cutAnnoInfo = extractCutMethodOrTargetFromAnnotation(modifier)
          if (cutAnnoInfo.targetInfo) {
            isPointCut = true
            cutTargetClass = cutAnnoInfo.targetInfo['cutClass'] ?? ''
            cutTargetMethod = cutAnnoInfo.targetInfo['cutMethod'] ?? ''
            cutType = cutAnnoInfo.targetInfo['type']
            cutAnnoMethod = cutMethod
          } else if (cutAnnoInfo.cutMethod) {
            cutAnnoMethod = cutAnnoInfo.cutMethod
          }
        }
      }
    }

    const res = super.processFunctionDefinition(scope, node, state)
    if (isBeanService && beanName && beanName !== '') {
      let returnType = ''
      if (node.returnType?.id?.type === 'Identifier') {
        const returnClass = node.returnType?.id
        const returnTypeIdentifier = this.processIdentifier(scope, returnClass, scope)
        returnType = returnTypeIdentifier.sort ? returnTypeIdentifier.sort : returnTypeIdentifier._qid
      }
      this.topScope.beanMap.set(beanName, {
        initFClos: res,
        className: returnType,
        isPrimary,
      })
    }
    if (isPointCut && cutTargetClass !== '' && cutTargetMethod !== '') {
      const value = this.topScope.aopMap.get(cutMethod);
      if (!value) {
        this.topScope.aopMap.set(cutMethod, {
          targetClass: cutTargetClass,
          targetMethod: cutTargetMethod,
          cutType: cutType
        })
      } else {
        value.targetClass = cutTargetClass
        value.targetMethod = cutTargetMethod
        value.cutType = cutType
        this.topScope.aopMap.set(cutMethod, value);
      }
    }
    if (isCutLogic && cutAnnoMethod !== '' && aopLogicTag) {
      const value = this.topScope.aopMap.get(cutAnnoMethod);
      if (!value) {
        this.topScope.aopMap.set(cutAnnoMethod, {
          logicMethod: [{
            fclos: res,
            logic: aopLogicTag
          }]
        })
      } else {
        if (value.logicMethod === undefined) {
          value.logicMethod = [{
            fclos: res,
            logic: aopLogicTag
          }]
        } else {
          value.logicMethod.push({
            fclos: res,
            logic: aopLogicTag
          })
        }
        this.topScope.aopMap.set(cutAnnoMethod, value);
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
  processClassDefinition(scope: any, node: any, state: any) {
    let isBeanService = false
    let beanName = ''
    let isPrimary = false
    if (node._meta?.annotations && Array.isArray(node._meta?.annotations)) {
      for (const annotation of node._meta?.annotations) {
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
          beanName = this.transformBeanNameVariable(node.id?.name)
          if (annotation.type === 'Sequence' && annotation.expressions && Array.isArray(annotation.expressions)) {
            for (const expr of annotation.expressions) {
              if (expr.type === 'Literal' && expr.value) {
                beanName = expr.value
                break
              }
            }
          }
        }
      }
    }
    const res = super.processClassDefinition(scope, node, state)
    if (isBeanService) {
      this.topScope.beanMap.set(beanName, {
        className: res.sort,
        isPrimary,
      })
    }
    return res
  }

  /**
   * 检测是否存在AOP相关调用
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   */
  processCallExpression(scope: any, node: any, state: any) {
    if (!this.topScope.aopMap || this.topScope.aopMap.size === 0) {
      return super.processCallExpression(scope, node, state)
    }
    
    const fclos = this.processInstruction(scope, node.callee, state)
    if (!fclos) return UndefinedValue()

    for (const [key, value] of this.topScope.aopMap.entries()) {
      const sig = value.targetClass + '.' + value.targetMethod
      if (sig === fclos._qid) {
        return this.processAop(scope, node, state, value, fclos)
      } else if (sig.includes('*')) {
        const escaped = sig.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
        const reg = new RegExp("^" + escaped.replace(/\*/g, ".*") + "$");
        if (reg.test(fclos._qid)) {
          return this.processAop(scope, node, state, value, fclos)
        }
      }
    }

    if (fclos._sid === 'proceed') { // 返回原有执行逻辑
      let proceedKey = fclos._qid.substring(0, fclos._qid.lastIndexOf("."))
      if (this.topScope.proceedMap.has(proceedKey)) {
        const originFclos = this.topScope.proceedMap.get(proceedKey)
        let argvalues: any[] = this.prepareArgValues(scope, node, state, fclos)
        return this.processCall(node, originFclos, argvalues, state, scope)
      }
    }

    return super.processCallExpression(scope, node, state)
  }

  /**
   * 处理AOP
   * @param scope - 作用域
   * @param node - AST 节点
   * @param state - 状态
   * @param aopLogic - AOP逻辑tag
   * @param current_fclos 当前fclos
   */
  processAop(scope: any, node: any, state: any, aopLogic: any, current_fclos: any) {
    let argvalues: any[] = []
    let fclos
    for (const logicM of aopLogic.logicMethod) {
      fclos = logicM.fclos
      argvalues = this.prepareArgValues(scope, node, state, fclos)
      switch (logicM.logic) {
        case '@After':
          super.processCallExpression(scope, node, state)
          break
        case '@Before':
        case '@Around':
          let isNeedProcessARg = this.needProceedArg(fclos.fdef?.parameters)
          if (isNeedProcessARg) {
            argvalues.unshift(current_fclos)
            this.topScope.proceedMap.set(current_fclos._qid, current_fclos)
          }
          break
        default:
          logger.warn(`AOP logic type: ${logicM.logic} need to be supported`)
          break
      }
    }

    return this.processCall(node, fclos, argvalues, state, scope)
  }

  /**
   * 简单处理调用
   * @fclos - 函数闭包
   * @argvalues - 参数值列表
   * @param node - AST 节点
   * @param state - 状态
   * @param scope - 作用域
   */
  processCall(node: any, fclos: any, argvalues: any, state: any, scope: any) {
    const res = this.executeCall(node, fclos, argvalues, state, scope)
    if (res) {
      res.rtype = fclos.rtype
    }
    if (res && argvalues && this.checkerManager?.checkAtFunctionCallAfter) {
      this.checkerManager.checkAtFunctionCallAfter(this, scope, node, state, {
        argvalues,
        fclos,
        ret: res,
        pcond: state.pcond,
        einfo: state.einfo,
        callstack: state.callstack,
      })
    }

    return res
  }

  /**
   * 判断是否需要ProceedingJoinPoint参数
   * @param parameters
   * @returns boolean
   */
  needProceedArg(parameters: any) {
    if (parameters && parameters.length > 0) {
      const param = parameters[0]
      if (param.varType?.id?.name === 'ProceedingJoinPoint') {
        return true
      }
    }
    return false
  }

  /**
   *
   * @param beanName
   * @param node
   */
  injectBeanByName(beanName: any, node: any) {
    if (
      beanName &&
      beanName !== '' &&
      this.topScope.beanMap?.has(beanName) &&
      this.topScope.beanMap?.get(beanName)?.className
    ) {
      const implValue = this.topScope.beanMap?.get(beanName).className
      if (node.varType?.id?.type === 'Identifier' && node.varType?.id?.name) {
        node.varType.id.name = implValue?.split('.').pop()
      }
      node.init = {
        type: 'ImportExpression',
        from: {
          type: 'Literal',
          value: implValue,
          literalType: 'string',
          _meta: {},
          loc: node.loc,
          parent: node.init,
        },
        arguments: [],
        _meta: node._meta,
        loc: node.loc,
        parent: node.parent,
      }
      return true
    }
    // spring reference场景
    if (beanName && beanName !== '' && this.topScope.springReferenceMap.has(beanName)) {
      const { interfaceName } = this.topScope.springReferenceMap.get(beanName)
      if (interfaceName && this.topScope.springServiceMap.has(interfaceName)) {
        const beanRef = this.topScope.springServiceMap.get(interfaceName)
        const implValue = this.topScope.beanMap?.get(beanRef.ref)?.className
        if (implValue) {
          if (node.varType?.id?.type === 'Identifier' && node.varType?.id?.name) {
            node.varType.id.name = implValue?.split('.').pop()
          }
          node.init = {
            type: 'ImportExpression',
            from: {
              type: 'Literal',
              value: implValue,
              literalType: 'string',
              _meta: {},
              loc: node.loc,
              parent: node.init,
            },
            arguments: [],
            _meta: node._meta,
            loc: node.loc,
            parent: node.parent,
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
  injectBeanByClass(targetClassName: any, node: any) {
    let hasFindPrimary = false
    for (const beanValue of this.topScope.beanMap.values()) {
      if (beanValue.isPrimary && beanValue.className === targetClassName) {
        hasFindPrimary = true
        node.init = {
          type: 'ImportExpression',
          from: {
            type: 'Literal',
            value: targetClassName,
            literalType: 'string',
            _meta: {},
            loc: node.loc,
            parent: node.init,
          },
          arguments: [],
          _meta: node._meta,
          loc: node.loc,
          parent: node.parent,
        }
        return true
      }
    }
    if (!hasFindPrimary) {
      for (const beanValue of this.topScope.beanMap.values()) {
        if (beanValue.className === targetClassName) {
          hasFindPrimary = true
          node.init = {
            type: 'ImportExpression',
            from: {
              type: 'Literal',
              value: targetClassName,
              literalType: 'string',
              _meta: {},
              loc: node.loc,
              parent: node.init,
            },
            arguments: [],
            _meta: node._meta,
            loc: node.loc,
            parent: node.parent,
          }
          return true
        }
      }
    }
  }

  /**
   *
   * @param variable
   */
  transformBeanNameVariable(variable: any) {
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
}

/**
 * 从 AOP 表达式中提取目标类和方法信息
 * @param annotation AOP 切点表达式字符串
 * @returns { cutClass?: string; cutMethod?: string; type: string }
 */
function extractCutTargetInfoFromAnnotation(annotation: string): {
  cutClass?: string
  cutMethod?: string
  type: 'execution' | 'annotation' | 'within' | 'unknown'
} {
  const targetInfo: {
    cutClass?: string
    cutMethod?: string
    type: 'execution' | 'annotation' | 'within' | 'unknown'
  } = { type: 'unknown' }
  const cleanAnnotation = annotation.replace(/\s+/g, ' ').trim()

  // 处理execution
  if (cleanAnnotation.includes('execution')) {
    targetInfo.type = 'execution'
    const executionReg = /execution\s*\(\s*(?:.*?\s+)+([a-zA-Z0-9_$.*]+)\.([a-zA-Z0-9_$*]+)\s*\(/
    const m = cleanAnnotation.match(executionReg)
    if (m) {
      targetInfo.cutClass = m[1]
      targetInfo.cutMethod = m[2]
    }
  }

  // 处理within
  else if (cleanAnnotation.includes('within')) {
    targetInfo.type = 'within'
    const withinReg = /within\s*\(\s*([a-zA-Z0-9_$.*]+)\s*\)/
    const m = cleanAnnotation.match(withinReg)
    if (m) {
      targetInfo.cutClass = m[1]
      targetInfo.cutMethod = '*' // 通常是类下所有方法
    }
  }

  // 处理annotation
  else if (cleanAnnotation.includes('annotation')) {
    targetInfo.type = 'annotation'
    const reg = /@annotation\s*\(\s*([A-Za-z0-9_$.]+)\s*\)/
    const m = cleanAnnotation.match(reg)

    if (m) {
      targetInfo.cutClass = m[1]
      targetInfo.cutMethod = undefined
    }
  }

  return targetInfo
}


/**
 * 提取方法名或直接设置aop映射
 * @param annotation
 */
function extractCutMethodOrTargetFromAnnotation(annotation: string): { targetInfo?: any, cutMethod?: string } {
  if (annotation.includes('execution') || annotation.includes('within') || annotation.includes('annotation')) {
    const targetInfo = extractCutTargetInfoFromAnnotation(annotation)

    return { targetInfo }
  } else {
    let method = ''

    const reg = /"([A-Za-z0-9_]+)\s*\(/
    const m = annotation.match(reg)
    if (m) {
      method = m[1]
    }

    return { cutMethod: method }
  }
}

export = SpringAnalyzer
