import * as assert from 'assert'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, it } from 'mocha'

const Config = require('../../src/config')
const GoAnalyzer = require('../../src/engine/analyzer/golang/common/go-analyzer')

const engineDir = path.resolve(__dirname, '../..')
const sdkDir = path.join(engineDir, 'deps')

function runCli(cwd: string, args: string[], options: { native?: boolean; preload?: string } = {}) {
  const env = { ...process.env }
  delete env.YASA_GO_PARSER
  if (options.native) env.YASA_GO_PARSER = 'native'
  const nodeArgs = ['--require', require.resolve('tsx/cjs')]
  if (options.preload) nodeArgs.push('--require', options.preload)
  const run = spawnSync(
    process.execPath,
    [...nodeArgs, path.join(engineDir, 'src/main.ts'), '--language', 'golang', ...args],
    { cwd, env, encoding: 'utf8', timeout: 15000 }
  )
  assert.ifError(run.error)
  assert.strictEqual(run.signal, null, run.stderr)
  return { status: run.status, log: run.stdout + run.stderr }
}

function readJson(filename: string) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'))
}

function assertSingleAst(report: string, source: string) {
  const parsed = readJson(report)
  const packageInfo = Array.isArray(parsed) ? parsed[0] : parsed.packageInfo
  const node = packageInfo.subs['/'].files[source].node
  assert.strictEqual(node.type, 'CompileUnit')
  assert.strictEqual(node.loc.sourcefile, source)
  assert.ok(node.body.some((decl: { type: string; id?: { name: string } }) =>
    decl.type === 'FunctionDefinition' && decl.id?.name === 'SharedName'))
}

describe('Go parser integration', function () {
  this.timeout(60000)
  let dir: string
  let project: string
  let source: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'yasa-go-parser-'))
    project = path.join(dir, 'project')
    source = path.join(project, 'p.go')
    fs.mkdirSync(project)
    fs.writeFileSync(path.join(project, 'go.mod'), 'module parserintegration\n\ngo 1.22\n')
    fs.writeFileSync(source, 'package p\nfunc SharedName() {}\n')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('loads the default npm parser and keeps external tests out of the production analysis scope', async () => {
    const internal = path.join(project, 'internal_test.go')
    const external = path.join(project, 'external_test.go')
    fs.writeFileSync(internal, 'package p\nfunc InternalOnly() {}\n')
    fs.writeFileSync(external, 'package p_test\nfunc SharedName() {}\nfunc ExternalOnly() {}\n')

    const previousMode = process.env.YASA_GO_PARSER
    const previousMainDir = Config.maindir
    delete process.env.YASA_GO_PARSER
    Config.maindir = project
    try {
      const analyzer = new GoAnalyzer({ ...Config, language: 'golang', uastSDKPath: undefined })
      await analyzer.preProcess(project)
      const { modules, packages } = analyzer.topScope.context
      assert.strictEqual(modules.moduleName, 'parserintegration')
      assert.strictEqual(modules.goModPath, path.join(project, 'go.mod'))
      const production = packages.getSubPackage('parserintegration')
      const tests = production.getSubPackage('%package_p_test')
      assert.notStrictEqual(production, tests)
      assert.strictEqual(production.members.get('SharedName')?.ast.fdef.loc.sourcefile, source)
      assert.strictEqual(production.members.get('InternalOnly')?.ast.fdef.loc.sourcefile, internal)
      assert.strictEqual(production.members.has('ExternalOnly'), false)
      assert.strictEqual(tests.members.get('SharedName')?.ast.fdef.loc.sourcefile, external)
      assert.strictEqual(tests.members.get('ExternalOnly')?.ast.fdef.loc.sourcefile, external)
    } finally {
      Config.maindir = previousMainDir
      if (previousMode === undefined) delete process.env.YASA_GO_PARSER
      else process.env.YASA_GO_PARSER = previousMode
    }
  })

  it('writes an AST for the real default single-file CLI', () => {
    const report = path.join(dir, 'single.json')
    const run = runCli(dir, ['--sourcePath', source, '--single', '--dumpAST', '--report', report])
    assert.strictEqual(run.status, 0, run.log)
    assertSingleAst(report, source)
  })

  it('runs native project and explicit SDK requests when the npm parser cannot be loaded', () => {
    const preload = path.join(dir, 'without-go-parser.cjs')
    fs.writeFileSync(preload, `
const Module = require('node:module')
const load = Module._load
Module._load = function (id, ...args) {
  if (id === '@ant-yasa/uast-parser-go') {
    console.error('Go npm parser load blocked by test')
    throw Object.assign(new Error(id), { code: 'MODULE_NOT_FOUND' })
  }
  return load.call(this, id, ...args)
}
`)
    const projectReport = path.join(dir, 'project-ast')
    const native = runCli(dir, ['--sourcePath', project, '--dumpAllAST', '--report', projectReport], {
      native: true,
      preload,
    })
    assert.strictEqual(native.status, 0, native.log)
    assert.doesNotMatch(native.log, /Go npm parser load blocked by test/)
    const exports: string[] = readJson(path.join(projectReport, 'astList.json'))
    assert.strictEqual(exports.length, 1)
    assert.strictEqual(readJson(path.join(projectReport, exports[0])).loc.sourcefile, source)

    const singleReport = path.join(dir, 'sdk.json')
    const singleArgs = ['--sourcePath', source, '--single', '--dumpAST', '--report', singleReport]
    const sdk = runCli(dir, [...singleArgs, '--uastSDKPath', sdkDir], { preload })
    assert.strictEqual(sdk.status, 0, sdk.log)
    assert.doesNotMatch(sdk.log, /Go npm parser load blocked by test/)
    assertSingleAst(singleReport, source)

    const missing = runCli(dir, [
      '--sourcePath', source, '--single', '--dumpAST', '--report', path.join(dir, 'missing.json'),
    ], { preload })
    assert.notStrictEqual(missing.status, 0, missing.log)
    assert.match(missing.log, /Go npm parser load blocked by test/)
  })
})
