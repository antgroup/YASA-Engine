const varUtil = require('./variable-util')
const config = require('../config')

/**
 * merge two sets
 * @param s1
 * @param s2
 * @returns {*}
 */
function mergeSets(s1: any, s2: any): Set<any> {
  s1 = s1 instanceof Set ? s1 : new Set(s1)
  s2 = s2 instanceof Set ? s2 : new Set(s2)
  if (!s1 || s1.size === 0) return s2
  if (!s2 || s2.size === 0) return s1
  const res = s1
  for (const x of s2) res.add(x)
  return res
}
/**
 *
 * @param source
 * @param res
 */
function mergeAToB(source: any, res: any): void {
  for (const key of Object.keys(source)) {
    const valA = source[key]
    const valB = res[key]
    if (Array.isArray(valA) && Array.isArray(valB)) {
      res[key] = valB.concat(valA)
    } else if (Array.isArray(valA) && valB) {
      res[key] = [valB].concat(valA)
    } else if (Array.isArray(valB) && valA) {
      res[key] = valB.concat([valA])
    } else if (valB && valA && typeof valB === typeof valA && typeof valB === 'object') {
      mergeAToB(valA, res[key])
    } else if (valA) {
      res[key] = valA
    }
  }
}
/**
 * getTaint of symboal value
 * @returns {*}
 * @param s
 */
function getTaint(s: any): Set<any> {
  return getTaintRec(s, 0, new Set())
}

/**
 *
 * @param s
 * @param stack
 * @param visited
 */
function getTaintRec(s: any, stack: number, visited: Set<any>): Set<any> {
  // s1的taint不为空 则返回不为空的taint
  let res = new Set()
  // s为空或者没有污点标志，或者污点标志为false
  // 超过递归深度
  if (s == null || !s?.hasTagRec || stack > 5) return res
  // 如果s本身污点不为空 返回s自身的污点
  visited.add(s)
  if (s && varUtil.isNotEmpty(s._tags)) {
    const res = s._tags instanceof Set ? s._tags : new Set(s._tags)
    if (res.size > 0) return res
  }
  // 遍历s的field中的符号值，若s的field不存在直接返回
  const fields = s && s?.field
  if (!fields) return res
  for (const key in fields) {
    // 防止循环引用重复遍历
    if (visited.has(fields[key])) continue
    res = getTaintRec(fields[key], stack + 1, visited)
    if (res?.size > 0) return res
  }
  return res
}

/**
 * Return the set of sub-nodes satisfying f
 * @param node
 * @param f
 * @param res
 * @param filter
 * @param visited
 * @returns {*}
 */
function getSatNodes(node: any, f: any, res: any, filter: any, visited: Set<any>): void {
  if (!node) return

  if (visited.has(node)) return
  visited.add(node)

  if (Array.isArray(node)) {
    for (const child of node) {
      getSatNodes(child, f, res, filter, visited)
    }
    return
  }
  if (!node.type && !node.vtype) return

  if (f(node)) res.add(node)

  for (const prop in node) {
    if (!node.hasOwnProperty(prop)) continue
    switch (prop) {
      case 'parent':
      case 'rrefs':
      case 'trace':
      case 'updates':
      case 'type':
      case 'ast':
      case 'loc':
        continue
    }

    if (!filter || filter(node, prop)) {
      const v = node[prop]
      getSatNodes(v, f, res, filter, visited)
    }
  }
}

/**
 * whether a function is public/external
 * @param fvisibility
 * @returns {boolean}
 */
function isPublicVisibility(fvisibility: string | undefined): boolean {
  if (!fvisibility) return true
  switch (fvisibility) {
    case 'default':
    case 'public':
      return true
  }
  return false
}

/**
 *
 * @param x
 * @param y
 */
function deepEqual(x: any, y: any): boolean {
  if (x === y) {
    return true
  }
  if (!(typeof x === 'object' && x != null) || !(typeof y === 'object' && y != null)) {
    return false
  }
  // 比较对象内部
  if (Object.keys(x).length != Object.keys(y).length) {
    return false
  }
  for (const prop in x) {
    if (y.hasOwnProperty(prop)) {
      if (!deepEqual(x[prop], y[prop])) {
        return false
      }
    } else {
      return false
    }
  }
  return true
}

/**
 *
 * @param objA
 * @param objB
 */
function shallowEqual(objA: any, objB: any): boolean {
  if (objA === objB) {
    return true
  }
  if (!(typeof objA === 'object' && objA != null) || !(typeof objB === 'object' && objB != null)) {
    return false
  }
  const keysA = Object.keys(objA)
  const keysB = Object.keys(objB)
  if (keysA.length !== keysB.length) {
    return false
  }
  for (let i = 0; i < keysA.length; i++) {
    if (objB.hasOwnProperty(keysA[i])) {
      if (objA[keysA[i]] !== objB[keysA[i]]) {
        return false
      }
    } else {
      return false
    }
  }
  return true
}

/**
 *
 * @param argval
 * @returns {string}
 */
function getSymbolRef(argval: any): string {
  // TODO 维护uuid，本质是生成符号值的签名
  const ref: Record<string, any> = {}
  ref.id = argval.id
  ref.sid = argval.sid
  ref.qid = argval.qid
  ref.vtype = argval.vtype
  ref.type = argval.type
  // raw_value 只能是原始值本身，不能是对象，union符号值中的raw_value竟然存储了对象，不可思议。。。
  if (argval?.raw_value != null && typeof argval.raw_value !== 'object') {
    ref.raw_value = argval.raw_value
  }
  // setFieldValue中会对.做切分
  // qid中携带.的信息因此要替换掉
  return JSON.stringify(ref).replace(/\./g, '-')
}

/**
 *
 * @param scope
 * @param f
 */
function getDataFromScopeWithFilter(scope: any, f: any): any {
  if (!scope?.field) return scope
  if (!f) return scope.getRawValue()
  return Object.values(scope.getRawValue()).filter((symVal: any) => f(symVal))
}

/**
 *
 * @param scope
 */
function getDataFromScope(scope: any): any {
  return getDataFromScopeWithFilter(scope, filterDataFromScope)
}

/**
 *
 * @param symVal
 */
function filterDataFromScope(symVal: any): boolean {
  return !(symVal?.vtype === 'fclos' && symVal?.execute) && symVal?.sid !== 'prototype'
}

/**
 * 获取匿名函数的唯一标识符
 * 
 * 该函数根据函数定义的位置信息生成匿名函数的唯一标识符，
 * 格式为：<anonymous_起始行号_结束行号>
 * 
 * 注意：目前仅使用行号生成标识符，可能存在冲突风险（理想情况下应包含列号）
 * 
 * @param {Object} fclos - 函数闭包对象
 * @returns {string|undefined} 生成的匿名函数标识符，如果缺少位置信息则返回 undefined
 */
function getAnonymousFunctionName(fclos: any) {
  // 检查函数闭包是否有位置信息
  if (fclos?.ast?.loc === undefined)
    return undefined

  // 使用函数定义的起始行和结束行生成唯一标识符
  // 格式: <anonymous_startLine_endLine>
  return '<anonymous_' + fclos.ast.loc.start.line + '_' + fclos.ast.loc.end.line + '>'
}

/**
 * 在作用域中查找函数闭包对象
 * 
 * 该函数在给定的作用域对象中递归查找指定名称的函数闭包(fclos)，
 * 支持查找具名函数、匿名函数以及嵌套在类和对象中的函数。
 * 
 * @param {Object} valExport - 作用域对象
 * @param {string} func - 要查找的函数名称
 * @returns {Object|null} 找到的函数闭包对象，未找到返回 null
 */
function getFclosFromScope(valExport: any, func: any): any {
  let valFunc
  const fdef = valExport?.fdef || valExport?.ast
  if (fdef && fdef?.type === 'FunctionDefinition') {
    // 具名函数匹配
    if (fdef.id?.name === func) {
      valFunc = valExport
    }
    // 匿名函数匹配
    else if (func.startsWith('<anonymous')) {
      // 生成当前函数的匿名标识符
      const anonymousID = getAnonymousFunctionName(fdef)
      // 标识符匹配则返回
      if (anonymousID == func)
        valFunc = valExport
    } else {
      return null
    }
  } else {
    // 从作用域的字段中直接查找
    valFunc = valExport?.field[func]

    // 如果直接查找失败
    if (!valFunc) {
      // 尝试在默认导出中查找
      if (valExport?.field?.default) {
        valFunc = getFclosFromScope(valExport.field.default, func)
      } else if (!func.includes('.')) {
        // 遍历作用域字段，查找类中的方法
        for (const i in valExport.field) {
          if (valExport.field[i] && valExport.field[i].vtype === 'class') {
            valFunc = getFclosFromScope(valExport.field[i], func)
            if (valFunc) {
              break
            }
          }
        }
      } else {
        // 处理点分名称（如 "module.submodule.function"）
        const arr = func.split('.')
        let fieldT = valExport
        // 沿着路径逐级查找
        arr.forEach((path: any) => {
          fieldT = fieldT?.field[path]
        })
        if (fieldT) {
          valFunc = fieldT
        }
      }
    }
  }
  return valFunc
}

/**
 * 填充污点源作用域的位置信息
 * 
 * 该函数用于完善污点源规则中的位置信息(locStart, locEnd)，
 * 当分析到函数定义时，使用函数的实际位置信息填充匹配的规则。
 * 
 * @param {Object} fclos - 函数闭包对象
 * @param {Object} sourceScope - 污点源作用域配置对象
 */
function fillSourceScope(fclos: any, sourceScope: any): void {
  if (sourceScope.complete) return

  const scopeValue = sourceScope.value
  let notComplete = false

  // 检查是否有未完成位置信息的规则
  for (const item of scopeValue) {
    if (item.locStart === undefined && item.locEnd === undefined) {
      notComplete = true
      break
    }
  }

  // 如果所有规则位置信息都已完善，标记为完成
  if (!notComplete) {
    sourceScope.complete = true
    return
  }

  // 确定函数名（处理匿名函数）
  let scpFunc
  if (fclos.ast?.name === '<anonymous>') {
    scpFunc = getAnonymousFunctionName(fclos)
  } else {
    scpFunc = fclos.ast?.id?.name
  }

  // 获取函数定义位置信息
  const scpPath = fclos.ast?.loc?.sourcefile
  // 计算起始行（优先使用参数位置）
  const locStart = fclos.ast?.parameters?.length > 0
    ? fclos.ast.parameters[0].loc?.start?.line
    : fclos.ast?.loc?.start?.line
  // 计算结束行（优先使用参数位置）
  const locEnd = fclos.ast?.parameters?.length > 0
    ? fclos.ast.parameters[fclos.ast.parameters.length - 1].loc?.end?.line
    : fclos.ast?.loc?.end?.line

  // 关键位置信息缺失则返回
  if (scpPath === undefined || locStart === undefined || locEnd === undefined) {
    return
  }

  let relativePath
  try {
    // 转换为相对路径
    relativePath = scpPath.substring(scpPath.indexOf(config.maindirPrefix) + config.maindirPrefix.length)
  } catch (e) {
    return
  }

  // 填充匹配规则的位置信息
  relativePath = relativePath.substring(relativePath.indexOf('/'))
  for (const item of scopeValue) {
    // 规则1：匹配具体函数
    if (item.scopeFile === relativePath && item.scopeFunc === scpFunc) {
      // 仅填充未完善的规则
      if (item.locStart !== undefined && item.locEnd !== undefined) {
        return
      }
      item.locStart = locStart
      item.locEnd = locEnd
    }
    // 规则2：匹配整个文件
    else if (item.scopeFile === relativePath && item.scopeFunc === 'all') {
      // 仅填充未完善的规则
      if (item.locStart !== undefined && item.locEnd !== undefined) {
        return
      }
      // 标记为整个文件范围
      item.locStart = 'all'
      item.locEnd = 'all'
    }
  }
}

/**
 *
 * @param sourceScope
 * @param checkerTaintSources
 */
function initSourceScope(sourceScope: any, checkerTaintSources: any): void {
  let hasScopedSource = false
  const sourceScopeVal = sourceScope.value

  if (Array.isArray(checkerTaintSources) && checkerTaintSources.length > 0) {
    for (const rule of checkerTaintSources) {
      let obj: Record<string, any> = {}
      if (rule.scopeFile === 'all' && rule.scopeFunc === 'all') {
        obj = {
          path: rule.path,
          kind: rule.kind,
          scopeFile: rule.scopeFile,
          scopeFunc: rule.scopeFunc,
          attribute: rule.attribute,
          locStart: 'all',
          locEnd: 'all',
        }
      } else {
        hasScopedSource = true
        obj = {
          path: rule.path,
          kind: rule.kind,
          scopeFile: rule.scopeFile,
          scopeFunc: rule.scopeFunc,
          attribute: rule.attribute,
          locStart: undefined,
          locEnd: undefined,
        }
      }
      sourceScopeVal.push(obj)
    }
  }
  sourceScope.complete = !hasScopedSource
}

/**
 *
 * @param sourceScope
 * @param checkerTaintSources
 */
function initSourceScopeByTaintSourceWithLoc(sourceScope: any, checkerTaintSources: any): void {
  sourceScope.complete = true
  const sourceScopeVal = sourceScope.value
  if (Array.isArray(checkerTaintSources) && checkerTaintSources.length > 0) {
    for (const rule of checkerTaintSources) {
      let obj: Record<string, any> = {}
      if (rule.scopeFile === 'all' && rule.scopeFunc === 'all') {
        obj = {
          path: rule.path,
          kind: rule.kind,
          scopeFile: rule.scopeFile,
          scopeFunc: rule.scopeFunc,
          attribute: rule.attribute,
          locStart: 'all',
          locEnd: 'all',
          locColumnStart: 'all',
          locColumnEnd: 'all',
        }
      } else {
        obj = {
          path: rule.path,
          kind: rule.kind,
          scopeFile: rule.scopeFile,
          scopeFunc: rule.scopeFunc,
          attribute: rule.attribute,
          locStart: rule.locStart,
          locEnd: rule.locEnd,
          locColumnStart: rule.locColumnStart,
          locColumnEnd: rule.locColumnEnd,
        }
      }
      sourceScopeVal.push(obj)
    }
  }
}

/**
 * find val in tree
 * @param tree
 * @param path
 */
function getValueFromTree(tree: any, path: string): any | undefined {
  let current = tree

  for (const key of path.split('.')) {
    if (current && typeof current === 'object' && key in current.value) {
      current = current.value[key] // 进入下一层
    } else {
      return undefined // 如果路径中断，返回 undefined
    }
  }

  return current // 返回最终找到的值
}

/**
 *
 * @param node
 * @param f
 * @param res
 * @param filter
 */
function getSatNodesWrapper(node: any, f: any, res: any, filter: any): void {
  return getSatNodes(node, f, res, filter, new Set())
}

export {
  mergeSets,
  mergeAToB,
  getTaint,
  getSatNodesWrapper as getSatNodes,
  isPublicVisibility,
  deepEqual,
  getValueFromTree,
  fillSourceScope,
  initSourceScope,
  shallowEqual,
  getFclosFromScope,
  getSymbolRef,
  getDataFromScope,
  filterDataFromScope,
  initSourceScopeByTaintSourceWithLoc,
}
