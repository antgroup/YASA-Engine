export {}
const _ = require('lodash')
const Config = require('../../../config')
const { prettyPrint } = require('../../../util/ast-util')
const { buildNewCopiedWithTag } = require('../../../util/clone-util')
const QidUnifyUtil = require('../../../util/qid-unify-util')
const VariableUtil = require('../../../util/variable-util')

/** **************** source code line management *********************** */

// 全局 analyzer 引用，用于访问 sourceCodeCache
let globalAnalyzer: any = null

// 无 analyzer 场景（如 dumpAllAST）共享的模块级单例 cache
// 不能每次 new 一个新 Map，否则 storeCode 写入和 getCodeByLocation 读取用的是不同实例
const fallbackSourceCodeCache: Map<string, string[]> = new Map<string, string[]>()

/**
 * 设置全局 analyzer 实例
 * @param analyzer analyzer 实例
 */
function setGlobalAnalyzer(analyzer: any) {
  globalAnalyzer = analyzer
}

/**
 * 获取全局 analyzer 实例
 * @returns analyzer 实例
 */
function getGlobalAnalyzer() {
  return globalAnalyzer
}

/**
 * 获取 sourceCodeCache（统一使用 analyzer.sourceCodeCache）
 * @returns sourceCodeCache Map，存储文件的行数组
 */
function getSourceCodeCache(): Map<string, string[]> {
  if (globalAnalyzer && globalAnalyzer.sourceCodeCache instanceof Map) {
    return globalAnalyzer.sourceCodeCache
  }
  // 没有全局 analyzer 时（如 dumpAllAST），使用模块级单例 Map
  // 修复：之前每次 new Map 导致 storeCode 写入和后续读取用的是不同实例，
  // 使 addNodeHash 拿不到源码，走 prettyPrint fallback，与 analyzer 路径产生 hash 不一致
  if (!globalAnalyzer) {
    return fallbackSourceCodeCache
  }
  // 如果 sourceCodeCache 不是 Map，转换为 Map
  if (
    globalAnalyzer.sourceCodeCache &&
    typeof globalAnalyzer.sourceCodeCache === 'object' &&
    !Array.isArray(globalAnalyzer.sourceCodeCache)
  ) {
    const map = new Map<string, string[]>()
    for (const key in globalAnalyzer.sourceCodeCache) {
      if (Object.prototype.hasOwnProperty.call(globalAnalyzer.sourceCodeCache, key)) {
        const value = globalAnalyzer.sourceCodeCache[key]
        // 兼容处理：如果是字符串，转换为数组
        map.set(key, typeof value === 'string' ? value.split(/\n/) : value)
      }
    }
    globalAnalyzer.sourceCodeCache = map
    return map
  }
  return fallbackSourceCodeCache
}


/**
 *
 * @param val
 * @param node
 * @param sourcefile
 * @param tag
 * @param affectedNodeName
 */
function addSrcLineInfo(val: any, node: any, sourcefile: any, tag: any, affectedNodeName: any) {
  if (!val) return val
  let sig = '<NodeLocUnknown>'
  if (node.loc?.sourcefile && typeof node.loc?.sourcefile === 'string') {
    sig = `${node.loc?.sourcefile.substring((node.loc?.sourcefile.lastIndexOf('/') || 0) + 1, node.loc?.sourcefile.lastIndexOf('.'))}_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}`
  }
  if (Array.isArray(val)) {
    let arrayHasTag = false
    for (const eachVal of val) {
      if ((eachVal as any).taint?.isTaintedRec) {
        arrayHasTag = true
        break
      }
    }
    if (!arrayHasTag) {
      return val
    }
    // 添加copied主要是为了生成新的符号值，避免覆盖原有的表项，这个跟符号值树使用内存维护有区别
    const newVal = buildNewCopiedWithTag(globalAnalyzer, val, sig)
    // @ts-ignore
    newVal.value = val.value
    for (const eachVal of newVal) {
      const start_line = node.loc.start?.line
      const end_line = node.loc.end?.line
      const tline = start_line === end_line ? start_line : _.range(start_line, end_line + 1)
      const traceItem = { file: sourcefile, line: tline, node, tag, affectedNodeName }

      eachVal.taint.dedupLastTrace(sourcefile, node.loc.start?.line, tag)

      // Pass traceItem to processFieldAndArguments for delayed addition
      processFieldAndArguments(eachVal, eachVal, 0, [], node, traceItem)
    }
    return newVal
  }
  if (!val.taint?.isTaintedRec || !sourcefile) return val

  const start_line = node.loc.start?.line
  const end_line = node.loc.end?.line
  const tline = start_line === end_line ? start_line : _.range(start_line, end_line + 1)
  const traceItem = { file: sourcefile, line: tline, node, tag, affectedNodeName }

  if (val.taint.hasTraces()) {
    val.taint.dedupLastTrace(sourcefile, node.loc.start?.line, tag)

    let newVal
    if (Config.shareSourceLineSet) {
      newVal = val
    } else {
      newVal = buildNewCopiedWithTag(globalAnalyzer, val, sig)
      newVal.value = val.value
    }
    // CRITICAL: If traceItem exists and val has tags, add it to val FIRST
    // This handles the case where val itself has tags (first call where val === res)
    if (traceItem && newVal.taint?.hasTags()) {
      newVal.taint.addTraceToAllTags(traceItem)
    }
    // Pass traceItem to processFieldAndArguments for delayed addition
    processFieldAndArguments(newVal, newVal, 0, [], node, traceItem)
    return newVal
  }
  const newVal = buildNewCopiedWithTag(globalAnalyzer, val, sig)
  newVal.value = val.value

  // Pass traceItem to processFieldAndArguments for delayed addition
  processFieldAndArguments(newVal, newVal, 0, [], node, traceItem)
  return newVal
}

/**
 *
 * @param val
 * @param res
 * @param stack
 * @param visited
 * @param node
 * @param traceItem - The trace item to be added during recursion
 */
function processFieldAndArguments(val: any, res: any, stack: any, visited: any[], node: any, traceItem?: any) {
  if (visited.includes(val)) {
    return
  }
  const sig = `${node.loc?.sourcefile.substring((node.loc?.sourcefile.lastIndexOf('/') || 0) + 1, node.loc?.sourcefile.lastIndexOf('.'))}_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}`

  for (const a of visited) {
    if (
      a.vtype !== 'union' &&
      a.vtype !== 'BVT' &&
      a.vtype === val.vtype &&
      a.sid === val.sid &&
      a.logicalQid === val.logicalQid &&
      a.ast?.node === val.ast?.node &&
      a.type === val.type &&
      a.taint?.isTaintedRec === val.taint?.isTaintedRec
    ) {
      return
    }
  }
  visited.push(val)
  if (stack >= 20) {
    return
  }

  // Check if val needs processing
  if (!val.taint?.isTaintedRec) {
    return
  }

  // Check if there's anything to propagate: res has traces OR traceItem exists
  // Don't return early just because res has no traces - traceItem might need to propagate to children
  if (!res.taint.hasTraces() && !traceItem) {
    return
  }
  if (val.taint?.isTaintedRec && val.vtype === 'BVT') {
    const childKeys = Object.keys(val.value)
    for (const key of childKeys) {
      const arg = val.getChild(key)
      if (arg == null) continue
      if (arg.taint?.isTaintedRec) {
        let hasChange = false
        if (arg.taint?.hasTags()) {
          const argCopy = buildNewCopiedWithTag(globalAnalyzer, arg, sig)
          argCopy.taint.propagateTraceFrom(res.taint, traceItem)
          val.setChild(key, argCopy)
          hasChange = true
        }
        if (hasChange) {
          processFieldAndArguments(val.getChild(key), res, stack + 1, visited, node, traceItem)
        } else {
          processFieldAndArguments(arg, res, stack + 1, visited, node, traceItem)
        }
      }
    }
  } else if (
    typeof val?._field !== 'undefined' &&
    (Array.isArray(val?._field) || Object.getOwnPropertyNames(val?._field).length !== 0) &&
    val.taint?.isTaintedRec
  ) {
    if (Array.isArray(val._field)) {
      for (const argI in val._field) {
        const arg = val.getFieldValue(argI)
        if (arg?.taint?.isTaintedRec) {
          let hasChange = false
          if (arg.taint?.hasTags()) {
            const argCopy = buildNewCopiedWithTag(globalAnalyzer, arg, sig)
            argCopy.taint.propagateTraceFrom(res.taint, traceItem)
            val.setFieldValue(argI, argCopy)
            hasChange = true
          }
          if (hasChange) {
            processFieldAndArguments(val.getFieldValue(argI), res, stack + 1, visited, node, traceItem)
          } else {
            processFieldAndArguments(arg, res, stack + 1, visited, node, traceItem)
          }
        }
      }
    } else if (val.members) {
      for (const key of val.members.keys()) {
        const arg = val.members.get(key)
        if (typeof arg === 'undefined' || arg === null || !arg.taint) {
          continue
        }
        if (arg.taint?.isTaintedRec) {
          let hasChange = false
          if (arg.taint?.hasTags()) {
            const argCopy = buildNewCopiedWithTag(globalAnalyzer, arg, sig)
            argCopy.taint.propagateTraceFrom(res.taint, traceItem)
            val.members.set(key, argCopy)
            hasChange = true
          }
          if (hasChange) {
            processFieldAndArguments(val.members.get(key), res, stack + 1, visited, node, traceItem)
          } else {
            processFieldAndArguments(arg, res, stack + 1, visited, node, traceItem)
          }
        }
      }
    }
  }
  if (val?.taint?.isTaintedRec && Array.isArray(val?.arguments)) {
    const argsSnapshot = val.arguments
    for (let argIdx = 0; argIdx < argsSnapshot.length; argIdx++) {
      const arg = argsSnapshot[argIdx]
      if (typeof arg === 'undefined' || arg === null) {
        continue
      }
      try {
        if (arg.taint?.isTaintedRec) {
          let hasChange = false
          if (arg.taint?.hasTags()) {
            const argCopy = buildNewCopiedWithTag(globalAnalyzer, arg, sig)
            argCopy.taint.propagateTraceFrom(res.taint, traceItem)
            const currentArgs = val.arguments
            currentArgs[argIdx] = argCopy
            val.arguments = currentArgs
            hasChange = true
          }
          if (hasChange) {
            processFieldAndArguments(val.arguments[argIdx], res, stack + 1, visited, node, traceItem)
          } else {
            processFieldAndArguments(arg, res, stack + 1, visited, node, traceItem)
          }
        }
      } catch (e) {}
    }
  }
  if (val?.left?.taint?.isTaintedRec) {
    if (val.left.taint?.hasTags()) {
      const leftCopy = buildNewCopiedWithTag(globalAnalyzer, val.left, sig)
      leftCopy.taint.propagateTraceFrom(res.taint, traceItem)
      val.left = leftCopy
    }
    processFieldAndArguments(val.left, res, stack + 1, visited, node, traceItem)
  }
  if (val?.right?.taint?.isTaintedRec) {
    if (val.right.taint?.hasTags()) {
      const rightCopy = buildNewCopiedWithTag(globalAnalyzer, val.right, sig)
      rightCopy.taint.propagateTraceFrom(res.taint, traceItem)
      val.right = rightCopy
    }
    processFieldAndArguments(val.right, res, stack + 1, visited, node, traceItem)
  }
  if (val?.expression?.taint?.isTaintedRec) {
    if (val.expression.taint?.hasTags()) {
      const expressionCopy = buildNewCopiedWithTag(globalAnalyzer, val.expression, sig)
      expressionCopy.taint.propagateTraceFrom(res.taint, traceItem)
      val.expression = expressionCopy
    }
    processFieldAndArguments(val.expression, res, stack + 1, visited, node, traceItem)
  }
  if (val?.children && val.vtype !== 'BVT') {
    for (const key in val.children) {
      if (Object.prototype.hasOwnProperty.call(val.children, key)) {
        const children = val.children[key]
        if (typeof children === 'undefined') {
          continue
        }
        if (children.taint?.isTaintedRec) {
          let hasChange = false
          if (children.taint?.hasTags()) {
            const childrenCopy = buildNewCopiedWithTag(globalAnalyzer, children, sig)
            childrenCopy.taint.propagateTraceFrom(res.taint, traceItem)
            val.children[key] = childrenCopy
            hasChange = true
          }
          if (hasChange) {
            processFieldAndArguments(val.children[key], res, stack + 1, visited, node, traceItem)
          } else {
            processFieldAndArguments(children, res, stack + 1, visited, node, traceItem)
          }
        }
      }
    }
  }

  if (val.vtype === 'symbol') {
    const processMemberAccess = (target: any) => {
      const targetRef = target === 'object' ? val.object : val.property

      if (targetRef.object && targetRef?.object?.sid && targetRef?.object?.sid?.includes('__tmp')) {
        return
      }

      if (targetRef.taint?.hasTags()) {
        const targetCopy = buildNewCopiedWithTag(globalAnalyzer, targetRef, sig)
        targetCopy.taint.propagateTraceFrom(res.taint, traceItem)
        if (target === 'object') {
          val.object = targetCopy
        } else {
          val.property = targetCopy
        }
      }

      const nextTarget = target === 'object' ? val.object : val.property
      processFieldAndArguments(nextTarget, res, stack + 1, visited, node, traceItem)
    }

    if (val.object?.taint && val.object.taint?.isTaintedRec) {
      processMemberAccess('object')
    }

    if (val.property?.taint && val.property.taint?.isTaintedRec) {
      processMemberAccess('property')
    }
  }
  if (val?.misc_?.buffer && Array.isArray(val.misc_.buffer)) {
    for (const bufferI in val.misc_.buffer) {
      const buffer = val.misc_.buffer[bufferI]
      if (buffer.taint?.isTaintedRec) {
        let hasChange = false
        if (buffer.taint?.hasTags()) {
          const buffer_copy = buildNewCopiedWithTag(globalAnalyzer, buffer, sig)
          buffer_copy.taint.propagateTraceFrom(res.taint, traceItem)
          val.misc_.buffer[bufferI] = buffer_copy
          hasChange = true
        }
        if (hasChange) {
          processFieldAndArguments(val.misc_.buffer[bufferI], res, stack + 1, visited, node, traceItem)
        } else {
          processFieldAndArguments(buffer, res, stack + 1, visited, node, traceItem)
        }
      }
    }
  }
}

/**
 *
 * @param fdef
 * @param node
 */
function getNodeTrace(fdef: any, node: any) {
  if (!node) return
  const { loc } = node
  if (!loc) return {}

  let src_node = node
  let sourcefile = fdef?.loc?.sourcefile
  while (src_node && !src_node?.loc?.sourcefile) {
    src_node = src_node.parent
  }
  if (src_node) {
    sourcefile = src_node?.loc?.sourcefile
  }

  const line = loc.start?.line === loc.end?.line ? loc.start?.line : _.range(loc.start?.line, loc.end?.line + 1)
  if (sourcefile === undefined) {
    sourcefile = node?.loc?.sourcefile
  }
  return { file: sourcefile, node, line }
}

/**
 *
 * @param sourcefile
 * @param code
 */
function storeCode(sourcefile: string, code: string) {
  const codeCache = getSourceCodeCache()
  const fname = sourcefile ? sourcefile.toString() : `_f_${codeCache.size}`
  const lines = (code as string).split(/\n/)
  codeCache.set(fname, lines)
  // 同时更新 analyzer.sourceCodeCache（如果存在）
  if (globalAnalyzer) {
    globalAnalyzer.sourceCodeCache = codeCache
  }
  return fname
}

/**
 *
 * @param item
 */
function formatSingleTrace(item: any) {
  let res = ''
  let prev_file: any
  let prev_line: any
  if (item.str) {
    const lno = item.line
    if (lno) {
      const pat = lno < 10 ? '   ' : lno < 100 ? '  ' : ' '
      res += `  ${lno}:${pat}`
    }
    res += `${item.str}\n`
    prev_line = -1
    return res
  }

  let fname = item.file
  if (!fname) {
    let fnode = item.node
    while (fnode) {
      if (fnode.loc.sourcefile) {
        fname = fnode.loc.sourcefile
        break
      }
      fnode = fnode.parent
    }
  }
  if (fname && fname !== prev_file) {
    if (!fname.startsWith('_f_')) {
      res += ` ${item.shortfile || fname}\n`
    }
  }
  const affectName = item.affectedNodeName
  if (affectName !== undefined) {
    res += `  ` + `AffectedNodeName: ${affectName}\n`
  }
  let code
  if (fname) {
    const codeCache = getSourceCodeCache()
    const flines = codeCache.get(fname)
    const lines = Array.isArray(item.line) ? item.line : [item.line]
    for (let i = 0; i < lines.length; i++) {
      const lno = lines[i]
      if (lno === prev_line && !(i == 0 && prev_file !== fname)) continue
      prev_line = lno
      code = flines?.[lno - 1]
      if (item.tag) code = `${item.tag} ${code}`
      const pat = lno < 10 ? '   ' : lno < 100 ? '  ' : ' '
      res += `  ${lno}:${pat}${code}\n`
    }
  } else {
    const lno = item.line
    if (lno === prev_line) return res
    prev_line = lno
    code = prettyPrint(item.node)
    const pat = lno < 10 ? '   ' : lno < 100 ? '  ' : ' '
    if (item.tag) code = `${item.tag} ${code}`
    res += `  ${lno}:${pat}${code}\n`
  }
  prev_file = fname
  return res
}

/**
 *
 * @param trace
 */
function formatTraces(trace: any) {
  let res = ''
  for (const item of trace) {
    res += formatSingleTrace(item)
  }
  res = res.substring(0, res.length - 1)
  return res
}

/**
 *
 * @param loc
 */
function getCodeByLocation(loc: any) {
  const sourcefile = loc?.sourcefile
  const startLine = loc?.start?.line
  const endLine = loc?.end?.line

  if (sourcefile && startLine && endLine) {
    const codeCache = getSourceCodeCache()
    const lines = codeCache.get(sourcefile)
    if (lines) {
      const startIdx = startLine - 1
      const endIdx = endLine - 1
      const targetLines = lines.slice(startIdx, endIdx + 1)
      if (targetLines.length === 0) return ''
      return targetLines.join('\n')
    }
  }
  return ''
}

/**
 *
 * @param sourcefile
 */
function getCodeBySourceFile(sourcefile: string) {
  const codeCache = getSourceCodeCache()
  if (sourcefile && codeCache.has(sourcefile)) {
    const lines = codeCache.get(sourcefile)
    if (lines && lines.length > 0) {
      return lines.join('\n')
    }
  }
  return ''
}

module.exports = {
  addSrcLineInfo,
  getNodeTrace,
  storeCode,
  formatTraces,
  formatSingleTrace,
  getCodeByLocation,
  getCodeBySourceFile,
  setGlobalAnalyzer,
  getGlobalAnalyzer,
}
