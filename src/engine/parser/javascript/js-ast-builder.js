const { Parser: UastParser } = require('@ant-yasa/uast-parser-java-js')
const stat = require('../../../util/statistics')
const UASTSanity = require('../uast-sanity')
const { Errors } = require('../../../util/error-code')

const uastParser = new UastParser()

let getUid

/**
 *
 * @param loc
 */
function getTmpIdentifier(loc) {
  return {
    type: 'Identifier',
    name: `__tmp${getUid()}__`,
    loc: loc || {
      start: {
        line: 0,
        column: 0,
      },
      end: {
        line: 0,
        column: 0,
      },
    },
  }
}

/**
 *
 * @param pattern
 * @param initId
 */
function processObjectPattern(pattern, initId) {
  const expressions = []
  for (const prop of pattern.properties) {
    if (prop.type === 'ObjectProperty') {
      const sub_expr = processObjectProperty(prop, initId)
      if (Array.isArray(sub_expr)) {
        expressions.push(...sub_expr)
      } else {
        expressions.push(sub_expr)
      }
    } else if (prop.type === 'RestElement') {
      expressions.push({
        type: 'VariableDeclaration',
        id: prop.argument,
        init: initId,
        loc: prop.loc,
      })
    }
  }
  return expressions
}

/**
 *
 * @param pattern
 * @param initId
 */
function processArrayPattern(pattern, initId) {
  const expressions = []
  for (const i in pattern.elements) {
    const ele = pattern.elements[i]
    if (ele) {
      const sub_expr = processObjectProperty(
        {
          type: 'ObjectProperty',
          key: {
            type: 'Literal',
            value: i,
          },
          value: ele,
          computed: true,
          loc: ele.loc,
        },
        initId
      )
      if (Array.isArray(sub_expr)) {
        expressions.push(...sub_expr)
      } else {
        expressions.push(sub_expr)
      }
    }
  }
  return expressions
}

/**
 *
 * @param pattern
 * @param initId
 */
function processAssignmentPattern(pattern, initId) {
  const key = pattern.left
  const default_expr = pattern.right
  return {
    type: 'VariableDeclaration',
    id: key,
    init: {
      type: 'Conditional',
      condition: key,
      trueExpression: initId,
      falseExpression: convert2UAST(default_expr),
      loc: pattern.loc,
    },
    loc: pattern.loc,
  }
}

/**
 *
 * @param pattern
 * @param initId
 */
function processPatternLike(pattern, initId) {
  if (pattern.type === 'ObjectPattern') {
    return processObjectPattern(pattern, initId)
  }
  if (pattern.type === 'ArrayPattern') {
    return processArrayPattern(pattern, initId)
  }
  if (pattern.type === 'AssignmentPattern') {
    return processAssignmentPattern(pattern, initId)
  }
  return convert2UAST(pattern)
}

/**
 *
 * @param prop
 * @param initId
 */
function processObjectProperty(prop, initId) {
  const { key, value } = prop
  if (value.type === 'Identifier') {
    return {
      type: 'VariableDeclaration',
      id: key,
      init: {
        type: 'MemberAccess',
        property: convert2UAST(value),
        expression: initId,
        loc: key.loc,
      },
      loc: prop.loc,
    }
  }
  // process pattern like
  return processPatternLike(value, {
    type: 'MemberAccess',
    property: key,
    expression: initId,
    loc: prop.loc,
  })
}

/**
 * convert js AST nodes to Unified AST nodes
 * @param ast
 * @param node
 */
function convert2UAST(node) {
  try {
    if (!node) return node

    if (Array.isArray(node)) {
      for (const i in node) {
        node[i] = convert2UAST(node[i])
      }
      return node
    }

    if (!node.type) return node

    assembleMeta(node)
    switch (node.type) {
      case 'File':
        return convert2UAST(node.program)
      case 'Program':
        node.type = 'SourceUnit'
        node.extra.sourceType = node.sourceType
        delete node.sourceType
        node.body = convert2UAST(node.body)
        return node
      case 'Identifier':
        return node
      case 'BooleanLiteral':
      case 'StringLiteral':
      case 'NumberLiteral':
        node.kind = node.type
        node.type = 'Literal'
        return convert2UAST(node)
      case 'ForOfStatement':
      case 'ForInStatement': {
        const tmpId = getTmpIdentifier(node.left.loc)
        const exprs = processPatternLike(node.left, tmpId)
        node.right = convert2UAST(node.right)
        node.body = convert2UAST(node.body)
        appendBody(exprs, node)
        return node
      }
      case 'VariableDeclarator': {
        node.type = 'VariableDeclaration'
        if (!node.init) {
          node.id = convert2UAST(node.id)
          return node
        }
        if (node.id.type === 'Identifier') {
          node.id = convert2UAST(node.id)
          node.init = convert2UAST(node.init)
          return node
        } // process pattern like
        let tmpId
        const expressions = []
        if (node.init.type === 'Identifier') {
          tmpId = convert2UAST(node.init)
        } else {
          tmpId = getTmpIdentifier(node.init.loc)
          const tmpVar = {
            type: 'VariableDeclaration',
            id: tmpId,
            init: convert2UAST(node.init),
            loc: node.init.loc,
          }
          expressions.push(tmpVar)
        }
        const seq = processPatternLike(node.id, tmpId)
        if (Array.isArray(seq)) {
          expressions.push(...seq)
        } else {
          expressions.push(seq)
        }
        return {
          type: 'Sequence',
          expressions,
          loc: node.loc,
          extra: node.extra,
        }
      }
      case 'VariableDeclaration': {
        const expressions = []
        node.type = 'Sequence'
        node.expressions = expressions
        for (const decl of node.declarations) {
          expressions.push(convert2UAST(decl))
        }
        delete node.declarations
        delete node.kind
        return node
      }
      case 'MemberExpression': {
        node.expression = node.object
        node.type = 'MemberAccess'
        delete node.object
        node.property = convert2UAST(node.property)
        node.object = convert2UAST(node.expression)
        return node
      }
      case 'PrivateName': {
        const private_node = convert2UAST(node.id)
        private_node.name = `#${private_node.name}`
        return private_node
      }
      case 'BinaryExpression':
      case 'LogicalExpression': {
        node.type = 'BinaryOperation'
        node.left = convert2UAST(node.left)
        node.right = convert2UAST(node.right)
        return node
      }
      case 'UnaryExpression':
      case 'UpdateExpression': {
        node.type = 'UnaryOperation'
        node.subExpression = node.argument
        node.isPrefix = node.prefix
        delete node.prefix
        delete node.argument
        node.subExpression = convert2UAST(node.subExpression)
        return node
      }
      case 'ConditionalExpression': {
        node.type = 'Conditional'
        node.condition = convert2UAST(node.test)
        node.trueExpression = convert2UAST(node.consequent)
        node.falseExpression = convert2UAST(node.alternate)
        delete node.consequent
        delete node.alternate
        delete node.test
        return node
      }
      case 'IfStatement': {
        if (node.test) {
          node.condition = convert2UAST(node.test)
          node.trueBody = convert2UAST(node.consequent)
          node.falseBody = convert2UAST(node.alternate)
          delete node.test
          delete node.consequent
          delete node.alternate
        }
        return node
      }
      case 'ReturnStatement': {
        if (node.hasOwnProperty('argument')) {
          node.expression = node.argument
          delete node.argument
        }
        break
      }
      case 'WhileStatement':
      case 'DoWhileStatement': {
        if (node.test) {
          node.condition = node.test
          delete node.test
        }
        break
      }
      case 'ForStatement': {
        if (node.test) {
          node.initExpression = node.init
          node.conditionExpression = node.test
          node.loopExpression = node.update
          // node.body
          delete node.init
          delete node.test
          delete node.update
        }
        break
      }
      // case 'BlockStatement': {
      //     node.type = 'Block';
      //     node.statements = node.body;
      //     break;
      // }
      case 'CallExpression': {
        node.type = 'FunctionCall'
        node.expression = node.callee

        const expr = node.expression
        if (expr.type === 'Import') {
          expr.type = 'Identifier'
          expr.name = 'require'
        }
        delete node.callee
        break
      }
      case 'NewExpression': {
        node.expression = node.callee
        const callee_name = node.callee && node.callee.name
        node.typeName = node.typeName || callee_name
        delete node.callee
        break
      }
      case 'FunctionExpression': {
        node.type = 'FunctionDefinition'
        node.name = node.id
        // node.parameters = {parameters: node.parameters};
        node.parameters = node.params
        node.modifiers = []
        delete node.id
        break
      }
      case 'FunctionDeclaration': {
        node.type = 'FunctionDefinition'
        node.name = convert2UAST(node.id && node.id.name)
        node.parameters = node.params
        node.returnParameters = convert2UAST(node.returnParameters ? node.returnParameters : undefined)
        node.body = convert2UAST(node.body)
        for (const i in node.parameters) {
          const param = node.parameters[i]
          if (param.type !== 'Identifier' && param.type !== 'RestElement') {
            const tmpId = getTmpIdentifier(param.loc)
            appendBody(processPatternLike(param, tmpId), node)
            node.parameters[i] = tmpId
          } else {
            node.parameters[i] = convert2UAST(param)
          }
        }

        delete node.id
        delete node.params
        return node
      }
      case 'ArrayExpression': {
        node.type = 'ObjectExpression'
        node.properties = []
        const { elements } = node
        for (const i in elements) {
          const prop = {
            type: 'ObjectProperty',
            loc: elements[i] && elements[i].loc,
            key: {
              type: 'StringLiteral',
              loc: elements[i] && elements[i].loc,
              value: i,
            },
            value: elements[i],
          }
          node.properties.push(prop)
        }
        delete node.elements
        break
      }
      case 'ObjectMethod': {
        const method_value = node
        node = {
          type: 'ObjectProperty',
          loc: node.loc,
          key: node.key,
          value: node,
          extra: node.extra,
        }
        method_value.type = 'FunctionDefinition'
        method_value.id = method_value.key
        method_value.parameters = method_value.params
        delete method_value.params
        break
      }
      case 'ArrowFunctionExpression': {
        node.type = 'FunctionDefinition'
        node.id = null
        node.parameters = node.params
        if (node.body.type !== 'BlockStatement') {
          // indicates expression
          const expr = node.body
          node.body = {
            type: 'ReturnStatement',
            loc: node.loc,
            extra: node.extra,
            argument: expr,
          }
        }
        break
      }
      // class decl
      case 'ClassDeclaration':
      case 'ClassExpression':
        // eliminate ClassBody type
        node.type = 'ClassDefinition'
        node.body = node.body && node.body.body
        node.name = node.id && node.id.name
        break
      case 'ClassMethod': {
        node.type = 'FunctionDefinition'
        node.parameters = node.params
        node.name = node.key?.name || node.key?.value
        if (node.kind === 'constructor') {
          node._meta.isConstructor = true
        }
        node.returnParameters = node.returnType
        delete node.returnType
        node.extra.isStatic = node.static
        delete node.static
        node.extra.kind = node.kind
        delete node.kind
        node.extra.generator = node.generator
        delete node.generator
        node.extra.async = node.async
        delete node.async
        node.extra.isConstructor = node.isConstructor
        delete node.params
        delete node.key
        break
      }
      case 'ClassProperty': {
        node.isStatic = node.static
        node.typeName = node.typeAnnotation
        delete node.static
        delete node.typeAnnotation
        node.isPrivate = false
        break
      }
      case 'ClassPrivateProperty': {
        node.type = 'ClassProperty'
        node.isStatic = node.static
        node.isPrivate = true
        delete node.static
        break
      }
      case 'Super': {
        node.type = 'SuperExpression'
        node.name = 'super'
        break
      }

      /** **  TypeScript *** */
      case 'TSEnumDeclaration': {
        node.type = 'VariableDeclarationStatement'
        node.variables = [node.id]
        node.initialValue = [
          {
            type: 'ObjectExpression',
            properties: node.members,
            loc: node.loc,
            extra: node.extra,
          },
        ]
        node.typeName = node.id
        for (const i in node.members) {
          const member = node.members[i]
          if (member.type === 'TSEnumMember' && !member.value) {
            member.initializer = {
              type: 'NumericLiteral',
              loc: member.loc,
              extra: member.extra,
              value: i,
            }
          }
        }
        delete node.members
        delete node.id
        break
      }
      case 'TSEnumMember': {
        node.type = 'ObjectProperty'
        node.key = node.id
        node.value = node.initializer
        delete node.id
        delete node.initializer
        break
      }
      case 'TSAsExpression': {
        return convert2UAST(node.expression)
      }
      default:
        break
    }
    for (const prop in node) {
      if (node.hasOwnProperty(prop)) {
        node[prop] = convert2UAST(node[prop])
      }
    }
  } catch (e) {
    return Errors.ParseError(`${e.toString()} : [node.type:${node.type}] : ${JSON.stringify(node.loc)}`, {
      no_throw: true,
    })
  }
  return node
}

/**
 * put optional properties in extra._meta for concision of UAST
 * @param node
 */
function assembleMeta(node) {
  node.loc = node.loc || {}
  node.loc.sourcefile = sourcefile
  const metaProperties = [
    'start',
    'end',
    'range',
    'leadingComments',
    'trailingComments',
    'innerComments',
    'directives',
    'interpreter',
  ]
  for (const prop of metaProperties) {
    if (node.hasOwnProperty(prop)) {
      node.extra = node.extra || {}
      node.extra._meta = node.extra._meta || {}
      node.extra._meta[prop] = node[prop]
      delete node[prop]
    }
  }
}

/**
 *
 * @param exprs
 * @param node
 */
function appendBody(exprs, node) {
  const origin_body = node.body
  if (origin_body.type === 'BlockStatement') {
    const stmts = origin_body.body
    origin_body.body = [].concat(exprs, stmts)
  } else {
    node.body = {
      type: 'BlockStatement',
      body: [].concat(exprs, origin_body),
      loc: origin_body.loc,
    }
  }
}

let sourcefile

/**
 *
 * @param code
 * @param options
 */
function parse(code, options) {
  return uastParser.parse(code, options)
}

module.exports = {
  parse,
}
