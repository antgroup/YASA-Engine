import type { Value } from '../../../../types/analyzer'
import type { TraceItem } from '../../../../util/finding-util'
import type { CallArg, CallArgKind, CallInfo } from '../../common/call-args'
import type { PythonFrameworkCallContext } from '../framework-call-model'

const { lodashCloneWithTag } = require('../../../../util/clone-util')
const AstUtil = require('../../../../util/ast-util')
const { UndefinedValue } = require('../../../util/value-util').ValueUtil
const _ = require('lodash')

const GRADIO_EVENT_METHODS = new Set([
  'click', 'submit', 'change', 'input', 'select', 'upload',
])

const GRADIO_COMPONENT_TYPES = new Set([
  'Textbox', 'Number', 'Slider', 'Checkbox', 'CheckboxGroup',
  'Radio', 'Dropdown', 'Image', 'Video', 'Audio', 'File',
  'DataFrame', 'JSON', 'HTML', 'Markdown', 'Code', 'Button',
  'Chatbot', 'Gallery', 'Label', 'Plot', 'HighlightedText',
])

type UnknownRecord = Record<string, unknown>
type GradioComponentCarrier = Value & { __yasaGradioComponent?: boolean }

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' ? value as UnknownRecord : undefined
}

function getStringField(value: unknown, field: string): string | undefined {
  const record = asRecord(value)
  const raw = record?.[field]
  return typeof raw === 'string' ? raw : undefined
}

function getNestedField(value: unknown, field: string): unknown {
  return asRecord(value)?.[field]
}

function getSourceFileFromLoc(loc: unknown): string | undefined {
  const sourcefile = asRecord(loc)?.sourcefile
  return typeof sourcefile === 'string' ? sourcefile : undefined
}

function normalizeTraceNode(node: unknown): TraceItem['node'] {
  const record = asRecord(node)
  if (!record) return undefined
  const loc = asRecord(record.loc)
  if (!loc) return record as TraceItem['node']
  return {
    ...record,
    loc: {
      ...loc,
      sourcefile: getSourceFileFromLoc(loc),
    },
  } as TraceItem['node']
}

function isGradioModuleValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false
  const record = asRecord(value)
  if (!record) return false
  const sid = getStringField(record, 'sid')
  const qid = getStringField(record, 'qid')
  if (sid === 'gradio' || qid === 'gradio') return true
  if (sid?.startsWith('gradio.') || qid?.startsWith('gradio.')) return true
  return isGradioModuleValue(record.parent, depth + 1)
}

function getIdentifierOrLiteralName(value: unknown): string | undefined {
  return getStringField(value, 'name') ?? getStringField(value, 'value')
}

function isGradioComponentConstructor(context: PythonFrameworkCallContext): boolean {
  const { node, fclos } = context
  if (node.callee?.type === 'MemberAccess') {
    const componentName = getIdentifierOrLiteralName(node.callee.property)
    if (!componentName || !GRADIO_COMPONENT_TYPES.has(componentName)) return false
    return isGradioModuleValue(getNestedField(fclos, '_this')) || isGradioModuleValue(getNestedField(fclos, 'object'))
  }
  if (node.callee?.type === 'Identifier' && GRADIO_COMPONENT_TYPES.has(node.callee.name)) {
    return isGradioModuleValue(getNestedField(fclos, 'parent'))
  }
  return false
}

function extractListElements(listValue: unknown): unknown[] {
  const record = asRecord(listValue)
  if (!record) return []
  const rawValue = record.value
  const valueRecord = asRecord(rawValue)
  if (valueRecord && !Array.isArray(rawValue)) {
    const rawLength = record.length
    const len = typeof rawLength === 'number'
      ? rawLength
      : Object.keys(valueRecord).filter((key: string) => /^\d+$/.test(key)).length
    const result: unknown[] = []
    for (let i = 0; i < len; i++) {
      result.push(valueRecord[i] ?? new UndefinedValue())
    }
    return result
  }
  if (Array.isArray(rawValue)) {
    return [...rawValue]
  }
  const members = record.members
  if (members instanceof Map && members.size > 0) {
    const numericKeys = [...members.keys()]
      .filter((key: unknown): key is string => typeof key === 'string' && /^\d+$/.test(key))
      .sort((a: string, b: string) => Number(a) - Number(b))
    if (numericKeys.length > 0) {
      return numericKeys.map((key: string) => members.get(key))
    }
  }
  return []
}

function isGradioComponentValue(value: unknown): boolean {
  const record = asRecord(value)
  if (!record) return false
  if ((record as GradioComponentCarrier).__yasaGradioComponent === true) return true
  const nestedValue = asRecord(record.value)?.value ?? record.value
  return Boolean((asRecord(nestedValue) as GradioComponentCarrier | undefined)?.__yasaGradioComponent === true)
}

function getGradioEventReceiver(fclos: unknown): unknown {
  const record = asRecord(fclos)
  const valueRecord = asRecord(record?.value)
  const candidates = [record?.object, record?._this, record?.parent, valueRecord?.object]
  return candidates.find(isGradioComponentValue)
}

function markGradioComponentSource(context: PythonFrameworkCallContext): void {
  const { node, res } = context
  if (!res?.taint || !isGradioComponentConstructor(context)) return
  ;(res as GradioComponentCarrier).__yasaGradioComponent = true
  res.taint.addTag('PYTHON_INPUT')
  if (res.taint.hasTraces()) return
  const startLine = node.loc?.start?.line
  const endLine = node.loc?.end?.line
  const tline = startLine === endLine ? startLine : (startLine && endLine ? _.range(startLine, endLine + 1) : startLine)
  res.taint.setAllTraces([{
    file: getSourceFileFromLoc(node.loc),
    line: tline,
    node: normalizeTraceNode(node),
    tag: 'SOURCE: ',
    affectedNodeName: AstUtil.prettyPrint(node),
  }])
}

function handleGradioEventBinding(context: PythonFrameworkCallContext): void {
  const { analyzer, scope, node, state, fclos, argvalues, callInfo, collectedArgs } = context
  const gradioEventReceiver = node.callee?.type === 'MemberAccess' ? getGradioEventReceiver(fclos) : undefined
  if (
    !gradioEventReceiver ||
    node.callee?.type !== 'MemberAccess' ||
    node.callee.property?.type !== 'Identifier' ||
    !GRADIO_EVENT_METHODS.has(node.callee.property.name)
  ) {
    return
  }

  let gradioCallback: Value | undefined
  let gradioInputValues: unknown[] = []
  if (callInfo.callArgs?.args) {
    for (const arg of callInfo.callArgs.args) {
      if (arg.kind === 'keyword' && arg.name === 'fn') {
        gradioCallback = arg.value
      } else if (arg.kind === 'keyword' && arg.name === 'inputs') {
        gradioInputValues = extractListElements(arg.value)
      }
    }
  }
  if (!gradioCallback && argvalues.length >= 1) {
    gradioCallback = argvalues[0]
  }
  if (gradioInputValues.length === 0 && argvalues.length >= 2) {
    gradioInputValues = extractListElements(argvalues[1])
  }
  if (!gradioCallback || typeof gradioCallback !== 'object' || !('vtype' in gradioCallback)) return

  let inputAstNodes: unknown[] = []
  if (collectedArgs.length >= 2) {
    const inputsArg = asRecord(collectedArgs[1])
    const properties = inputsArg?.properties
    if (inputsArg?.type === 'ObjectExpression' && Array.isArray(properties)) {
      inputAstNodes = properties
    }
  }

  const clonedInputValues: Value[] = []
  for (let i = 0; i < gradioInputValues.length; i++) {
    const inputVal = gradioInputValues[i]
    const inputRecord = asRecord(inputVal)
    if (inputRecord?.taint) {
      const clonedVal = lodashCloneWithTag(inputVal) as Value
      clonedInputValues.push(clonedVal)
      clonedVal.taint.addTag('PYTHON_INPUT')
      const inputNode = inputAstNodes[i]
      const traceNode = inputNode || node
      const traceRecord = asRecord(traceNode)
      const loc = asRecord(traceRecord?.loc)
      const start = asRecord(loc?.start)
      const end = asRecord(loc?.end)
      const startLine = typeof start?.line === 'number' ? start.line : undefined
      const endLine = typeof end?.line === 'number' ? end.line : undefined
      const tline = startLine === endLine ? startLine : (startLine && endLine ? _.range(startLine, endLine + 1) : startLine)
      clonedVal.taint.setAllTraces([{
        file: getSourceFileFromLoc(loc),
        line: tline,
        node: normalizeTraceNode(traceNode),
        tag: 'SOURCE: ',
        affectedNodeName: AstUtil.prettyPrint(traceNode),
      }])
    } else {
      clonedInputValues.push(inputVal as Value)
    }
  }

  const syntheticCallArgs: CallArg[] = clonedInputValues.map((val, idx) => ({
    index: idx,
    value: val,
    kind: 'positional' as CallArgKind,
  }))
  const syntheticCallInfo: CallInfo = { callArgs: { args: syntheticCallArgs } }
  analyzer.executeCall(node, gradioCallback, state, scope, syntheticCallInfo)
}

export function handleGradioCall(context: PythonFrameworkCallContext): void {
  markGradioComponentSource(context)
  handleGradioEventBinding(context)
}
