import type { CallInfo } from '../../../engine/analyzer/common/call-args'
import type { BaseNode, CallExpression, CompileUnit, Identifier, MemberAccess, Node } from '../../../types/uast'

const JsTaintChecker = require('./js-taint-checker')
const Config = require('../../../config')
const fs = require('fs')
const path = require('path')
const AstUtil = require('../../../util/ast-util')
const Constant = require('../../../util/constant')
const IntroduceTaint = require('../common-kit/source-util')

const TAINT_TAG_NAME_NODEJS_CLI = 'JS_INPUT'
const CHECKER_ID_NODEJS_CLI = 'taint_flow_nodejs_cli_input'

type EntryPointLike = {
  filePath?: string
  attribute?: string
  scopeVal?: unknown
  entryPointSymVal?: unknown
}

type AnalyzerLike = {
  entryPoints?: unknown[]
  fileManager?: Record<string, unknown>
  symbolTable?: Map<string, unknown>
}

type FileEntryLike = {
  uuid?: string
}

type FileSymbolLike = {
  ast?: { node?: Node }
}

type PackageJsonLike = {
  bin?: string | Record<string, string>
  scripts?: Record<string, string>
}

type MemberAccessInfo = {
  res?: unknown
  fclos?: unknown
}

type FunctionCallInfo = {
  fclos?: unknown
  callInfo?: CallInfo
  ret?: unknown
}

type TaintCarrierLike = {
  taint?: { isTaintedRec?: boolean }
  hasTagRec?: boolean
}

type FunctionEvidenceLike = {
  sid?: string
  qid?: string
  name?: string
  fsig?: string
  moduleName?: string
  packageName?: string
  importPath?: string
  loc?: { sourcefile?: string }
  object?: FunctionEvidenceLike
}

const CLI_PARSER_MODULES = new Set(['minimist', 'mri', 'arg'])
const CLI_FRAMEWORK_MODULES = new Set(['commander', 'yargs', 'yargs/yargs'])
const CLI_FRAMEWORK_RETURN_METHODS = new Set(['opts', 'parse', 'argv'])

function isIdentifier(node: Node | undefined): node is Identifier {
  return node?.type === 'Identifier'
}

function isMemberAccess(node: Node | undefined): node is MemberAccess {
  return node?.type === 'MemberAccess'
}

function isCallExpression(node: Node | undefined): node is CallExpression {
  return node?.type === 'CallExpression'
}

function isCompileUnit(node: Node | undefined): node is CompileUnit {
  return node?.type === 'CompileUnit'
}

function getSourcefile(node: BaseNode | undefined): string | undefined {
  return node?.loc?.sourcefile ?? undefined
}

function isProcessArgvAccess(node: Node | undefined): boolean {
  return AstUtil.prettyPrintAST(node) === 'process.argv'
}

function isProcessArgvDerivedCall(node: Node | undefined): boolean {
  if (!isCallExpression(node)) return false
  const callee = node.callee
  if (!isMemberAccess(callee)) return false
  const methodName = isIdentifier(callee.property) ? callee.property.name : ''
  if (methodName !== 'slice' && methodName !== 'at') return false
  return isProcessArgvAccess(callee.object)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getEvidenceText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const evidence = value as FunctionEvidenceLike
  return [evidence.sid, evidence.qid, evidence.name, evidence.fsig, evidence.moduleName, evidence.packageName, evidence.importPath]
    .filter((item): item is string => typeof item === 'string')
    .join(' ')
}

function hasModuleEvidence(value: unknown, modules: Set<string>): boolean {
  if (!value || typeof value !== 'object') return false
  const evidence = value as FunctionEvidenceLike
  const directModule = [evidence.moduleName, evidence.packageName, evidence.importPath]
    .some((item) => typeof item === 'string' && modules.has(item))
  if (directModule) return true
  const scopedText = [evidence.sid, evidence.qid, evidence.name, evidence.fsig]
    .filter((item): item is string => typeof item === 'string')
    .join(' ')
  if ([...modules].some((moduleName) => new RegExp(`(^|[\\s])(?:node_modules\\.)?${escapeRegExp(moduleName)}($|[\\s./:-])`).test(scopedText))) {
    return true
  }
  const objectEvidence = evidence.object
  return Boolean(objectEvidence && hasModuleEvidence(objectEvidence, modules))
}

function getCalleeName(node: Node | undefined): string {
  if (!node) return ''
  if (isIdentifier(node)) return node.name
  if (isMemberAccess(node) && isIdentifier(node.property)) return node.property.name
  return ''
}

function isKnownCliParserCall(node: Node | undefined, fclos: unknown): boolean {
  if (node && !isCallExpression(node)) return false
  const calleeName = getCalleeName(node?.callee)
  if (calleeName && CLI_PARSER_MODULES.has(calleeName) && hasModuleEvidence(fclos, CLI_PARSER_MODULES)) return true
  return hasModuleEvidence(fclos, CLI_PARSER_MODULES)
}

function isKnownCliFrameworkReturnCall(node: Node | undefined, fclos: unknown): boolean {
  if (node && !isCallExpression(node)) return false
  const calleeName = getCalleeName(node?.callee)
  if (!CLI_FRAMEWORK_RETURN_METHODS.has(calleeName)) return false
  return hasModuleEvidence(fclos, CLI_FRAMEWORK_MODULES)
}

function isArgvInputNode(node: Node | undefined): boolean {
  return isProcessArgvAccess(node) || isProcessArgvDerivedCall(node)
}

function isTaintedValue(value: unknown): boolean {
  const carrier = value as TaintCarrierLike | undefined
  return Boolean(carrier?.taint?.isTaintedRec || carrier?.hasTagRec)
}

function isKnownCliFrameworkArgvMemberAccess(node: Node | undefined, fclos: unknown): boolean {
  if (!isMemberAccess(node) || !isIdentifier(node.property) || node.property.name !== 'argv') return false
  const objectCall = node.object
  if (!isCallExpression(objectCall)) return false
  return hasModuleEvidence(fclos, CLI_FRAMEWORK_MODULES) && (objectCall.arguments ?? []).some((arg) => isArgvInputNode(arg))
}

function hasArgvInputArgument(node: Node | undefined, callInfo: CallInfo | undefined): boolean {
  const astArgs = isCallExpression(node) ? node.arguments : []
  if (astArgs.some((arg) => isArgvInputNode(arg))) return true
  return Boolean(callInfo?.callArgs?.args.some((arg) => isArgvInputNode(arg.node as Node | undefined) || isTaintedValue(arg.value)))
}

function normalizePathForCompare(filePath: string): string {
  return path.normalize(filePath).replace(/\\/g, '/')
}

function hasCliFilePathEvidence(filePath: string | undefined): boolean {
  return typeof filePath === 'string' && /(^|\/)(bin|cli)(\/|\.|$)/i.test(normalizePathForCompare(filePath))
}

function hasShebangEvidence(node: BaseNode | undefined): boolean {
  const runtimeNode = node as (BaseNode & { shebang?: string; interpreter?: string }) | undefined
  const shebang = runtimeNode?.shebang
  const interpreter = runtimeNode?.interpreter
  return (typeof shebang === 'string' && shebang.startsWith('#!')) ||
    (typeof interpreter === 'string' && interpreter.length > 0)
}

function getProjectRoot(filePath: string | undefined): string | undefined {
  if (typeof filePath !== 'string' || filePath.length === 0) return undefined
  const maindirPrefix = Config.maindirPrefix
  if (typeof maindirPrefix === 'string' && maindirPrefix.length > 0) return maindirPrefix
  return path.dirname(filePath)
}

function readPackageJson(projectRoot: string | undefined): PackageJsonLike | undefined {
  if (!projectRoot) return undefined
  const packageJsonPath = path.join(projectRoot, 'package.json')
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJsonLike
  } catch (_error: unknown) {
    return undefined
  }
}

function packageScriptReferencesFile(script: string, relativeFilePath: string): boolean {
  const normalizedScript = normalizePathForCompare(script)
  const normalizedRelative = normalizePathForCompare(relativeFilePath).replace(/^\.\//, '')
  return normalizedScript.includes(normalizedRelative) || normalizedScript.includes(`./${normalizedRelative}`)
}

function packageJsonHasFileEvidence(packageJson: PackageJsonLike | undefined, filePath: string | undefined, projectRoot: string | undefined): boolean {
  if (!packageJson || !filePath || !projectRoot) return false
  const relativeFilePath = normalizePathForCompare(path.relative(projectRoot, filePath))
  const binEntries = typeof packageJson.bin === 'string' ? [packageJson.bin] : Object.values(packageJson.bin ?? {})
  if (binEntries.some((binPath) => normalizePathForCompare(binPath).replace(/^\.\//, '') === relativeFilePath)) return true
  return Object.values(packageJson.scripts ?? {}).some((script) => packageScriptReferencesFile(script, relativeFilePath))
}

function hasCliNodeEvidence(node: BaseNode | undefined, packageJson?: PackageJsonLike, projectRoot?: string): boolean {
  const filePath = getSourcefile(node)
  return hasCliFilePathEvidence(filePath) || hasShebangEvidence(node) || packageJsonHasFileEvidence(packageJson, filePath, projectRoot)
}

function hasCliEntrypointEvidence(entryPoint: EntryPointLike | undefined, packageJson?: PackageJsonLike, projectRoot?: string): boolean {
  if (!entryPoint) return false
  if (entryPoint.attribute === 'nodejs-cli') return true
  return hasCliFilePathEvidence(entryPoint.filePath) || packageJsonHasFileEvidence(packageJson, entryPoint.filePath, projectRoot)
}

function getFileSymbolFromManager(analyzer: AnalyzerLike, fileEntry: unknown): FileSymbolLike | undefined {
  const fileUuid = typeof fileEntry === 'string' ? fileEntry : (fileEntry as FileEntryLike | undefined)?.uuid
  if (typeof fileUuid !== 'string') return undefined
  return analyzer.symbolTable?.get(fileUuid) as FileSymbolLike | undefined
}

/** Node.js CLI 独立 checker，仅在显式 pack 中标记命令行输入 source。 */
class NodejsCliTaintChecker extends JsTaintChecker {
  private packageJson: PackageJsonLike | undefined

  private projectRoot: string | undefined

  private readonly cliEvidenceSourcefiles = new Set<string>()

  constructor(resultManager: unknown) {
    super(resultManager, CHECKER_ID_NODEJS_CLI)
  }

  private markCliSource(target: unknown, path: BaseNode): void {
    IntroduceTaint.markTaintSource(target, { path, kind: TAINT_TAG_NAME_NODEJS_CLI })
  }

  private hasCompleteCliEvidence(node: BaseNode | undefined): boolean {
    const sourcefile = getSourcefile(node)
    return typeof sourcefile === 'string' && this.cliEvidenceSourcefiles.has(normalizePathForCompare(sourcefile))
  }

  private ensurePackageEvidence(node: BaseNode | undefined): void {
    if (this.packageJson) return
    this.projectRoot = getProjectRoot(getSourcefile(node))
    this.packageJson = readPackageJson(this.projectRoot)
  }

  private recordCliEvidenceForFile(node: CompileUnit | undefined): boolean {
    this.ensurePackageEvidence(node)
    if (!hasCliNodeEvidence(node, this.packageJson, this.projectRoot)) return false
    const sourcefile = getSourcefile(node)
    if (typeof sourcefile === 'string') {
      this.cliEvidenceSourcefiles.add(normalizePathForCompare(sourcefile))
    }
    return true
  }

  triggerAtStartOfAnalyze(analyzer: AnalyzerLike, scope: unknown, node: unknown, state: unknown, info: unknown): void {
    if (Config.analyzer !== 'JavaScriptAnalyzer') return
    const { topScope, fileManager } = analyzer as AnalyzerLike & { topScope?: unknown; fileManager?: Record<string, unknown> }
    this.prepareEntryPoints(analyzer, topScope, fileManager)
    analyzer.entryPoints?.push(...this.entryPoints)
  }

  prepareEntryPoints(analyzer: AnalyzerLike, topScope: unknown, fileManager: Record<string, unknown> | undefined): void {
    if (!fileManager) return

    for (const fileEntry of Object.values(fileManager)) {
      const file = getFileSymbolFromManager(analyzer, fileEntry)
      const node = file?.ast?.node
      if (!isCompileUnit(node) || !this.recordCliEvidenceForFile(node)) continue

      this.entryPoints.push({
        type: Constant.ENGIN_START_FILE_BEGIN,
        scopeVal: file,
        functionName: undefined,
        filePath: getSourcefile(node),
        attribute: 'nodejs-cli',
        entryPointSymVal: file,
      })
    }
  }

  triggerAtMemberAccess(analyzer: unknown, scope: unknown, node: MemberAccess, state: unknown, info: MemberAccessInfo): void {
    if (Config.analyzer !== 'JavaScriptAnalyzer') return
    if (Config.entryPointMode === 'ONLY_CUSTOM') return
    this.ensurePackageEvidence(node)
    if (!this.hasCompleteCliEvidence(node) || !info.res) return
    if (isProcessArgvAccess(node) || isKnownCliFrameworkArgvMemberAccess(node, info.fclos)) {
      this.markCliSource(info.res, node)
    }
  }

  triggerAtFunctionCallBefore(analyzer: unknown, scope: unknown, node: CallExpression, state: unknown, info: FunctionCallInfo): void {
    if (Config.analyzer !== 'JavaScriptAnalyzer') return
    this.checkSinkAtFunctionCall(node, info.fclos, info.callInfo, state)
    this.checkByFieldMatch(node, info.fclos, info.callInfo, scope, state)
  }

  triggerAtFunctionCallAfter(analyzer: unknown, scope: unknown, node: CallExpression, state: unknown, info: FunctionCallInfo): void {
    if (Config.analyzer !== 'JavaScriptAnalyzer') return
    if (Config.entryPointMode === 'ONLY_CUSTOM' || !info.ret) return
    this.ensurePackageEvidence(node)
    if (!this.hasCompleteCliEvidence(node)) return
    if (isProcessArgvDerivedCall(node)) {
      this.markCliSource(info.ret, node)
      return
    }
    if (isKnownCliParserCall(node, info.fclos) && hasArgvInputArgument(node, info.callInfo)) {
      this.markCliSource(info.ret, node)
      return
    }
    if (isKnownCliFrameworkReturnCall(node, info.fclos)) {
      this.markCliSource(info.ret, node)
    }
  }
}

module.exports = NodejsCliTaintChecker
module.exports.hasCliEntrypointEvidence = hasCliEntrypointEvidence
module.exports.hasCliNodeEvidence = hasCliNodeEvidence
module.exports.isProcessArgvAccess = isProcessArgvAccess
module.exports.isProcessArgvDerivedCall = isProcessArgvDerivedCall
module.exports.hasModuleEvidence = hasModuleEvidence
module.exports.hasArgvInputArgument = hasArgvInputArgument
module.exports.isKnownCliParserCall = isKnownCliParserCall
module.exports.isKnownCliFrameworkReturnCall = isKnownCliFrameworkReturnCall
module.exports.isKnownCliFrameworkArgvMemberAccess = isKnownCliFrameworkArgvMemberAccess
