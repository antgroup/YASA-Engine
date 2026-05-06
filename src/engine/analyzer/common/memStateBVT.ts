const {
  ValueUtil: { BVTValue, UnionValue, Scoped, SymbolValue, UndefinedValue },
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
function writeValueBVT(fields: any, index: any, value: any, br: any, br_index: any, scope: any): void {
  /**
   *
   * @param tree
   * @param br
   * @param i
   * @param parent
   * @param pname
   */
  function write(tree: any, br: any, i: number, parentBvt: any, pname: any): void {
    if (!tree || tree.vtype !== 'BVT') {
      const oldTree = tree
      tree = new BVTValue('', `<BVT_create>`, {})
      tree.raw_value = oldTree
      // 保留原始值的类型信息
      if (oldTree?.rtype) tree.rtype = oldTree.rtype
      parentBvt.setChild(pname, tree)
    }
    if (i < br.length - 1) {
      const c = br[i]
      write(tree.getChild(c), br, i + 1, tree, c)
    } else {
      const c = br[br.length - 1]
      const oldVal = tree.getChild(c)
      if (oldVal) {
        tree.setChild(`${c}_`, oldVal)
      }
      tree.setChild(c, value)
    }
  }

  if (br && br.length > 0) {
    // initialize the BVT root node
    let old_value = fields[index]
    if (!old_value) {
      const oldValue = old_value
      old_value = new BVTValue(scope.qid, `<BVT_${index}>`, {})
      old_value.raw_value = oldValue  // 直接设置 raw_value，不通过 setter
    } else if (old_value.vtype !== 'BVT') {
      old_value = createBVT(scope.qid, br, old_value, value.ast?.node, index)
    }
    fields[index] = old_value
    // 标记此 scope 有 BVT 字段，供 mergeLeafValues parent 链跳跃使用
    scope._hasBVTFields = true
    write(old_value, br, br_index, old_value, index)
  } else if (scope.pointerReference) {
    // overwrite directly
    Object.assign(fields[index], value)
  } else {
    fields[index] = value
  }
}

/**
 *
 * @param qidPrefix
 * @param br
 * @param old_value
 * @param node
 */
function createBVT(qidPrefix: string, br: any, old_value: any, node: any, fieldIndex?: string): any {
  if (!br || br.length === 0) {
    return old_value
  }

  const currentChar = br[0]

  const nestedBVT = createBVT(qidPrefix, br.slice(1), old_value, node)
  let sig = '<NodeLocUnknown>'
  if (node?.loc?.sourcefile && typeof node?.loc?.sourcefile === 'string') {
    sig = `${node.loc?.sourcefile.substring((node.loc?.sourcefile.lastIndexOf('/') || 0) + 1, node.loc?.sourcefile.lastIndexOf('.'))}_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}`
  }
  // 字段索引加入 sig，避免同一对象不同字段写入因共享 AST 节点位置导致 UUID 碰撞
  const indexPart = fieldIndex ? `_${fieldIndex}` : ''
  const bvt = new BVTValue(qidPrefix, `<BVT_${sig}${indexPart}_${br}>`, { [currentChar]: nestedBVT })
  // 保留原始值的类型信息，供分支读取时传播
  if (old_value?.rtype) bvt.rtype = old_value.rtype
  return bvt
}

/**
 * read value from the Branch Value Tree
 * @param value
 * @param br
 * @param br_index
 * @returns {*}
 */
function readValue(value: any, br: any, br_index: any): any {
  /**
   *
   * @param tree
   * @param br
   * @param i
   */
  function read(tree: any, br: any, i: number): any {
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
        const sv = new SymbolValue('', {
          sid: `<treeBranch_br${i}>${tree.sid}`,
          qid: `<treeBranch_br${i}>${tree.qid}`,
          field: value,
        })
        // 分支回退时保留 BVT 上保存的类型信息
        if (tree.rtype) sv.rtype = tree.rtype
        return sv
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
    const sv2 = new SymbolValue('', {
      sid: `<treeBranch_br${i}>${tree.sid}`,
      qid: `<treeBranch_br${i}>${tree.qid}`,
      field: pval,
    })
    // 分支回退时保留 BVT 上保存的类型信息
    if (tree.rtype) sv2.rtype = tree.rtype
    return sv2
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
function wrapValue(v: any): any {
  if (!v) return new UndefinedValue()
  if (v.vtype) return v

  return new SymbolValue('', { sid: '<wrapValue>', qid: '<wrapValue>', field: v })
}

/**
 * union two values, reduce duplications whenever possible
 * @param v1
 * @param v2
 * @returns {{vtype: string, value: *[]}}
 */
function unionValue(v1: any, v2: any): any {
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
      // 按 uuid 去重合并两个 Union 的元素
      const seen = new Set<string>()
      const vs: any[] = []
      for (const val of v1.value) {
        const uid = val?.uuid || val
        if (typeof uid === 'string' && seen.has(uid)) continue
        if (typeof uid === 'string') seen.add(uid)
        vs.push(val)
      }
      for (const val of v2.value) {
        const uid = val?.uuid || val
        if (typeof uid === 'string' && seen.has(uid)) continue
        if (typeof uid === 'string') seen.add(uid)
        vs.push(val)
      }
      return vs.length === 1 ? vs[0] : new UnionValue(vs, undefined, `${v1.qid}.<union@bvt>`, v1.ast?.node)
    }
    const vs = v1.value.slice()
    if (!vs.some((x: any) => x === v2))
      vs.push(v2)
    return vs.length === 1 ? vs[0] : new UnionValue(vs, undefined, `${v1.qid}.<union@bvt>`, v1.ast?.node)
  }
  if (v1 === v2) return v1
  return new UnionValue([v1, v2], undefined, `${v1.qid}.<union@bvt>`, v1.ast?.node)
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
function mergeLeafValues(scope: any, brs: any, br_index: any, parent: any, visited: Set<any>): any {
  if (typeof scope !== 'object' || scope === null) return scope
  if (scope.type) return scope // expressions

  visited.add(scope)
  if (scope.vtype === 'BVT') {
    const c = brs[br_index]
    if (br_index < brs.length - 1) {
      const { children } = scope
      return mergeLeafValues(children[c], brs, br_index + 1, scope, visited)
    }
    let vs: any
    let numChildren = 0
    for (const branch in scope.children) {
      const val = scope.children[branch]
      vs = unionValue(vs, val)
      numChildren++
    }
    if (numChildren < 2 && scope.value) vs = unionValue(vs, scope.value)
    if (parent) {
      parent.setChild(brs[br_index - 1], vs)
      return parent
    }
    return vs // scope;
  }
  if (scope.vtype === 'object' || scope.vtype === 'fclos' || scope.vtype === 'scope') {
    // 深度优先递归合并 scope 的所有字段
    for (const field in scope.value) {
      const v = scope.value[field]
      if (visited.has(v)) continue
      scope.value[field] = mergeLeafValues(v, brs, br_index, parent, visited)
    }
    // 沿 parent 链跳跃合并：只处理 writeValueBVT 标记过的 scope（_hasBVTFields），
    // 跳过无 BVT 修改的中间 parent，避免对大型 global scope 的无效遍历。
    let p = scope.parent
    while (p && !visited.has(p)) {
      if (p._hasBVTFields) {
        mergeLeafValues(p, brs, br_index, parent, visited)
        break // 更深层的 parent 会在 mergeLeafValues(p, ...) 的递归中处理
      }
      visited.add(p) // 标记已跳过，避免重复遍历
      p = p.parent
    }
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
function reduceBranchValues(scope: any, visited: Set<any>): any {
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
function unionBVTScope(scope1: any, scope2: any, visited: Map<any, any>): any {
  if (scope1 === scope2) return scope1
  if (scope1.type === 'Literal' && scope2.type.type == 'Literal' && scope1.value === scope2.value) {
    return scope1
  }
  const bvtQid = `<BVTUnionResQid_${scope1.qid}_${scope2.qid}>`
  const bvtSid = `<BVTUnionResSid_${scope1.sid}_${scope2.sid}>`
  const result = new Scoped('', { sid: bvtSid, qid: bvtQid, parent: scope1.parent })
  const vvalue1 = scope1.value
  const vvalue2 = scope2.value
  const rvalue = result.value
  for (const field in vvalue1) {
    const v1 = vvalue1[field]
    const v2 = vvalue2[field]
    if (v2) {
      const prev_v = visited.get(field)
      if (prev_v) return prev_v
      const bvtSid = `<BVTUnionSid_${v1.sid}_${v2.sid}>`
      const new_v = new BVTValue('', bvtSid, { L: v1, R: v2 })
      rvalue[field] = new_v
      visited.set(field, new_v)
    } else {
      const bvtSid = `<BVTUnionSid_${v1.sid}>`
      rvalue[field] = new BVTValue(scope1.qid, bvtSid, { L: v1 })
    }
  }
  for (const field in vvalue2) {
    const v2 = vvalue2[field]
    const bvtSid = `<BVTUnionSid_${v2.sid}>`
    if (!vvalue1 || !vvalue1[field]) rvalue[field] = new BVTValue(scope2.qid, bvtSid, { R: v2 })
  }

  return result
}

/**
 * fold the BVT
 * @param scope
 * @param visited
 * @returns {*}
 */
function reduceBVTScope(scope: any, visited: Set<any>): any {
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
      scope.setChild('L', l)
    } else if (rchild) {
      const r = reduceBVTScope(rchild, visited)
      scope.setChild('R', r)
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
function unionValuesBVT(scope: any, lstate: any, brs: any): any {
  return mergeLeafValues(scope, lstate.brs, brs.length, null, new Set())
}

/**
 * In BVT the scope is shared
 * @param scope
 * @param state
 * @returns {*}
 */
function cloneScope(scope: any, state: any): any {
  return scope
}

/**
 * UnionValue for array
 * @param scopes
 * @param state
 */
function unionAllValues(scopes: any, state: any): any {
  const res = scopes[0]
  const validScopes = scopes.filter((s: any) => s != null)
  return new UnionValue(validScopes, undefined, `${res?.qid || '<union>'}.<union@all>`, res?.ast?.node)
}
//* ***************************** exports ********************************************

module.exports = {
  readValue,
  writeValue: writeValueBVT,
  unionValues: unionValuesBVT,
  cloneScope,
  unionAllValues,
  reduceScope: (scope: any) => {
    return reduceBVTScope(scope, new Set())
  },
}
