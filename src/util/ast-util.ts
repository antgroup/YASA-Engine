let sourcefile: string | null
const _ = require('lodash')
const UastSpec = require('@ant-yasa/uast-spec')
const config = require('../config')
const varUtil = require('./variable-util')
const BasicRuleHandler = require('../checker/common/rules-basic-handler')
const { md5 } = require('./hash-util')

const defaultFilter = (nd: any, prop: string, from: any): boolean => {
  /**
   *
   * @param obj
   */
  function objHasCallExpressionOrBinaryExpressionOrTag(obj: any): boolean {
    if (!obj) {
      return false
    }
    if (
      (obj.type === 'CallExpression' ||
        obj.type === 'BinaryExpression' ||
        obj._tags !== undefined ||
        obj.vtype === 'object') &&
      obj._has_tags
    ) {
      return true
    }
    if (obj.object) {
      return objHasCallExpressionOrBinaryExpressionOrTag(obj.object)
    }
    return false
  }

  return (
    !(nd.type === 'MemberAccess' && prop === 'object' && nd._tags !== undefined) &&
    !(
      nd.type === 'MemberAccess' &&
      prop === 'object' &&
      (!nd._has_tags || from.type !== 'CallExpression') &&
      (!nd._has_tags || from.type !== 'BinaryExpression') &&
      (!nd._has_tags ||
        (nd.object.type !== 'CallExpression' &&
          nd.object.value.T === undefined &&
          nd.object.value.F === undefined &&
          nd.object.value.U === undefined)) &&
      !objHasCallExpressionOrBinaryExpressionOrTag(nd.object)
    ) &&
    nd[prop] &&
    typeof nd[prop] === 'object' &&
    Object.keys(nd[prop]).length > 0
  )
}

/**
 * slightly adjust the AST nodes, and add parent pointers
 * @param sourceunit
 */
function adjustASTNode(sourceunit: any): void {
  const visited = new Set()
  visited.add(sourceunit)
  const worklist = [sourceunit]
  while (worklist.length) {
    const node = worklist.shift()
    for (const prop of Object.keys(node)) {
      const sub_node = node[prop]
      if (sub_node && typeof sub_node === 'object' && sub_node.type) {
        switch (sub_node.type) {
          case 'FunctionDefinition':
            sub_node.name = sub_node.id?.name ?? `<anonymous>`
            break
          case 'ClassDefinition':
            sub_node.name = sub_node.id?.name ?? '<anonymous>'
            break
        }
        if (visited.has(sub_node)) continue
        sub_node.parent = node
        sub_node.loc = sub_node.loc || {}
        sub_node.loc.sourcefile = sourcefile
        worklist.push(sub_node)
        visited.add(sub_node)
      } else if (Array.isArray(sub_node)) {
        for (const sn of sub_node) {
          if (sn?.type && !visited.has(sn)) {
            sn.parent = node
            sn.loc = sn.loc || {}
            sn.loc.sourcefile = sourcefile
            worklist.push(sn)
            visited.add(sn)
          }
        }
      }
    }
  }
}

interface AnnotateOptions {
  sourcefile?: string
  [key: string]: any
}

/**
 * add annotations, e.g. source file info, to AST nodes
 * @param node
 * @param options
 */
function annotateAST(node: any, options?: AnnotateOptions): void {
  sourcefile = null
  if (options) {
    if (options.sourcefile) sourcefile = options.sourcefile
  }
  adjustASTNode(node)
}

/**
 * 给uast分配hash
 * @param obj
 */
function addNodeHash(obj: any): void {
  if (!obj) return
  if (Array.isArray(obj)) {
    obj.forEach((o: any) => {
      addNodeHash(o)
    })
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) return
  if (obj.type) {
    const { getCodeByLocation } = require('../engine/analyzer/common/source-line')
    let content = getCodeByLocation(obj.loc)
    if (content === '') {
      content = prettyPrint(obj)
    }
    const relateFilePath = obj.loc?.sourcefile?.startsWith(config.maindirPrefix)
      ? obj.loc?.sourcefile?.substring(config.maindirPrefix.length)
      : obj.loc?.sourcefile
    if (!obj._meta) obj._meta = {}
    obj._meta.nodehash = md5(
      `${content}_${obj.loc?.start?.line}_${obj.loc?.start?.column}_${obj.loc?.end?.line}_${
        obj.loc?.end?.column
      }_${relateFilePath}_${obj.type}_${obj.parent?._meta?.nodehash}`
    )
  }
  for (const key in obj) {
    if (key === 'parent') continue
    if (obj.hasOwnProperty(key)) {
      const subObj = obj[key]
      addNodeHash(subObj)
    }
  }
}

/**
 *
 * @param obj
 */
function deleteParent(obj: any) {
  if (typeof obj !== 'object' || obj === null) {
    return obj
  }

  // 处理数组
  if (Array.isArray(obj)) {
    obj.forEach((item) => deleteParent(item))
    return obj
  }

  // 处理普通对象
  if ('parent' in obj) {
    delete obj.parent
  }

  // 递归处理所有属性
  for (const key in obj) {
    if (obj.hasOwnProperty(key) && typeof obj[key] === 'object' && obj[key] !== null) {
      deleteParent(obj[key])
    }
  }
}

/**
 * AST visitor
 * @param node
 * @param visitor
 */
function visit(node: any, visitor: any): void {
  if (!node) return

  if (Array.isArray(node)) {
    node.forEach(function (child: any) {
      return visit(child, visitor)
    })
  }

  if (!node.type && !node.vtype) return

  let cont = true

  if (visitor[node.type]) {
    cont = visitor[node.type](node)
  }

  if (cont === false) return

  for (const prop in node) {
    if (prop != 'parent' && prop != 'rrefs' && prop != 'trace' && node.hasOwnProperty(prop)) {
      visit(node[prop], visitor)
    }
  }

  const selector = `${node.type}:exit`
  if (visitor[selector]) {
    visitor[selector](node)
  }
}

/**
 * get val in the node that satisfies the f condition.
 * @param node
 * @param f
 * @param filter
 * @param visited
 * @param multiMatch
 * @param maxdepth
 * @param satisfyCallback
 */
function satisfy(
  node: any,
  f: any,
  filter?: any,
  visited?: Set<any>,
  multiMatch?: boolean,
  maxdepth?: number,
  satisfyCallback?: any
): any | any[] | null {
  const res: any[] = []
  visited = visited || new Set()
  const worklist = [node]
  const fromlist = [node]
  const depthlist = [1]
  const parentMap = new WeakMap()
  while (worklist.length) {
    node = worklist.shift()
    const from = fromlist.shift()
    const depth = depthlist.shift()
    if (!node || visited.has(node)) continue
    visited.add(node)
    if (Array.isArray(node)) {
      node.forEach((child: any) => {
        worklist.push(child)
        fromlist.push(node)
        depthlist.push(depth || 1)
        if (child && typeof child === 'object') {
          parentMap.set(child, node)
        }
      })
    }

    if (f(node)) {
      if (satisfyCallback) {
        satisfyCallback(node, from, parentMap)
      }
      if (multiMatch) {
        res.push(node)
      } else {
        return node
      }
    }
    if (node.vtype === 'BVT') {
      node = node.children
    }
    if (typeof node !== 'object') continue
    if (maxdepth && depth) {
      if (depth > maxdepth) continue
    }
    for (const prop in node) {
      if (!Object.prototype.hasOwnProperty.call(node, prop)) continue
      // 过滤的时候 不仅要过滤_this还要过滤__this
      if (
        [
          'parent',
          'rrefs',
          'trace',
          'updates',
          'type',
          'operator',
          'id',
          'ast',
          'loc',
          'sort',
          '_tags',
          'uninit',
          'callnode',
          'names',
          '_this',
          '__this',
          'cdef',
          'fdef',
          'packageScope',
          'fileScope',
          'exports',
          '_sid',
          '_id',
          '_qid',
          'vtype',
          '_meta',
        ].indexOf(prop) !== -1
      ) {
        continue
      }
      if (filter && !filter(node, prop, from)) continue
      if (prop === 'field') {
        const sub_field = node[prop]
        for (const p in sub_field) {
          if (!Object.prototype.hasOwnProperty.call(sub_field, p)) continue
          worklist.push(sub_field[p])
          fromlist.push(sub_field)
          depthlist.push((depth || 0) + 1)
          if (sub_field[p] && typeof sub_field[p] === 'object') {
            parentMap.set(sub_field[p], node)
          }
        }
      } else {
        const v = node[prop]
        worklist.push(v)
        fromlist.push(node)
        depthlist.push((depth || 0) + 1)
        if (v && typeof v === 'object') {
          parentMap.set(v, node)
        }
      }
    }
  }
  return res.length === 0 ? null : res
}

/**
 * @param symVal
 * @param targetAttribute
 */
function hasTag(symVal: any, targetAttribute?: any): boolean {
  if (config.makeAllCG || !BasicRuleHandler.getPreprocessReady()) return false
  const checkRawProps = ['arguments', 'left', 'right', 'expression', 'object']
  const checkFieldsProps = ['field', 'children', 'misc_']

  /**
   *
   * @param symVal
   * @param targetAttribute
   * @param stack
   * @param visited
   */
  function hasTagRec(symVal: any, targetAttribute: any, stack: number, visited: Set<any>): boolean {
    if (!symVal) {
      return false
    }
    if (symVal.vtype === 'fclos') {
      return false
    }
    visited = visited || new Set()
    if (stack > 20) {
      return false
    }
    if (!symVal || visited.has(symVal)) {
      return false
    }
    visited.add(symVal)

    if (
      targetAttribute &&
      targetAttribute !== '' &&
      !Array.isArray(symVal) &&
      symVal?._has_tags &&
      varUtil.isNotEmpty(symVal)
    ) {
      return true
    }
    if (!Array.isArray(symVal) && symVal?._has_tags) {
      return true
    }

    if (Array.isArray(symVal)) {
      for (const eleVal of symVal) {
        const tagVal = hasTagRec(eleVal, targetAttribute, stack + 1, visited)
        if (tagVal) {
          return true
        }
      }
      return false
    }
    // 查找field的属性，field属性里每一个符号值都要搜索
    for (const fieldProp of checkFieldsProps) {
      if (_.has(symVal, fieldProp)) {
        // 处理数组的情况
        if (Array.isArray(symVal?.[fieldProp])) {
          for (const eleVal of symVal?.[fieldProp]) {
            const tagVal = hasTagRec(eleVal, targetAttribute, stack + 1, visited)
            if (tagVal) {
              return true
            }
          }
        } else {
          // 处理普通对象
          for (const key in symVal?.[fieldProp]) {
            const eleVal = symVal?.[fieldProp][key]
            if (
              typeof eleVal?._qid === 'string' &&
              (eleVal?._qid?.includes('Egg.Context<instance>') || eleVal?._qid?.includes('Egg.Application.service'))
            ) {
              return false
            }
            const tagVal = hasTagRec(eleVal, targetAttribute, stack + 1, visited)
            if (tagVal) {
              return true
            }
          }
        }
      }
    }
    // 查找普通属性,普通属性只check自身
    for (const prop of checkRawProps) {
      if (_.has(symVal, prop)) {
        // 处理数组的情况 eg arguments
        if (Array.isArray(symVal?.[prop]) && symVal?.[prop]?.length > 0) {
          for (const eleVal of symVal?.[prop]) {
            const tagVal = hasTagRec(eleVal, targetAttribute, stack + 1, visited)
            if (tagVal) {
              return true
            }
          }
        } else if (symVal?.[prop]?._has_tags) {
          const tagVal = hasTagRec(symVal?.[prop], targetAttribute, stack + 1, visited)
          if (tagVal) {
            return true
          }
        } else if (prop === 'misc_') {
          const tagVal = hasTagRec(symVal?.[prop], targetAttribute, stack + 1, visited)
          if (tagVal) {
            return true
          }
        }
      }
    }
    if (targetAttribute && targetAttribute !== '' && (arrayHasTag(symVal) || symVal?._has_tags)) {
      return true
    }
    return !Array.isArray(symVal) && symVal?._has_tags
  }

  return hasTagRec(symVal, targetAttribute, 0, new Set())
}

/**
 * 判断array中是否有一个元素包含污点
 * @param array
 * @returns {boolean|*|boolean}
 */
function arrayHasTag(array: any): boolean {
  let hasTag = false
  if (!Array.isArray(array) && array.raw_value === undefined) {
    return array?._has_tags
  }
  if (Array.isArray(array)) {
    for (const i in array) {
      if (array[i]?._has_tags) {
        hasTag = true
        break
      } else if (typeof array[i].raw_value !== 'undefined') {
        for (const r in array[i].raw_value) {
          if (array[i].raw_value[r]?._has_tags) {
            hasTag = true
            break
          }
        }
      }
    }
  } else if (typeof array.raw_value !== 'undefined') {
    for (const r in array.raw_value) {
      if (array.raw_value[r]?._has_tags) {
        hasTag = true
        break
      }
    }
  }
  return hasTag
}

/**
 * whether node affected by {tag}
 * @param node
 * @param attribute
 * @param multiMatch
 * @returns {boolean}
 */
function findTag(node: any, attribute: any, multiMatch?: boolean): any | any[] | null | false {
  if (config.makeAllCG || !BasicRuleHandler.getPreprocessReady()) {
    return false
  }
  return satisfy(
    node,
    (nd: any) => {
      const tags = nd?._tags
      if (_.isFunction(tags?.has) && tags.has(attribute)) {
        return true
      }
    },
    defaultFilter,
    undefined,
    multiMatch,
    30
  )
}

/**
 *
 * @param node
 * @param f
 * @returns {*}
 */
function getAncestor(node: any, f: any): any | undefined {
  if (!node) return
  do {
    if (f(node)) return node
    node = node.parent
  } while (node)
}

/**
 *
 * @param node
 */
function prettyPrintAST(node: any): string {
  if (!node) return ''
  if (Array.isArray(node)) {
    const len = node.length
    if (!len) return ''
    let res = prettyPrintAST(node[0])
    for (let i = 1; i < len; i++) {
      res = `${res}, ${prettyPrintAST(node[i])}`
    }
    return res
  }
  return prettyPrint(node.ast || node.decl || node.fdecl || node)
}

/**
 * Pretty-print AST nodes
 * @param node
 * @returns {*}
 */
function prettyPrint(node: any): string {
  if (!node) return ''

  if (Array.isArray(node)) {
    const len = node.length
    if (!len) return ''
    let res = prettyPrint(node[0])
    for (let i = 1; i < len; i++) {
      res = `${res}, ${prettyPrint(node[i])}`
    }
    return res
  }
  switch (node.type) {
    case 'AssignmentExpression': {
      return prettyPrint(node.left) + node.operator + prettyPrint(node.right)
    }
    case 'BinaryExpression': {
      return prettyPrint(node.left) + node.operator + prettyPrint(node.right)
    }
    case 'BreakStatement': {
      return `break ${prettyPrint(node.label)}`
    }
    case 'CallExpression': {
      return `${prettyPrint(node.callee)}(${prettyPrint(node.arguments)})`
    }
    case 'CastExpression': {
      return `(${prettyPrint(node.as)})${prettyPrint(node.expression)}`
    }
    case 'CaseClause': {
      return `case ${node.test}: ${prettyPrint(node.body)}`
    }
    case 'CatchClause': {
      return `catch(${prettyPrint(node.parameter)}){${prettyPrint(node.body)}}`
    }
    case 'ClassDefinition': {
      return `class ${prettyPrint(node.id)}{${prettyPrint(node.body)}}`
    }
    // CompileUnit
    case 'CompileUnit': {
      return `${prettyPrint(node.body)}`
    }
    case 'ConditionalExpression': {
      return `${prettyPrint(node.test)}? ${prettyPrint(node.consequent)}: ${prettyPrint(node.alternative)}}`
    }
    case 'ContinueStatement': {
      return `continue ${prettyPrint(node.label)}`
    }
    case 'DereferenceExpression': {
      return `*${prettyPrint(node.argument)}`
    }
    //  | DereferenceExpression
    //   | DynamicType
    case 'ExportStatement': {
      return `export ${prettyPrint(node.argument)}`
    }
    case 'ExpressionStatement': {
      return prettyPrint(node.expression)
    }
    case 'ForStatement': {
      return `for(${prettyPrint(node.init)};${prettyPrint(node.test)};${prettyPrint(node.update)}{${prettyPrint(node.body)})`
    }
    case 'FunctionDefinition': {
      return `function ${prettyPrint(node.id)}(${prettyPrint(node.parameters)}){${prettyPrint(node.body)}}`
    }
    case 'Identifier':
      return node.name
    case 'IfStatement': {
      let res = `if(${prettyPrint(node.test)}){${prettyPrint(node.consequent)}}`
      if (node.alternative) {
        res += ` else {${prettyPrint(node.alternative)}}`
      }
      return res
    }
    case 'ImportExpression': {
      return `import ${prettyPrint(node.imported)} from ${prettyPrint(node.from)}`
    }
    case 'LabeledStatement': {
      return `${prettyPrint(node.label)}: {${prettyPrint(node.body)}`
    }
    case 'Literal': {
      return node.value
    }
    case 'MemberAccess': {
      return `${prettyPrint(node.object)}.${prettyPrint(node.property)}`
    }
    case 'NewExpression': {
      return `new ${prettyPrint(node.callee)}(${prettyPrint(node.arguments)})`
    }
    case 'Noop': {
      return ''
    }
    case 'ObjectExpression': {
      return `${prettyPrint(node.id)}{${prettyPrint(node.properties)}}`
    }
    case 'ObjectProperty': {
      return `${prettyPrint(node.key)}:${prettyPrint(node.value)}`
    }
    case 'RangeStatement': {
      return `for(${prettyPrint(node.key)}, ${prettyPrint(node.value)} : ${prettyPrint(node.right)}){${prettyPrint(node.body)}}`
    }
    // ReferenceExpression
    case 'ReturnStatement': {
      return `return ${prettyPrint(node.argument)}`
    }
    case 'ScopedStatement': {
      return `{${prettyPrint(node.body)}}`
    }
    case 'Sequence': {
      return `(${prettyPrint(node.expressions)})`
    }
    case 'SliceExpression': {
      return `${prettyPrint(node.element)}[${prettyPrint(node.start)} : ${prettyPrint(node.end)} ${node.step ? `:${prettyPrint(node.step)}` : ''}]`
    }
    case 'SpreadElement': {
      return `with(${prettyPrint(node.argument)})`
    }
    case 'SuperExpression': {
      return 'super'
    }
    case 'SwitchStatement': {
      return `switch(${prettyPrint(node.discriminant)}){${prettyPrint(node.cases)}`
    }
    case 'ThisExpression': {
      return 'this'
    }
    case 'ThrowStatement': {
      return `throw ${prettyPrint(node.argument)}}`
    }
    case `TryStatement`: {
      let res = `try {${prettyPrint(node.body)}}${prettyPrint(node.handlers)}`
      if (node.finalizer) {
        res += `finally{${prettyPrint(node.finalizer)}`
      }
      return res
    }
    case 'TupleExpression': {
      return `(${prettyPrint(node.elements)})`
    }
    case 'UnaryExpression': {
      if (!node.isSuffix) {
        return node.operator + prettyPrint(node.argument)
      }
      return prettyPrint(node.argument) + node.operator
    }
    case 'VariableDeclaration': {
      let res = `var ${prettyPrint(node.id)}`
      if (node.varType) {
        res += `:${prettyPrint(node.varType)}`
      }
      if (node.init) {
        res += `=${prettyPrint(node.init)}`
      }
      return res
    }
    case 'WhileStatement': {
      if (node.isPostTest) {
        return `do{${prettyPrint(node.body)}while(${prettyPrint(node.test)})`
      }
      return `while(${prettyPrint(node.test)}){${prettyPrint(node.body)}`
    }
    case 'YieldExpression': {
      return `yield ${prettyPrint(node.argument)}`
    }
    case 'ScopedStatement:begin':
    case 'ScopedStatement:end': {
      return ''
    }
    case 'PointerType': {
      return `*${prettyPrint(node.element)}`
    }
    case 'ReferenceExpression': {
      return `&${prettyPrint(node.argument)}`
    }
    default: {
      if (node.id) {
        return `${prettyPrint(node.id)}`
      }
    }
  }

  if (node.vtype) return '...'
  if (node.type === 'DynamicType' && node.id === null) return 'any'
  try {
    return JSON.stringify(
      node,
      function replacer(key: string, value: any) {
        if (key === 'parent' || key === 'loc' || key === 'rrefs') return undefined
        return value
      },
      ' '
    )
  } catch (e) {
    return '{ ... }'
  }
}

/**
 *
 */
class ASTQuery {
  nodes: Set<any> // ast nodes

  /**
   *
   * @param nodes
   */
  constructor(nodes?: any) {
    if (!nodes) {
      this.nodes = new Set()
    } else if (nodes instanceof Set) {
      this.nodes = nodes
    } else if (Array.isArray(nodes)) {
      this.nodes = new Set(nodes)
    } else {
      this.nodes = new Set([nodes])
    }
  }

  /**
   *
   * @param match
   * @param prune
   */
  findAll(match: any, prune?: any): ASTQuery {
    const visited = new Set()
    const res = new ASTQuery()
    for (const node of this.nodes) {
      res.add(_find(node))
    }
    return res

    /**
     *
     * @param subNode
     */
    function _find(subNode: any): any[] {
      if (visited.has(subNode)) {
        return []
      }
      visited.add(subNode)
      const res: any[] = []
      if (!subNode) {
        return res
      }
      if (Array.isArray(subNode)) {
        subNode.forEach((s: any) => res.push(..._find(s)))
        return res
      }
      if (!subNode.type) return res
      if (!(prune && prune(subNode))) {
        if (match(subNode)) res.push(subNode)
      }
      for (const prop in subNode) {
        res.push(..._find(subNode[prop]))
      }

      return res
    }
  }

  /**
   *
   * @param prop
   */
  getSubNode(prop: string): ASTQuery {
    const res = new ASTQuery()
    for (const node of this.nodes) {
      const subNode = node[prop]
      if (subNode) {
        res.add(subNode)
      }
    }
    return res
  }

  /**
   *
   * @param nodes
   */
  add(nodes: any): void {
    if (!nodes) return
    if (Array.isArray(nodes)) {
      for (const elem of nodes) {
        this.nodes.add(elem)
      }
      return
    }
    this.nodes.add(nodes)
  }

  /**
   *
   * @param query
   */
  union(query: ASTQuery): void {
    for (const elem of query.nodes) {
      this.nodes.add(elem)
    }
  }

  /**
   *
   * @param typeName
   */
  findAllByType(typeName: string): ASTQuery {
    return this.findAll((node: any) => node.type === typeName)
  }

  /**
   *
   */
  toString(): string {
    let res = ''
    let i = 0
    for (const node of this.nodes) {
      res += `${i++} : ${JSON.stringify(node, null, 2).replace(/\n/g, '    \n')}\n`
    }
    return res
  }
}

/**
 *
 * @param type
 */
function typeToQualifiedName(type: any): string | null {
  switch (type.type) {
    case 'ScopedType': {
      if (type.scope) {
        return typeToQualifiedName + type.id.name
      }
      break
    }
    case 'DynamicType': {
      return null
    }
  }
  return type.id?.name
}

/**
 *
 * @param qid
 */
function qualifiedNameToMemberAccess(qid: string): any {
  const ids = qid.split('.')
  let ret: any
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    if (!ret) {
      ret = UastSpec.identifier(id)
    } else {
      const prop = UastSpec.identifier(id)
      ret = UastSpec.memberAccess(ret, prop)
    }
  }
  return ret
}

// ***

module.exports = {
  prettyPrint,
  prettyPrintAST,
  annotateAST,
  addNodeHash,
  typeToQualifiedName,
  getAncestor,
  qualifiedNameToMemberAccess,

  visit,
  satisfy,
  hasTag,
  findTag,
  ASTQuery,
  deleteParent,
  arrayHasTag,
  defaultFilter,
}
