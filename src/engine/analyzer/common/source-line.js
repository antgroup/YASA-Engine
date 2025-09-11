const _ = require('lodash')
const config = require('../../../config')
const { prettyPrint } = require('../../../util/ast-util')
const { cloneWithDepth } = require('../../../util/clone-util')
const varUtil = require('../../../util/variable-util')

/** **************** source code line management *********************** */

const codeCache = new Map()

/**
 * append source line into the line trace
 * @param val
 * @param node
 * @param sourcefile
 * @param tag
 * @param affectedNodeName
 */
function addSrcLineInfo(val, node, sourcefile, tag, affectedNodeName) {
  if (!val) return val
  if (Array.isArray(val)) {
    let arrayHasTag = false
    for (const eachVal of val) {
      if (eachVal.hasTagRec) {
        arrayHasTag = true
        break
      }
    }
    if (!arrayHasTag) {
      return val
    }
    const new_val = _.clone(val)
    for (const eachVal of new_val) {
      if (eachVal.trace) {
        const { trace } = eachVal
        if (trace.length > 0) {
          const last_line = trace[trace.length - 1]
          if (last_line.file === sourcefile && last_line.line === node.loc.start?.line && last_line.tag === tag)
            // return val;
            trace.pop()
        }
        const start_line = node.loc.start?.line
        const end_line = node.loc.end?.line
        const tline = start_line === end_line ? start_line : _.range(start_line, end_line + 1)
        eachVal.trace.push({ file: sourcefile, line: tline, node, tag, affectedNodeName })
      } else {
        const start_line = node.loc.start?.line
        const end_line = node.loc.end?.line
        const tline = start_line === end_line ? start_line : _.range(start_line, end_line + 1)
        eachVal.trace = [
          {
            file: sourcefile,
            line: tline,
            node,
            tag,
            affectedNodeName,
          },
        ]
      }
      processFieldAndArguments(eachVal, eachVal, 0, new Array())
    }
    return new_val
  }
  if (!val.hasTagRec || !sourcefile)
    // important: only trace tags values
    return val

  const { trace } = val
  if (trace) {
    if (trace.length > 0) {
      const last_line = trace[trace.length - 1]
      if (last_line.file === sourcefile && last_line.line === node.loc.start?.line && last_line.tag === tag)
        // return val;
        trace.pop()
    }

    let new_val
    if (config.shareSourceLineSet) {
      new_val = val
    } else {
      new_val = _.clone(val)
      new_val.trace = _.clone(val.trace)
    }
    const start_line = node.loc.start?.line
    const end_line = node.loc.end?.line
    const tline = start_line === end_line ? start_line : _.range(start_line, end_line + 1)
    new_val.trace.push({ file: sourcefile, line: tline, node, tag, affectedNodeName })
    processFieldAndArguments(new_val, new_val, 0, new Array())
    return new_val
  }
  const new_val = _.clone(val)
  const start_line = node.loc.start?.line
  const end_line = node.loc.end?.line
  const tline = start_line === end_line ? start_line : _.range(start_line, end_line + 1)
  new_val.trace = [
    {
      file: sourcefile,
      line: tline,
      node,
      tag,
      affectedNodeName,
    },
  ]
  processFieldAndArguments(new_val, new_val, 0, new Array())
  return new_val
}

/**
 *
 * @param val
 * @param res
 * @param stack
 * @param visited
 */
function processFieldAndArguments(val, res, stack, visited) {
  // 同步trace
  if (visited.includes(val)) {
    return
  }
  // 即使容器内所有元素相同，容器内存地址不一样，通不过===验证，所以手动选取进行比较。qid为唯一值，预计可以作为唯一值去重标准
  for (const a of visited) {
    if (
      a.vtype !== 'union' &&
      a.vtype === val.vtype &&
      a._sid === val._sid &&
      a._qid === val._qid &&
      a._id === val._id &&
      a.ast === val.ast &&
      a.type === val.type &&
      a.hasTagRec === val.hasTagRec
    ) {
      return
    }
  }
  visited.push(val)
  if (stack >= 20) {
    // 说明是循环了
    return
  }
  if (!Array.isArray(res.trace)) {
    return
  }
  if (typeof val.hasTagRec !== 'undefined' && !val.hasTagRec) {
    return
  }
  if (
    typeof val?.field !== 'undefined' &&
    (Array.isArray(val?.field) || Object.getOwnPropertyNames(val?.field).length !== 0) &&
    val.hasTagRec
  ) {
    if (Array.isArray(val.field)) {
      for (const argI in val.field) {
        const arg = val.field[argI]
        if (arg.hasTagRec) {
          let hasChange = false
          if (Array.isArray(arg.trace) && varUtil.isNotEmpty(arg._tags)) {
            const arg_copy = cloneWithDepth(arg, 2)
            for (const argT in res.trace) {
              let flag = 1
              for (const tt in arg_copy.trace) {
                if (
                  arg_copy.trace[tt].file === res.trace[argT].file &&
                  arg_copy.trace[tt].tag === res.trace[argT].tag &&
                  JSON.stringify(arg_copy.trace[tt].line) === JSON.stringify(res.trace[argT].line)
                ) {
                  if (
                    arg_copy.trace[tt]?.affectedNodeName?.includes('__tmp') &&
                    !res.trace[argT]?.affectedNodeName?.includes('__tmp')
                  ) {
                    arg_copy.trace[tt].affectedNodeName = res.trace[argT]?.affectedNodeName
                  }
                  flag = 0
                  break
                }
              }
              if (flag) {
                arg_copy.trace.push(res.trace[argT])
              }
            }
            val.field[argI] = arg_copy
            hasChange = true
          }
          if (hasChange) {
            processFieldAndArguments(val.field[argI], res, stack + 1, visited)
          } else {
            processFieldAndArguments(arg, res, stack + 1, visited)
          }
        }
      }
    } else {
      for (const key in val.field) {
        if (Object.prototype.hasOwnProperty.call(val.field, key)) {
          const arg = val.field[key]
          if (typeof arg === 'undefined') {
            continue
          }
          if (arg.hasTagRec) {
            let hasChange = false
            if (Array.isArray(arg.trace) && varUtil.isNotEmpty(arg._tags)) {
              const arg_copy = cloneWithDepth(arg, 2)
              for (const argT in res.trace) {
                let flag = 1
                for (const tt in arg_copy.trace) {
                  if (
                    arg_copy.trace[tt].file === res.trace[argT].file &&
                    arg_copy.trace[tt].tag === res.trace[argT].tag &&
                    JSON.stringify(arg_copy.trace[tt].line) === JSON.stringify(res.trace[argT].line)
                  ) {
                    if (
                      arg_copy.trace[tt]?.affectedNodeName?.includes('__tmp') &&
                      !res.trace[argT]?.affectedNodeName?.includes('__tmp')
                    ) {
                      arg_copy.trace[tt].affectedNodeName = res.trace[argT].affectedNodeName
                    }
                    flag = 0
                    break
                  }
                }
                if (flag) {
                  arg_copy.trace.push(res.trace[argT])
                }
              }
              if (val.vtype === 'BVT') {
                val.value = { [key]: arg_copy }
              } else {
                val.field[key] = arg_copy
              }
              hasChange = true
            }
            if (hasChange) {
              processFieldAndArguments(val.field[key], res, stack + 1, visited)
            } else {
              processFieldAndArguments(arg, res, stack + 1, visited)
            }
          }
        }
      }
    }
  }
  if (val?.hasTagRec && Array.isArray(val?.arguments)) {
    for (const argJ in val.arguments) {
      const arg = val.arguments[argJ]
      if (typeof arg === 'undefined' || arg === null) {
        continue
      }
      try {
        if (arg.hasTagRec) {
          let hasChange = false
          if (Array.isArray(arg.trace) && varUtil.isNotEmpty(arg._tags)) {
            const arg_copy = cloneWithDepth(arg, 2)
            for (const argT in res.trace) {
              let flag = 1
              for (const tt in arg_copy.trace) {
                if (
                  arg_copy.trace[tt].file === res.trace[argT].file &&
                  arg_copy.trace[tt].tag === res.trace[argT].tag &&
                  JSON.stringify(arg_copy.trace[tt].line) === JSON.stringify(res.trace[argT].line)
                ) {
                  if (
                    arg_copy.trace[tt]?.affectedNodeName?.includes('__tmp') &&
                    !res.trace[argT]?.affectedNodeName?.includes('__tmp')
                  ) {
                    arg_copy.trace[tt].affectedNodeName = res.trace[argT].affectedNodeName
                  }
                  flag = 0
                  break
                }
              }
              if (flag) {
                arg_copy.trace.push(res.trace[argT])
              }
            }
            val.arguments[argJ] = arg_copy
            hasChange = true
          }
          if (hasChange) {
            processFieldAndArguments(val.arguments[argJ], res, stack + 1, visited)
          } else {
            processFieldAndArguments(arg, res, stack + 1, visited)
          }
        }
      } catch (e) {}
    }
  }
  if (val?.left?.hasTagRec) {
    if (varUtil.isNotEmpty(val.left._tags) && typeof val.left.trace !== 'undefined' && Array.isArray(val.left.trace)) {
      const arg = val.left
      const left_copy = cloneWithDepth(arg, 2)
      for (const argT in res.trace) {
        let flag = 1
        for (const tt in left_copy.trace) {
          if (
            left_copy.trace[tt].file === res.trace[argT].file &&
            left_copy.trace[tt].tag === res.trace[argT].tag &&
            JSON.stringify(left_copy.trace[tt].line) === JSON.stringify(res.trace[argT].line)
          ) {
            if (
              left_copy?.trace[tt]?.affectedNodeName?.includes('__tmp') &&
              !res.trace[argT]?.affectedNodeName?.includes('__tmp')
            ) {
              left_copy.trace[tt].affectedNodeName = res.trace[argT].affectedNodeName
            }
            flag = 0
            break
          }
        }
        if (flag) {
          left_copy.trace.push(res.trace[argT])
        }
      }
      val.left = left_copy
    }
    processFieldAndArguments(val.left, res, stack + 1, visited)
  }
  if (val?.right?.hasTagRec) {
    if (
      varUtil.isNotEmpty(val.right._tags) &&
      typeof val.right.trace !== 'undefined' &&
      Array.isArray(val.right.trace)
    ) {
      const arg = val.right
      const right_copy = cloneWithDepth(arg, 2)
      for (const argT in res.trace) {
        let flag = 1
        for (const tt in right_copy.trace) {
          if (
            right_copy.trace[tt].file === res.trace[argT].file &&
            right_copy.trace[tt].tag === res.trace[argT].tag &&
            JSON.stringify(right_copy.trace[tt].line) === JSON.stringify(res.trace[argT].line)
          ) {
            if (
              right_copy?.trace[tt]?.affectedNodeName?.includes('__tmp') &&
              !res.trace[argT]?.affectedNodeName?.includes('__tmp')
            ) {
              right_copy.trace[tt].affectedNodeName = res.trace[argT]?.affectedNodeName
            }
            flag = 0
            break
          }
        }
        if (flag) {
          right_copy.trace.push(res.trace[argT])
        }
      }
      val.right = right_copy
    }
    processFieldAndArguments(val.right, res, stack + 1, visited)
  }
  if (val?.expression?.hasTagRec) {
    if (
      varUtil.isNotEmpty(val.expression._tags) &&
      typeof val.expression.trace !== 'undefined' &&
      Array.isArray(val.expression.trace)
    ) {
      const arg = val.expression
      const expression_copy = cloneWithDepth(arg, 2)
      for (const argT in res.trace) {
        let flag = 1
        for (const tt in expression_copy.trace) {
          if (
            expression_copy.trace[tt].file === res.trace[argT].file &&
            expression_copy.trace[tt].tag === res.trace[argT].tag &&
            JSON.stringify(expression_copy.trace[tt].line) === JSON.stringify(res.trace[argT].line)
          ) {
            if (
              expression_copy.trace[tt]?.affectedNodeName?.includes('__tmp') &&
              !res.trace[argT]?.affectedNodeName?.includes('__tmp')
            ) {
              expression_copy.trace[tt].affectedNodeName = res.trace[argT]?.affectedNodeName
            }
            flag = 0
            break
          }
        }
        if (flag) {
          expression_copy.trace.push(res.trace[argT])
        }
      }
      val.expression = expression_copy
    }
    processFieldAndArguments(val.expression, res, stack + 1, visited)
  }
  if (val?.children) {
    for (const key in val.children) {
      if (Object.prototype.hasOwnProperty.call(val.children, key)) {
        const children = val.children[key]
        if (typeof children === 'undefined') {
          continue
        }
        if (children.hasTagRec) {
          let hasChange = false
          if (Array.isArray(children.trace) && varUtil.isNotEmpty(children._tags)) {
            const children_copy = cloneWithDepth(children, 2)
            for (const argT in res.trace) {
              let flag = 1
              for (const tt in children_copy.trace) {
                if (
                  children_copy.trace[tt].file === res.trace[argT].file &&
                  children_copy.trace[tt].tag === res.trace[argT].tag &&
                  JSON.stringify(children_copy.trace[tt].line) === JSON.stringify(res.trace[argT].line)
                ) {
                  if (
                    children_copy.trace[tt]?.affectedNodeName?.includes('__tmp') &&
                    !res.trace[argT]?.affectedNodeName?.includes('__tmp')
                  ) {
                    children_copy.trace[tt].affectedNodeName = res.trace[argT].affectedNodeName
                  }
                  flag = 0
                  break
                }
              }
              if (flag) {
                children_copy.trace.push(res.trace[argT])
              }
            }
            val.field[key] = children_copy
            hasChange = true
          }
          if (hasChange) {
            processFieldAndArguments(val.field[key], res, stack + 1, visited)
          } else {
            processFieldAndArguments(children, res, stack + 1, visited)
          }
        }
      }
    }
  }

  // object.property
  if (val.vtype === 'symbol') {
    const processMemberAccess = (target) => {
      const targetRef = val[target]

      if (targetRef.object && targetRef?.object?._sid && targetRef?.object?._sid?.includes('__tmp')) {
        // from Deconstruct assignment, don't copy
        return
      }

      if (Array.isArray(targetRef.trace) && varUtil.isNotEmpty(targetRef._tags)) {
        const target_copy = cloneWithDepth(targetRef, 2)
        for (const argT in res.trace) {
          let flag = 1
          for (const tt in target_copy.trace) {
            if (
              target_copy.trace[tt].file === res.trace[argT].file &&
              target_copy.trace[tt].tag === res.trace[argT].tag &&
              JSON.stringify(target_copy.trace[tt].line) === JSON.stringify(res.trace[argT].line)
            ) {
              if (
                target_copy.trace[tt]?.affectedNodeName?.includes('__tmp') &&
                !res.trace[argT]?.affectedNodeName?.includes('__tmp')
              ) {
                target_copy.trace[tt].affectedNodeName = res.trace[argT].affectedNodeName
              }
              flag = 0
              break
            }
          }
          if (flag) {
            target_copy.trace.push(res.trace[argT])
          }
        }
        val[target] = target_copy
      }

      processFieldAndArguments(val[target], res, stack + 1, visited)
    }

    if (val.object?.hasTagRec) {
      processMemberAccess('object')
    }

    if (val.property?.hasTagRec) {
      processMemberAccess('property')
    }
  }
}

/**
 * obtain the souce line information of a node
 * @param fdef
 * @param node
 */
function getNodeTrace(fdef, node) {
  if (!node) return
  const { loc } = node
  if (!loc) return {}

  // get source file from node rather than fdef
  let src_node = node
  let sourcefile = fdef?.sourcefile
  while (src_node && !src_node.sourcefile) {
    src_node = src_node.parent
  }
  if (src_node) {
    sourcefile = src_node.sourcefile
  }

  const line = loc.start.line === loc.end.line ? loc.start.line : _.range(loc.start.line, loc.end.line + 1)
  // 适配CompileUnit节点下没有sourcefile的场景，直接从loc中取
  if (sourcefile === undefined) {
    sourcefile = node?.loc?.sourcefile
  }
  return { file: sourcefile, node, line }
}

/**
 *
 * @param sourcefile
 * @param code
 * @returns {*|string}
 */
function storeCode(sourcefile, code) {
  const fname = sourcefile ? sourcefile.toString() : `_f_${codeCache.size}`
  // var allLines = data.split(/\n|\r/);
  const lines = code.split(/\n/)
  codeCache.set(fname, lines)
  return fname
}

/**
 *
 * @param item
 */
function formatSingleTrace(item) {
  let res = ''
  let prev_file
  let prev_line
  if (item.str) {
    // the preset string
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
    // obtain the fname from the AST node
    let fnode = item.node
    while (fnode) {
      if (fnode.sourcefile) {
        fname = fnode.sourcefile
        break
      }
      fnode = fnode.parent
    }
  }
  if (fname && fname !== prev_file) {
    // fname = fname.toString();
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
    const flines = codeCache.get(fname)
    const lines = Array.isArray(item.line) ? item.line : [item.line]
    for (let i = 0; i < lines.length; i++) {
      const lno = lines[i]
      if (lno === prev_line && !(i == 0 && prev_file !== fname)) continue
      prev_line = lno
      code = flines[lno - 1]
      if (item.tag) code = `${item.tag} ${code}`
      const pat = lno < 10 ? '   ' : lno < 100 ? '  ' : ' '
      // res += '  ' + lno + ':' + pat + code + '\n';
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
 * format the trace and print the source lines
 * @param trace
 */
function formatTraces(trace) {
  let res = ''
  let prev_file
  let prev_line
  for (const item of trace) {
    res += formatSingleTrace(item)
  }
  // strip the last '\n'
  res = res.substring(0, res.length - 1)
  return res
}

//* ***************************** exports ******************************

module.exports = {
  addSrcLineInfo,
  getNodeTrace,
  storeCode,
  formatTraces,
  formatSingleTrace,
}
