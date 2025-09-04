const _ = require('lodash')

/**
 * use cache to avoid infinite recursion
 * @param node
 * @param visited
 * @returns {*}
 */
function toStringIDCached(node, visited) {
  if (!node) return

  let id = visited.get(node)
  if (id) return id

  visited.set(node, '__') // place holder: unknown
  id = toStringID(node, visited)
  if (id && id.length > 36) id = id.substring(id.length - 36)
  visited.set(node, id) // replace the unknown
  node.sid = id
  return id
}

/**
 * convert a node to a unique string (may be hashed to obtain a shorter ID)
 * @param node
 * @param visited
 */
function toStringID(node, visited) {
  if (!node) return

  if (node.sid) return node.sid

  if (Array.isArray(node)) {
    const sub_ids = node.map((x) => toStringIDCached(x, visited))
    return sub_ids.join(',')
  }

  switch (node.type) {
    case 'ThisExpression':
      return 'this'
    case 'Literal':
      return String(node.value)
    case 'Identifier':
    case 'Parameter':
    case 'VariableDeclarator':
      return node.id?.name || node.name
    case 'MemberAccess':
      if (!node.object || node.object.vtype === 'scope') return toStringIDCached(node.property, visited)
      if (node.computed) return `${toStringIDCached(node.object, visited)}[${toStringIDCached(node.property, visited)}]`
      return `[${toStringIDCached(node.object, visited)}.${toStringIDCached(node.property, visited)}]`
    case 'Noop': {
      return 'Noop'
    }
    case 'BinaryOperation': {
      const left = toStringIDCached(node.left, visited)
      const right = toStringIDCached(node.right, visited)
      switch (node.operator) {
        case '+':
        case '-':
        case '*':
        case '&&':
        case '||':
        case '&':
        case '|':
        case '^':
        case '==':
        case '!=':
          if (left < right) return left + node.operator + right
          return right + node.operator + left
      }
      return left + node.operator + right
    }
    case 'UnaryOperation':
      if (node.isPrefix) return node.operator + toStringIDCached(node.subExpression, visited)
      return toStringIDCached(node.subExpression, visited) + node.operator
    case 'TupleExpression': {
      const sub_ids = node.components.map((x) => toStringIDCached(x, visited))
      const sid = sub_ids.join(',')
      return `<${sid}>`
    }
    case 'CallExpression': {
      const id = toStringIDCached(node.callee, visited)
      const sub_ids = node.arguments.map((x) => toStringIDCached(x, visited))
      const sid = sub_ids.join(',')
      return `${id}(${sid})`
    }
    case 'NewExpression': {
      const sub_ids = node.arguments.map((x) => toStringIDCached(x, visited))
      const sid = sub_ids.join(',')
      return `new ${node.callee.name}(${sid})`
    }
  }

  switch (node.vtype) {
    case 'object': {
      let { parent } = node
      let { id } = node
      while (parent && parent.vtype !== 'scope' && parent.vtype !== 'fclos' && !parent.type) {
        id = `${toStringIDCached(parent, visited)}.${id}`
        parent = parent.parent
      }
      if (parent && parent.vtype === 'fclos') id = `${parent.id}.${id}`
      return id
    }
    case 'union': {
      let id = '{'
      for (const val of node.value) {
        id += `${toStringIDCached(val, visited)}|`
      }
      id += '}'
      return id
    }
    case 'BVT': {
      let id = 'bvt{'
      for (const x in node.children) {
        const child = node.children[x]
        // if (child.vtype === 'union')
        //     continue;
        // else
        id += `${toStringIDCached(child, visited)},`
      }
      id += '}'
      return id
    }
  }
}

/**
 * whether two values, e.g. two symbolic expressions, are equivalent
 * @param val1
 * @param val2
 * @returns {*}
 * TODO
 */
function isSameValue(val1, val2) {
  if (val1 === val2) return true
  if (!val1 || !val2) return false

  switch (val1.type) {
    case 'MemberAccess':
      return isSameValue(val1.expression, val2.expression) && isSameValue(val1.property, val2.property)
    case 'Identifier':
    case 'Parameter':
      if (val2.type) return val1.name === val2.name
    case 'Literal':
      return val1.value === val2.value
    default:
      return false
  }
  switch (val1.vtype) {
    case 'object':
      if (val1.id !== val2.id) return false
      return isSameValue(val1.parent, val2.parent)
    case 'scope':
      return val1.id === val2.id
  }
  return false
}

// ***

module.exports = {
  toStringID(node) {
    return toStringIDCached(node, new Map())
  },

  isSameValue,
}
