const { PythonTaintAbstractChecker, loadPythonDefaultRule } = require('./python-taint-abstract-checker')
const Config = require('../../../config')
const { markTaintSource } = require('../common-kit/source-util')
const AstUtil = require('../../../util/ast-util')

type EntryPointLike = {
  filePath?: string
}

type AnalyzerLike = {
  entryPoints: EntryPointLike[]
}

type AstNodeLike = {
  loc?: {
    sourcefile?: string
  }
  sourcefile?: string
}

type FunctionClosureLike = {
  qid?: string
}

type FunctionCallAfterInfo = {
  fclos?: FunctionClosureLike
  ret?: unknown
}

type MemberAccessInfo = {
  res?: unknown
}

type RuleConfigBlock = {
  sources?: Record<string, unknown>
  sinks?: Record<string, unknown>
  sanitizers?: Record<string, unknown>
  entrypoints?: Record<string, unknown>
}

// fclos.qid 匹配规则
const ARGPARSE_QID_PATTERN = /\.argparse\.ArgumentParser\(.*\)\.(parse_args|parse_known_args)$/
const OPTPARSE_QID_PATTERN = /\.optparse\.OptionParser\(.*\)\.(parse_args|parse_known_args)$/
const INPUT_QID_PATTERN = /\.(input|raw_input)$/
const GETOPT_QID_PATTERN = /\.getopt\.(getopt|gnu_getopt)$/
const OS_GETENV_QID_PATTERN = /\.os\.getenv$/
const OS_ENVIRON_GET_QID_PATTERN = /\.os\.environ\.get$/
const SYS_STDIN_QID_PATTERN = /\.sys\.stdin\.(read|readline|readlines)$/

// 文件 I/O source：open() / io.open() / codecs.open() 返回文件句柄，携带本地文件内容
const FILE_OPEN_QID_PATTERN = /\.(open|io\.open|codecs\.open)$/
// pathlib 文件读取
const PATHLIB_READ_QID_PATTERN = /\.Path.*\.(read_text|read_bytes|read)$/

const SCRIPT_SOURCE_QID_PATTERNS = [
  ARGPARSE_QID_PATTERN,
  OPTPARSE_QID_PATTERN,
  INPUT_QID_PATTERN,
  GETOPT_QID_PATTERN,
  OS_GETENV_QID_PATTERN,
  OS_ENVIRON_GET_QID_PATTERN,
  SYS_STDIN_QID_PATTERN,
  FILE_OPEN_QID_PATTERN,
  PATHLIB_READ_QID_PATTERN,
]

function mergeRuleSection(target: Record<string, unknown>, source?: Record<string, unknown>): void {
  if (!source) return
  for (const [key, value] of Object.entries(source)) {
    const current = target[key]
    if (Array.isArray(current) && Array.isArray(value)) {
      target[key] = current.concat(value)
    } else if (current && value && typeof current === 'object' && typeof value === 'object' && !Array.isArray(current) && !Array.isArray(value)) {
      mergeRuleSection(current as Record<string, unknown>, value as Record<string, unknown>)
    } else if (typeof value !== 'undefined') {
      target[key] = value
    }
  }
}

function mergeRuleConfigBlock(target: RuleConfigBlock, source?: RuleConfigBlock): void {
  if (!source) return
  target.sources = target.sources || {}
  target.sinks = target.sinks || {}
  target.sanitizers = target.sanitizers || {}
  target.entrypoints = target.entrypoints || {}
  mergeRuleSection(target.sources, source.sources)
  mergeRuleSection(target.sinks, source.sinks)
  mergeRuleSection(target.sanitizers, source.sanitizers)
  mergeRuleSection(target.entrypoints, source.entrypoints)
}

function normalizePathForSkillCheck(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

const SKILL_SCRIPT_PATH_SEGMENTS = ['.claude/skills/', '.codex/skills/', '.codefuse/skills/', '.skills/']

function isSkillPythonScriptPath(filePath: string, projectRoot?: string): boolean {
  const normalizedFilePath = normalizePathForSkillCheck(filePath)
  const normalizedRoot = projectRoot ? normalizePathForSkillCheck(projectRoot).replace(/\/+$/, '') : undefined
  const relativeOrAbsolutePath =
    normalizedRoot && normalizedFilePath.startsWith(`${normalizedRoot}/`)
      ? normalizedFilePath.slice(normalizedRoot.length + 1)
      : normalizedFilePath
  return SKILL_SCRIPT_PATH_SEGMENTS.some((segment: string) => relativeOrAbsolutePath.includes(segment))
}

/**
 * Python 脚本污点追踪 checker
 * Source: argparse.parse_args(), sys.argv, input(), os.environ, getopt, open() 等
 * Entrypoint: 文件级入口（脚本从文件头开始执行）
 */
class ScriptTaintChecker extends PythonTaintAbstractChecker {
  protected readonly skillPathOnly: boolean

  constructor(resultManager: unknown, checkerId = 'taint_flow_python_script_input', skillPathOnly = false) {
    super(resultManager, checkerId)
    this.skillPathOnly = skillPathOnly
    if (this.skillPathOnly) {
      mergeRuleConfigBlock(this.checkerRuleConfigContent, loadPythonDefaultRule()?.[0])
    }
  }

  triggerAtStartOfAnalyze(analyzer: AnalyzerLike, scope: unknown, node: unknown, state: unknown, info: unknown): void {
    this.addSourceTagForcheckerRuleConfigContent('PYTHON_INPUT', this.checkerRuleConfigContent)
    if (Config.entryPointMode === 'ONLY_CUSTOM') return
    const fullCallGraphFileEntryPoint = require('../../common/full-callgraph-file-entrypoint')
    let fullFileEntrypoint: EntryPointLike[] = fullCallGraphFileEntryPoint.getAllFileEntryPointsUsingFileManager(analyzer)
    if (this.skillPathOnly) {
      fullFileEntrypoint = fullFileEntrypoint.filter((entryPoint) => this.shouldAnalyzeFile(entryPoint.filePath))
    }
    analyzer.entryPoints.push(...fullFileEntrypoint)
  }

  triggerAtFunctionCallAfter(
    analyzer: unknown,
    scope: unknown,
    node: AstNodeLike,
    state: unknown,
    info: FunctionCallAfterInfo
  ): void {
    super.triggerAtFunctionCallAfter(analyzer, scope, node, state, info)
    const { fclos, ret } = info
    if (Config.entryPointMode === 'ONLY_CUSTOM' || !fclos || !ret) return
    if (!this.shouldAnalyzeNode(node)) return

    const { qid } = fclos
    if (typeof qid !== 'string') return

    for (const pattern of SCRIPT_SOURCE_QID_PATTERNS) {
      if (pattern.test(qid)) {
        markTaintSource(ret, { path: node, kind: 'PYTHON_INPUT' })
        return
      }
    }
  }

  triggerAtMemberAccess(
    analyzer: unknown,
    scope: unknown,
    node: AstNodeLike,
    state: unknown,
    info: MemberAccessInfo
  ): void {
    if (Config.entryPointMode === 'ONLY_CUSTOM') return
    if (!this.shouldAnalyzeNode(node)) return

    // sys.argv
    if (AstUtil.prettyPrintAST(node) === 'sys.argv') {
      markTaintSource(info.res, { path: node, kind: 'PYTHON_INPUT' })
    }

    // os.environ
    if (AstUtil.prettyPrintAST(node) === 'os.environ') {
      markTaintSource(info.res, { path: node, kind: 'PYTHON_INPUT' })
    }
  }

  protected shouldAnalyzeNode(node: AstNodeLike): boolean {
    return this.shouldAnalyzeFile(node.loc?.sourcefile || node.sourcefile)
  }

  protected shouldAnalyzeFile(filePath?: string): boolean {
    if (!this.skillPathOnly) return true
    return typeof filePath === 'string' && isSkillPythonScriptPath(filePath, Config.maindir)
  }
}

module.exports = ScriptTaintChecker
module.exports.isSkillPythonScriptPath = isSkillPythonScriptPath
