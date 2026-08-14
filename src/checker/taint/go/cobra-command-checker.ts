import type { EntryPoint } from '../../../engine/analyzer/common/entrypoint/entrypoint'
import type {
  AssignmentExpression,
  FunctionDefinition,
  Identifier,
  MemberAccess,
  NewExpression,
  Node,
  PointerType,
  ReferenceExpression,
  ReturnStatement,
  Sequence,
  Type,
  VariableDeclaration,
} from '../../../types/uast'

const _ = require('lodash')
const completeEntryPoint = require('../common-kit/entry-points-util')
const config = require('../../../config')
const Checker = require('../../common/checker')

const processedBuiltInRegistry = new Set<string>()
const cobraCommandQid = /github\.com\/spf13\/cobra\.Command<instance_.*?>/
const preAction: string[] = ['PreRun', 'PreRunE', 'PersistentPreRun', 'PersistentPreRunE']
const postAction: string[] = ['RunE', 'Run']
const cobraActions = [...preAction, ...postAction]

type FClosLike = {
  vtype?: string
  ast?: { fdef?: FunctionDefinition; node?: FunctionDefinition }
}

type AnalyzerLike = {
  entryPoints: EntryPoint[]
  processInstruction?: (scope: unknown, node: unknown, state: unknown) => unknown
}

type CobraFactoryAction = {
  action: string
  fdef: FunctionDefinition
}

type FunctionBodyLike = FunctionDefinition & { body?: Node[] | { body?: Node[] } }
type GoFunctionDefinition = FunctionDefinition & { varType?: Type; body?: Node[] | { body?: Node[] } }
type GoVariableDeclaration = VariableDeclaration & { init?: Node; varType?: Type }
type GoNewExpression = NewExpression & { varType?: Type }
type ReferenceExpressionWithSequence = ReferenceExpression & { argument: Sequence }

function isNode(value: unknown): value is Node {
  return !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
}

function isIdentifier(node: unknown): node is Identifier {
  return isNode(node) && node.type === 'Identifier'
}

function isMemberAccess(node: unknown): node is MemberAccess {
  return isNode(node) && node.type === 'MemberAccess'
}

function isPointerType(node: unknown): node is PointerType {
  return isNode(node) && node.type === 'PointerType'
}

function isNewExpression(node: unknown): node is GoNewExpression {
  return isNode(node) && node.type === 'NewExpression'
}

function isVariableDeclaration(node: unknown): node is GoVariableDeclaration {
  return isNode(node) && node.type === 'VariableDeclaration'
}

function isAssignmentExpression(node: unknown): node is AssignmentExpression {
  return isNode(node) && node.type === 'AssignmentExpression'
}

function isFunctionDefinition(node: unknown): node is FunctionDefinition {
  return isNode(node) && node.type === 'FunctionDefinition'
}

function isReturnStatement(node: unknown): node is ReturnStatement & { expression?: Node } {
  return isNode(node) && node.type === 'ReturnStatement'
}

function isReferenceExpression(node: unknown): node is ReferenceExpression {
  return isNode(node) && node.type === 'ReferenceExpression'
}

function isSequence(node: unknown): node is Sequence {
  return isNode(node) && node.type === 'Sequence' && Array.isArray((node as Sequence).expressions)
}

function hasSequenceArgument(node: ReferenceExpression): node is ReferenceExpressionWithSequence {
  return isSequence(node.argument)
}

function getNodeName(node: unknown): string | undefined {
  if (!isNode(node)) return undefined
  return (node as { name?: string; value?: string }).name ?? (node as { name?: string; value?: string }).value
}

function getMemberPropertyName(node: unknown): string | undefined {
  if (!isMemberAccess(node)) return undefined
  return getNodeName(node.property)
}

function getMemberReceiver(node: unknown): Node | undefined {
  return isMemberAccess(node) ? node.object : undefined
}

function isCobraCommandValue(value: unknown): boolean {
  const qid = (value as { qid?: string } | undefined)?.qid
  return typeof qid === 'string' && cobraCommandQid.test(qid)
}

function resolveReceiverValue(analyzer: unknown, scope: unknown, node: unknown, state: unknown): unknown {
  const receiverNode = getMemberReceiver(node)
  const processInstruction = (analyzer as { processInstruction?: (scope: unknown, node: unknown, state: unknown) => unknown } | undefined)?.processInstruction
  if (!receiverNode || typeof processInstruction !== 'function') return undefined
  return processInstruction.call(analyzer, scope, receiverNode, state)
}

function isCobraCommandType(node: unknown): boolean {
  if (!isNode(node)) return false
  if (isPointerType(node)) return isCobraCommandType(node.element)
  if (!isMemberAccess(node)) return false
  const objectName = getNodeName(node.object)
  const propertyName = getMemberPropertyName(node)
  return objectName === 'cobra' && propertyName === 'Command'
}

function isCobraCommandNewExpression(node: unknown): boolean {
  if (!isNewExpression(node)) return false
  return isCobraCommandType(node.callee) || isCobraCommandType(node.varType)
}

function getStatementList(node: FunctionBodyLike | undefined): Node[] {
  if (!node?.body) return []
  if (Array.isArray(node.body)) return node.body
  return Array.isArray(node.body.body) ? node.body.body : []
}

function getAssignedName(node: unknown): string | undefined {
  if (isIdentifier(node)) return getNodeName(node)
  if (isMemberAccess(node)) return getMemberPropertyName(node)
  return undefined
}

function collectReturnedIdentifiers(node: FunctionBodyLike | undefined, result: Set<string>): void {
  getStatementList(node).forEach((statement) => {
    if (!isReturnStatement(statement)) return
    const returned = getAssignedName(statement.argument ?? statement.expression)
    if (returned) result.add(returned)
  })
}

function expandFactoryStatements(statement: Node): Node[] {
  const result = [statement]
  const argument = isReferenceExpression(statement)
    ? statement.argument
    : isVariableDeclaration(statement) && isReferenceExpression(statement.init)
      ? statement.init.argument
      : undefined
  if (isSequence(argument)) result.push(...argument.expressions)
  return result
}

function isFunctionReturningCobraCommand(node: GoFunctionDefinition): boolean {
  return isCobraCommandType(node.returnType ?? node.varType)
}

function collectCobraFactoryActions(node: GoFunctionDefinition): CobraFactoryAction[] {
  if (!isFunctionReturningCobraCommand(node)) return []

  const commandVars = new Set<string>()
  const returnedVars = new Set<string>()
  const aliases = new Map<string, Set<string>>()
  collectReturnedIdentifiers(node, returnedVars)

  const actions: CobraFactoryAction[] = []
  getStatementList(node).flatMap(expandFactoryStatements).forEach((statement) => {
    if (isVariableDeclaration(statement) && isCobraCommandNewExpression(statement.init)) {
      const varName = getAssignedName(statement.id)
      if (varName) commandVars.add(varName)
      return
    }

    if (isVariableDeclaration(statement) && isReferenceExpression(statement.init)) {
      const aliasName = getAssignedName(statement.id)
      const aliasTargets = hasSequenceArgument(statement.init)
        ? statement.init.argument.expressions
          .filter((expression) => isVariableDeclaration(expression) && isCobraCommandNewExpression(expression.init))
          .map((expression) => getAssignedName((expression as VariableDeclaration).id))
          .filter((name): name is string => typeof name === 'string')
        : []
      if (aliasName && aliasTargets.length > 0) aliases.set(aliasName, new Set(aliasTargets))
      return
    }

    if (!isAssignmentExpression(statement) || !isFunctionDefinition(statement.right)) return
    const receiverName = getAssignedName(getMemberReceiver(statement.left))
    const action = getMemberPropertyName(statement.left)
    if (!receiverName || !action || !cobraActions.includes(action)) return
    if (returnedVars.size > 0) {
      const receiverIsReturned = returnedVars.has(receiverName)
      const receiverAliasReturned = [...aliases.entries()].some(([alias, targets]) => returnedVars.has(alias) && targets.has(receiverName))
      if (!receiverIsReturned && !receiverAliasReturned) return
    }
    if (!commandVars.has(receiverName)) return
    actions.push({ action, fdef: statement.right })
  })

  return actions
}

/**
 * cobra.Command bulitIn checker
 * 为第三方库方法cobra.command做建模，添加entryPoints
 */
class cobraCommandChecker extends Checker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'cobra.Command-builtIn')
    this.entryPoints = []
    this.sourceScope = {
      complete: false,
      value: [],
    }
    this.resultManager = resultManager
  }

  /**
   *
   * @param fClos
   */
  ifIgnoreEntryPoint(fClos: any): boolean {
    if (!fClos.ast.fdef?.loc) return true
    // todo：this.func{call this.f1()}，this.f1依赖于this的符号值，但注册this.func时，目前的hash无法反映不同this符号值的区别，如alarm_center/pkg/app/app.go的#173行
    const hash = JSON.stringify(fClos.ast.fdef.loc)
    if (processedBuiltInRegistry.has(hash)) return true
    processedBuiltInRegistry.add(hash)
    return false
  }

  /**
   *
   * @param analyzer
   * @param node
   * @param scope
   * @param state
   * @param info
   */
  triggerAtVariableDeclaration(analyzer: any, scope: any, node: any, state: any, info: any): void {
    const { initVal } = info
    if (config.entryPointMode === 'ONLY_CUSTOM') return
    if (!cobraCommandQid.test(initVal?.qid) || !initVal.members || initVal.members.size === 0) return
    const initField = initVal.value

    const preEntryPoints: EntryPoint[] = []
    const postEntryPoints: EntryPoint[] = []

    const processActions = (actions: string[], targetEntryPoints: EntryPoint[]) => {
      actions.forEach((action: string) => {
        if (initField.hasOwnProperty(action) && initField[action]?.vtype === 'fclos') {
          const ep = initField[action]
          if (this.ifIgnoreEntryPoint(ep)) return
          targetEntryPoints.push(completeEntryPoint(ep, true))
        }
      })
    }
    processActions(preAction, preEntryPoints)
    processActions(postAction, postEntryPoints)
    analyzer.entryPoints.push(...preEntryPoints, ...postEntryPoints)
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtAssignment(analyzer: AnalyzerLike, scope: unknown, node: AssignmentExpression, state: unknown, info: { lvalue?: unknown; rvalue?: FClosLike }): void {
    const { lvalue, rvalue } = info
    if (config.entryPointMode === 'ONLY_CUSTOM') {
      return // 不路由自采集
    }
    if (rvalue?.vtype !== 'fclos') {
      return
    }

    const actionName = (lvalue as { sid?: string } | undefined)?.sid ?? getMemberPropertyName(node?.left)
    if (!actionName || !cobraActions.includes(actionName)) {
      return
    }

    const lvalueMatched = isCobraCommandValue(lvalue)
    const receiverValue = lvalueMatched ? undefined : resolveReceiverValue(analyzer, scope, node?.left, state)
    if (!lvalueMatched && !isCobraCommandValue(receiverValue)) {
      return
    }

    if (this.ifIgnoreEntryPoint(rvalue)) {
      return
    }
    analyzer.entryPoints.push(completeEntryPoint(rvalue, true))
  }


  /**
   * 静态收集返回 cobra.Command 的工厂函数内 action 闭包。
   */
  triggerAtFunctionDefinition(analyzer: AnalyzerLike, scope: unknown, node: GoFunctionDefinition, state: unknown, info: { fclos?: FClosLike }): void {
    if (config.entryPointMode === 'ONLY_CUSTOM') return
    const actions = collectCobraFactoryActions(node)
    actions.forEach(({ fdef }) => {
      const fclos = analyzer.processInstruction?.(scope, fdef, state) as FClosLike | undefined
      const entryPoint = fclos?.vtype === 'fclos' ? fclos : { vtype: 'fclos', ast: { fdef, node: fdef } }
      if (this.ifIgnoreEntryPoint(entryPoint)) return
      analyzer.entryPoints.push(completeEntryPoint(entryPoint, true))
    })
  }

  /**
   * 每次运行完main后清空hash
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtSymbolInterpretOfEntryPointAfter(analyzer: any, scope: any, node: any, state: any, info: any): void {
    if (info?.entryPoint.functionName === 'main') processedBuiltInRegistry.clear()
  }
}

module.exports = cobraCommandChecker
