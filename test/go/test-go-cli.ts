import { describe, it } from 'mocha'
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'

const engineDir = path.resolve(__dirname, '../..')

function runCli(
  args: string[],
  cwd: string,
  { mode, preload, language = 'golang' }: { mode?: string; preload?: string; language?: string } = {}
) {
  const env = { ...process.env }
  if (mode !== undefined) env.YASA_GO_PARSER = mode
  else delete env.YASA_GO_PARSER
  const nodeArgs = ['--require', require.resolve('tsx/cjs')]
  if (preload) nodeArgs.push('--require', preload)
  const run = spawnSync(
    process.execPath,
    [...nodeArgs, path.join(engineDir, 'src/main.ts'), '--language', language, ...args],
    { cwd, env, encoding: 'utf8', timeout: 10000 }
  )
  assert.ifError(run.error)
  assert.strictEqual(run.signal, null, run.stderr)
  return { status: run.status, log: run.stdout + run.stderr }
}

function readExports(dir: string): any[] {
  const astList: string[] = JSON.parse(fs.readFileSync(path.join(dir, 'astList.json'), 'utf8'))
  return astList
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')))
    .sort((a, b) => a.loc.sourcefile.localeCompare(b.loc.sourcefile))
}

describe('Go CLI request boundary', function () {
  this.timeout(30000)

  it('exports linked Go files without following linked directories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-links-'))
    try {
      const root = path.join(dir, 'project')
      const outside = path.join(dir, 'outside')
      fs.mkdirSync(root)
      fs.mkdirSync(outside)
      fs.writeFileSync(path.join(root, 'go.mod'), 'module linked\n')
      fs.writeFileSync(path.join(root, 'main.go'), 'package p\nfunc Main() {}\n')
      fs.writeFileSync(path.join(outside, 'example.go'), 'package p\nfunc LinkedExample() {}\n')
      fs.symlinkSync(path.join(outside, 'example.go'), path.join(root, 'example.go'))
      fs.symlinkSync(outside, path.join(root, 'directory-link'), 'dir')
      const outputs = [undefined, 'native'].map((mode) => {
        const report = path.join(dir, mode ?? 'default')
        const run = runCli(['--sourcePath', root, '--dumpAllAST', '--report', report], dir, { mode })
        assert.strictEqual(run.status, 0, run.log)
        const exports = readExports(report)
        assert.deepStrictEqual(exports.map((ast) => ast.loc.sourcefile), [path.join(root, 'example.go'), path.join(root, 'main.go')])
        assert.ok(JSON.stringify(exports[0]).includes('LinkedExample'))
        return exports
      })
      assert.deepStrictEqual(outputs[0], outputs[1])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exports and analyzes valid files even when a linked file and a syntax error are skipped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-partial-'))
    try {
      const root = path.join(dir, 'project')
      const subdir = path.join(root, 'hasOwnProperty')
      fs.mkdirSync(subdir, { recursive: true })
      fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/partial\n')
      const goodFiles = [path.join(root, 'main.go'), path.join(subdir, 'sub.go')]
      fs.writeFileSync(goodFiles[0], 'package main\nfunc main() {}\n')
      fs.writeFileSync(goodFiles[1], 'package sub\nfunc F() {}\n')
      const broken = path.join(root, 'broken.go')
      fs.symlinkSync(path.join(dir, 'missing'), broken)
      const syntaxError = path.join(root, 'bad.go')
      fs.writeFileSync(syntaxError, 'package main\nfunc\n')

      const output = path.join(dir, 'asts')
      const dumped = runCli(['--sourcePath', root, '--dumpAllAST', '--report', output], dir)
      assert.strictEqual(dumped.status, 0, dumped.log)
      assert.ok(dumped.log.includes(`${broken}: [error/read_error]`), dumped.log)
      assert.ok(dumped.log.includes(`${syntaxError}: [error/parse_error]`), dumped.log)
      const sourceFiles = readExports(output).map((ast) => ast.loc.sourcefile)
      assert.deepStrictEqual(sourceFiles.sort(), goodFiles.sort())

      const scanned = runCli([
        '--sourcePath', root, '--ruleConfigFile', path.join(__dirname, 'rule_config.json'),
        '--checkerIds', 'taint_flow_test', '--report', path.join(dir, 'findings'),
      ], dir)
      assert.strictEqual(scanned.status, 0, scanned.log)
      assert.match(scanned.log, /Files analyzed\s*:\s*2\b/)
      assert.ok(scanned.log.includes(`${broken}: [error/read_error]`), scanned.log)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not report success when no Go file can be parsed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-all-bad-'))
    try {
      const root = path.join(dir, 'project')
      fs.mkdirSync(root)
      const out = path.join(dir, 'asts')
      const empty = runCli(['--sourcePath', root, '--dumpAllAST', '--report', out], dir)
      assert.notStrictEqual(empty.status, 0, empty.log)
      assert.doesNotMatch(empty.log, /parseDirectory UAST success/)
      assert.ok(!fs.existsSync(path.join(out, 'astList.json')))

      fs.writeFileSync(path.join(root, 'bad.go'), 'package p\nfunc\n')
      const dumped = runCli(['--sourcePath', root, '--dumpAllAST', '--report', out], dir)
      assert.notStrictEqual(dumped.status, 0, dumped.log)
      assert.match(dumped.log, /no packages found under/)
      assert.doesNotMatch(dumped.log, /parseDirectory UAST success/)
      assert.ok(!fs.existsSync(path.join(out, 'astList.json')))

      const scanned = runCli([
        '--sourcePath', root, '--ruleConfigFile', path.join(__dirname, 'rule_config.json'),
        '--checkerIds', 'taint_flow_test', '--report', path.join(dir, 'findings'),
      ], dir)
      assert.notStrictEqual(scanned.status, 0, scanned.log)
      assert.match(scanned.log, /no packages found under/)
      assert.doesNotMatch(scanned.log, /Analysis Overview/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an unreadable go.mod instead of proceeding with a different module', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-broken-module-'))
    try {
      const root = path.join(dir, 'project')
      fs.mkdirSync(root)
      fs.writeFileSync(path.join(root, 'main.go'), 'package main\nfunc main() {}\n')
      const brokenModule = path.join(root, 'go.mod')
      fs.symlinkSync(path.join(dir, 'missing'), brokenModule)
      const out = path.join(dir, 'asts')
      const dumped = runCli(['--sourcePath', root, '--dumpAllAST', '--report', out], dir)
      assert.notStrictEqual(dumped.status, 0, dumped.log)
      assert.ok(dumped.log.includes(brokenModule), dumped.log)
      assert.doesNotMatch(dumped.log, /parseDirectory UAST success/)
      assert.ok(!fs.existsSync(path.join(out, 'astList.json')))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs explicit native CLI paths without loading the npm parser', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-native-only-'))
    try {
      const root = path.join(dir, 'project')
      fs.mkdirSync(root)
      fs.writeFileSync(path.join(root, 'main.go'), 'package main\nfunc main() {}\n')
      const preload = path.join(dir, 'no-go-npm.cjs')
      fs.writeFileSync(preload, `
        const Module = require('module');
        const load = Module._load;
        Module._load = function (id, ...args) {
          if (id === '@ant-yasa/uast-parser-go') {
            throw Object.assign(new Error('Go npm package unavailable'), { code: 'MODULE_NOT_FOUND' });
          }
          return load.call(this, id, ...args);
        };
      `)
      const args = ['--sourcePath', root, '--dumpAllAST', '--report', path.join(dir, 'asts')]
      const native = runCli(args, dir, { mode: 'native', preload })
      assert.strictEqual(native.status, 0, native.log)
      assert.ok(!native.log.includes('Go npm package unavailable'), native.log)
      for (const mode of [undefined, '']) {
        const sdk = runCli([...args, '--uastSDKPath', path.join(engineDir, 'deps')], dir, { mode, preload })
        assert.strictEqual(sdk.status, 0, sdk.log)
        assert.ok(!sdk.log.includes('Go npm package unavailable'), sdk.log)
      }
      const defaultMode = runCli(args, dir, { preload })
      assert.notStrictEqual(defaultMode.status, 0, defaultMode.log)
      assert.match(defaultMode.log, /Tree-sitter.*Go npm package unavailable.*YASA_GO_PARSER=native/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects retired and unknown Go modes even when the SDK is explicit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-invalid-mode-'))
    try {
      const source = path.join(dir, 'main.go')
      fs.writeFileSync(source, 'package main\nfunc main() {}\n')
      const report = path.join(dir, 'asts')
      const withSdk = ['--uastSDKPath', path.join(engineDir, 'deps')]
      const project = runCli(
        ['--sourcePath', dir, '--dumpAllAST', '--report', report, ...withSdk],
        dir,
        { mode: 'wasm' }
      )
      assert.notStrictEqual(project.status, 0, project.log)
      assert.match(project.log, /Invalid YASA_GO_PARSER="wasm".*Unset.*default.*native/)
      assert.ok(!fs.existsSync(path.join(report, 'astList.json')))

      const single = runCli(
        ['--sourcePath', source, '--single', '--dumpAST', '--report', path.join(dir, 'single.json'), ...withSdk],
        dir,
        { mode: 'unknown' }
      )
      assert.notStrictEqual(single.status, 0, single.log)
      assert.match(single.log, /Invalid YASA_GO_PARSER="unknown".*Unset.*default.*native/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not apply Go backend settings to a non-Go CLI request', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-go-mode-'))
    try {
      const source = path.join(dir, 'main.js')
      const report = path.join(dir, 'ast.json')
      fs.writeFileSync(source, 'const message = "hello"\n')
      const run = runCli(
        ['--sourcePath', source, '--single', '--dumpAST', '--report', report],
        dir,
        { language: 'javascript', mode: 'wasm' }
      )
      assert.strictEqual(run.status, 0, run.log)
      assert.doesNotMatch(run.log, /Invalid YASA_GO_PARSER/)
      assert.ok(JSON.parse(fs.readFileSync(report, 'utf8')))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
