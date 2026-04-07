let sourcefile: string | null
let skipSourcefile: boolean = false
const _ = require('lodash')
const UastSpec = require('@ant-yasa/uast-spec')
const config = require('../config')
const varUtil = require('./variable-util')
const BasicRuleHandler = require('../checker/common/rules-basic-handler')
const { md5 } = require('./hash-util')
const { setGlobalASTManager, getGlobalASTManager, setGlobalSymbolTable, getGlobalSymbolTable } = require('./global-registry')
const Unit: typeof import('../engine/analyzer/common/value/unit') = require('../engine/analyzer/common/value/unit')

let getCodeByLocation: ((loc: any) => string) | null = null

/**
 * 获取 getCodeByLocation 函数
 * @returns {Function} getCodeByLocation 函数
 */
function getGetCodeByLocation(): (loc: any) => string {
  if (!getCodeByLocation) {
    const sourceLine = require('../engine/analyzer/common/source-line')
    getCodeByLocation = sourceLine.getCodeByLocation
  }
  if (!getCodeByLocation) {
    throw new Error('getCodeByLocation is not initialized')
  }
  return getCodeByLocation
}

/**
 * 默认过滤器函数
 * @param nd 节点
 * @param prop 属性名
 * @param from 来源节点
 * @returns {boolean} 是否通过过滤
 */
// eslint-disable-next-line complexity
const defaultFilter = (nd: any, prop: string, from: any): boolean => {
  /**
   * 检查对象是否有 CallExpression、BinaryExpression 或 Tag
   * @param obj 对象
   * @returns {boolean} 是否有相关表达式或标签
   */
  function objHasCallExpressionOrBinaryExpressionOrTag(obj: any): boolean {
    if (!obj) {
      return false
    }
    if (
      (obj.type === 'CallExpression' ||
        obj.type === 'BinaryExpression' ||
        (obj instanceof Unit && obj.taint?.hasTags()) ||
        obj.vtype === 'object') &&
      obj instanceof Unit && obj.taint.isTainted
    ) {
      return true
    }
    if (obj.object) {
      return objHasCallExpressionOrBinaryExpressionOrTag(obj.object)
    }
    return false
  }

  // nd.taint 访问需要确认 nd 是 Unit 实例
  const ndTainted = nd instanceof Unit && nd.taint.isTainted
  const ndHasTags = nd instanceof Unit && nd.taint?.hasTags()
  return (
    !(nd.type === 'MemberAccess' && prop === 'object' && ndHasTags) &&
    !(
      nd.type === 'MemberAccess' &&
      prop === 'object' &&
      (!ndTainted || from.type !== 'CallExpression') &&
      (!ndTainted || from.type !== 'BinaryExpression') &&
      (!ndTainted ||
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
 * 遍历 AST 节点树，为每个节点添加 parent 指针和 sourcefile 信息
 * @param sourceunit 根 AST 节点
 */
function adjustASTNode(sourceunit: any): void {
  const visited = new Set()
  visited.add(sourceunit)
  const worklist = [sourceunit]
  // 使用索引访问元素，避免 shift() 的 O(n) 开销
  let index = 0

  while (index < worklist.length) {
    const node = worklist[index++]

    // 直接使用 for...in 遍历属性，避免 Object.keys() 创建数组的开销
    for (const prop in node) {
      // 跳过原型链上的属性
      if (!Object.prototype.hasOwnProperty.call(node, prop)) continue

      const subNode = node[prop]
      // 跳过 null、undefined、非对象类型
      if (!subNode || typeof subNode !== 'object') continue

      if (subNode.type) {
        const nodeType = subNode.type
        if (nodeType === 'FunctionDefinition') {
          subNode.name =
            subNode.id?.name ??
            `<anonymousFunc_${subNode?.loc?.start?.line}_${subNode?.loc?.start?.column}_${subNode?.loc?.end?.line}_${subNode?.loc?.end?.column}>`
        } else if (nodeType === 'ClassDefinition') {
          subNode.name =
            subNode.id?.name ??
            `<anonymousFunc_${subNode?.loc?.start?.line}_${subNode?.loc?.start?.column}_${subNode?.loc?.end?.line}_${subNode?.loc?.end?.column}>`
        }

        // 使用 visited Set 避免重复处理已访问的节点
        if (!visited.has(subNode)) {
          subNode.parent = node
          if (!subNode.loc) {
            subNode.loc = {}
          }
          // 只在需要时设置 sourcefile（不跳过且 sourcefile 不为 null）
          if (!skipSourcefile && sourcefile !== null) {
            subNode.loc.sourcefile = sourcefile
          }
          worklist.push(subNode)
          visited.add(subNode)
        }
      } else if (Array.isArray(subNode)) {
        const arrLen = subNode.length
        for (let i = 0; i < arrLen; i++) {
          const sn = subNode[i]
          if (sn?.type && !visited.has(sn)) {
            sn.parent = node
            if (!sn.loc) {
              sn.loc = {}
            }
            // 只在需要时设置 sourcefile（不跳过且 sourcefile 不为 null）
            if (!skipSourcefile && sourcefile !== null) {
              sn.loc.sourcefile = sourcefile
            }
            worklist.push(sn)
            visited.add(sn)
          }
        }
      }
    }
  }
}

interface AnnotateOptions {
  sourcefile?: string | null
  skipSourcefile?: boolean // 是否跳过设置 sourcefile（用于外部工具已设置的情况）
  [key: string]: any
}

/**
 * add annotations, e.g. source file info, to AST nodes
 * @param node
 * @param options
 */
function annotateAST(node: any, options?: AnnotateOptions): void {
  sourcefile = null
  skipSourcefile = false
  if (options) {
    if (options.sourcefile !== undefined) sourcefile = options.sourcefile
    if (options.skipSourcefile) skipSourcefile = true
  }
  adjustASTNode(node)
}

/**
 * 给uast分配hash
 * 递归遍历 AST 节点树，为每个有 type 的节点计算并分配 nodehash
 * @param obj 根 AST 节点
 * @param visited 已访问节点集合（内部使用，外部调用时无需传入）
 */
function addNodeHash(obj: any, visited?: WeakSet<any>): void {
  if (!obj) return

  if (!visited) {
    visited = new WeakSet()
  }

  addNodeHashInternal(obj, visited)
}

/**
 * 内部递归函数，用于计算节点 hash
 * @param obj AST 节点
 * @param visited 已访问节点集合
 */
// eslint-disable-next-line complexity
function addNodeHashInternal(obj: any, visited: WeakSet<any>): void {
  if (Array.isArray(obj)) {
    const arrLen = obj.length
    // 使用传统 for 循环，避免 forEach 的函数调用开销
    for (let i = 0; i < arrLen; i++) {
      const item = obj[i]
      if (item && !visited.has(item)) {
        addNodeHash(item, visited)
      }
    }
    return
  }

  if (typeof obj !== 'object') return

  // visited WeakSet 避免重复处理循环引用或共享节点
  if (visited.has(obj)) return
  visited.add(obj)

  if (obj.type) {
    const { loc } = obj
    let content = getRawCode(obj)

    // 非常重要的性能优化，尽量保留，对于特殊程序，如（content超过4000字符），可能快 10 倍
    const MAX_CONTENT_LENGTH = 128
    if (content?.length > MAX_CONTENT_LENGTH) {
      const firstTen = content.substring(0, 64)
      const lastTen = content.substring(content.length - 64)
      content = `${firstTen}...${lastTen}`
    }

    let relateFilePath = obj.loc?.sourcefile
    if (relateFilePath && config.maindirPrefix && relateFilePath.startsWith(config.maindirPrefix)) {
      relateFilePath = relateFilePath.substring(config.maindirPrefix.length)
    }

    if (!obj._meta) {
      obj._meta = {}
    }

    // 使用数组 join() 替代多次字符串拼接，减少中间对象创建
    const parentHash = obj.parent?._meta?.nodehash || ''
    const hashParts = [
      content,
      loc?.start?.line || '',
      loc?.start?.column || '',
      loc?.end?.line || '',
      loc?.end?.column || '',
      relateFilePath || '',
      obj.type,
      parentHash,
    ]

    const baseNodehash = md5(hashParts.join('_'))
    let nodehash = baseNodehash

    // 如果设置了全局 AST 管理器，检查 nodehash 是否已存在
    // 如果已存在，则通过添加后缀来生成新的 nodehash，确保不替换原有对象
    // TODO 符号值重构todo：现在的并行方式globalASTManager获取不到
    const astManager = getGlobalASTManager()
    if (astManager) {
      let suffix = 0
      while (astManager.has(nodehash)) {
        suffix++
        nodehash = `${baseNodehash}_${suffix}`
      }
      obj._meta.nodehash = nodehash
      astManager.register(obj)
    } else {
      // 如果没有全局 AST 管理器，直接使用计算出的 nodehash
      obj._meta.nodehash = nodehash
    }
  }

  // 使用 for...in 直接遍历，避免 Object.keys() 创建新数组
  for (const key in obj) {
    // 跳过 parent 和 _meta
    // 注意_meta中有decorators，还不能直接跳过
    // TODO Java需要统一到decorators
    if (
      key === 'parent' ||
      (key === '_meta' &&
        (!Array.isArray(obj._meta?.decorators) ||
          (Array.isArray(obj._meta?.decorators) && obj._meta?.decorators?.length === 0)) &&
        (!Array.isArray(obj._meta?.annotations) ||
          (Array.isArray(obj._meta?.annotations) && obj._meta?.annotations?.length === 0)))
    ) {
      continue
    } else if (key === '_meta' && Array.isArray(obj._meta?.annotations) && obj._meta?.annotations?.length > 0) {
      addNodeHashInternal(obj._meta?.annotations, visited)
    } else if (key === '_meta' && Array.isArray(obj._meta?.decorators) && obj._meta?.decorators?.length > 0) {
      addNodeHashInternal(obj._meta?.decorators, visited)
    } else {
      if (!Object.prototype.hasOwnProperty.call(obj, key)) continue

      const subObj = obj[key]
      if (!subObj || typeof subObj !== 'object') continue

      addNodeHashInternal(subObj, visited)
    }
  }
}

/**
 * 递归删除 AST 节点树中所有节点的 parent 指针
 * @param obj 根 AST 节点
 */
function deleteParent(obj: any) {
  if (typeof obj !== 'object' || obj === null) {
    return obj
  }

  if (Array.isArray(obj)) {
    obj.forEach((item) => deleteParent(item))
    return obj
  }

  if ('parent' in obj) {
    delete obj.parent
  }

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
  // 使用索引替代 shift() 操作，提高性能
  let worklistIndex = 0
  while (worklistIndex < worklist.length) {
    node = worklist[worklistIndex]
    const from = fromlist[worklistIndex]
    const depth = depthlist[worklistIndex]
    worklistIndex++
    if (!node || visited.has(node)) {
      continue
    }
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
          '_parentRef',
          'uuid',
          'rrefs',
          'trace',
          'updates',
          'type',
          'operator',
          'ast',
          'loc',
          '_owner',
          'uninit',
          'callnode',
          'names',
          '_this',
          '_thisRef',
          'cdef',
          'fdef',
          'packageScope',
          '_packageScopeRef',
          'fileScope',
          'exports',
          '__exportsUuid',
          '__fileScopeUuid',
          '_superRef',
          '_scopeCtx',
          'sid',
          'qid',
          '_declsNodehashMap',
          '_ast',
          'decls',
          '_isConstructing',
          'overloaded',
          '_sid',
          '_qid',
          'vtype',
          '_meta',
        ].indexOf(prop) !== -1
      ) {
        continue
      }
      if (prop.includes('__yasa')) {
        continue
      }
      if (filter && !filter(node, prop, from)) continue
      if (prop === '_field') {
        const sub_field = node[prop]
        for (const p in sub_field) {
          if (!Object.prototype.hasOwnProperty.call(sub_field, p)) continue
          let fieldValue = sub_field[p]

          // 如果属性值是以 symuuid_ 开头的字符串，从符号表中查找对应的符号值
          if (typeof fieldValue === 'string' && fieldValue.startsWith('symuuid_')) {
            const symbolTable = getGlobalSymbolTable()
            if (symbolTable) {
              // 优化：使用单次 get 替代 has + get，减少一次哈希查找
              const resolved = symbolTable.get(fieldValue)
              if (resolved) {
                fieldValue = resolved
              }
            }
          }
          worklist.push(fieldValue)
          fromlist.push(sub_field)
          depthlist.push((depth || 0) + 1)
          if (fieldValue && typeof fieldValue === 'object') {
            parentMap.set(fieldValue, node)
          }
        }
      } else {
        let v = node[prop]

        // 如果属性值是以 symuuid_ 开头的字符串，从符号表中查找对应的符号值
        if (typeof v === 'string' && v.startsWith('symuuid_')) {
          const symbolTable = getGlobalSymbolTable()
          if (symbolTable) {
            // 优化：使用单次 get 替代 has + get，减少一次哈希查找
            const resolved = symbolTable.get(v)
            if (resolved) {
              v = resolved
            }
          }
        }
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
  if (
    config.makeAllCG ||
    !BasicRuleHandler.getPreprocessReady() ||
    config.saveContextEnvironment ||
    config.miniSaveContextEnvironment
  )
    return false
  const checkRawProps = ['arguments', 'left', 'right', 'expression', 'object']
  const checkFieldsProps = ['_field', 'children', 'misc_']

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
      symVal instanceof Unit && symVal.taint.isTainted &&
      varUtil.isNotEmpty(symVal)
    ) {
      return true
    }
    if (!Array.isArray(symVal) && symVal instanceof Unit && symVal.taint.isTainted) {
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
        if (Array.isArray(symVal?.[fieldProp])) {
          for (const eleVal of symVal?.[fieldProp]) {
            const tagVal = hasTagRec(eleVal, targetAttribute, stack + 1, visited)
            if (tagVal) {
              return true
            }
          }
        } else {
          for (const key in symVal?.[fieldProp]) {
            const eleVal = symVal?.[fieldProp][key]
            if (
              typeof eleVal?.qid === 'string' &&
              (eleVal?.qid?.includes('Egg.Context<instance') || eleVal?.qid?.includes('Egg.Application.service'))
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
        if (Array.isArray(symVal?.[prop]) && symVal?.[prop]?.length > 0) {
          for (const eleVal of symVal?.[prop]) {
            const tagVal = hasTagRec(eleVal, targetAttribute, stack + 1, visited)
            if (tagVal) {
              return true
            }
          }
        } else if (symVal?.[prop] instanceof Unit && symVal[prop].taint.isTainted) {
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
    if (targetAttribute && targetAttribute !== '' && (arrayHasTag(symVal) || (symVal instanceof Unit && symVal.taint.isTainted))) {
      return true
    }
    return !Array.isArray(symVal) && symVal instanceof Unit && symVal.taint.isTainted
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
    return array instanceof Unit && array.taint.isTainted
  }
  if (Array.isArray(array)) {
    for (const i in array) {
      if (array[i] instanceof Unit && array[i].taint.isTainted) {
        hasTag = true
        break
      } else if (typeof array[i].raw_value !== 'undefined') {
        for (const r in array[i].raw_value) {
          if (array[i].raw_value[r] instanceof Unit && array[i].raw_value[r].taint.isTainted) {
            hasTag = true
            break
          }
        }
      }
    }
  } else if (typeof array.raw_value !== 'undefined') {
    for (const r in array.raw_value) {
      if (array.raw_value[r] instanceof Unit && array.raw_value[r].taint.isTainted) {
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
  if (
    config.makeAllCG ||
    !BasicRuleHandler.getPreprocessReady() ||
    config.saveContextEnvironment ||
    config.miniSaveContextEnvironment
  ) {
    return false
  }
  return satisfy(
    node,
    (nd: any) => {
      if (nd instanceof Unit && nd.taint?.containsTag(attribute)) {
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
  return prettyPrint(node.ast?.node || node.fdecl || node)
}

/**
 *
 * @param node
 */
function getRawCode(node: any): string {
  let content = ''
  if (!node) {
    return content
  }
  const { loc } = node
  if (loc && loc.sourcefile && loc.start && loc.end) {
    const getCode = getGetCodeByLocation()
    content = getCode(loc)
  }
  if (content === '') {
    content = prettyPrint(node)
  }
  return content
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
  setGlobalASTManager,
  getGlobalASTManager,
  setGlobalSymbolTable,
  getGlobalSymbolTable,
  typeToQualifiedName,
  getAncestor,
  qualifiedNameToMemberAccess,
  getRawCode,
  visit,
  satisfy,
  hasTag,
  findTag,
  ASTQuery,
  deleteParent,
  arrayHasTag,
  defaultFilter,
}
