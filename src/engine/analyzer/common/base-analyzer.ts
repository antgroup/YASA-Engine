/**
 * BaseAnalyzer 抽象类
 * 
 * 定义所有 Analyzer 必须实现的核心方法签名
 * 所有语言特定的 Analyzer (JsAnalyzer, JavaAnalyzer, PythonAnalyzer, GoAnalyzer) 必须继承此类
 * 
 * 方法分类：
 * - 核心方法 (2个): processInstruction, processCompileUnit
 * - Expr 方法 (21个): 处理所有表达式节点
 * - Stmt 方法 (14个): 处理所有语句节点
 * - Decl 方法 (3个): 处理所有声明节点
 * 
 * @see .cursor/rules/analyzer-architecture.mdc
 */

import type {
  Node,
  // 6大分类
  Stmt,
  Expr,
  Decl,
  // CompileUnit
  CompileUnit,
  // Expr 节点 (21个)
  Literal,
  Identifier,
  BinaryExpression,
  UnaryExpression,
  AssignmentExpression,
  ConditionalExpression,
  CallExpression,
  NewExpression,
  MemberAccess,
  SliceExpression,
  CastExpression,
  ImportExpression,
  YieldExpression,
  TupleExpression,
  ObjectExpression,
  SpreadElement,
  Sequence,
  DereferenceExpression,
  ReferenceExpression,
  ThisExpression,
  SuperExpression,
  // Stmt 节点 (14个)
  Noop,
  IfStatement,
  SwitchStatement,
  ForStatement,
  WhileStatement,
  RangeStatement,
  BreakStatement,
  ContinueStatement,
  ReturnStatement,
  ThrowStatement,
  ScopedStatement,
  TryStatement,
  ExpressionStatement,
  ExportStatement,
  // Decl 节点 (3个)
  FunctionDefinition,
  ClassDefinition,
  VariableDeclaration,
} from '../../../types/uast'

import type { Scope, State, Value, SymbolValue, VoidValue, SpreadValue, BinaryExprValue, UnaryExprValue } from '../../../types/analyzer'

const MemSpace = require('./memSpace')

/**
 * BaseAnalyzer 抽象基类
 * 
 * 定义所有 Analyzer 必须实现的方法签名
 * 每个方法接收 (scope, node, state) 三个参数，返回 Value
 */
export abstract class BaseAnalyzer extends MemSpace {
  // ===== 核心方法 (2个) =====

  /**
   * 处理任意指令节点 (Stmt | Expr | Decl)
   * 根据节点类型分发到对应的 process 方法
   */
  abstract processInstruction(scope: Scope, node: Stmt | Expr | Decl, state: State): Value

  /**
   * 处理编译单元（程序入口）
   */
  abstract processCompileUnit(scope: Scope, node: CompileUnit, state: State): Value

  // ===== Expr 方法 (21个) =====

  abstract processLiteral(scope: Scope, node: Literal, state: State): SymbolValue
  abstract processIdentifier(scope: Scope, node: Identifier, state: State): SymbolValue
  abstract processBinaryExpression(scope: Scope, node: BinaryExpression, state: State): BinaryExprValue
  abstract processUnaryExpression(scope: Scope, node: UnaryExpression, state: State): UnaryExprValue
  abstract processAssignmentExpression(scope: Scope, node: AssignmentExpression, state: State): SymbolValue
  abstract processConditionalExpression(scope: Scope, node: ConditionalExpression, state: State): SymbolValue
  abstract processCallExpression(scope: Scope, node: CallExpression, state: State): SymbolValue
  abstract processNewExpression(scope: Scope, node: NewExpression, state: State): SymbolValue
  abstract processMemberAccess(scope: Scope, node: MemberAccess, state: State): SymbolValue
  abstract processSliceExpression(scope: Scope, node: SliceExpression, state: State): SymbolValue
  abstract processCastExpression(scope: Scope, node: CastExpression, state: State): SymbolValue
  abstract processImportExpression(scope: Scope, node: ImportExpression, state: State): SymbolValue
  abstract processYieldExpression(scope: Scope, node: YieldExpression, state: State): VoidValue
  abstract processTupleExpression(scope: Scope, node: TupleExpression, state: State): SymbolValue
  abstract processObjectExpression(scope: Scope, node: ObjectExpression, state: State): SymbolValue
  abstract processSpreadElement(scope: Scope, node: SpreadElement, state: State): SpreadValue
  abstract processSequence(scope: Scope, node: Sequence, state: State): SymbolValue
  abstract processDereferenceExpression(scope: Scope, node: DereferenceExpression, state: State): SymbolValue
  abstract processReferenceExpression(scope: Scope, node: ReferenceExpression, state: State): SymbolValue
  abstract processThisExpression(scope: Scope, node: ThisExpression, state: State): SymbolValue
  abstract processSuperExpression(scope: Scope, node: SuperExpression, state: State): SymbolValue

  // ===== Stmt 方法 (14个) - 返回 VoidValue（预期无返回值） =====

  abstract processNoop(scope: Scope, node: Noop, state: State): VoidValue
  abstract processIfStatement(scope: Scope, node: IfStatement, state: State): VoidValue
  abstract processSwitchStatement(scope: Scope, node: SwitchStatement, state: State): VoidValue
  abstract processForStatement(scope: Scope, node: ForStatement, state: State): VoidValue
  abstract processWhileStatement(scope: Scope, node: WhileStatement, state: State): VoidValue
  abstract processRangeStatement(scope: Scope, node: RangeStatement, state: State): VoidValue
  abstract processBreakStatement(scope: Scope, node: BreakStatement, state: State): VoidValue
  abstract processContinueStatement(scope: Scope, node: ContinueStatement, state: State): VoidValue
  abstract processReturnStatement(scope: Scope, node: ReturnStatement, state: State): VoidValue
  abstract processThrowStatement(scope: Scope, node: ThrowStatement, state: State): VoidValue
  abstract processScopedStatement(scope: Scope, node: ScopedStatement, state: State): VoidValue
  abstract processTryStatement(scope: Scope, node: TryStatement, state: State): VoidValue
  abstract processExpressionStatement(scope: Scope, node: ExpressionStatement, state: State): VoidValue
  abstract processExportStatement(scope: Scope, node: ExportStatement, state: State): VoidValue

  // ===== Decl 方法 (3个) =====

  abstract processFunctionDefinition(scope: Scope, node: FunctionDefinition, state: State): SymbolValue
  abstract processClassDefinition(scope: Scope, node: ClassDefinition, state: State): SymbolValue
  abstract processVariableDeclaration(scope: Scope, node: VariableDeclaration, state: State): SymbolValue
}
