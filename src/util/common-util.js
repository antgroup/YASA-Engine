const { getRules } = require('../checker/common/rules-basic-handler')
const Rules = require('../checker/common/rules-basic-handler')
const varUtil = require('./variable-util')
const config = require('../config')

/**
 * merge two sets
 * @param s1
 * @param s2
 * @returns {*}
 */
function mergeSets(s1, s2) {
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
function mergeAToB(source, res) {
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
function getTaint(s) {
  return getTaintRec(s, 0, new Set())
}

/**
 *
 * @param s
 * @param stack
 * @param visited
 */
function getTaintRec(s, stack, visited) {
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
function getSatNodes(node, f, res, filter, visited) {
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
function isPublicVisibility(fvisibility) {
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
function deepEqual(x, y) {
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
function shallowEqual(objA, objB) {
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
function getSymbolRef(argval) {
  // TODO 维护uuid，本质是生成符号值的签名
  const ref = {}
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
  return JSON.stringify(ref).replaceAll('.', '-')
}

/**
 *
 * @param scope
 * @param f
 */
function getDataFromScopeWithFilter(scope, f) {
  if (!scope?.field) return scope
  if (!f) return scope.getRawValue()
  return Object.values(scope.getRawValue()).filter((symVal) => f(symVal))
}

/**
 *
 * @param scope
 */
function getDataFromScope(scope) {
  return getDataFromScopeWithFilter(scope, filterDataFromScope)
}

/**
 *
 * @param symVal
 */
function filterDataFromScope(symVal) {
  return !(symVal?.vtype === 'fclos' && symVal?.execute) && symVal?.sid !== 'prototype'
}

/**
 *
 * @param valExport
 * @param func
 */
function getFclosFromScope(valExport, func) {
  let valFunc
  const fdef = valExport?.fdef || valExport?.ast
  if (fdef && fdef?.type === 'FunctionDefinition') {
    if (fdef.id?.name === func) {
      valFunc = valExport
    } else return null
  } else {
    // !!这里不能从topScope的modules里取，信息会缺失，直接从topScope的field里依据目录结构去取。
    // const valExport = this.topScope.modules.field[path.join(dir,filepath)];
    valFunc = valExport?.field[func]
    if (!valFunc) {
      if (valExport?.field?.default) {
        valFunc = getFclosFromScope(valExport.field.default, func)
      } else if (!func.includes('.')) {
        for (const i in valExport.field) {
          if (valExport.field[i] && valExport.field[i].vtype === 'class') {
            valFunc = getFclosFromScope(valExport.field[i], func)
            if (valFunc) {
              break
            }
          }
        }
      } else {
        const arr = func.split('.')
        let fieldT = valExport
        arr.forEach((path) => {
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
 *
 * @param fclos
 * @param sourceScope
 */
function fillSourceScope(fclos, sourceScope) {
  if (sourceScope.complete) return
  const scopeValue = sourceScope.value
  let notComplete = false
  for (const item of scopeValue) {
    if (item.locStart === undefined && item.locEnd === undefined) {
      notComplete = true
      break
    }
  }
  if (!notComplete) {
    sourceScope.complete = true
    return
  }
  const scpFunc = fclos.ast?.id?.name
  const scpPath = fclos.ast?.loc?.sourcefile
  const locStart =
    fclos.ast?.parameters?.length > 0 ? fclos.ast.parameters[0].loc?.start?.line : fclos.ast?.loc?.start?.line
  const locEnd =
    fclos.ast?.parameters?.length > 0
      ? fclos.ast.parameters[fclos.ast.parameters.length - 1].loc?.end?.line
      : fclos.ast?.loc?.end?.line
  if (scpPath === undefined || locStart === undefined || locEnd === undefined) {
    return
  }
  let relativePath
  try {
    relativePath = scpPath.substring(scpPath.indexOf(config.maindirPrefix) + config.maindirPrefix.length)
  } catch (e) {
    return
  }
  relativePath = relativePath.substring(relativePath.indexOf('/'))
  for (const item of scopeValue) {
    if (item.scopeFile === relativePath && item.scopeFunc === scpFunc) {
      if (item.locStart !== undefined && item.locEnd !== undefined) {
        return
      }
      item.locStart = locStart
      item.locEnd = locEnd
    } else if (item.scopeFile === relativePath && item.scopeFunc === 'all') {
      if (item.locStart !== undefined && item.locEnd !== undefined) {
        return
      }
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
function initSourceScope(sourceScope, checkerTaintSources) {
  let hasScopedSource = false
  const sourceScopeVal = sourceScope.value

  if (Array.isArray(checkerTaintSources) && checkerTaintSources.length > 0) {
    for (const rule of checkerTaintSources) {
      let obj = {}
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
function initSourceScopeByTaintSourceWithLoc(sourceScope, checkerTaintSources) {
  sourceScope.complete = true
  const sourceScopeVal = sourceScope.value
  if (Array.isArray(checkerTaintSources) && checkerTaintSources.length > 0) {
    for (const rule of checkerTaintSources) {
      let obj = {}
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
function getValueFromTree(tree, path) {
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

module.exports = {
  mergeSets,
  mergeAToB,
  getTaint,
  getSatNodes: (node, f, res, filter) => {
    return getSatNodes(node, f, res, filter, new Set())
  },
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
