const {
  ValueUtil: { BVT, UnionValue, Scoped, SymbolValue, UndefinedValue },
} = require('../../util/value-util')

/** ************************************************************
 * Analysis state management with lazy side-effects;
 * including a lazy mechanism for scope unions
 * *********************************************************** */

//* ************************* scope operations *****************

/**
 * update the Branch Value Tree
 * @param fields
 * @param index
 * @param value
 * @param br
 * @param br_index
 * @param scope
 */
function writeValue(fields, index, value, br, br_index, scope) {
  /**
   *
   * @param tree
   * @param br
   * @param i
   * @param parent
   * @param pname
   */
  function write(tree, br, i, parent, pname) {
    if (!tree || tree.vtype !== 'BVT') {
      // create a sub-tree for the new appeared branch
      tree = BVT({ value: tree })
      parent[pname] = tree
    }
    if (i < br.length - 1) {
      const c = br[i]
      const { children } = tree
      write(children[c], br, i + 1, children, c)
    } else {
      const c = br[br.length - 1]
      tree.children[c] = value
    }
  }

  if (br && br.length > 0) {
    // initialize the BVT root node
    let old_value = fields[index]
    if (!old_value) {
      old_value = BVT({ value: old_value })
    } else if (old_value.vtype !== 'BVT') {
      old_value = createBVT(br, old_value)
    }
    fields[index] = old_value
    write(old_value, br, br_index)
  } else if (scope.misc_.pointer_reference) {
    // overwrite directly
    Object.assign(fields[index], value)
  } else {
    fields[index] = value
  }
}

/**
 *
 * @param br
 * @param old_value
 */
function createBVT(br, old_value) {
  if (!br || br.length === 0) {
    return old_value
  }

  const currentChar = br[0]

  const nestedBVT = createBVT(br.slice(1), old_value)
  return BVT({ children: { [currentChar]: nestedBVT } })
}

/**
 * read value from the Branch Value Tree
 * @param value
 * @param br
 * @param br_index
 * @returns {*}
 */
function readValue(value, br, br_index) {
  /**
   *
   * @param tree
   * @param br
   * @param i
   */
  function read(tree, br, i) {
    if (i < br.length - 1) {
      const c = br[i]
      const children = tree?.children
      if (
        !children ||
        (children &&
          typeof children === 'object' &&
          typeof children.hasOwnProperty === 'function' &&
          !children.hasOwnProperty(c))
      ) {
        if (tree?.vtype !== 'BVT') {
          return tree
        }
        const { value } = tree
        if (value.vtype) {
          return value
        }
        return SymbolValue({ field: value })
      }
      return read(children[c], br, i + 1)
    }
    // else if (!tree || !tree.children)
    if (!tree) return tree
    if (tree.vtype !== 'BVT') return tree

    const this_br = br[i]
    if (
      tree?.children &&
      typeof tree?.children?.hasOwnProperty === 'function' &&
      tree.children.hasOwnProperty(this_br)
    ) {
      return tree.children[this_br]
    }
    const pval = tree.value
    if (pval.vtype) {
      return pval
    }
    return SymbolValue({ field: pval })
  }

  if (!value) return value
  if (value.vtype === 'BVT') {
    return read(value, br, br_index)
  }
  return value
}

//* ***************************** scope union ***********************************

/**
 *
 * @param v
 */
function wrapValue(v) {
  if (!v) return UndefinedValue()
  if (v.vtype) return v

  return SymbolValue({ field: v })
}

/**
 * union two values, reduce duplications whenever possible
 * @param v1
 * @param v2
 * @returns {{vtype: string, value: *[]}}
 */
function unionValue(v1, v2) {
  v1 = wrapValue(v1)
  v2 = wrapValue(v2)

  if (!v1 || v1?.vtype === 'undefine') return v2
  if (v2.vtype === 'union') {
    const tmp = v1
    v1 = v2
    v2 = tmp
  }
  if (v1.vtype === 'union') {
    if (v2.vtype === 'union') {
      const vs = v1.value.concat(v2.value)
      return vs.length === 1 ? vs[0] : UnionValue({ value: vs })
    }
    const vs = v1.value.slice()
    if (
      !vs.some(function (x) {
        x === v2
      })
    )
      vs.push(v2)
    return vs.length === 1 ? vs[0] : UnionValue({ value: vs })
  }
  if (v1 === v2) return v1
  return UnionValue({ value: [v1, v2] })
}

/**
 * reduce a Branch Value Tree by merging the given branches
 * @param value
 * @param brs
 * @returns {*}
 */
function mergeBVT(value, brs) {
  /**
   *
   * @param tree
   * @param br
   * @param i
   * @param parent
   */
  function merge(tree, br, i, parent) {
    if (i < br.length - 1) {
      const c = br[i]
      const { children } = tree
      return merge(children[c], br, i + 1, tree)
    }
    if (tree) {
      const c = br[i]
      let vs
      let numChildren = 0
      for (const field in tree.children) {
        const val = tree.children[field]
        vs = unionValue(vs, val)
        numChildren++
      }
      if (numChildren < 2 && tree.value) vs = unionValue(vs, tree.value)
      if (parent) {
        parent.children[c] = vs
      } else return vs
    }
  }

  if (!value) return value
  if (value.vtype === 'BVT') {
    const res = merge(value, brs[0], 0)
    return res || value
  }
  return value
}

/**
 * value union for control-flow convergence points
 * @param scope
 * @param brs: a list of branch indices
 * @param brs
 * @param br_index
 * @param parent
 * @param visited
 * @returns {*}
 */
function mergeLeafValues(scope, brs, br_index, parent, visited) {
  if (typeof scope !== 'object') return scope
  if (scope.type) return scope // expressions

  visited.add(scope)
  if (scope.vtype === 'BVT') {
    const c = brs[br_index]
    if (br_index < brs.length - 1) {
      const { children } = scope
      return mergeLeafValues(children[c], brs, br_index + 1, scope, visited)
    }
    let vs
    let numChildren = 0
    for (const branch in scope.children) {
      const val = scope.children[branch]
      vs = unionValue(vs, val)
      numChildren++
    }
    if (numChildren < 2 && scope.value) vs = unionValue(vs, scope.value)
    if (parent) {
      parent.children[brs[br_index - 1]] = vs
      return parent
    }
    return vs // scope;
  }
  if (scope.vtype === 'object' || scope.vtype === 'fclos' || scope.vtype === 'scope') {
    // 深度优先递归合并scope的所有children元素
    for (const field in scope.value) {
      // if (field === 'parent') continue;
      const v = scope.value[field]
      if (visited.has(v)) continue
      scope.value[field] = mergeLeafValues(v, brs, br_index, parent, visited)
    }
    // TODO:check以下这段逻辑，parent为什么要合并？是否有污染问题
    const parent_scope = scope.parent
    if (parent_scope && !visited.has(parent_scope))
      scope.parent = mergeLeafValues(parent_scope, brs, br_index, parent, visited)
    return scope
  }
  if (Array.isArray(scope)) {
    for (const field in scope) {
      const v = scope[field]
      if (visited.has(v)) continue
      scope[field] = mergeLeafValues(v, brs, br_index, parent, visited)
    }
    return scope
  }
  return scope
}

/**
 *
 * @param scope
 * @param visited
 * @returns {*}
 */
function reduceBranchValues(scope, visited) {
  if (typeof scope !== 'object') return scope
  if (scope.type) return scope // expressions

  visited.add(scope)
  if (scope.vtype === 'BVT') {
    const lchild = scope.children.L
    const rchild = scope.children.R
  } else if (scope.vtype === 'object' || scope.vtype === 'fclos' || scope.vtype === 'scope') {
    for (const field in scope.value) {
      // if (field === 'parent') continue;
      const v = scope.value[field]
      if (visited.has(v)) continue
      scope.value[field] = reduceBranchValues(v, visited)
    }
    const { parent } = scope
    if (parent && !visited.has(parent)) scope.parent = reduceBranchValues(parent, visited)
    return scope
  } else if (Array.isArray(scope)) {
    for (const field in scope) {
      const v = scope[field]
      if (visited.has(v)) continue
      scope[field] = reduceBranchValues(v, visited)
    }
    return scope
  }
  return scope
}

//* ***************************** BVT scopes ********************************************

/**
 * scope union for control-flow convergence points
 * @param scope1
 * @param scope2
 * @param visited
 * @returns {*}
 */
function unionBVTScope(scope1, scope2, visited) {
  if (scope1 === scope2) return scope1
  if (scope1.type === 'Literal' && scope2.type.type == 'Literal' && scope1.value === scope2.value) {
    return scope1
  }

  const result = Scoped({ parent: scope1.parent })
  const vvalue1 = scope1.value
  const vvalue2 = scope2.value
  const rvalue = result.value
  for (const field in vvalue1) {
    const v1 = vvalue1[field]
    const v2 = vvalue2[field]
    if (v2) {
      const prev_v = visited.get(field)
      if (prev_v) return prev_v
      const new_v = BVT({ children: { L: v1, R: v2 } })
      rvalue[field] = new_v
      visited.set(field, new_v)
    } else rvalue[field] = BVT({ children: { L: v1 } })
  }
  for (const field in vvalue2) {
    const v2 = vvalue2[field]
    if (!vvalue1 || !vvalue1[field]) rvalue[field] = BVT({ children: { R: v2 } })
  }
  // if (scope1.ast) {
  //    if (scope2.ast)
  //        result.ast = unionPrimitiveValues(scope1.ast, scope2.ast);
  //    else
  //        result.ast = scope1.ast;
  // }
  // else if (scope2.ast)
  //    result.ast = scope2.ast;
  return result
}

/**
 * fold the BVT
 * @param scope
 * @param visited
 * @returns {*}
 */
function reduceBVTScope(scope, visited) {
  if (scope.type) return scope // expressions

  if (visited.has(scope))
    // already reduced
    return scope
  visited.add(scope)

  if (scope.vtype === 'BVT') {
    const lchild = scope.children.L
    const rchild = scope.children.R
    if (lchild) {
      const l = reduceBVTScope(lchild, visited)
      if (rchild) {
        const r = reduceBVTScope(rchild, visited)
        return unionBVTScope(l, r, new Map())
      }
      scope.children.L = l
    } else if (rchild) {
      const r = reduceBVTScope(rchild, visited)
      scope.children.R = r
    }
  } else if (scope.vtype === 'object' || scope.vtype === 'fclos' || scope.vtype === 'scope') {
    for (const field in scope.value) {
      const v = scope.value[field]
      scope.value[field] = reduceBVTScope(v, visited) // overwrite the value
    }
    const { parent } = scope
    if (parent && !visited.has(parent)) scope.parent = reduceBVTScope(parent, visited)
    return scope
  } else if (Array.isArray(scope)) {
    for (const field in scope) {
      const v = scope[field]
      scope[field] = reduceBVTScope(v, visited)
    }
    return scope
  }
  return scope
}

//* ***************************** Utilities ******************************************

/**
 * fold the BVT tree by merging the leaves
 * @param scope
 * @param lstate
 * @param rstate
 * @param brs
 * @returns {*}
 */
function unionValues(scope, lstate, brs) {
  return mergeLeafValues(scope, lstate.brs, brs.length, null, new Set())
}

/**
 * In BVT the scope is shared
 * @param scope
 * @param state
 * @returns {*}
 */
function cloneScope(scope, state) {
  return scope
}

/**
 * UnionValue for array
 * @param scopes
 * @param state
 */
function unionAllValues(scopes, state) {
  const res = scopes[0]
  const tmp = UnionValue()
  tmp.appendValue(res)
  for (let i = 1; i < scopes.length; i++) {
    if (scopes[i].vtype === 'union') {
      tmp._pushValue(scopes[i])
    } else {
      tmp.appendValue(scopes[i])
    }
  }
  return tmp
}
//* ***************************** exports ********************************************

module.exports = {
  readValue,
  writeValue,
  unionValues,
  cloneScope,
  unionAllValues,
  reduceScope: (scope) => {
    return reduceBVTScope(scope, new Set())
  },
}
