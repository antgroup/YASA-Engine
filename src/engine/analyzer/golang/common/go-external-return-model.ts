import type { Value } from '../../../../types/analyzer'
import type { CallExpression, Node } from '../../../../types/uast'

const FileUtil = require('../../../../util/file-util') as GoModelFileUtil
const AstUtil = require('../../../../util/ast-util') as { prettyPrintAST: (node: unknown) => string }

export interface GoTypeAstNode {
  type: string
  name?: string
  element?: GoTypeAstNode
  argument?: GoTypeAstNode
  property?: { name?: string } | GoTypeAstNode
  object?: GoTypeAstNode
  [key: string]: unknown
}

export interface GoExternalReturnModel {
  returnTypes: GoTypeAstNode[]
  packageAliases?: string[]
  importPaths?: string[]
  calleeNames?: string[]
  canonicalCallee?: string
}

interface GoExternalReturnCallCandidate {
  key: string
  qualifier?: string
  calleeName?: string
}

interface GoCallNameNode {
  type?: string
  name?: string
  value?: string
  sid?: string
  object?: GoCallNameNode
  property?: GoCallNameNode
  qid?: string
}

interface GoModelFileUtil {
  getAbsolutePath: (p: string) => string
  loadJSONfile: (filename: string) => unknown
}

type GoModelValue = Value & {
  sid?: unknown
  name?: unknown
  property?: { name?: unknown; value?: unknown; sid?: unknown }
  object?: Value | null
}

function isGoTypeAstNode(value: unknown): value is GoTypeAstNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown): item is string => typeof item === 'string')
}

function isGoExternalReturnModel(value: unknown): value is GoExternalReturnModel {
  const model = value as { returnTypes?: unknown; packageAliases?: unknown; importPaths?: unknown; calleeNames?: unknown } | null
  return Array.isArray(model?.returnTypes) &&
    model.returnTypes.every(isGoTypeAstNode) &&
    (model.packageAliases === undefined || isStringArray(model.packageAliases)) &&
    (model.importPaths === undefined || isStringArray(model.importPaths)) &&
    (model.calleeNames === undefined || isStringArray(model.calleeNames))
}

function loadGoExternalReturnModels(): Record<string, GoExternalReturnModel> {
  const modelPath = FileUtil.getAbsolutePath('resource/golang/external-return-models.json')
  const rawModels = FileUtil.loadJSONfile(modelPath)
  if (!rawModels || typeof rawModels !== 'object' || Array.isArray(rawModels)) return {}

  const models: Record<string, GoExternalReturnModel> = {}
  for (const [callee, model] of Object.entries(rawModels as Record<string, unknown>)) {
    if (isGoExternalReturnModel(model)) models[callee] = { ...model, canonicalCallee: callee }
  }
  return models
}

function getMemberName(property: { name?: unknown; value?: unknown; sid?: unknown } | null | undefined): string | null {
  if (!property) return null
  if (typeof property.name === 'string') return property.name
  if (typeof property.value === 'string') return property.value
  if (typeof property.sid === 'string') return property.sid
  return null
}

export class GoExternalReturnModelResolver {
  private readonly models: Record<string, GoExternalReturnModel>

  constructor(models: Record<string, GoExternalReturnModel> = loadGoExternalReturnModels()) {
    this.models = models
  }

  findForFclos(fclos: Value | null | undefined): GoExternalReturnModel | null {
    return this.find(this.getFclosCandidates(fclos))
  }

  findForCallNode(node: CallExpression): GoExternalReturnModel | null {
    return this.find(this.getCallNodeCandidates(node))
  }

  formatCallQid(node: CallExpression, model?: GoExternalReturnModel): string {
    const rendered = AstUtil.prettyPrintAST(node)
    const canonicalCallee = model?.canonicalCallee
    if (!canonicalCallee || !this.matchesCallNode(node, model)) return rendered
    const args = Array.isArray(node.arguments) ? node.arguments.map((arg: Node) => AstUtil.prettyPrintAST(arg)).join(', ') : ''
    return `${canonicalCallee}(${args})`
  }

  private find(candidates: GoExternalReturnCallCandidate[]): GoExternalReturnModel | null {
    for (const candidate of candidates) {
      for (const [modelKey, model] of Object.entries(this.models)) {
        if (this.matches(candidate, modelKey, model)) return model
      }
    }
    return null
  }

  private getFclosCandidates(fclos: Value | null | undefined): GoExternalReturnCallCandidate[] {
    const candidates = new Map<string, GoExternalReturnCallCandidate>()
    const addCandidate = (rawKey: unknown): void => {
      const candidate = this.makeCandidate(rawKey)
      if (candidate) candidates.set(candidate.key, candidate)
    }
    const modelFclos = fclos as GoModelValue | null | undefined
    for (const rawKey of [modelFclos?.qid, modelFclos?.sid, modelFclos?.name]) addCandidate(rawKey)
    const propertyName = getMemberName(modelFclos?.property)
    if (propertyName && modelFclos?.object) {
      for (const receiverKey of this.getReceiverKeys(modelFclos.object)) addCandidate(`${receiverKey}.${propertyName}`)
    }
    return Array.from(candidates.values())
  }

  private getCallNodeCandidates(node: CallExpression): GoExternalReturnCallCandidate[] {
    const candidates = new Map<string, GoExternalReturnCallCandidate>()
    const addCandidate = (rawKey: unknown): void => {
      const candidate = this.makeCandidate(rawKey)
      if (candidate) candidates.set(candidate.key, candidate)
    }
    const callee = node.callee as GoCallNameNode | null | undefined
    for (const rawKey of [callee?.qid, callee?.sid, callee?.name]) addCandidate(rawKey)
    const renderedCallee = callee ? this.renderCallNamePath(callee) : AstUtil.prettyPrintAST(node.callee).trim()
    addCandidate(renderedCallee)
    if (callee?.type === 'MemberAccess') {
      const propertyName = getMemberName(callee.property)
      const objectPath = this.renderCallNamePath(callee.object)
      if (propertyName && objectPath) addCandidate(`${objectPath}.${propertyName}`)
    }
    return Array.from(candidates.values())
  }

  private getReceiverKeys(value: Value | null | undefined): string[] {
    if (!value) return []
    const modelValue = value as GoModelValue
    return [modelValue.sid, modelValue.qid, modelValue.name]
      .map((part: unknown) => this.normalizeKey(part))
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
  }

  private normalizeKey(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const normalized = value
      .replace(/<instance_[^>]*>/g, '')
      .replace(/<global>\.?/g, '')
      .replace(/\.exports$/g, '')
      .trim()
    return normalized.length > 0 ? normalized : null
  }

  private makeCandidate(rawKey: unknown): GoExternalReturnCallCandidate | null {
    const key = this.normalizeKey(rawKey)
    if (!key) return null
    const dotIndex = key.lastIndexOf('.')
    if (dotIndex < 0) return { key, calleeName: key }
    const qualifier = key.slice(0, dotIndex)
    const calleeName = key.slice(dotIndex + 1)
    return { key, qualifier, calleeName }
  }

  private renderCallNamePath(node: GoCallNameNode | null | undefined): string | null {
    if (!node) return null
    if (node.type === 'MemberAccess') {
      const objectPath = this.renderCallNamePath(node.object)
      const propertyName = this.renderCallNamePath(node.property)
      return objectPath && propertyName ? `${objectPath}.${propertyName}` : objectPath ?? propertyName
    }
    const rawName = typeof node.name === 'string' ? node.name : typeof node.value === 'string' ? node.value : node.sid
    return this.normalizeKey(rawName) ?? AstUtil.prettyPrintAST(node).trim()
  }

  private matches(candidate: GoExternalReturnCallCandidate, modelKey: string, model: GoExternalReturnModel): boolean {
    if (candidate.key === modelKey || candidate.key.endsWith(`.${modelKey}`)) return true
    const calleeNames = this.getCalleeNames(modelKey, model)
    if (!candidate.calleeName || !calleeNames.has(candidate.calleeName)) return false
    const qualifiers = this.getQualifiers(modelKey, model, calleeNames)
    if (!candidate.qualifier) return qualifiers.size === 0
    if (qualifiers.has(candidate.qualifier)) return true
    for (const qualifier of qualifiers) {
      if (candidate.qualifier.endsWith(`.${qualifier}`)) return true
    }
    return false
  }

  private matchesCallNode(node: CallExpression, model: GoExternalReturnModel): boolean {
    return this.getCallNodeCandidates(node).some((candidate: GoExternalReturnCallCandidate) => {
      const canonicalCallee = model.canonicalCallee ?? ''
      return this.matches(candidate, canonicalCallee, model)
    })
  }

  private getCalleeNames(modelKey: string, model: GoExternalReturnModel): Set<string> {
    const calleeNames = new Set<string>(model.calleeNames ?? [])
    const dotIndex = modelKey.lastIndexOf('.')
    calleeNames.add(dotIndex >= 0 ? modelKey.slice(dotIndex + 1) : modelKey)
    return calleeNames
  }

  private getQualifiers(modelKey: string, model: GoExternalReturnModel, calleeNames: Set<string>): Set<string> {
    const qualifiers = new Set<string>([...(model.packageAliases ?? []), ...(model.importPaths ?? [])])
    for (const calleeName of calleeNames) {
      if (modelKey.endsWith(`.${calleeName}`)) {
        const qualifier = modelKey.slice(0, -calleeName.length - 1)
        if (qualifier.length > 0) qualifiers.add(qualifier)
      }
    }
    return qualifiers
  }
}

export const goExternalReturnModelResolver = new GoExternalReturnModelResolver()
