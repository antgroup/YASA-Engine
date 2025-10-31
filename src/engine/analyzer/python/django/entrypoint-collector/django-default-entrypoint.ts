const { extractRelativePath } = require('../../../../../util/file-util')
const { entryPointAndSourceAtSameTime } = require('../../../../../config')
const { findSourceOfFuncParam } = require('../../common/entrypoint-collector/python-entrypoint-source')
const EntryPoint = require('../../../common/entrypoint')
const constValue = require('../../../../../util/constant')

/**
 * 查找Django的entrypoint和source
 * @param filenameAstObj
 * @param dir
 */
function findDjangoEntryPointAndSource(filenameAstObj, dir) {
  const djangoEntryPointArray = []
  const djangoEntryPointSourceArray = []

  for (const filename in filenameAstObj) {
    const body = filenameAstObj[filename]?.body
    if (!body) {
      continue
    }

    // 收集当前文件中来自 django.urls 的直接导入标识符（如: from django.urls import path, re_path）
    // 说明：当后续匹配到 Identifier 形式的调用（path(...)）时，只有在被确认导入自 django.urls 才视为路由注册，避免误报
    const importedFromDjangoUrls = new Set()
    let hasAnyImportFromDjangoUrls = false
    try {
      for (const obj of body) {
        // 为了兼容不同的 UAST 结构，保守地通过字符串判断
        const str = JSON.stringify(obj)
        if (str && str.includes('from') && str.includes('django.urls') && str.includes('import')) {
          if (str.includes('re_path')) importedFromDjangoUrls.add('re_path')
          if (str.includes('path')) importedFromDjangoUrls.add('path')
          hasAnyImportFromDjangoUrls = true
        }
      }
    } catch (e) {
      // ignore parsing errors
    }

    // 查找urlpatterns中的path和re_path调用
    // Python AST中赋值语句是 VariableDeclaration 类型，不是 AssignExpression
    for (let obj of body) {
      // 某些UAST会把赋值包在 ExpressionStatement.expression 里
      if (obj && obj.type === 'ExpressionStatement' && obj.expression) {
        obj = obj.expression
      }
      // 支持两种类型：AssignExpression (通用) 和 VariableDeclaration (Python特有)
      let varName = null
      let initValue = null

      if (obj.type === 'AssignExpression' || obj.type === 'AssignmentExpression' || obj.type === 'Assign') {
        // 通用赋值表达式格式
        varName = obj.left?.id?.name || obj.left?.name//urlpatterns：value
        initValue = obj.right
      } else if (obj.type === 'VariableDeclaration') {
        // Python变量声明格式：VariableDeclaration { id, init }
        // 直接访问 id 和 init（不是 declarations 数组）
        if (obj.id) {
          varName = obj.id?.name || obj.id?.id?.name
          initValue = obj.init
        } else if (obj.declarations && obj.declarations.length > 0) {
          // 也支持 declarations 数组格式（JS风格）
          const decl = obj.declarations[0]
          varName = decl.id?.name || decl.id?.id?.name
          initValue = decl.init
        }
      }//path('run-cmd/', views.run_cmd_view, name='run_cmd'),

      if (varName === 'urlpatterns' && initValue) {
        // 处理数组/列表表达式
        // Python中列表可能被解析为 ArrayExpression 或 ObjectExpression（带 properties/elements）
        let elementGroups = []

        function extractElementsFromNode(node) {
          if (!node) return
          if (node.type === 'ArrayExpression' && node.elements) {
            elementGroups.push(node.elements)
          } else if (node.type === 'ListExpression' && node.elements) {
            // Python 列表在某些 UAST 版本中可能标为 ListExpression
            elementGroups.push(node.elements)
          } else if (node.type === 'ObjectExpression' && node.properties) {
            // ObjectExpression 的 properties 对应数组元素
            elementGroups.push(node.properties.map(prop => prop.value || prop.init || prop))
          } else if (node.type === 'ObjectExpression' && node.elements) {
            elementGroups.push(node.elements)
          } else if (node.type === 'BinaryExpression') {
            // 处理 urlpatterns += [...] 或 urlpatterns = A + [...]
            extractElementsFromNode(node.left)
            extractElementsFromNode(node.right)
          }
        }
        extractElementsFromNode(initValue)

        for (const elements of elementGroups) {
          if (!elements || !Array.isArray(elements)) continue
          for (const element of elements) {
            if (element.type === 'CallExpression' && element.callee) {
              const { callee } = element
              // 处理 MemberAccess (如 django.urls.path) 和 Identifier (如直接导入的 path)
              let methodName = null
              if (callee.type === 'MemberAccess' && callee.property?.name) {
                methodName = callee.property.name
              } else if (callee.type === 'Identifier') {
                methodName = callee.name
              }

              // 对 Identifier 形式要求其确实从 django.urls 导入；
              // 对 MemberAccess 形式（django.urls.path / urls.path）放宽为按方法名判断。
              const isIdentifierCall = callee.type === 'Identifier'
              const isMemberAccessCall = callee.type === 'MemberAccess'

              // 放宽规则以兼容更多项目：
              // - Identifier 形式：优先要求从 django.urls 导入；若文件名以 urls.py 结尾，则放宽为直接接受（兼容历史行为，避免漏检）
              // - MemberAccess 形式：方法名匹配即可
              const fileIsUrlsPy = filename.endsWith('urls.py') || filename.includes('/urls.py')
              const looksLikeDjangoRouteCall =
                  methodName && (
                      (isIdentifierCall && ['path', 're_path'].includes(methodName) && (importedFromDjangoUrls.has(methodName) || hasAnyImportFromDjangoUrls || fileIsUrlsPy)) ||
                      (isMemberAccessCall && ['path', 're_path'].includes(methodName))
                  )

              if (looksLikeDjangoRouteCall) {
                // 获取path调用的参数
                if (element.arguments && element.arguments.length >= 2) {
                  const viewFunction = element.arguments[1]
                  if (viewFunction.type === 'Identifier' || viewFunction.type === 'MemberAccess') {
                    // 查找对应的视图函数定义
                    const viewFunctionName = getViewFunctionName(viewFunction)
                    if (viewFunctionName) {
                      // 查找视图函数定义所在的文件（不是urls.py，而是实际的views.py）
                      const viewFuncDef = findViewFunctionDefinition(filenameAstObj, viewFunctionName)
                      let targetFileName = filename // 默认使用当前文件

                      if (viewFuncDef) {
                        // 如果找到了视图函数定义，使用定义所在的文件路径
                        if (viewFuncDef.loc?.sourcefile) {
                          targetFileName = viewFuncDef.loc.sourcefile
                        } else {
                          // 如果没有找到视图函数定义文件，尝试在其他文件中搜索
                          for (const otherFilename in filenameAstObj) {
                            const body = filenameAstObj[otherFilename]?.body
                            if (!body) continue
                            for (const obj of body) {
                              if (obj.type === 'FunctionDefinition' && obj.id?.name === viewFunctionName) {
                                if (obj.loc?.sourcefile) {
                                  targetFileName = obj.loc.sourcefile
                                  break
                                }
                              }
                            }
                            if (targetFileName !== filename) break
                          }
                        }
                      }

                      const shortFileName = extractRelativePath(targetFileName, dir)

                      const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
                      entryPoint.filePath = shortFileName
                      entryPoint.functionName = viewFunctionName
                      entryPoint.attribute = 'HTTP'
                      djangoEntryPointArray.push(entryPoint)

                      if (entryPointAndSourceAtSameTime) {
                        // 查找视图函数定义并添加source
                        const viewFuncDef = findViewFunctionDefinition(filenameAstObj, viewFunctionName)
                        if (viewFuncDef) {
                          const paramSourceArray = findSourceOfFuncParam(shortFileName, viewFunctionName, viewFuncDef, null)
                          if (paramSourceArray) {
                            djangoEntryPointSourceArray.push(...paramSourceArray)
                          }
                        }
                      }
                    }
                  }
                  // 处理类视图：第二参数是 CallExpression，形如 ClassName.as_view()
                  else if (viewFunction.type === 'CallExpression' && viewFunction.callee) {
                    const callee = viewFunction.callee
                    if (callee.type === 'MemberAccess' && callee.property?.name === 'as_view') {
                      // 提取类名
                      const clsObj = callee.object
                      let className = null
                      if (clsObj?.type === 'Identifier') {
                        className = clsObj.name
                      } else if (clsObj?.type === 'MemberAccess' && clsObj.property?.name) {
                        className = clsObj.property.name
                      }
                      if (className) {
                        // 在所有文件中查找类定义，并将常见 HTTP 方法作为入口点
                        const httpMethods = new Set(['get', 'post', 'put', 'delete', 'patch'])
                        for (const otherFilename in filenameAstObj) {
                          const obody = filenameAstObj[otherFilename]?.body
                          if (!obody) continue
                          for (const obj2 of obody) {
                            if (obj2.type === 'ClassDefinition' && obj2.id?.name === className) {
                              // 遍历类体，找到方法定义
                              const classBody = obj2.body || obj2.block || obj2.elements || []
                              for (const member of classBody) {
                                if (member?.type === 'FunctionDefinition' && member.id?.name && httpMethods.has(member.id.name)) {
                                  const shortFileName = extractRelativePath(member.loc?.sourcefile || otherFilename, dir)
                                  const entryPoint = new EntryPoint(constValue.ENGIN_START_FUNCALL)
                                  entryPoint.filePath = shortFileName
                                  entryPoint.functionName = member.id.name
                                  entryPoint.attribute = 'HTTP'
                                  djangoEntryPointArray.push(entryPoint)
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return { djangoEntryPointArray, djangoEntryPointSourceArray }
}

/**
 * 获取视图函数名称
 * @param viewFunction
 */
function getViewFunctionName(viewFunction) {
  if (viewFunction.type === 'Identifier') {
    return viewFunction.name
  } else if (viewFunction.type === 'MemberAccess') {
    // 处理类似 views.run_cmd 的情况
    if (viewFunction.property?.name) {
      return viewFunction.property.name
    }
  }
  return null
}

/**
 * 查找视图函数定义
 * @param filenameAstObj
 * @param functionName
 */
function findViewFunctionDefinition(filenameAstObj, functionName) {
  for (const filename in filenameAstObj) {
    const body = filenameAstObj[filename]?.body
    if (!body) {
      continue
    }

    for (const obj of body) {
      if (obj.type === 'FunctionDefinition' && obj.id?.name === functionName) {
        return obj
      }
    }
  }
  return null
}

module.exports = {
  findDjangoEntryPointAndSource,
}

