import type { Value } from '../../../types/analyzer'
import type { CallArg, CallInfo } from './call-args'

const FileUtil = require('../../../util/file-util') as {
  getAbsolutePath: (path: string) => string
  loadJSONfile: (path: string) => unknown
}
const path = require('path') as typeof import('path')
const fs = require('fs') as typeof import('fs')

const DEFAULT_CALLBACK_MODEL_RESOURCE = 'resource/callback-model/callback-api-model.json'
const callbackApiModelCache = new Map<string, CallbackApiModel[]>()

export type CallbackModelLanguage = 'python' | 'java' | 'javascript'
type CallbackArgumentMapping = 'tail'
type CallbackResultPolicy = 'ignore'
type CallbackDispatchPolicy = 'short-circuit-generic-fallback'

export interface CallbackApiModel {
  id: string
  language: CallbackModelLanguage
  matcher: {
    method: string
    receiverIdentities: string[]
    minArgs?: number
  }
  callback: {
    index?: number
    keyword?: string
  }
  argumentMapping: CallbackArgumentMapping
  receiverPolicy: 'preserve-callback-receiver'
  resultPolicy: CallbackResultPolicy
  dispatchPolicy: CallbackDispatchPolicy
}

interface CallbackApiModelResource {
  version: number
  models: unknown[]
}

export interface CallbackModelMatchInput {
  language: CallbackModelLanguage
  methodName: string
  receiverIdentities: string[]
  callInfo: CallInfo
}

export type CallbackExecutionResult =
  | { status: 'completed' }
  | { status: 'failed' }
  | { status: 'incomplete' }

export interface CallbackModelDispatchInput extends CallbackModelMatchInput {
  execute: (callback: Value, callInfo: CallInfo) => CallbackExecutionResult
}

export interface CallbackExecutionInfo {
  callback: Value
  callInfo: CallInfo
}

function isLanguage(value: unknown): value is CallbackModelLanguage {
  return value === 'python' || value === 'java' || value === 'javascript'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)
}

function isCallbackApiModel(value: unknown): value is CallbackApiModel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const model = value as Partial<CallbackApiModel>
  const callback = model.callback
  const hasIndex = Number.isInteger(callback?.index) && callback!.index! >= 0
  const hasKeyword = typeof callback?.keyword === 'string' && callback.keyword.length > 0
  return typeof model.id === 'string' &&
    model.id.length > 0 &&
    isLanguage(model.language) &&
    typeof model.matcher?.method === 'string' &&
    model.matcher.method.length > 0 &&
    isStringArray(model.matcher.receiverIdentities) &&
    model.matcher.receiverIdentities.length > 0 &&
    (model.matcher.minArgs === undefined || (Number.isInteger(model.matcher.minArgs) && model.matcher.minArgs >= 1)) &&
    !!callback &&
    hasIndex !== hasKeyword &&
    model.argumentMapping === 'tail' &&
    model.receiverPolicy === 'preserve-callback-receiver' &&
    model.resultPolicy === 'ignore' &&
    model.dispatchPolicy === 'short-circuit-generic-fallback'
}

export function parseCallbackApiModelResource(resource: unknown, language: CallbackModelLanguage): CallbackApiModel[] {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return []
  const parsed = resource as Partial<CallbackApiModelResource>
  if (parsed.version !== 1 || !Array.isArray(parsed.models)) return []
  return parsed.models.filter(isCallbackApiModel).filter((model) => model.language === language)
}

function resolveCallbackApiModelResource(resourcePath: string): string {
  const resolved = FileUtil.getAbsolutePath(resourcePath)
  if (fs.existsSync(resolved) || resourcePath !== DEFAULT_CALLBACK_MODEL_RESOURCE) return resolved
  return path.resolve(__dirname, '../../../../resource/callback-model/callback-api-model.json')
}

export function loadCallbackApiModels(language: CallbackModelLanguage, resourcePath = DEFAULT_CALLBACK_MODEL_RESOURCE): CallbackApiModel[] {
  const absolutePath = resolveCallbackApiModelResource(resourcePath)
  const cached = callbackApiModelCache.get(absolutePath)
  if (cached) return cached.filter((model) => model.language === language)

  let resource: unknown
  try {
    resource = FileUtil.loadJSONfile(absolutePath)
  } catch {
    callbackApiModelCache.set(absolutePath, [])
    return []
  }

  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    callbackApiModelCache.set(absolutePath, [])
    return []
  }
  const parsed = resource as Partial<CallbackApiModelResource>
  if (parsed.version !== 1 || !Array.isArray(parsed.models)) {
    callbackApiModelCache.set(absolutePath, [])
    return []
  }
  const models = parsed.models.filter(isCallbackApiModel)
  callbackApiModelCache.set(absolutePath, models)
  return models.filter((model) => model.language === language)
}

export function clearCallbackApiModelCache(): void {
  callbackApiModelCache.clear()
}

function findCallbackArg(model: CallbackApiModel, args: CallArg[]): CallArg | undefined {
  if (model.callback.index !== undefined) return args.find((arg) => arg.index === model.callback.index)
  return args.find((arg) => arg.kind === 'keyword' && arg.name === model.callback.keyword)
}

function rebaseTailArgs(model: CallbackApiModel, args: CallArg[], callbackArg: CallArg): CallArg[] {
  if (model.argumentMapping !== 'tail') return []
  return args
    .filter((arg) => arg !== callbackArg && arg.index > callbackArg.index)
    .map((arg, index) => ({ ...arg, index }))
}

export function findCallbackApiModel(input: CallbackModelMatchInput, models = loadCallbackApiModels(input.language)): CallbackApiModel | undefined {
  const args = input.callInfo.callArgs?.args
  if (!args) return undefined
  return models.find((model) => {
    if (model.language !== input.language) return false
    if (model.matcher.method !== input.methodName) return false
    if (args.length < (model.matcher.minArgs ?? 1)) return false
    if (!model.matcher.receiverIdentities.some((identity) => input.receiverIdentities.includes(identity))) return false
    return !!findCallbackArg(model, args)
  })
}

function isExecutableCallback(value: Value | undefined): value is Value {
  if (!value) return false
  if (value.vtype === 'fclos') return true
  return value.vtype === 'union' && Array.isArray(value.value) && value.value.some((member: Value | undefined) => member?.vtype === 'fclos')
}

export function buildCallbackCallInfo(model: CallbackApiModel, callInfo: CallInfo): { callback: Value, callInfo: CallInfo } | undefined {
  const args = callInfo.callArgs?.args
  if (!args) return undefined
  const callbackArg = findCallbackArg(model, args)
  if (!callbackArg || !isExecutableCallback(callbackArg.value)) return undefined
  return {
    callback: callbackArg.value,
    callInfo: {
      callsiteNode: callInfo.callsiteNode,
      callArgs: {
        receiver: callbackArg.value._this,
        node: callInfo.callArgs?.node,
        args: rebaseTailArgs(model, args, callbackArg),
      },
    },
  }
}

export function getCallbackApiExecution(input: CallbackModelMatchInput, models = loadCallbackApiModels(input.language)): CallbackExecutionInfo | undefined {
  const model = findCallbackApiModel(input, models)
  return model ? buildCallbackCallInfo(model, input.callInfo) : undefined
}

export function dispatchCallbackApiModel(input: CallbackModelDispatchInput, models = loadCallbackApiModels(input.language)): boolean {
  const callbackCall = getCallbackApiExecution(input, models)
  if (!callbackCall) return false
  return input.execute(callbackCall.callback, callbackCall.callInfo).status === 'completed'
}
