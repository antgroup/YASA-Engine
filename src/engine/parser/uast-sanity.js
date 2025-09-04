const logger = require('../../util/logger')(__filename)

/**
 * sanity check for other languages converted to UAST
 * @param node
 * @returns {*}
 */
function nodeSanity(node) {
  const fields = requiredFields[node.type]
  if (!fields) return

  const keys = Object.keys(node)
  for (const field of fields) {
    if (keys.indexOf(field) === -1) if (logger.isDebugEnabled()) logger.debug('Missing:', field)
  }
  for (const key of keys) {
    if (key === 'type' || key === 'loc') continue
    // extra._meta is the place where optional properties should put for concision of the UAST
    // since properties being put in _meta, they are marked, and shouldn't be counted as 'Extra'
    if (key === 'extra') continue
    if (fields.indexOf(key) === -1) {
      const optional = optionalFields[node.type]
      if (optional) {
        if (optional.indexOf(key) !== -1) continue
      }
      if (logger.isDebugEnabled()) logger.debug('Extra:', key)
    }
  }
}

// ***

const requiredFields = {
  SourceUnit: ['body'],
  FunctionDefinition: ['name', 'parameters', 'returnParameters', 'body'],

  ElementaryTypeNameExpression: ['typeName'],
  ArrayTypeName: ['baseTypeName', 'length'],
  ElementaryTypeName: ['name'],
  FunctionTypeName: ['parameterTypes', 'returnTypes'],
  UserDefinedTypeName: ['namePath'],

  ReturnStatement: ['expression'],
  FunctionCall: ['expression', 'arguments'],
  StructDefinition: ['members'],
  VariableDeclaration: ['typeName', 'name'],
  WhileStatement: ['condition', 'body'],
  DoWhileStatement: ['condition', 'body'],
  IfStatement: ['condition', 'trueBody'],
  BlockStatement: ['body'],
  ExpressionStatement: ['expression'],

  Literal: ['value'],
  NumberLiteral: ['number'],
  Mapping: ['keyType', 'valueType'],

  NewExpression: ['expression'],
  UnaryOperation: ['operator', 'subExpression', 'isPrefix'],
  TupleExpression: ['components'],
  // MemberAccess: [ 'expression', 'memberName' ],
  MemberAccess: ['expression', 'property'],
  BinaryOperation: ['operator', 'left', 'right'],
  IndexAccess: ['base', 'index'],
  Conditional: ['condition', 'trueExpression', 'falseExpression'],
  ForStatement: ['initExpression', 'conditionExpression', 'loopExpression', 'body'],
  VariableDeclarationStatement: ['variables', 'typeName'],
  SwitchStatement: ['discriminant', 'cases'],

  Identifier: ['name'],
  ParameterList: ['parameters'],
  Parameter: ['typeName'],
  TryStatement: ['block', 'handler', 'finalizer'],
  ClassDeclaration: ['name', 'body', 'id'],
  ClassProperty: ['key', 'value'],
  MethodDeclaration: ['parameters', 'name', 'id', 'body', 'returnParameters'],
  Super: ['name'],
}

const optionalFields = {
  SourceUnit: ['directives'],
  Block: ['directives'],
  FunctionDefinition: ['receiver', 'visibility', 'modifiers', 'isConstructor', 'stateMutability', 'async', 'generator'],
  ElementaryTypeName: ['stateMutability'],
  FunctionTypeName: ['visibility', 'stateMutability'],
  FunctionCall: ['names'],
  VariableDeclaration: ['expression', 'storageLocation', 'isDeclaredConst', 'isStateVar', 'isIndexed'],
  TupleExpression: ['isArray'],
  VariableDeclarationStatement: ['initialValue'],
  StructDefinition: ['name'],
  IfStatement: ['falseBody'],
  NewExpression: ['typeName', 'arguments'],

  MemberAccess: ['computed'],
  NumberLiteral: ['subdenomination'],

  Parameter: ['name', 'storageLocation', 'isStateVar', 'isIndexed'],
  Identifier: ['typeAnnotation'],
  MethodDeclaration: ['isConstructor', 'computed', 'kind', 'decorators'],
  ClassDeclaration: ['superClass'],
  ClassProperty: ['computed', 'typeName', 'isStatic', 'isPrivate'],
}

/**
 * simple sanity of the AST tree
 * @param node
 */
function sanityCheck(node) {
  if (!node) return

  if (Array.isArray(node)) {
    for (const child of node) {
      sanityCheck(child)
    }
  }

  if (!node.type) return

  // if (!node.loc) {
  //     logger.warn('No LOC: ', node.type);
  // }
  nodeSanity(node)

  for (const prop in node) {
    if (prop !== 'parent' && node.hasOwnProperty(prop)) {
      const val = node[prop]
      sanityCheck(val)
    }
  }
}

// ***
module.exports = {
  sanityCheck,
}
