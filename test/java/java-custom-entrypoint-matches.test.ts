import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, it } from 'mocha'

const JavaAnalyzer = require('../../src/engine/analyzer/java/common/java-analyzer')
const Config = require('../../src/config')

const JavaChecker = require('../../src/checker/taint/java/java-taint-abstract-checker') as {
  prototype: {
    resolveAllMatchingEntryPoints: (entrypoint: Record<string, unknown>, analyzer: unknown, functionName: string) => unknown[]
    matchEntrypointFunction: (node: Record<string, unknown>, entrypoint: Record<string, unknown>) => boolean
    resolveAndPushEntryPoint: (...args: unknown[]) => void
  }
}

type JavaClass = {
  logicalQid: string
  ast: { node: { loc: { sourcefile: string } } }
  members: Map<string, unknown>
}

const functionClosure = (line: number): Record<string, unknown> => ({
  vtype: 'fclos',
  ast: { node: { id: { name: 'handle' }, loc: { start: { line }, end: { line: line + 2 } } } },
})

describe('Java custom entrypoint matching', () => {
  it('expands nested callback methods from a parser-backed Java analyzer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-java-entrypoint-'))
    const sourcePath = path.join(root, 'demo', 'MedicalTradeQueryProcessor.java')
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, `package demo;
public class MedicalTradeQueryProcessor {
  public void doProcess(String request) {
    Runnable callback = new Runnable() {
      public void doProcess(String value) {
        System.out.println(value);
      }
    };
  }
}
`)
    Config.maindirPrefix = root
    const analyzer = new JavaAnalyzer({
      language: 'java',
      sourcePath: root,
      uastSDKPath: path.resolve(__dirname, '../../deps'),
      checkerIds: [],
      checkerPackIds: [],
      printers: [],
    })
    await analyzer.preProcess(root)
    const owner = analyzer.symbolTable.get(analyzer.classMap.get('demo.MedicalTradeQueryProcessor'))
    const outerMethod = owner.members.get('doProcess')
    const checker = Object.create(JavaChecker.prototype) as typeof JavaChecker.prototype
    const matched = checker.resolveAllMatchingEntryPoints(
      { filePath: '/demo/MedicalTradeQueryProcessor.java', packageName: 'demo.MedicalTradeQueryProcessor' },
      analyzer,
      'doProcess'
    )
    const locations = matched.map((candidate) => candidate.ast.node.loc)
    assert.strictEqual(analyzer.classMap.has('demo.MedicalTradeQueryProcessor'), true)
    assert.strictEqual(matched.length, 2)
    assert.deepStrictEqual(locations.map((loc) => loc.start.line), [3, 5])
    assert.deepStrictEqual(locations.map((loc) => loc.end.line), [9, 7])
    assert.strictEqual(matched[0], outerMethod)
    assert.notStrictEqual(matched[1].parent, matched[0].parent)
    assert.strictEqual(matched[1].parent?.logicalQid?.includes('<anonymousFunc_5_7>'), true)
    assert.strictEqual(typeof (matched[1].parent?.ast as { hasDecl?: unknown })?.hasDecl, 'function')
    assert.strictEqual(Array.isArray(matched[1].overloaded), false)
    assert.strictEqual(matched[1].overloaded?.length, 1)

    const checkerWithEntries = Object.create(JavaChecker.prototype) as typeof JavaChecker.prototype & { entryPoints: unknown[]; normalizeAstSourceFilePath: (value: string) => string | null }
    checkerWithEntries.entryPoints = []
    checkerWithEntries.normalizeAstSourceFilePath = (value: string): string | null => value ? value.replace(root, '') : null
    const EntryPoint = class { entryPointSymVal: unknown; constructor(_type: unknown) {} } as unknown as new (type: unknown) => Record<string, unknown>
    checkerWithEntries.resolveAndPushEntryPoint(outerMethod, { filePath: '/demo/MedicalTradeQueryProcessor.java', packageName: 'demo.MedicalTradeQueryProcessor', functionName: 'doProcess' }, 'doProcess', analyzer, class {}, EntryPoint, { ENGIN_START_FUNCALL: 'start' })
    assert.strictEqual(checkerWithEntries.entryPoints.length, 2)
    assert.notStrictEqual((checkerWithEntries.entryPoints[0] as { entryPointSymVal: unknown }).entryPointSymVal, (checkerWithEntries.entryPoints[1] as { entryPointSymVal: unknown }).entryPointSymVal)
  })

  it('does not fall back when filePath does not match', () => {
    const outer = { logicalQid: 'demo.Service', ast: { node: { loc: { sourcefile: '/workspace/src/demo/Service.java' } } }, members: new Map([['handle', functionClosure(10)]]) }
    const analyzer = { classMap: new Map([['demo.Service', 'outer']]), symbolTable: new Map([['outer', outer]]) }
    const checker = Object.create(JavaChecker.prototype) as typeof JavaChecker.prototype
    checker.normalizeAstSourceFilePath = (value: string): string | null => value.replace('/workspace', '')
    assert.strictEqual(checker.resolveAllMatchingEntryPoints({ filePath: '/src/Other.java', packageName: 'demo.Service' }, analyzer, 'handle').length, 0)
  })

  it('expands one file/package rule to outer and anonymous owners', () => {
    const outer = { logicalQid: 'demo.Service', ast: { node: { loc: { sourcefile: '/workspace/src/demo/Service.java' } } }, members: new Map([['handle', functionClosure(10)]]) }
    const anonymous = { logicalQid: 'demo.Service$1', ast: { node: { loc: { sourcefile: '/workspace/src/demo/Service.java' } } }, members: new Map([['handle', functionClosure(30)]]) }
    const analyzer = { classMap: new Map([['demo.Service', 'outer'], ['demo.Service$1', 'anonymous']]), symbolTable: new Map([['outer', outer], ['anonymous', anonymous]]) }
    const checker = Object.create(JavaChecker.prototype) as typeof JavaChecker.prototype
    checker.normalizeAstSourceFilePath = (path: string): string | null => path.replace('/workspace', '')
    const matched = checker.resolveAllMatchingEntryPoints({ filePath: '/src/demo/Service.java', packageName: 'demo.Service' }, analyzer, 'handle')
    assert.strictEqual(matched.length, 2)
    assert.deepStrictEqual(matched.map((candidate) => (candidate as Record<string, unknown>).ast).length, 2)
  })

  it('normalizes a leading dot in the configured package name', () => {
    const outer = { logicalQid: 'demo.Service', ast: { node: { loc: { sourcefile: '/workspace/src/demo/Service.java' } } }, members: new Map([['handle', functionClosure(10)]]) }
    const analyzer = { classMap: new Map([['demo.Service', 'outer']]), symbolTable: new Map([['outer', outer]]) }
    const checker = Object.create(JavaChecker.prototype) as typeof JavaChecker.prototype
    checker.normalizeAstSourceFilePath = (sourcePath: string): string | null => sourcePath.replace('/workspace', '')

    const matched = checker.resolveAllMatchingEntryPoints(
      { filePath: '/src/demo/Service.java', packageName: '.demo.Service' },
      analyzer,
      'handle'
    )

    assert.strictEqual(matched.length, 1)
    assert.strictEqual(matched[0], outer.members.get('handle'))
  })

  it('pushes two independent entrypoints for the outer and anonymous owners', () => {
    const outer = { logicalQid: 'demo.Service', ast: { node: { loc: { sourcefile: '/workspace/src/demo/Service.java' } } }, members: new Map([['handle', functionClosure(10)]]) }
    const anonymous = { logicalQid: 'demo.Service$1', ast: { node: { loc: { sourcefile: '/workspace/src/demo/Service.java' } } }, members: new Map([['handle', functionClosure(30)]]) }
    const analyzer = { classMap: new Map([['demo.Service', 'outer'], ['demo.Service$1', 'anonymous']]), symbolTable: new Map([['outer', outer], ['anonymous', anonymous]]) }
    const checker = Object.create(JavaChecker.prototype) as typeof JavaChecker.prototype & { entryPoints: unknown[]; normalizeAstSourceFilePath: (path: string) => string }
    checker.entryPoints = []
    checker.normalizeAstSourceFilePath = (path: string): string => path.replace('/workspace', '')
    const entrypoint = { filePath: '/src/demo/Service.java', packageName: 'demo.Service', functionName: 'handle' }
    const EntryPoint = class { entryPointSymVal: unknown; constructor(_type: unknown) {} } as unknown as new (type: unknown) => Record<string, unknown>
    checker.resolveAndPushEntryPoint(outer.members.get('handle'), entrypoint, 'handle', analyzer, class {}, EntryPoint, { ENGIN_START_FUNCALL: 'start' })
    assert.strictEqual(checker.entryPoints.length, 2)
    assert.notStrictEqual((checker.entryPoints[0] as { entryPointSymVal: unknown }).entryPointSymVal, (checker.entryPoints[1] as { entryPointSymVal: unknown }).entryPointSymVal)
  })

  it('uses funcLoc, paramTypes, and signature as mutually exclusive selectors', () => {
    const checker = Object.create(JavaChecker.prototype) as typeof JavaChecker.prototype
    const node = { id: { name: 'handle' }, loc: { start: { line: 10 }, end: { line: 12 } }, parameters: [{ varType: { id: { name: 'String' } } }] }
    assert.strictEqual(checker.matchEntrypointFunction(node, { funcLocStart: 10, funcLocEnd: 12, paramTypes: ['Other'], signature: 'handle(Other)' }), true)
    assert.strictEqual(checker.matchEntrypointFunction(node, { paramTypes: ['String'], signature: 'handle(Other)' }), true)
    assert.strictEqual(checker.matchEntrypointFunction(node, { signature: 'handle(String)' }), true)
    assert.strictEqual(checker.matchEntrypointFunction(node, { funcLocStart: 99, paramTypes: ['String'] }), false)
    assert.strictEqual(checker.matchEntrypointFunction(node, { paramTypes: ['Other'] }), false)
  })
})
