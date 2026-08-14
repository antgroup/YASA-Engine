const { extractRelativePath } = require('../../../../../util/file-util')
const { entryPointAndSourceAtSameTime } = require('../../../../../config')
const { findSourceOfFuncParam } = require('../../common/entrypoint-collector/python-entrypoint-source')
const EntryPoint = require('../../../common/entrypoint/entrypoint')
const Constant = require('../../../../../util/constant')
const logger: import('../../../../../util/logger').Logger = require('../../../../../util/logger')(__filename)

interface ASTObject {
  body?: any[]
  [key: string]: any
}

interface FilenameAstMap {
  [filename: string]: ASTObject
}

// Gradio 事件绑定方法名：component.click / component.submit / component.change /
// component.input / component.select / component.upload
const GRADIO_EVENT_METHODS = new Set([
  'click',
  'submit',
  'change',
  'input',
  'select',
  'upload',
])

// Gradio 组件类型：用于识别组件定义（如 url = gr.Textbox(...)）
const GRADIO_COMPONENT_TYPES = new Set([
  'Textbox', 'Number', 'Slider', 'Checkbox', 'CheckboxGroup',
  'Radio', 'Dropdown', 'Image', 'Video', 'Audio', 'File',
  'DataFrame', 'JSON', 'HTML', 'Markdown', 'Code', 'Button',
  'Chatbot', 'Gallery', 'Label', 'Plot', 'HighlightedText',
  'UploadButton',
])

// 递归遍历 AST 的最大深度保护
const MAX_AST_TRAVERSAL_DEPTH = 64

/**
 * Gradio 事件绑定中 inputs 列表的组件引用信息
 */
interface GradioInputRef {
  /** 组件变量名，如 'url' */
  name: string
  /** 对应 callback 参数索引 */
  paramIndex: number
}

/**
 * 从 ImportExpression 的 imported 字段提取模块名
 * UAST 中 imported 可能是 Identifier（name 属性）或 Literal（value 属性）
 */
function extractImportedName(imported: any): string | null {
  if (!imported) return null
  if (imported.type === 'Identifier' && typeof imported.name === 'string') {
    return imported.name
  }
  if (imported.type === 'Literal' && typeof imported.value === 'string') {
    return imported.value
  }
  return null
}

/**
 * 从 AST body 中检测是否导入了 gradio 模块
 * 支持三种模式：
 *   - import gradio / import gradio as gr
 *   - from gradio import Blocks / from gradio.components import Textbox
 */
function hasGradioImport(body: any[]): boolean {
  if (!Array.isArray(body)) return false
  for (const obj of body) {
    if (!obj || typeof obj !== 'object') continue
    if (obj.type === 'VariableDeclaration' && obj.init?.type === 'ImportExpression') {
      const importExpr = obj.init
      const fromValue = extractLiteralString(importExpr.from)
      const importedName = extractImportedName(importExpr.imported)
      // import gradio / import gradio as gr
      if (!fromValue && importedName === 'gradio') {
        return true
      }
      // from gradio import ... / from gradio.xxx import ...
      if (fromValue === 'gradio' || fromValue?.startsWith('gradio.')) {
        return true
      }
    }
  }
  return false
}

/**
 * 提取字面量字符串值
 */
function extractLiteralString(node: any): string | null {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value
  }
  return null
}

/**
 * 从 AST body 中收集 import gradio 的别名映射
 * 返回 Map<localName, canonicalName>，例如 gr -> gradio
 */
function analyzeGradioImports(body: any[]): Map<string, string> {
  const map = new Map<string, string>()
  if (!Array.isArray(body)) return map
  for (const obj of body) {
    if (!obj || typeof obj !== 'object') continue
    if (obj.type === 'VariableDeclaration' && obj.init?.type === 'ImportExpression') {
      const importExpr = obj.init
      const localName = obj.id?.name
      if (!localName) continue
      const fromValue = extractLiteralString(importExpr.from)
      const importedName = extractImportedName(importExpr.imported)
      // import gradio / import gradio as gr
      if (!fromValue && importedName === 'gradio') {
        map.set(localName, 'gradio')
      }
      // from gradio import Blocks 等
      if (fromValue === 'gradio' && importedName) {
        map.set(localName, `gradio.${importedName}`)
      }
      // from gradio.xxx import ...
      if (fromValue?.startsWith('gradio.') && importedName) {
        map.set(localName, `${fromValue}.${importedName}`)
      }
    }
  }
  return map
}

/**
 * 递归收集 AST 中所有 FunctionDefinition 节点（含嵌套在 ScopedStatement / WithStatement 内的）
 * 返回 Map<funcName, funcNode[]>，同名函数可能有多个定义
 */
function collectAllFunctionDefinitions(
  node: any,
  result: Map<string, any[]>,
  depth: number
): void {
  if (depth > MAX_AST_TRAVERSAL_DEPTH) return
  if (!node) return
  if (Array.isArray(node)) {
    for (const child of node) {
      collectAllFunctionDefinitions(child, result, depth + 1)
    }
    return
  }
  if (typeof node !== 'object') return

  if (node.type === 'FunctionDefinition' && node.id?.name && node.parameters) {
    const funcName: string = node.id.name
    if (!result.has(funcName)) {
      result.set(funcName, [])
    }
    result.get(funcName)!.push(node)
  }

  // 递归进入 body（含 ScopedStatement / FunctionDefinition / ClassDefinition 等）
  if (Array.isArray(node.body)) {
    collectAllFunctionDefinitions(node.body, result, depth + 1)
  } else if (node.body && typeof node.body === 'object') {
    collectAllFunctionDefinitions(node.body, result, depth + 1)
  }

  // 递归进入 Sequence.expressions（Python with 语句块在 UAST 中表示为 Sequence）
  if (Array.isArray(node.expressions)) {
    collectAllFunctionDefinitions(node.expressions, result, depth + 1)
  }

  // 递归进入 ExpressionStatement.expression
  if (node.expression && typeof node.expression === 'object') {
    collectAllFunctionDefinitions(node.expression, result, depth + 1)
  }
}

/**
 * 递归收集 AST 中所有 Gradio 组件定义（如 url = gr.Textbox(...)）
 * UAST 中 with 块内的赋值表示为 AssignmentExpression（left=Identifier, right=CallExpression）
 * 顶层赋值表示为 VariableDeclaration（id=Identifier, init=CallExpression）
 * 返回 Map<变量名, { lineStart, lineEnd }>
 */
function collectGradioComponentDefinitions(
  node: any,
  gradioAliases: Set<string>,
  result: Map<string, { lineStart: number; lineEnd: number }>,
  depth: number
): void {
  if (depth > MAX_AST_TRAVERSAL_DEPTH) return
  if (!node) return
  if (Array.isArray(node)) {
    for (const child of node) {
      collectGradioComponentDefinitions(child, gradioAliases, result, depth + 1)
    }
    return
  }
  if (typeof node !== 'object') return

  // 匹配 VariableDeclaration: url = gr.Textbox(...)（顶层赋值）
  if (
    node.type === 'VariableDeclaration' &&
    node.id?.type === 'Identifier' &&
    node.id?.name &&
    node.init?.type === 'CallExpression' &&
    node.init.callee?.type === 'MemberAccess' &&
    node.init.callee.object?.type === 'Identifier' &&
    gradioAliases.has(node.init.callee.object.name) &&
    node.init.callee.property?.name &&
    GRADIO_COMPONENT_TYPES.has(node.init.callee.property.name) &&
    node.loc?.start?.line &&
    node.loc?.end?.line
  ) {
    result.set(node.id.name, {
      lineStart: node.loc.start.line,
      lineEnd: node.loc.end.line,
    })
  }

  // 匹配 AssignmentExpression: url = gr.Textbox(...)（with 块内赋值）
  // UAST 中 with gr.Blocks() as demo: 块内的赋值为 AssignmentExpression
  if (
    node.type === 'AssignmentExpression' &&
    node.left?.type === 'Identifier' &&
    node.left?.name &&
    node.right?.type === 'CallExpression' &&
    node.right.callee?.type === 'MemberAccess' &&
    node.right.callee.object?.type === 'Identifier' &&
    gradioAliases.has(node.right.callee.object.name) &&
    node.right.callee.property?.name &&
    GRADIO_COMPONENT_TYPES.has(node.right.callee.property.name) &&
    node.loc?.start?.line &&
    node.loc?.end?.line
  ) {
    result.set(node.left.name, {
      lineStart: node.loc.start.line,
      lineEnd: node.loc.end.line,
    })
  }

  // 递归进入 body（含 ScopedStatement / FunctionDefinition / ClassDefinition 等）
  if (Array.isArray(node.body)) {
    collectGradioComponentDefinitions(node.body, gradioAliases, result, depth + 1)
  } else if (node.body && typeof node.body === 'object') {
    collectGradioComponentDefinitions(node.body, gradioAliases, result, depth + 1)
  }

  // 递归进入 Sequence.expressions（Python with 语句块在 UAST 中表示为 Sequence）
  if (Array.isArray(node.expressions)) {
    collectGradioComponentDefinitions(node.expressions, gradioAliases, result, depth + 1)
  }

  // 递归进入 ExpressionStatement.expression
  if (node.expression && typeof node.expression === 'object') {
    collectGradioComponentDefinitions(node.expression, gradioAliases, result, depth + 1)
  }
}

/**
 * 根据 inputs 列表中的组件引用和组件定义映射，生成 PYTHON_INPUT source 规则
 * 使引擎在组件定义处标记 source，补全 组件定义→事件绑定→callback 参数 的传播段
 *
 * locStart/locEnd 使用事件绑定调用的行号范围（而非组件定义行号），
 * 因为引擎的 introduceTaintAtIdentifier 基于标识符求值位置的行号范围匹配 source 规则，
 * 组件标识符（如 url）在 .click() 调用处被引用，而非在组件定义处。
 */
function generateComponentSourceRules(
  componentRefs: GradioInputRef[],
  componentMap: Map<string, { lineStart: number; lineEnd: number }>,
  filename: string,
  eventBindingLoc: { lineStart: number; lineEnd: number }
): any[] {
  const sourceRules: any[] = []
  for (const ref of componentRefs) {
    const componentDef = componentMap.get(ref.name)
    if (!componentDef) continue
    sourceRules.push({
      introPoint: 4,
      kind: 'PYTHON_INPUT',
      path: ref.name,
      scopeFunc: 'all',
      scopeFile: filename,
      locStart: eventBindingLoc.lineStart,
      locEnd: eventBindingLoc.lineEnd,
    })
  }
  if (sourceRules.length > 0) {
    logger.info(`[GRADIO-SRC] Generated ${sourceRules.length} component source rules for ${filename} at L${eventBindingLoc.lineStart}: refs=[${componentRefs.map(r => r.name).join(',')}]`)
  }
  return sourceRules
}

/**
 * 判断 CallExpression 是否为 Gradio 事件绑定调用（如 button.click(fn, inputs, outputs)）
 * 返回事件方法名（如 'click'），不匹配则返回 null
 */
function matchGradioEventCall(
  callExpr: any,
  gradioLocalNames: Set<string>
): string | null {
  if (callExpr.type !== 'CallExpression' || !callExpr.callee) return null
  const { callee } = callExpr
  if (callee.type !== 'MemberAccess' || !callee.property?.name) return null
  const methodName = callee.property.name
  if (!GRADIO_EVENT_METHODS.has(methodName)) return null

  // 验证调用者（callee.object）是 Gradio 组件
  // 直接变量名（如 set_chat_but）不需要验证是否为 Gradio 组件，
  // 因为只要文件内有 import gradio 就激活收集器，
  // 且 .click()/.submit() 等方法名在普通代码中极少作为链式调用
  return methodName
}

/**
 * 从 CallExpression 的 arguments 中提取事件回调信息
 * Gradio 事件绑定格式：component.click(fn, inputs, outputs)
 *   - arguments[0]: 回调函数（Identifier 或 MemberAccess）
 *   - arguments[1]: inputs 列表（ArrayExpression），其元素数量对应回调函数的参数数量
 *
 * 也支持 gr.Interface(fn=..., inputs=..., outputs=...) 模式：
 *   - arguments 中查找 VariableDeclaration(id.name==='fn') 获取回调函数
 *   - arguments 中查找 VariableDeclaration(id.name==='inputs') 获取输入组件数量
 */
interface GradioEventInfo {
  /** 回调函数名 */
  callbackName: string
  /** 回调函数定义节点（用于定位行号和参数） */
  callbackFuncNode: any
  /** source 参数索引列表（基于回调函数参数位置） */
  sourceParamIndices: number[]
  /** inputs 列表中的组件引用（用于生成组件定义 source 规则） */
  componentRefs: GradioInputRef[]
}

/**
 * 从事件绑定调用的 arguments 中提取回调函数名
 * arguments[0] 应为 Identifier（函数名）
 */
function extractCallbackNameFromEventArgs(args: any[]): string | null {
  if (!args || args.length === 0) return null
  const firstArg = args[0]
  if (!firstArg) return null
  // 直接函数引用：button.click(set_chat_fn, ...)
  if (firstArg.type === 'Identifier' && firstArg.name) {
    return firstArg.name
  }
  // 成员方法引用：button.click(self.handler, ...) — 暂不支持
  // lambda 作为回调暂不支持
  return null
}

/**
 * 从事件绑定调用的 arguments[1]（inputs 列表）提取组件引用和总元素数
 * UAST 中 Python 列表可能表示为 ArrayExpression 或 ObjectExpression
 * 返回 totalCount（总元素数，用于向后兼容标记 callback 参数）和 componentRefs（组件引用列表）
 */
function extractInputsFromEventArgs(args: any[]): { totalCount: number; componentRefs: GradioInputRef[] } {
  if (!args || args.length < 2) return { totalCount: 0, componentRefs: [] }
  const secondArg = args[1]
  if (!secondArg) return { totalCount: 0, componentRefs: [] }
  let elements: any[] = []
  if (secondArg.type === 'ArrayExpression' && Array.isArray(secondArg.elements)) {
    elements = secondArg.elements
  } else if (secondArg.type === 'ObjectExpression' && Array.isArray(secondArg.properties)) {
    elements = secondArg.properties
  }
  const refs: GradioInputRef[] = []
  for (let i = 0; i < elements.length; i++) {
    const elem = elements[i]
    // ArrayExpression: 元素直接是 Identifier（如 url）
    if (elem?.type === 'Identifier' && elem.name) {
      refs.push({ name: elem.name, paramIndex: i })
    }
    // ObjectExpression: 元素是 VariableDeclaration，实际标识符在 init 中
    else if (elem?.type === 'VariableDeclaration' && elem.init?.type === 'Identifier' && elem.init.name) {
      refs.push({ name: elem.init.name, paramIndex: i })
    }
    // ObjectExpression properties: ObjectProperty（UAST 中 Python 列表表示为 ObjectExpression，
    // 每个 property 是 ObjectProperty，key 为索引，value 为实际元素如 Identifier("url")）
    else if (elem?.type === 'ObjectProperty' && elem.value?.type === 'Identifier' && elem.value.name) {
      refs.push({ name: elem.value.name, paramIndex: i })
    }
  }
  return { totalCount: elements.length, componentRefs: refs }
}

/**
 * 从 gr.Interface(fn=..., inputs=...) 的关键字参数中提取回调信息
 */
function extractInterfaceCallbackInfo(
  args: any[],
  funcDefs: Map<string, any[]>
): GradioEventInfo | null {
  let callbackName: string | null = null
  let inputCount = 0
  const componentRefs: GradioInputRef[] = []

  for (const arg of args) {
    if (!arg || arg.type !== 'VariableDeclaration' || !arg.id?.name) continue
    // fn=xxx
    if (arg.id.name === 'fn' && arg.init?.type === 'Identifier' && arg.init.name) {
      callbackName = arg.init.name
    }
    // inputs=[...] 或 inputs=component
    if (arg.id.name === 'inputs') {
      if (arg.init?.type === 'ArrayExpression' && Array.isArray(arg.init.elements)) {
        inputCount = arg.init.elements.length
        for (let i = 0; i < arg.init.elements.length; i++) {
          const elem = arg.init.elements[i]
          if (elem?.type === 'Identifier' && elem.name) {
            componentRefs.push({ name: elem.name, paramIndex: i })
          }
        }
      } else if (arg.init?.type === 'ObjectExpression' && Array.isArray(arg.init.properties)) {
        // UAST 中 Python 列表可能表示为 ObjectExpression
        inputCount = arg.init.properties.length
        for (let i = 0; i < arg.init.properties.length; i++) {
          const prop = arg.init.properties[i]
          if (prop?.type === 'Identifier' && prop.name) {
            componentRefs.push({ name: prop.name, paramIndex: i })
          }
        }
      } else if (arg.init) {
        // 单个组件作为 inputs
        inputCount = 1
        if (arg.init.type === 'Identifier' && arg.init.name) {
          componentRefs.push({ name: arg.init.name, paramIndex: 0 })
        }
      }
    }
  }

  if (!callbackName || callbackName === 'None') return null

  // 查找回调函数定义
  const funcNodes = funcDefs.get(callbackName)
  if (!funcNodes || funcNodes.length === 0) return null
  const callbackFuncNode = funcNodes[0]

  const sourceParamIndices: number[] = []
  for (let i = 0; i < inputCount; i++) {
    sourceParamIndices.push(i)
  }

  return { callbackName, callbackFuncNode, sourceParamIndices, componentRefs }
}

/**
 * 处理 gr.Interface(fn=..., inputs=..., outputs=...) 模式
 * 检测 gr.Interface 调用并注册 fn 参数对应的回调函数为 entrypoint
 */
function processInterfaceCalls(
  body: any[],
  filename: string,
  shortFileName: string,
  gradioLocalNames: Set<string>,
  funcDefs: Map<string, any[]>,
  componentMap: Map<string, { lineStart: number; lineEnd: number }>,
  entryPointArray: any[],
  entryPointSourceArray: any[]
): void {
  traverseForInterfaceCalls(body, gradioLocalNames, funcDefs, componentMap, filename, shortFileName, entryPointArray, entryPointSourceArray, 0)
}

function traverseForInterfaceCalls(
  node: any,
  gradioLocalNames: Set<string>,
  funcDefs: Map<string, any[]>,
  componentMap: Map<string, { lineStart: number; lineEnd: number }>,
  filename: string,
  shortFileName: string,
  entryPointArray: any[],
  entryPointSourceArray: any[],
  depth: number
): void {
  if (depth > MAX_AST_TRAVERSAL_DEPTH) return
  if (!node) return
  if (Array.isArray(node)) {
    for (const child of node) {
      traverseForInterfaceCalls(child, gradioLocalNames, funcDefs, componentMap, filename, shortFileName, entryPointArray, entryPointSourceArray, depth + 1)
    }
    return
  }
  if (typeof node !== 'object') return

  // 检测 gr.Interface(...) 调用
  if (node.type === 'CallExpression' && node.callee?.type === 'MemberAccess') {
    const callee = node.callee
    // gr.Interface 或 gr.TabbedInterface
    if (
      callee.object?.type === 'Identifier' &&
      gradioLocalNames.has(callee.object.name) &&
      (callee.property?.name === 'Interface' || callee.property?.name === 'TabbedInterface') &&
      Array.isArray(node.arguments)
    ) {
      const eventInfo = extractInterfaceCallbackInfo(node.arguments, funcDefs)
      if (eventInfo) {
        registerGradioEntryPoint(
          eventInfo.callbackName,
          eventInfo.callbackFuncNode,
          eventInfo.sourceParamIndices,
          filename,
          shortFileName,
          entryPointArray,
          entryPointSourceArray
        )
        // 生成组件定义 source 规则
        const eventBindingLoc = {
          lineStart: node.loc?.start?.line || 0,
          lineEnd: node.loc?.end?.line || 0,
        }
        const componentSourceRules = generateComponentSourceRules(eventInfo.componentRefs, componentMap, filename, eventBindingLoc)
        if (componentSourceRules.length > 0) {
          entryPointSourceArray.push(...componentSourceRules)
        }
      }
    }
  }

  // 递归
  if (Array.isArray(node.body)) {
    traverseForInterfaceCalls(node.body, gradioLocalNames, funcDefs, componentMap, filename, shortFileName, entryPointArray, entryPointSourceArray, depth + 1)
  } else if (node.body && typeof node.body === 'object') {
    traverseForInterfaceCalls(node.body, gradioLocalNames, funcDefs, componentMap, filename, shortFileName, entryPointArray, entryPointSourceArray, depth + 1)
  }
  // 也遍历 arguments（可能嵌套调用）
  if (Array.isArray(node.arguments)) {
    for (const arg of node.arguments) {
      traverseForInterfaceCalls(arg, gradioLocalNames, funcDefs, componentMap, filename, shortFileName, entryPointArray, entryPointSourceArray, depth + 1)
    }
  }
}

/**
 * 注册 Gradio entrypoint
 */
function registerGradioEntryPoint(
  funcName: string,
  funcNode: any,
  sourceParamIndices: number[],
  filename: string,
  shortFileName: string,
  entryPointArray: any[],
  entryPointSourceArray: any[]
): void {
  const entryPoint = new EntryPoint(Constant.ENGIN_START_FUNCALL)
  entryPoint.filePath = shortFileName
  entryPoint.functionName = funcName
  entryPoint.attribute = 'GradioEvent'
  // 携带函数定义行号，用于精确匹配 overloaded 同名函数
  entryPoint.funcLocStart = funcNode.loc?.start?.line as number | undefined
  entryPoint.funcLocEnd = funcNode.loc?.end?.line as number | undefined
  entryPointArray.push(entryPoint)

  if (entryPointAndSourceAtSameTime) {
    const paramSourceArray = findSourceOfFuncParam(
      filename,
      funcName,
      funcNode,
      sourceParamIndices.length > 0 ? sourceParamIndices : undefined
    )
    if (paramSourceArray) {
      entryPointSourceArray.push(...paramSourceArray)
    }
  }
}

/**
 * 递归遍历 AST，查找 Gradio 事件绑定调用并注册 entrypoint
 * 模式：component.click(fn, inputs, outputs) / component.submit(fn, inputs, outputs) 等
 */
function traverseForEventBindings(
  node: any,
  gradioLocalNames: Set<string>,
  funcDefs: Map<string, any[]>,
  componentMap: Map<string, { lineStart: number; lineEnd: number }>,
  filename: string,
  shortFileName: string,
  entryPointArray: any[],
  entryPointSourceArray: any[],
  depth: number
): void {
  if (depth > MAX_AST_TRAVERSAL_DEPTH) return
  if (!node) return
  if (Array.isArray(node)) {
    for (const child of node) {
      traverseForEventBindings(child, gradioLocalNames, funcDefs, componentMap, filename, shortFileName, entryPointArray, entryPointSourceArray, depth + 1)
    }
    return
  }
  if (typeof node !== 'object') return

  // 检测 xxx.click(fn, inputs, outputs) 等事件绑定调用
  if (node.type === 'CallExpression') {
    const eventName = matchGradioEventCall(node, gradioLocalNames)
    if (eventName && Array.isArray(node.arguments)) {
      const callbackName = extractCallbackNameFromEventArgs(node.arguments)
      if (callbackName) {
        // 查找回调函数定义
        const funcNodes = funcDefs.get(callbackName)
        if (funcNodes && funcNodes.length > 0) {
          const callbackFuncNode = funcNodes[0]
          // 从 inputs 列表提取组件引用和总元素数
          const { totalCount, componentRefs } = extractInputsFromEventArgs(node.arguments)
          // 所有 inputs 参数都标记为 source（向后兼容）
          const sourceParamIndices: number[] = []
          for (let i = 0; i < totalCount; i++) {
            sourceParamIndices.push(i)
          }
          registerGradioEntryPoint(
            callbackName,
            callbackFuncNode,
            sourceParamIndices,
            filename,
            shortFileName,
            entryPointArray,
            entryPointSourceArray
          )
          // 生成组件定义 source 规则，补全 组件定义→事件绑定→callback 参数 的传播段
          const eventBindingLoc = {
            lineStart: node.loc?.start?.line || 0,
            lineEnd: node.loc?.end?.line || 0,
          }
          const componentSourceRules = generateComponentSourceRules(componentRefs, componentMap, filename, eventBindingLoc)
          if (componentSourceRules.length > 0) {
            entryPointSourceArray.push(...componentSourceRules)
          }
        }
      }
    }
  }

  // 递归进入 body（含 ScopedStatement / FunctionDefinition / ClassDefinition 等）
  if (Array.isArray(node.body)) {
    traverseForEventBindings(node.body, gradioLocalNames, funcDefs, componentMap, filename, shortFileName, entryPointArray, entryPointSourceArray, depth + 1)
  } else if (node.body && typeof node.body === 'object') {
    traverseForEventBindings(node.body, gradioLocalNames, funcDefs, componentMap, filename, shortFileName, entryPointArray, entryPointSourceArray, depth + 1)
  }

  // 递归进入 Sequence.expressions（Python with 语句块在 UAST 中表示为 Sequence）
  if (Array.isArray(node.expressions)) {
    traverseForEventBindings(node.expressions, gradioLocalNames, funcDefs, componentMap, filename, shortFileName, entryPointArray, entryPointSourceArray, depth + 1)
  }

  // 递归进入 ExpressionStatement.expression
  if (node.expression && typeof node.expression === 'object') {
    traverseForEventBindings(node.expression, gradioLocalNames, funcDefs, componentMap, filename, shortFileName, entryPointArray, entryPointSourceArray, depth + 1)
  }

  // 递归进入 VariableDeclaration.init（如 file_msg = file_btn.upload(fn, inputs, outputs)）
  if (node.type === 'VariableDeclaration' && node.init && typeof node.init === 'object') {
    traverseForEventBindings(node.init, gradioLocalNames, funcDefs, componentMap, filename, shortFileName, entryPointArray, entryPointSourceArray, depth + 1)
  }

  // 递归进入 AssignmentExpression.right（with 块内赋值）
  if (node.type === 'AssignmentExpression' && node.right && typeof node.right === 'object') {
    traverseForEventBindings(node.right, gradioLocalNames, funcDefs, componentMap, filename, shortFileName, entryPointArray, entryPointSourceArray, depth + 1)
  }

  // 也遍历 arguments（可能嵌套调用）
  if (Array.isArray(node.arguments)) {
    for (const arg of node.arguments) {
      traverseForEventBindings(arg, gradioLocalNames, funcDefs, componentMap, filename, shortFileName, entryPointArray, entryPointSourceArray, depth + 1)
    }
  }
}

/**
 * fallback 检测：当直接 import 检测失败时，通过框架使用模式识别 Gradio 文件
 * 检测 `with xxx.Blocks(...)` 或 `xxx.Interface(...)` / `xxx.TabbedInterface(...)` 调用模式
 * 返回检测到的 Gradio 别名集合（如 {'gr'}）
 */
function detectGradioFrameworkUsage(body: any[]): Set<string> {
  const aliases = new Set<string>()
  if (!Array.isArray(body)) return aliases

  // Gradio 框架标志性 API 名称
  const gradioFrameworkApis = new Set(['Blocks', 'Interface', 'TabbedInterface'])

  /**
   * 检查 CallExpression 的 callee 是否为 xxx.Blocks/Interface/TabbedInterface 模式
   * 若匹配则将 xxx 加入 aliases
   */
  function checkCallExpression(callExpr: any): void {
    if (callExpr?.type !== 'CallExpression' || !callExpr.callee) return
    const callee = callExpr.callee
    if (callee.type === 'MemberAccess' && callee.property?.name &&
        gradioFrameworkApis.has(callee.property.name) &&
        callee.object?.type === 'Identifier' && callee.object.name) {
      aliases.add(callee.object.name)
    }
  }

  for (const obj of body) {
    if (!obj || typeof obj !== 'object') continue

    // 模式 1：with xxx.Blocks(...) as demo:
    // UAST 表示为 ScopedStatement，object 是 CallExpression
    if (obj.type === 'ScopedStatement' && obj.object?.type === 'CallExpression') {
      checkCallExpression(obj.object)
    }

    // 模式 2：with xxx.Blocks(...) as demo: 的另一种 UAST 表示
    // Python with 语句在 UAST 中可能表示为 Sequence，首元素是 VariableDeclaration
    // VariableDeclaration.id = demo, VariableDeclaration.init = CallExpression (gr.Blocks(...))
    if (obj.type === 'Sequence' && Array.isArray(obj.expressions) && obj.expressions.length > 0) {
      const firstExpr = obj.expressions[0]
      // with xxx.Blocks() as var → VariableDeclaration { id: var, init: CallExpression }
      if (firstExpr?.type === 'VariableDeclaration' && firstExpr.init?.type === 'CallExpression') {
        checkCallExpression(firstExpr.init)
      }
      // with xxx.Blocks() → ScopedStatement { object: CallExpression }
      if (firstExpr?.type === 'ScopedStatement' && firstExpr.object?.type === 'CallExpression') {
        checkCallExpression(firstExpr.object)
      }
    }

    // 模式 3：顶层 xxx.Interface(...) / xxx.TabbedInterface(...) 调用
    // VariableDeclaration: demo = gr.Interface(...)
    if (obj.type === 'VariableDeclaration' && obj.init?.type === 'CallExpression') {
      checkCallExpression(obj.init)
    }

    // 模式 4：ExpressionStatement: gr.Interface(...)（无赋值）
    if (obj.type === 'ExpressionStatement' && obj.expression?.type === 'CallExpression') {
      checkCallExpression(obj.expression)
    }
  }

  return aliases
}

/**
 * Gradio entrypoint 预收集器
 * 检测两种事件绑定模式：
 *   1. component.click(fn, inputs, outputs) / component.submit(...) 等
 *   2. gr.Interface(fn=..., inputs=..., outputs=...)
 * 回调函数的 inputs 对应位置参数标记为 source
 * 同时收集 inputs 中引用的 Gradio 组件定义，生成组件级 source 规则
 *
 * @param filenameAstObj 文件名 -> AST 映射
 * @param dir 基础目录
 */
function findGradioEntryPointAndSource(
  filenameAstObj: FilenameAstMap,
  dir: string
): { gradioEntryPointArray: any[]; gradioEntryPointSourceArray: any[] } {
  const gradioEntryPointArray: any[] = []
  const gradioEntryPointSourceArray: any[] = []

  for (const filename in filenameAstObj) {
    const body = filenameAstObj[filename]?.body
    if (!body) continue

    // 仅在文件导入了 gradio 时激活
    let hasGradio = hasGradioImport(body)

    const shortFileName = extractRelativePath(filename, dir)

    // 收集 import gradio as gr 的别名
    const importMap = analyzeGradioImports(body)
    const gradioLocalNames = new Set<string>()
    for (const [localName, canonical] of importMap) {
      if (canonical === 'gradio' || canonical.startsWith('gradio.')) {
        gradioLocalNames.add(localName)
      }
    }

    // fallback：直接 import 检测失败时，通过框架使用模式识别（如 with gr.Blocks()）
    // 覆盖间接 import 场景（from qwen_agent.gui import gr）
    if (!hasGradio) {
      const frameworkAliases = detectGradioFrameworkUsage(body)
      if (frameworkAliases.size > 0) {
        hasGradio = true
        for (const alias of frameworkAliases) {
          gradioLocalNames.add(alias)
        }
        logger.info(`[GRADIO-FALLBACK] ${shortFileName}: detected Gradio framework usage via ${[...frameworkAliases].join(', ')} (indirect import)`)
      }
    }

    if (!hasGradio) continue

    // 收集文件中所有函数定义（含嵌套在 with gr.Blocks() 内的）
    const funcDefs = new Map<string, any[]>()
    collectAllFunctionDefinitions(body, funcDefs, 0)

    // 收集文件中所有 Gradio 组件定义（如 url = gr.Textbox(...)）
    const componentMap = new Map<string, { lineStart: number; lineEnd: number }>()
    collectGradioComponentDefinitions(body, gradioLocalNames, componentMap, 0)
    if (componentMap.size > 0) {
      logger.info(`[GRADIO-COMP] ${shortFileName}: found ${componentMap.size} components: ${[...componentMap.keys()].join(', ')}`)
    }

    // 遍历 AST 查找事件绑定调用
    traverseForEventBindings(
      body,
      gradioLocalNames,
      funcDefs,
      componentMap,
      filename,
      shortFileName,
      gradioEntryPointArray,
      gradioEntryPointSourceArray,
      0
    )

    // 处理 gr.Interface(fn=..., inputs=...) 模式
    processInterfaceCalls(
      body,
      filename,
      shortFileName,
      gradioLocalNames,
      funcDefs,
      componentMap,
      gradioEntryPointArray,
      gradioEntryPointSourceArray
    )
  }

  return { gradioEntryPointArray, gradioEntryPointSourceArray }
}

export = {
  findGradioEntryPointAndSource,
}
