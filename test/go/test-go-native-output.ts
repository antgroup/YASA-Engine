import * as assert from 'assert'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, it } from 'mocha'
import readGoProjectJson from '../../src/engine/parser/golang/go-project-json-reader'

const fs = require('fs')
const child = require('child_process')
const builder = require('../../src/engine/parser/golang/go-ast-builder')
const DEPS_DIR = path.resolve(__dirname, '../../deps')

/** 大 JSON 的受控复现：只模拟同步字符串读取的尺寸限制，不构造巨大测试文件。 */
describe('Go native subprocess output', () => {
  let previousMode: string | undefined
  beforeEach(() => {
    previousMode = process.env.YASA_GO_PARSER
    process.env.YASA_GO_PARSER = 'native'
  })
  afterEach(() => {
    if (previousMode === undefined) delete process.env.YASA_GO_PARSER
    else process.env.YASA_GO_PARSER = previousMode
  })

  it('preserves module metadata and does not run the native parser twice', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-stream-'))
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module streamfixture\n')
    fs.writeFileSync(path.join(dir, 'main.go'), 'package p\nvar X = 1\n')
    const read = fs.readFileSync
    const exec = child.execSync
    let invocations = 0
    try {
      const options = { uastSDKPath: DEPS_DIR }
      const reference = await builder.parseProject(dir, options)
      assert.ok(reference)
      fs.readFileSync = (file: any, ...args: any[]) => {
        if (String(file).includes('yasa-uast-go-') && String(file).endsWith('uast.json')) {
          throw new RangeError('controlled maximum string size')
        }
        return read(file, ...args)
      }
      child.execSync = (...args: any[]) => {
        invocations++
        return exec(...args)
      }
      const streamed = await builder.parseProject(dir, options)
      assert.deepStrictEqual(streamed, reference)
      assert.equal(invocations, 1)
    } finally {
      fs.readFileSync = read
      child.execSync = exec
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an unsuccessful subprocess even if it produced parseable output', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-failed-native-'))
    const output = path.join(dir, 'uast.json')
    const exec = child.execSync
    const failure = new Error('controlled native failure after output')
    let invocations = 0
    try {
      fs.writeFileSync(path.join(dir, 'main.go'), 'package p\n')
      child.execSync = (...args: any[]) => {
        invocations++
        exec(...args)
        throw failure
      }
      await assert.rejects(
        builder.parseProject(dir, { ASTFileOutput: output }),
        (error: unknown) => error === failure
      )
      assert.equal(invocations, 1)
      assert.ok(!fs.existsSync(output))
    } finally {
      child.execSync = exec
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an older SDK that exits successfully with an empty package tree', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-empty-native-'))
    const output = path.join(dir, 'uast.json')
    const exec = child.execSync
    try {
      child.execSync = () => {
        fs.writeFileSync(output, JSON.stringify({ packageInfo: { files: {}, subs: {} }, moduleName: 'empty' }))
        return Buffer.alloc(0)
      }
      await assert.rejects(builder.parseProject(dir, { ASTFileOutput: output }), /No Go compilation units/)
      assert.ok(!fs.existsSync(output))
    } finally {
      child.execSync = exec
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps valid single-file output and rejects stale, empty or failed output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-single-output-'))
    const source = path.join(dir, 'main.go')
    const output = path.join(dir, 'uast.json')
    const options = { ASTFileOutput: output, dumpAST: true }
    const exec = child.execSync
    try {
      fs.writeFileSync(source, 'package p\n')
      const packageInfo = { files: { [source]: { node: { type: 'CompileUnit' } } } }
      const legacyOutput = JSON.stringify([packageInfo, '__single_module__'])
      child.execSync = () => {
        fs.writeFileSync(output, legacyOutput)
        return Buffer.alloc(0)
      }
      assert.deepStrictEqual(builder.parseSingleFile(source, options), { packageInfo, moduleName: '__single_module__' })
      assert.strictEqual(fs.readFileSync(output, 'utf8'), legacyOutput)

      child.execSync = () => Buffer.alloc(0)
      assert.throws(() => builder.parseSingleFile(source, options), /ENOENT/)
      assert.ok(!fs.existsSync(output))

      child.execSync = () => {
        fs.writeFileSync(output, JSON.stringify({ packageInfo: { files: {}, subs: {} } }))
        return Buffer.alloc(0)
      }
      assert.throws(() => builder.parseSingleFile(source, options), /No Go compilation units/)
      assert.ok(!fs.existsSync(output))

      const failure = new Error('controlled native failure after partial output')
      child.execSync = () => {
        fs.writeFileSync(output, '{"packageInfo":')
        throw failure
      }
      assert.throws(() => builder.parseSingleFile(source, options), (error: unknown) => error === failure)
      assert.ok(!fs.existsSync(output))
    } finally {
      child.execSync = exec
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** 大项目原生输出分块读取，不允许丢字段、改变字符或返回部分项目。 */
describe('Go project JSON file streaming', function () {
  this.timeout(30000)
  it('preserves every field across byte boundaries and nested packages', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-json-'))
    try {
      const file = path.join(dir, 'input.json')
      const unit = { packageName: 'p', version: '0', node: { type: 'CompileUnit', body: [{ type: 'Literal', value: '中😀\\"{}[]\n', loc: { start: { line: 3, column: 4 } }, _meta: { ReceiveCls: '', flags: [true, false, null, 1.25e3] } }] } }
      const expected = { packageInfo: { files: null, subs: { '/': { files: { '/x/a.go': unit }, subs: { '/a': { files: { '/x/a/引号".go': unit }, subs: null } } } } }, moduleName: 'example/p', goModPath: '/x/go.mod', numOfGoMod: 2 }
      for (const value of [expected, [expected.packageInfo, 'example/p', '/x/go.mod', 2]]) {
        fs.writeFileSync(file, JSON.stringify(value))
        for (const chunkBytes of [1, 2, 7, 31, 65536]) {
          const actual = await readGoProjectJson(file, chunkBytes)
          assert.deepStrictEqual(actual, value)
          const pkg = Array.isArray(actual) ? actual[0] : actual.packageInfo
          assert.notStrictEqual(pkg.subs['/'].files['/x/a.go'], pkg.subs['/'].subs['/a'].files['/x/a/引号".go'])
        }
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects truncated files, malformed nodes and missing input', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-json-errors-'))
    try {
      const file = path.join(dir, 'input.json')
      for (const text of ['{"packageInfo":', '{"files":{"x.go":{"type":"Literal"', '{"files":{"x.go":{"type":}}}', '{"files":{"x.go":{}}} trailing']) {
        fs.writeFileSync(file, text)
        await assert.rejects(readGoProjectJson(file, 3))
      }
      await assert.rejects(readGoProjectJson(path.join(dir, 'missing.json')), /ENOENT/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('retains 60000 declarations with a controlled 72 MiB child old-space limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-json-memory-'))
    try {
      const input = path.join(dir, 'project.json')
      const loc = { start: { line: 1, column: 1 }, end: { line: 1, column: 2 }, sourcefile: '/fixture/main.go' }
      const body = Array.from({ length: 3000 }, (_, i) => ({
        type: 'VariableDeclaration', id: { type: 'Identifier', name: `v${i}`, loc, _meta: { ReceiveCls: '' } },
        init: { type: 'Literal', literalType: 'STRING', value: `value${i}`, loc, _meta: { ReceiveCls: '' } },
        cloned: true, varType: { type: 'DynamicType', id: null, typeArguments: null, loc: null, _meta: { ReceiveCls: '' } },
        variableParam: false, loc, _meta: { ReceiveCls: '' },
      }))
      const unit = JSON.stringify({ node: { type: 'CompileUnit', body }, packageName: 'p', version: '0' })
      fs.writeFileSync(input, '{"packageInfo":{"subs":{"/":{"files":{')
      for (let i = 0; i < 20; i++) fs.appendFileSync(input, `${i ? ',' : ''}${JSON.stringify(`/fixture/f${i}.go`)}:${unit}`)
      fs.appendFileSync(input, '},"subs":{}}}},"moduleName":"p","goModPath":"/fixture/go.mod","numOfGoMod":1}')
      const ts = require('typescript')
      const source = fs.readFileSync(path.join(__dirname, '../../src/engine/parser/golang/go-project-json-reader.ts'), 'utf8')
      fs.writeFileSync(path.join(dir, 'reader.cjs'), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText)
      fs.writeFileSync(path.join(dir, 'check.cjs'), `
        const assert = require('assert');
        require('./reader.cjs').default(process.argv[2]).then(result => {
          const files = result.packageInfo.subs['/'].files;
          assert.equal(Object.keys(files).length, 20);
          for (const file of Object.values(files)) {
            assert.equal(file.node.body.length, 3000);
            file.node.body.forEach((node, i) => {
              assert.equal(node.id.name, 'v' + i);
              assert.equal(node.init.value, 'value' + i);
            });
          }
          assert.equal(result.numOfGoMod, 1);
          console.log('complete');
        }).catch(error => { console.error(error); process.exitCode = 1 });
      `)
      const run = child.spawnSync(process.execPath, ['--max-old-space-size=72', path.join(dir, 'check.cjs'), input], { encoding: 'utf8', timeout: 25000 })
      assert.equal(run.status, 0, `${run.signal || ''}\n${run.stderr}`)
      assert.match(run.stdout, /complete/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
