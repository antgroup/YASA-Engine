type VisitedMap = Map<any, string>

/**
 * use cache to avoid infinite recursion
 * @param node
 * @param visited
 * @returns {*}
 */
function toStringIDCached(node: any, visited: VisitedMap): string | undefined {
  if (!node) return

  let id = visited.get(node)
  if (id) return id

  visited.set(node, '__') // place holder: unknown
  id = toStringID(node, visited)
  if (id && id.length > 100) id = id.substring(id.length - 100)
  visited.set(node, id || '__') // replace the unknown
  return id
}

/**
 * convert a node to a unique string (may be hashed to obtain a shorter ID)
 * @param node
 * @param visited
 */
function toStringID(node: any, visited: VisitedMap): string | undefined {
  if (!node) return

  if (Array.isArray(node)) {
    const sub_ids = node.map((x: any) => toStringIDCached(x, visited))
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
      return `${toStringIDCached(node.object, visited)}.${toStringIDCached(node.property, visited)}`
    case 'Noop': {
      return 'Noop'
    }
    case 'BinaryExpression': {
      const left = toStringIDCached(node.left, visited) || ''
      const right = toStringIDCached(node.right, visited) || ''
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
      const sub_ids = node.elements.map((x: any) => toStringIDCached(x, visited))
      const sid = sub_ids.join(',')
      return `<${sid}>`
    }
    case 'CallExpression': {
      const id = toStringIDCached(node.callee, visited)
      const sub_ids = node.arguments.map((x: any) => toStringIDCached(x, visited))
      const sid = sub_ids.join(',')
      return `${id}(${sid})`
    }
    case 'NewExpression': {
      const sub_ids = node.arguments.map((x: any) => toStringIDCached(x, visited))
      const sid = sub_ids.join(',')
      return `new ${node.callee.name}(${sid})`
    }
  }

  switch (node.vtype) {
    case 'object': {
      let { parent } = node
      let { sid } = node
      while (parent && parent.vtype !== 'scope' && parent.vtype !== 'fclos' && !parent.type) {
        sid = `${toStringIDCached(parent, visited)}.${sid}`
        parent = parent.parent
      }
      if (parent && parent.vtype === 'fclos') sid = `${parent.sid}.${sid}`
      return sid
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

// ***

export = {
  toStringID(node: any) {
    return toStringIDCached(node, new Map())
  },
}
