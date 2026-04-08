// ===== UAST 三层继承类型系统 =====
// 结构: BaseNode → 6大分类基类 → 具体节点

// 运行时属性扩展（UAST walker 在运行时添加的属性）
declare module '@ant-yasa/uast-spec' {
  interface BaseNode {
    parent?: BaseNode | null
  }
  interface ExprBase {
    name?: string
  }
  interface StmtBase {
    name?: string
  }
  interface DeclBase {
    name?: string
  }
}

// 第1层: BaseNode
export type { BaseNode } from '@ant-yasa/uast-spec'

// 第2层: 6大分类基类 (extends BaseNode)
export type {
  CompileUnitBase, // CompileUnit基类
  StmtBase, // Stmt基类 (控制流语句)
  ExprBase, // Expr基类 (表达式)
  DeclBase, // Decl基类 (声明)
  TypeBase, // Type基类 (类型系统)
  NameBase, // Name基类 (标识符)
} from '@ant-yasa/uast-spec'

// 第2层: 6大分类联合类型
export type {
  Node, // 所有节点
  CompileUnit, // 翻译单元
  Stmt, // 控制流语句 (17个)
  Expr, // 表达式 (21个)
  Decl, // 声明 (4个)
  Type, // 类型 (10个)
  Name, // 标识符 (1个)
} from '@ant-yasa/uast-spec'

// 类型守卫
export { isCompileUnit, isStmt, isExpr, isDecl, isType, isName } from '@ant-yasa/uast-spec'

// 第3层: 具体节点 (通过交叉类型继承对应的基类)
export type {
  // Stmt (17个) - 都继承 StmtBase
  Noop,
  IfStatement,
  SwitchStatement,
  CaseClause,
  ForStatement,
  WhileStatement,
  RangeStatement,
  BreakStatement,
  ContinueStatement,
  ReturnStatement,
  ThrowStatement,
  ScopedStatement,
  TryStatement,
  CatchClause,
  LabeledStatement,
  ExpressionStatement,
  ExportStatement,

  // Expr (21个) - 都继承 ExprBase
  Literal,
  ThisExpression,
  SuperExpression,
  UnaryExpression,
  BinaryExpression,
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
  ObjectProperty,
  SpreadElement,
  Sequence,
  DereferenceExpression,
  ReferenceExpression,

  // Decl (4个) - 都继承 DeclBase
  FunctionDefinition,
  ClassDefinition,
  VariableDeclaration,
  PackageDeclaration,

  // Type (10个) - 都继承 TypeBase
  PrimitiveType,
  DynamicType,
  VoidType,
  ArrayType,
  TupleType,
  MapType,
  PointerType,
  ScopedType,
  FuncType,
  ChanType,

  // Name (1个) - 继承 NameBase
  Identifier,
} from '@ant-yasa/uast-spec'

// ===== 使用示例 =====
//
// // 类型安全的函数签名
// function getValue(expr: Expr): Value {
//   // expr 必须是 Expr 类型，编译时检查
//   return processExpr(expr);
// }
//
// function executeStmt(stmt: Stmt): void {
//   // stmt 必须是 Stmt 类型
//   processStmt(stmt);
// }
//
// // 类型守卫
// function analyze(node: BaseNode) {
//   if (isExpr(node)) {
//     getValue(node);  // node 类型收窄为 Expr
//   }
//   if (isStmt(node)) {
//     executeStmt(node);  // node 类型收窄为 Stmt
//   }
// }
