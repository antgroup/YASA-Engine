import TypeResolverASTVisitor from './visitor'
import type { TypeRelatedInfoResult } from './value/type-related-info-result'
import type { Invocation } from './value/invocation'
import type { ClassHierarchy } from './value/class-hierarchy'
import type { Declaration } from './value/declaration'
import type { AstAndScope } from './value/ast-and-scope'
import { handleException } from '../../engine/analyzer/common/exception-handler'

const lodash = require('lodash')
const UastSpec = require('@ant-yasa/uast-spec')
const astUtil = require('../../util/ast-util')
const MemSpace = require('../../engine/analyzer/common/memSpace')
const { prettyPrint } = require('../../util/ast-util')
const { getValueFromPackageByQid } = require('../../engine/util/value-util')

/**
 * resolve type, declarations, invocations after preprocess
 */
export default class TypeRelatedInfoResolver extends MemSpace {
  classHierarchyMap: Map<string, ClassHierarchy> = new Map()

  typeResultCacheMap = new Map()

  resolveFinish: boolean = false

  /**
   * resolve
   * @param analyzer
   */
  resolve(analyzer: any) {
    this.classHierarchyMap = this.findClassHierarchy(analyzer, analyzer.initState(analyzer.topScope))
    Object.entries(analyzer.funcSymbolTable).forEach(([, funcSymbol]) => {
      const funcSymbolAny = funcSymbol as any
      if (funcSymbolAny.vtype === 'fclos' && funcSymbolAny.ast) {
        const targetAstAndScopeArray = this.findTargetUastNodeInScope(funcSymbolAny)
        for (const targetAstAndScope of targetAstAndScopeArray) {
          const thisScope =
            targetAstAndScope.nodeScope.vtype === 'fclos'
              ? targetAstAndScope.nodeScope.parent
              : targetAstAndScope.nodeScope

          const state = analyzer.initState(thisScope)
          state.nodeScope = targetAstAndScope.nodeScope
          state.nodeScopeAst = targetAstAndScope.nodeScopeAst

          this.resolveInstruction(analyzer, targetAstAndScope.nodeScope, targetAstAndScope.ast, state)
        }
      }
    })
    this.resolveFinish = true
  }

  /**
   * resolve instruction
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveInstruction(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    if (this.typeResultCacheMap.has(node?._meta?.nodehash)) {
      return this.typeResultCacheMap.get(node?._meta?.nodehash)
    }

    let resultArray: TypeRelatedInfoResult[] = []

    const inst = this.loadInstruction(`resolve${node.type}`)
    if (inst) {
      try {
        resultArray = inst.call(this, analyzer, scope, node, state)
        this.typeResultCacheMap.set(node._meta?.nodehash, resultArray)
      } catch (e) {
        handleException(
          e,
          '',
          `resolve${node.type} error! loc is${node.loc.sourcefile}::${node.loc.start.line}_${node.loc.end.line}`
        )
      }
    }

    return resultArray
  }

  /**
   * find class hierarchy
   * @param analyzer
   * @param state
   * @returns {Map<string, ClassHierarchy>}
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  findClassHierarchy(analyzer: any, state: any): Map<string, ClassHierarchy> {
    return new Map()
  }

  /**
   * Identifier
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveIdentifier(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    const resultArray: TypeRelatedInfoResult[] = []

    let val
    let defScopeType: string = ''
    const defScope = this.getDefScope(scope, node)
    if (defScope) {
      if (['class', 'package'].includes(defScope.vtype)) {
        defScopeType = defScope._qid
      }
      val = this.getMemberValueNoCreate(defScope, node, 1)
    }
    if (val?.vtype !== 'undefine') {
      if (['class', 'package'].includes(val.vtype)) {
        resultArray.push(this.assembleTypeResult(node, 0, node.name, val._qid, val, val.ast, defScope, defScopeType))
      } else if (val.rtype?.definiteType && !val.rtype?.vagueType) {
        resultArray.push(
          this.assembleTypeResult(
            node,
            0,
            node.name,
            prettyPrint(val.rtype.definiteType),
            val,
            val.ast,
            defScope,
            defScopeType
          )
        )
      } else if (val.vtype === 'fclos' && val.overloaded?.length > 0 && Array.isArray(state.argumentTypes)) {
        const funcDef = this.findMatchedFuncDef(val, state.argumentTypes)
        const funcReturnTypeArray = this.resolveInstruction(analyzer, scope, funcDef.returnType, state)
        for (const funcReturnType of funcReturnTypeArray) {
          const finalTypeResult: TypeRelatedInfoResult = this.assembleTypeResult(
            node,
            funcReturnType.index,
            funcReturnType.name,
            funcReturnType.type,
            val,
            funcDef,
            defScope,
            defScopeType
          )
          resultArray.push(finalTypeResult)
        }
      }
    } else {
      let declScope = scope
      while (declScope) {
        if (scope.declarationMap?.has(node.name)) {
          const { type } = scope.declarationMap.get(node.name)
          resultArray.push(this.assembleTypeResult(node, 0, node.name, type, undefined, undefined, undefined, ''))
          break
        }
        declScope = declScope.parent
      }
    }

    if (resultArray.length === 0) {
      if (state.allOrigin) {
        resultArray.push(this.assembleTypeResult(node, 0, node.name, node.name, undefined, undefined, undefined, ''))
      } else {
        resultArray.push(this.assembleTypeResult(node, 0, node.name, '', val, val?.ast, defScope, defScopeType))
      }
    }

    return resultArray
  }

  /**
   * VariableDeclaration
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveVariableDeclaration(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    const resultArray: TypeRelatedInfoResult[] = []

    const declTypeResultArray: TypeRelatedInfoResult[] = this.resolveInstruction(analyzer, scope, node.varType, state)
    let initTypeResultArray: TypeRelatedInfoResult[] = []
    if (node.init) {
      initTypeResultArray = this.resolveInstruction(analyzer, scope, node.init, state)
    }

    const nameArray: string[] = []
    if (node.id?.type === 'Identifier') {
      nameArray.push(node.id.name)
    } else if (node.id?.type === 'TupleExpression') {
      for (const element of node.id.elements) {
        nameArray.push(element.name)
      }
    }
    if (nameArray.length === 0) {
      return resultArray
    }

    let typeResultArray: TypeRelatedInfoResult[]
    if (nameArray.length === declTypeResultArray.length) {
      typeResultArray = declTypeResultArray
    } else if (nameArray.length === initTypeResultArray.length) {
      typeResultArray = initTypeResultArray
    } else {
      return resultArray
    }

    for (let i: number = 0; i < nameArray.length; i++) {
      const typeResult = typeResultArray[i]
      let finalTypeResult: TypeRelatedInfoResult
      if (typeResult.type !== '') {
        finalTypeResult = this.assembleTypeResult(
          node,
          i,
          nameArray[i],
          typeResult.type,
          typeResult.value,
          typeResult.valueNode,
          typeResult.valueDefScope,
          typeResult.valueDefScopeType
        )
      } else {
        finalTypeResult = this.assembleTypeResult(node, i, '', '', undefined, undefined, undefined, '')
      }
      resultArray.push(finalTypeResult)

      if (state.nodeScope && typeResult.name !== '' && typeResult.type !== '') {
        const declaration: Declaration = {
          name: nameArray[i],
          type: typeResult.type,
          declSite: node,
          nodeScope: state.nodeScope,
        }
        if (!(state.nodeScope.declarationMap instanceof Map)) {
          state.nodeScope.declarationMap = new Map()
        }
        state.nodeScope.declarationMap.set(nameArray[i], declaration)
      }
    }

    return resultArray
  }

  /**
   * MemberAccess
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveMemberAccess(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    const resultArray: TypeRelatedInfoResult[] = []

    let objScope
    let objScopeType: string = ''
    const objTypeResultArray: TypeRelatedInfoResult[] = this.resolveInstruction(analyzer, scope, node.object, state)
    if (objTypeResultArray.length === 1) {
      const objTypeResult: TypeRelatedInfoResult = objTypeResultArray[0]
      objScopeType = objTypeResult.type
      if (['class', 'package'].includes(objTypeResult.value?.vtype)) {
        objScope = objTypeResult.value
      } else if (objTypeResult.type !== '') {
        if (objTypeResult.type.includes('.')) {
          objScope = getValueFromPackageByQid(analyzer.topScope.packageManager, objTypeResult.type)
        } else {
          objScope = this.getMemberValueNoCreate(scope, UastSpec.identifier(objTypeResult.type))
        }
      }
    }

    if (!objScope) {
      if (state.allOrigin) {
        resultArray.push(
          this.assembleTypeResult(node, 0, node.property.name, prettyPrint(node), undefined, undefined, undefined, '')
        )
      } else {
        resultArray.push(this.assembleTypeResult(node, 0, node.property.name, '', undefined, undefined, undefined, ''))
      }
      return resultArray
    }

    const propertyTypeArray = this.resolveInstruction(analyzer, objScope, node.property, state)
    if (propertyTypeArray.length > 0) {
      for (const propertyType of propertyTypeArray) {
        let finalTypeResult
        if (propertyType.type === '' && state.allOrigin) {
          finalTypeResult = this.assembleTypeResult(
            node,
            propertyType.index,
            node.property.name,
            prettyPrint(node),
            propertyType.value,
            propertyType.valueNode,
            objScope,
            objScopeType
          )
        } else {
          finalTypeResult = this.assembleTypeResult(
            node,
            propertyType.index,
            node.property.name,
            propertyType.type,
            propertyType.value,
            propertyType.valueNode,
            objScope,
            objScopeType
          )
        }
        resultArray.push(finalTypeResult)
      }
    } else if (state.allOrigin) {
      resultArray.push(
        this.assembleTypeResult(
          node,
          0,
          node.property.name,
          prettyPrint(node),
          undefined,
          undefined,
          objScope,
          objScopeType
        )
      )
    } else {
      resultArray.push(
        this.assembleTypeResult(node, 0, node.property.name, '', undefined, undefined, objScope, objScopeType)
      )
    }

    return resultArray
  }

  /**
   * CallExpression
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveCallExpression(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    const resultArray: TypeRelatedInfoResult[] = []
    const calleeArgumentTypes: string[] = []
    for (const argument of node.arguments) {
      const argumentTypeResultArray: TypeRelatedInfoResult[] = this.resolveInstruction(analyzer, scope, argument, state)
      if (argumentTypeResultArray.length === 1) {
        calleeArgumentTypes.push(argumentTypeResultArray[0].type)
      } else {
        calleeArgumentTypes.push('')
      }
    }

    const newState = lodash.clone(state)
    newState.parent = state
    newState.argumentTypes = calleeArgumentTypes
    const returnTypeResultArray: TypeRelatedInfoResult[] = this.resolveInstruction(
      analyzer,
      scope,
      node.callee,
      newState
    )

    if (returnTypeResultArray.length > 0) {
      for (const returnTypeResult of returnTypeResultArray) {
        if (state.nodeScope) {
          const invocation: Invocation = {
            callSiteLiteral: prettyPrint(node.callee),
            calleeType: returnTypeResult.valueDefScopeType,
            fsig: returnTypeResult.name,
            argTypes: calleeArgumentTypes,
            callSite: node,
            fromScope: state.nodeScope,
            fromScopeAst: state.nodeScopeAst,
            toScope: returnTypeResult.value,
            toScopeAst: returnTypeResult.valueNode,
          }
          if (node?._meta?.nodehash) {
            this.addInvocationToScope(state.nodeScope, node?._meta?.nodehash, invocation)
            if (invocation.calleeType !== '') {
              const polyInvocationArray = this.findPolymorphismInvocation(invocation, state)
              this.addInvocationToScope(state.nodeScope, node?._meta?.nodehash, polyInvocationArray)
            }
          }
        }
        const finalTypeResult = this.assembleTypeResult(
          node,
          returnTypeResult.index,
          returnTypeResult.name,
          returnTypeResult.type,
          returnTypeResult.value,
          returnTypeResult.valueNode,
          returnTypeResult.valueDefScope,
          returnTypeResult.valueDefScopeType
        )
        resultArray.push(finalTypeResult)
      }
    } else if (state.nodeScope) {
      const invocation: Invocation = {
        callSiteLiteral: prettyPrint(node.callee),
        calleeType: '',
        fsig: '',
        argTypes: calleeArgumentTypes,
        callSite: node,
        fromScope: state.nodeScope,
        fromScopeAst: state.nodeScopeAst,
        toScope: undefined,
        toScopeAst: undefined,
      }
      if (node?._meta?.nodehash) {
        this.addInvocationToScope(state.nodeScope, node?._meta?.nodehash, invocation)
      }
    }

    return resultArray
  }

  /**
   * AssignmentExpression
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveAssignmentExpression(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    const resultArray: TypeRelatedInfoResult[] = []

    this.resolveInstruction(analyzer, scope, node.right, state)

    const leftTypeArray = this.resolveInstruction(analyzer, scope, node.left, state)
    for (const leftType of leftTypeArray) {
      this.assembleTypeResult(
        node,
        leftType.index,
        leftType.name,
        leftType.type,
        leftType.value,
        leftType.valueNode,
        leftType.valueDefScope,
        leftType.valueDefScopeType
      )
      resultArray.push(leftType)
    }

    return resultArray
  }

  /**
   * BinaryExpression
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveBinaryExpression(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    const resultArray: TypeRelatedInfoResult[] = []

    this.resolveInstruction(analyzer, scope, node.left, state)
    this.resolveInstruction(analyzer, scope, node.right, state)

    return resultArray
  }

  /**
   * CastExpression
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveCastExpression(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    const resultArray: TypeRelatedInfoResult[] = []

    const asTypeResultArray: TypeRelatedInfoResult[] = this.resolveInstruction(analyzer, scope, node.as, state)
    for (const asTypeResult of asTypeResultArray) {
      const finalTypeResult = this.assembleTypeResult(
        node,
        asTypeResult.index,
        asTypeResult.name,
        asTypeResult.type,
        asTypeResult.value,
        asTypeResult.valueNode,
        asTypeResult.valueDefScope,
        asTypeResult.valueDefScopeType
      )
      resultArray.push(finalTypeResult)
    }

    return resultArray
  }

  /**
   * ConditionalExpression
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveConditionalExpression(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    const resultArray: TypeRelatedInfoResult[] = []

    this.resolveInstruction(analyzer, scope, node.test, state)
    const consequentResultArray = this.resolveInstruction(analyzer, scope, node.consequent, state)
    const alternativeResultArray = this.resolveInstruction(analyzer, scope, node.alternative, state)

    const resultLength =
      consequentResultArray.length >= alternativeResultArray.length
        ? consequentResultArray.length
        : alternativeResultArray.length
    for (let i = 0; i < resultLength; i++) {
      let propertyTypeResult: TypeRelatedInfoResult
      if (i < consequentResultArray.length && consequentResultArray[i]?.type !== '') {
        propertyTypeResult = consequentResultArray[i]
      } else if (i < alternativeResultArray.length && alternativeResultArray[i]?.type !== '') {
        propertyTypeResult = alternativeResultArray[i]
      } else {
        propertyTypeResult = this.assembleTypeResult(node, i, '', '', undefined, undefined, undefined, '')
      }

      const finalTypeResult = this.assembleTypeResult(
        node,
        propertyTypeResult.index,
        propertyTypeResult.name,
        propertyTypeResult.type,
        propertyTypeResult.value,
        propertyTypeResult.valueNode,
        propertyTypeResult.valueDefScope,
        propertyTypeResult.valueDefScopeType
      )
      resultArray.push(finalTypeResult)
    }

    return resultArray
  }

  /**
   * resolve argument of expression
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveArgumentExpression(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    const resultArray: TypeRelatedInfoResult[] = []

    const argumentResultArray = this.resolveInstruction(analyzer, scope, node.argument, state)
    for (const argumentTypeResult of argumentResultArray) {
      const finalTypeResult = this.assembleTypeResult(
        node,
        argumentTypeResult.index,
        argumentTypeResult.name,
        argumentTypeResult.type,
        argumentTypeResult.value,
        argumentTypeResult.valueNode,
        argumentTypeResult.valueDefScope,
        argumentTypeResult.valueDefScopeType
      )
      resultArray.push(finalTypeResult)
    }

    return resultArray
  }

  /**
   * DereferenceExpression
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveDereferenceExpression(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    return this.resolveArgumentExpression(analyzer, scope, node, state)
  }

  /**
   * NewExpression
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveNewExpression(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    const resultArray: TypeRelatedInfoResult[] = []

    const calleeArgumentTypes: string[] = []
    for (const argument of node.arguments) {
      const argumentTypeResultArray: TypeRelatedInfoResult[] = this.resolveInstruction(analyzer, scope, argument, state)
      if (argumentTypeResultArray.length === 1) {
        calleeArgumentTypes.push(argumentTypeResultArray[0].type)
      } else {
        calleeArgumentTypes.push('')
      }
    }

    const classVal = this.getMemberValueNoCreate(scope, node.callee, state)
    if (classVal?.vtype === 'class') {
      const fclos = this.getMemberValueNoCreate(classVal, UastSpec.identifier('_CTOR_'), state, 1)
      if (fclos?.vtype === 'fclos') {
        const funcDef = this.findMatchedFuncDef(fclos, calleeArgumentTypes)
        const funcReturnTypeArray = this.resolveInstruction(analyzer, scope, funcDef.returnType, state)
        for (const funcReturnType of funcReturnTypeArray) {
          const finalTypeResult: TypeRelatedInfoResult = this.assembleTypeResult(
            node,
            funcReturnType.index,
            funcReturnType.name,
            funcReturnType.type,
            fclos,
            funcDef,
            classVal,
            classVal._qid
          )
          resultArray.push(finalTypeResult)
        }

        if (state.nodeScope) {
          const invocation: Invocation = {
            callSiteLiteral: prettyPrint(node.callee),
            calleeType: classVal._qid,
            fsig: fclos._sid,
            argTypes: calleeArgumentTypes,
            callSite: node,
            fromScope: state.nodeScope,
            fromScopeAst: state.nodeScopeAst,
            toScope: fclos,
            toScopeAst: funcDef,
          }
          if (node?._meta?.nodehash) {
            this.addInvocationToScope(scope, node._meta.nodehash, invocation)
          }
        }
      } else if (state.nodeScope) {
        const invocation: Invocation = {
          callSiteLiteral: prettyPrint(node.callee),
          calleeType: classVal._qid,
          fsig: prettyPrint(node.callee),
          argTypes: calleeArgumentTypes,
          callSite: node,
          fromScope: state.nodeScope,
          fromScopeAst: state.nodeScopeAst,
          toScope: undefined,
          toScopeAst: undefined,
        }
        if (node?._meta?.nodehash) {
          this.addInvocationToScope(state.nodeScope, node?._meta?.nodehash, invocation)
        }
      }
    } else if (state.nodeScope) {
      const invocation: Invocation = {
        callSiteLiteral: prettyPrint(node.callee),
        calleeType: prettyPrint(node.callee),
        fsig: prettyPrint(node.callee),
        argTypes: calleeArgumentTypes,
        callSite: node,
        fromScope: state.nodeScope,
        fromScopeAst: state.nodeScopeAst,
        toScope: undefined,
        toScopeAst: undefined,
      }
      if (node?._meta?.nodehash) {
        this.addInvocationToScope(state.nodeScope, node?._meta?.nodehash, invocation)
      }
    }

    return resultArray
  }

  /**
   * ObjectProperty
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveObjectProperty(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    this.resolveInstruction(analyzer, scope, node.key, state)
    this.resolveInstruction(analyzer, scope, node.value, state)
    return []
  }

  /**
   * ObjectExpression
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveObjectExpression(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    if (!node.properties) {
      return []
    }

    for (const property of node.properties) {
      this.resolveInstruction(analyzer, scope, property, state)
    }

    return []
  }

  /**
   * ReferenceExpression
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveReferenceExpression(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    return this.resolveArgumentExpression(analyzer, scope, node, state)
  }

  /**
   * Sequence
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveSequence(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    if (!node.expressions) {
      return []
    }

    for (const expression of node.expressions) {
      this.resolveInstruction(analyzer, scope, expression, state)
    }
    return []
  }

  /**
   * SpreadElement
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveSpreadElement(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    return this.resolveArgumentExpression(analyzer, scope, node, state)
  }

  /**
   * TupleExpression
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveTupleExpression(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    if (!node.elements) {
      return []
    }

    for (const element of node.elements) {
      this.resolveInstruction(analyzer, scope, element, state)
    }
    return []
  }

  /**
   * UnaryExpression
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveUnaryExpression(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    return this.resolveArgumentExpression(analyzer, scope, node, state)
  }

  /**
   * YieldExpression
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveYieldExpression(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    return this.resolveArgumentExpression(analyzer, scope, node, state)
  }

  /**
   * ThisExpression
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveThisExpression(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    const resultArray: TypeRelatedInfoResult[] = []
    if (scope.parent?.vtype === 'class') {
      resultArray.push(
        this.assembleTypeResult(node, 0, '', scope.parent._qid, scope.parent, scope.parent.ast, scope.parent.parent, '')
      )
    }
    return resultArray
  }

  /**
   * SuperExpression
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveSuperExpression(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    const resultArray: TypeRelatedInfoResult[] = []
    if (scope.parent?.super?.vtype === 'class') {
      resultArray.push(
        this.assembleTypeResult(
          node,
          0,
          '',
          scope.parent.super._qid,
          scope.parent.super,
          scope.parent.super.ast,
          scope.parent.super.parent,
          ''
        )
      )
    }
    return resultArray
  }

  /**
   * ScopedType
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveScopedType(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    const resultArray: TypeRelatedInfoResult[] = []

    const newState = lodash.clone(state)
    newState.parent = state
    newState.allOrigin = true

    const idTypeResultArray = this.resolveInstruction(analyzer, scope, node.id, newState)
    for (const idTypeResult of idTypeResultArray) {
      const finalTypeResult: TypeRelatedInfoResult = this.assembleTypeResult(
        node,
        idTypeResult.index,
        idTypeResult.name,
        idTypeResult.type,
        idTypeResult.value,
        idTypeResult.valueNode,
        idTypeResult.valueDefScope,
        idTypeResult.valueDefScopeType
      )
      resultArray.push(finalTypeResult)
    }

    return resultArray
  }

  /**
   * PointerType
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolvePointerType(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    const resultArray: TypeRelatedInfoResult[] = []

    const newState = lodash.clone(state)
    newState.parent = state
    newState.allOrigin = true

    const elementTypeResultArray = this.resolveInstruction(analyzer, scope, node.element, newState)
    for (const elementTypeResult of elementTypeResultArray) {
      const finalTypeResult: TypeRelatedInfoResult = this.assembleTypeResult(
        node,
        elementTypeResult.index,
        elementTypeResult.name,
        elementTypeResult.type,
        elementTypeResult.value,
        elementTypeResult.valueNode,
        elementTypeResult.valueDefScope,
        elementTypeResult.valueDefScopeType
      )
      resultArray.push(finalTypeResult)
    }

    return resultArray
  }

  /**
   * TupleType
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @returns {TypeRelatedInfoResult[]}
   */
  resolveTupleType(analyzer: any, scope: any, node: any, state: any): TypeRelatedInfoResult[] {
    const resultArray: TypeRelatedInfoResult[] = []

    const newState = lodash.clone(state)
    newState.parent = state
    newState.allOrigin = true

    for (let i: number = 0; i < node.elements.length; i++) {
      const elementTypeResultArray = this.resolveInstruction(analyzer, scope, node.elements[i], newState)
      if (elementTypeResultArray.length === 1) {
        const finalTypeResult: TypeRelatedInfoResult = this.assembelTypeResult(
          node,
          i,
          elementTypeResultArray[0].name,
          elementTypeResultArray[0].type,
          elementTypeResultArray[0].value,
          elementTypeResultArray[0].valueNode,
          elementTypeResultArray[0].valueDefScope
        )
        resultArray.push(finalTypeResult)
      } else {
        resultArray.push(this.assembleTypeResult(node, i, '', '', undefined, undefined, undefined, ''))
      }
    }

    return resultArray
  }

  /**
   * find target node to resolve
   * @param funcSymbol
   * @returns {any[]}
   */
  findTargetUastNodeInScope(funcSymbol: any): any[] {
    const resultArray: AstAndScope[] = []

    if (funcSymbol.vtype !== 'fclos' || !Array.isArray(funcSymbol.overloaded)) {
      return resultArray
    }

    const typeResolverASTVisitor = new TypeResolverASTVisitor()
    for (const funcDef of funcSymbol.overloaded) {
      typeResolverASTVisitor.nodeScope = funcSymbol
      typeResolverASTVisitor.nodeScopeAst = funcDef
      typeResolverASTVisitor.astAndScopeArray = []
      astUtil.visit(funcDef, typeResolverASTVisitor)
      if (Array.isArray(typeResolverASTVisitor.astAndScopeArray)) {
        resultArray.push(...typeResolverASTVisitor.astAndScopeArray)
      }
    }

    return resultArray
  }

  /**
   * assemble type result
   * @param node
   * @param value
   * @param valueNode
   * @param index
   * @param name
   * @param type
   * @param valueDefScope
   * @param valueDefScopeType
   * @returns {TypeRelatedInfoResult}
   */
  assembleTypeResult(
    node: any,
    index: number,
    name: string,
    type: string,
    value: any,
    valueNode: any,
    valueDefScope: any,
    valueDefScopeType: string
  ): TypeRelatedInfoResult {
    return {
      node,
      index,
      name,
      type,
      value,
      valueNode,
      valueDefScope,
      valueDefScopeType,
    }
  }

  /**
   * find subtypes
   * @param typeInfo
   * @param typeDeclaration
   * @returns {string[]}
   */
  findSubTypes(typeInfo: ClassHierarchy, typeDeclaration?: string): string[] {
    const resultArray: string[] = []
    if (!typeInfo) {
      return resultArray
    }

    for (const extendedByTypeInfo of typeInfo.extendedBy) {
      if (!typeDeclaration || typeDeclaration === extendedByTypeInfo.typeDeclaration) {
        resultArray.push(extendedByTypeInfo.type)
      }
      resultArray.push(...this.findSubTypes(extendedByTypeInfo, typeDeclaration))
    }
    for (const implementedByTypeInfo of typeInfo.implementedBy) {
      if (!typeDeclaration || typeDeclaration === implementedByTypeInfo.typeDeclaration) {
        resultArray.push(implementedByTypeInfo.type)
      }
      resultArray.push(...this.findSubTypes(implementedByTypeInfo, typeDeclaration))
    }

    return resultArray
  }

  /**
   * find invoke by polymorphism
   * @param invocation
   * @param state
   * @returns {Invocation[]}
   */
  findPolymorphismInvocation(invocation: Invocation, state: any): Invocation[] {
    const resultArray: Invocation[] = []
    if (!invocation || invocation.calleeType === '' || invocation.fsig === '') {
      return resultArray
    }
    const classHierarchy: ClassHierarchy | undefined = this.classHierarchyMap.get(invocation.calleeType)
    if (!classHierarchy) {
      return resultArray
    }

    const subTypeArray: string[] = this.findSubTypes(classHierarchy)
    for (const subType of subTypeArray) {
      const subClassHierarchy: ClassHierarchy | undefined = this.classHierarchyMap.get(subType)
      if (!subClassHierarchy) {
        continue
      }
      const fclos = this.getMemberValueNoCreate(subClassHierarchy.value, UastSpec.identifier(invocation.fsig), state, 1)
      if (fclos?.vtype !== 'fclos' || !Array.isArray(fclos.overloaded)) {
        continue
      }
      let polyFuncDef
      for (const funcDef of fclos.overloaded) {
        if (funcDef.parameters.length === invocation.argTypes.length) {
          polyFuncDef = funcDef
        }

        let argTypeMatch: boolean = false
        if (invocation.toScopeAst?.type === 'FunctionDefinition') {
          const argTypes: string[] = []
          for (const toScopeParamAst of invocation.toScopeAst.parameters) {
            argTypes.push(toScopeParamAst.varType?.id ? toScopeParamAst.varType?.id?.name : '')
          }
          argTypeMatch = this.checkFuncParamTypeMatch(funcDef.parameters, argTypes)
        } else {
          argTypeMatch = this.checkFuncParamTypeMatch(funcDef.parameters, invocation.argTypes)
        }

        if (argTypeMatch) {
          polyFuncDef = funcDef
          break
        }
      }

      if (polyFuncDef) {
        const polymorphismInvocation = {
          callSiteLiteral: invocation.callSiteLiteral,
          calleeType: subType,
          fsig: invocation.fsig,
          argTypes: invocation.argTypes,
          callSite: invocation.callSite,
          fromScope: invocation.fromScope,
          fromScopeAst: invocation.fromScopeAst,
          toScope: fclos,
          toScopeAst: polyFuncDef,
        }
        resultArray.push(polymorphismInvocation)
      }
    }

    return resultArray
  }

  /**
   * find matched func ast
   * @param fclos
   * @param argumentTypes
   * @returns {*}
   */
  findMatchedFuncDef(fclos: any, argumentTypes: string[]): any {
    if (fclos?.vtype !== 'fclos' || !Array.isArray(fclos.overloaded) || fclos.overloaded.length === 0) {
      return undefined
    }

    let funcDef = fclos.overloaded[0]
    for (const f of fclos.overloaded) {
      const paramLength = Array.isArray(f.parameters) ? f.parameters.length : f.parameters.parameters.length
      if (paramLength !== argumentTypes.length) {
        continue
      }
      funcDef = f
      if (this.checkFuncParamTypeMatch(f.parameters, argumentTypes)) {
        funcDef = f
        break
      }
    }

    return funcDef
  }

  /**
   * check func param type match
   * @param parameters
   * @param argumentTypes
   * @returns {boolean}
   */
  checkFuncParamTypeMatch(parameters: any, argumentTypes: string[]): boolean {
    const paramLength = Array.isArray(parameters) ? parameters.length : parameters.parameters.length
    if (paramLength !== argumentTypes.length) {
      return false
    }
    let typeMatch = true
    for (let i = 0; i < paramLength; i++) {
      if (
        argumentTypes[i] === '' ||
        parameters[i].varType?.id?.name === argumentTypes[i] ||
        argumentTypes[i].endsWith(`.${parameters[i].varType?.id?.name}`)
      ) {
        continue
      }
      typeMatch = false
    }

    return typeMatch
  }

  /**
   * add invocation to scope
   * @param scope
   * @param nodeHash
   * @param invocation
   */
  addInvocationToScope(scope: any, nodeHash: string, invocation: Invocation | Invocation[]) {
    if (nodeHash === '') {
      return
    }

    if (!(scope.invocationMap instanceof Map)) {
      scope.invocationMap = new Map()
    }
    if (!Array.isArray(scope.invocationMap.get(nodeHash))) {
      scope.invocationMap.set(nodeHash, [])
    }
    if (Array.isArray(invocation)) {
      scope.invocationMap.get(nodeHash).push(...invocation)
    } else {
      scope.invocationMap.get(nodeHash).push(invocation)
    }
  }

  /**
   * reflect
   * @param instructionType
   * @returns {*}
   */
  loadInstruction(instructionType: any) {
    /**
     * load
     * @param obj
     * @returns {*}
     */
    function load(obj: any) {
      if (!obj) return
      if (obj.hasOwnProperty(instructionType)) {
        return obj[instructionType]
      }
      return load(Object.getPrototypeOf(obj))
    }

    return load(this)
  }
}
