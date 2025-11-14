const logger = require('../../../../util/logger')(__filename)
const JavaAnalyzer = require('../common/java-analyzer')
const AstUtil = require('../../../../util/ast-util')
const Initializer = require('./spring-initializer')
const _ = require('lodash')
const entryPointConfig = require('../../common/current-entrypoint')
const constValue = require('../../../../util/constant')
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

export = SpringAnalyzer
