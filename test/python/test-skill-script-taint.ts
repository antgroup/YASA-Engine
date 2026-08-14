import * as assert from 'assert'
import { describe, it } from 'mocha'

const Config = require('../../src/config')
const ResultManager = require('../../src/engine/analyzer/common/result-manager')
const BasicRuleHandler = require('../../src/checker/common/rules-basic-handler')
const ScriptTaintChecker = require('../../src/checker/taint/python/script-taint-checker')
const SkillScriptTaintChecker = require('../../src/checker/taint/python/skill-script-taint-checker')

const SKILL_CASE_PATHS = [
  '/repo/.claude/skills/demo/run.py',
  '/repo/.codex/skills/demo/run.py',
  '/repo/.codefuse/skills/demo/run.py',
  '/repo/.skills/demo/run.py',
]

const NON_SKILL_CASE_PATHS = [
  '/repo/.claude/tools/run.py',
  '/repo/.codex/tools/run.py',
  '/repo/.codefuse/tools/run.py',
  '/repo/.skill/demo/run.py',
  '/repo/tools/run.py',
]

type CheckerLike = {
  triggerAtStartOfAnalyze(analyzer: AnalyzerLike, scope: unknown, node: unknown, state: unknown, info: unknown): void
  triggerAtFunctionCallAfter(analyzer: unknown, scope: unknown, node: AstNodeLike, state: unknown, info: FunctionCallAfterInfo): void
  triggerAtFunctionCallBefore(analyzer: unknown, scope: unknown, node: AstNodeLike, state: unknown, info: FunctionCallBeforeInfo): void
  findArgsAndAddNewFinding(node: AstNodeLike, callInfo: FunctionCallBeforeInfo['callInfo'], fclos: FunctionClosureLike, rule: { fsig: string; args: number[] }, state: unknown): boolean
  checkerRuleConfigContent: { sinks: { FuncCallTaintSink: Array<{ fsig: string; args: number[] }> } }
  resultManager: { getFindings(): Record<string, unknown[]> }
}

type AnalyzerLike = {
  entryPoints: unknown[]
  fileManager: Record<string, { uuid: string }>
  symbolTable: { get(uuid: string): unknown }
}

function compileUnit(sourcefile: string): unknown {
  return {
    ast: {
      node: {
        type: 'CompileUnit',
        loc: { sourcefile },
      },
    },
  }
}

function makeAnalyzer(files: string[]): AnalyzerLike {
  const symbols = new Map<string, unknown>()
  const fileManager: Record<string, { uuid: string }> = {}
  files.forEach((filePath, index) => {
    const uuid = `file-${index}`
    fileManager[filePath] = { uuid }
    symbols.set(uuid, compileUnit(filePath))
  })
  return {
    entryPoints: [],
    fileManager,
    symbolTable: { get: (uuid: string): unknown => symbols.get(uuid) },
  }
}

function runStart(checker: CheckerLike, files: string[]): AnalyzerLike {
  Config.language = 'python'
  Config.entryPointMode = 'BOTH'
  Config.maindir = '/repo/'
  const analyzer = makeAnalyzer(files)
  checker.triggerAtStartOfAnalyze(analyzer, null, null, null, null)
  return analyzer
}

type AstNodeLike = {
  type?: string
  callee?: unknown
  loc?: {
    sourcefile?: string
    start?: { line: number }
    end?: { line: number }
  }
}

type FunctionClosureLike = {
  qid?: string
}

type FunctionCallAfterInfo = {
  fclos?: FunctionClosureLike
  ret?: unknown
}

type FunctionCallBeforeInfo = {
  fclos?: FunctionClosureLike
  callInfo?: { args: Array<{ index: number; value: unknown }> }
}

type TaintLike = {
  tags: Set<string>
  traces: unknown[]
  addTag(tag: string): void
  addSanitizerTag(tag: unknown): void
  getFirstTrace(): unknown[] | undefined
  clearTrace(): void
  hasTraces(): boolean
  setAllTraces(traces: unknown[]): void
  getSanitizerTags(): unknown[]
  getTagTracesMap(): Map<string, unknown>
  isTaintedRec(tag: string): boolean
}

function makeTaint(): TaintLike {
  return {
    tags: new Set<string>(),
    traces: [],
    addTag(tag: string): void {
      this.tags.add(tag)
    },
    addSanitizerTag(): void {},
    getFirstTrace(): unknown[] | undefined {
      return this.traces[0] as unknown[] | undefined
    },
    clearTrace(): void {
      this.traces = []
    },
    hasTraces(): boolean {
      return this.traces.length > 0
    },
    setAllTraces(traces: unknown[]): void {
      this.traces = traces
    },
    getSanitizerTags(): unknown[] {
      return []
    },
    getTagTracesMap(): Map<string, unknown> {
      const tagTraces = new Map<string, unknown>()
      for (const tag of this.tags) {
        tagTraces.set(tag, this.traces)
      }
      return tagTraces
    },
    isTaintedRec(tag: string): boolean {
      return this.tags.has(tag)
    },
  }
}

function callNode(sourcefile: string): AstNodeLike {
  return {
    type: 'CallExpression',
    callee: { type: 'MemberAccess', object: { type: 'Identifier', name: 'os' }, property: { type: 'Identifier', name: 'system' } },
    loc: { sourcefile, start: { line: 1 }, end: { line: 1 } },
  } as unknown as AstNodeLike
}

function inputNode(sourcefile: string): AstNodeLike {
  return {
    type: 'CallExpression',
    callee: { type: 'Identifier', name: 'input' },
    loc: { sourcefile, start: { line: 1 }, end: { line: 1 } },
  } as unknown as AstNodeLike
}

function makeChecker(): CheckerLike {
  const checker = new SkillScriptTaintChecker(new ResultManager()) as CheckerLike
  checker.checkerRuleConfigContent = {
    sinks: { FuncCallTaintSink: [{ fsig: 'os.system', args: [0] }] },
  }
  return checker
}

describe('Python skill script taint checker', function () {
  it('matches explicit skill root allowlist only', function () {
    assert.strictEqual(ScriptTaintChecker.isSkillPythonScriptPath('/repo/.claude/skills/demo/run.py', '/repo/'), true)
    assert.strictEqual(ScriptTaintChecker.isSkillPythonScriptPath('/repo/.codex/skills/demo/run.py', '/repo/'), true)
    assert.strictEqual(ScriptTaintChecker.isSkillPythonScriptPath('/repo/.codefuse/skills/demo/run.py', '/repo/'), true)
    assert.strictEqual(ScriptTaintChecker.isSkillPythonScriptPath('/repo/.skills/demo/run.py', '/repo/'), true)
    assert.strictEqual(ScriptTaintChecker.isSkillPythonScriptPath('C:\\repo\\.codex\\skills\\demo\\run.py', 'C:\\repo'), true)
    assert.strictEqual(ScriptTaintChecker.isSkillPythonScriptPath('/repo/.claude/tools/run.py', '/repo/'), false)
    assert.strictEqual(ScriptTaintChecker.isSkillPythonScriptPath('/repo/.codex/tools/run.py', '/repo/'), false)
    assert.strictEqual(ScriptTaintChecker.isSkillPythonScriptPath('/repo/.codefuse/tools/run.py', '/repo/'), false)
    assert.strictEqual(ScriptTaintChecker.isSkillPythonScriptPath('/repo/.skill/demo/run.py', '/repo/'), false)
    assert.strictEqual(ScriptTaintChecker.isSkillPythonScriptPath('/repo/tools/run.py', '/repo/'), false)
  })

  it('keeps skill checker entrypoints inside explicit skill roots', function () {
    const analyzer = runStart(new SkillScriptTaintChecker({}), [...SKILL_CASE_PATHS, ...NON_SKILL_CASE_PATHS])

    assert.strictEqual(analyzer.entryPoints.length, SKILL_CASE_PATHS.length)
  })

  it('reports finding for each explicit skill root sink only', function () {
    for (const skillPath of SKILL_CASE_PATHS) {
      Config.entryPointMode = 'BOTH'
      BasicRuleHandler.setPreprocessReady(true)
      const checker = makeChecker()
      const taintedArg = { taint: makeTaint() }
      checker.triggerAtFunctionCallAfter(null, null, inputNode(skillPath), null, {
        fclos: { qid: '<builtin>.input' },
        ret: taintedArg,
      })
      const matched = checker.findArgsAndAddNewFinding(callNode(skillPath), { args: [{ index: 0, value: taintedArg }] }, { qid: '<module>.os.system' }, { fsig: 'os.system', args: [0] }, { callstack: [] })

      assert.strictEqual(matched, true)
      assert.strictEqual(taintedArg.taint.isTaintedRec('PYTHON_INPUT'), true)
      assert.strictEqual(taintedArg.taint.getTagTracesMap().has('PYTHON_INPUT'), true)
    }
  })

  it('does not report finding for adjacent non skill dot directories', function () {
    for (const nonSkillPath of NON_SKILL_CASE_PATHS) {
      Config.entryPointMode = 'BOTH'
      BasicRuleHandler.setPreprocessReady(true)
      const checker = makeChecker()
      const arg = { taint: makeTaint() }
      checker.triggerAtFunctionCallAfter(null, null, inputNode(nonSkillPath), null, {
        fclos: { qid: '<builtin>.input' },
        ret: arg,
      })
      checker.triggerAtFunctionCallBefore(null, null, callNode(nonSkillPath), {}, {
        fclos: { qid: '<module>.os.system' },
        callInfo: { args: [{ index: 0, value: arg }] },
      })

      const findings = checker.resultManager.getFindings()
      assert.strictEqual(Object.values(findings).flat().length, 0)
    }
  })

  it('keeps original script checker entrypoints unchanged', function () {
    const analyzer = runStart(new ScriptTaintChecker({}), [
      '/repo/.claude/skills/demo/run.py',
      '/repo/tools/run.py',
    ])

    assert.strictEqual(analyzer.entryPoints.length, 2)
  })
})
