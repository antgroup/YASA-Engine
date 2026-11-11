import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, it } from 'mocha'
import { groupGoPackageFiles, primaryGoPackageName } from '../../src/engine/analyzer/golang/common/go-package-files'

const { Parser } = require('@ant-yasa/uast-parser-go')
const { addNodeHash } = require('../../src/util/ast-util')
const GoAnalyzer = require('../../src/engine/analyzer/golang/common/go-analyzer')
const GoAstBuilder = require('../../src/engine/parser/golang/go-ast-builder')
const Config = require('../../src/config')

const DEPS_DIR = path.resolve(__dirname, '../../deps')

function setBackend(backend: 'native' | 'default'): void {
  if (backend === 'native') process.env.YASA_GO_PARSER = 'native'
  else delete process.env.YASA_GO_PARSER
}

describe('Go parser integration', function () {
  this.timeout(10000)
  let previousMode: string | undefined

  beforeEach(() => {
    previousMode = process.env.YASA_GO_PARSER
    setBackend('default')
  })
  afterEach(() => {
    if (previousMode === undefined) delete process.env.YASA_GO_PARSER
    else process.env.YASA_GO_PARSER = previousMode
  })

  describe('backend compatibility', () => {
    it('preserves project module metadata across backends', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-go-proj-'))
      try {
        const goModPath = path.join(root, 'go.mod')
        fs.writeFileSync(goModPath, 'module example.com/demo\n\ngo 1.22\n')
        for (const name of ['a', 'b']) {
          const dir = path.join(root, 'pkg', name)
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(path.join(dir, `${name}.go`), `package ${name}\n`)
        }
        const expected = ['example.com/demo', 1, goModPath]
        const inProcess = await GoAstBuilder.parseProject(root)
        assert.deepStrictEqual([inProcess.moduleName, inProcess.numOfGoMod, inProcess.goModPath], expected)
        setBackend('native')
        const native = await GoAstBuilder.parseProject(root, { uastSDKPath: DEPS_DIR })
        assert.deepStrictEqual([native.moduleName, native.numOfGoMod, native.goModPath], expected)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })

    it('matches native root-first, depth-first module selection', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-go-modules-'))
      try {
        const deep = path.join(root, 'a', 'child')
        const sibling = path.join(root, 'z')
        for (const [dir, name] of [[deep, 'first'], [sibling, 'second']]) {
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(path.join(dir, 'go.mod'), `module example.com/${name}\n`)
          fs.writeFileSync(path.join(dir, 'main.go'), 'package p\n')
        }
        const rootMod = path.join(root, 'go.mod')
        fs.writeFileSync(rootMod, 'module example.com/root\n')
        for (const expected of [
          [rootMod, 'example.com/root', 3],
          [path.join(deep, 'go.mod'), 'example.com/first', 2],
        ]) {
          for (const backend of ['native', 'default'] as const) {
            setBackend(backend)
            const options = backend === 'native' ? { uastSDKPath: DEPS_DIR } : {}
            const result = await GoAstBuilder.parseProject(root, options)
            assert.deepStrictEqual([result.goModPath, result.moduleName, result.numOfGoMod], expected, backend)
          }
          if (expected[0] === rootMod) fs.unlinkSync(rootMod)
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })

    it('matches decoded dumpAST output across backends', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-go-dump-'))
      try {
        const source = path.join(dir, 'x.go')
        fs.writeFileSync(source, 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("hi") }\n')
        const options = { single: true, dumpAST: true, language: 'golang' }
        const defaultOut = path.join(dir, 'default.json')
        await GoAstBuilder.ensureInitialized(options)
        GoAstBuilder.parseSingleFile(source, { ...options, ASTFileOutput: defaultOut })

        const nativeOut = path.join(dir, 'native.json')
        setBackend('native')
        GoAstBuilder.parseSingleFile(source, { ...options, ASTFileOutput: nativeOut, uastSDKPath: DEPS_DIR })

        // 两个后端保留自己的 JSON 格式，只比较解码后的 UAST。
        assert.deepStrictEqual(
          JSON.parse(fs.readFileSync(defaultOut, 'utf8')),
          JSON.parse(fs.readFileSync(nativeOut, 'utf8'))
        )
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('package analysis', () => {
    const files = {
      'z_test.go': { packageName: 'p_test', node: { type: 'CompileUnit', body: [], marker: 'external' } },
      'b.go': { packageName: 'p', node: { type: 'CompileUnit', body: [], marker: 'production' } },
      'a_test.go': { packageName: 'p', node: { type: 'CompileUnit', body: [], marker: 'internal' } },
    }

    function scope(): any {
      return {
        name: '',
        packageProcessed: false,
        children: new Map(),
        getSubPackage(name: string) {
          if (!this.children.has(name)) this.children.set(name, scope())
          return this.children.get(name)
        },
      }
    }

    it('groups deterministically and selects the production import target', () => {
      const groups = groupGoPackageFiles(files)
      assert.deepStrictEqual([...groups.keys()], ['p', 'p_test'])
      assert.equal(primaryGoPackageName(groups), 'p')
      assert.deepStrictEqual(groups.get('p')!.map((file) => file.node.marker), ['internal', 'production'])
    })

    it('scans external tests in a distinct package scope', () => {
      const root = scope()
      const calls: Array<{ scope: any; marker: string }> = []
      const receiver = {
        topScope: scope(),
        preProcessClassDefinition() {},
        processInstruction(s: any, n: any) {
          calls.push({ scope: s, marker: n.marker })
        },
      }
      GoAnalyzer.prototype._scanPackages.call(receiver, root, '/', { files, subs: {} }, {}, true)
      const prod = calls.find((x) => x.marker === 'production')!.scope
      const internal = calls.find((x) => x.marker === 'internal')!.scope
      const external = calls.find((x) => x.marker === 'external')!.scope
      assert.equal(prod, internal)
      assert.notEqual(prod, external)
      assert.equal(prod.name, 'p')
      assert.equal(external.name, 'p_test')
      assert.equal(prod.packageProcessed, true)
      assert.equal(external.packageProcessed, true)
    })

    it('lazy imports never load declarations from the external test package', () => {
      const calls: string[] = []
      const receiver = {
        topScope: { context: { modules: { rootDir: { files } } } },
        processInstruction(_s: any, n: any) {
          calls.push(n.marker)
        },
      }
      const target = scope()
      GoAnalyzer.prototype.addFdef.call(receiver, target, [], {})
      assert.deepStrictEqual(calls, ['internal', 'production'])
      assert.equal(target.name, 'p')
    })

    it('hashing body nodes does not mutate shared type metadata', async () => {
      const parser = new Parser()
      await parser.init()
      const result = parser.parseProject([
        { name: '/hash/go.mod', content: 'module hash\n' },
        { name: '/hash/main.go', content: 'package p\ntype T struct { X int }; var a=T{X:1}; func F(){ b:=[]int{1,2}; _=b }' },
      ], { root: '/hash' })
      const file = result.packageInfo.subs['/'].files['/hash/main.go']
      const serialized = JSON.parse(JSON.stringify(file))
      addNodeHash(file)
      addNodeHash(serialized)
      assert.deepStrictEqual(file, serialized)
    })

    for (const backend of ['native', 'default'] as const) {
      it(`keeps taint through selector index writes and reads (${backend})`, async () => {
        setBackend(backend)
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-index-'))
        const filename = path.join(dir, 'main.go')
        const saved = { ...Config }
        try {
          Object.assign(Config, {
            ruleConfigFile: path.join(__dirname, 'rule_config.json'),
            checkerIds: ['taint_flow_test'],
            language: 'golang',
            maindir: dir,
            maindirPrefix: dir,
          })
          const analyzer = new GoAnalyzer({
            ...Config,
            uastSDKPath: backend === 'native' ? DEPS_DIR : undefined,
            examineIssues: true,
            checkers: { taint_flow_test: true },
            mode: { intra: true },
            sanity: true,
          })
          const source = `package main
func __taint_sink(x string) {}
func f(__taint_src string) {
 p := struct { m map[string]map[string]string }{m:map[string]map[string]string{"a":{}}}
 l := struct { Name, Value string }{Name:"a", Value:"b"}
 p.m[l.Name][l.Value] = __taint_src
 __taint_sink(p.m[l.Name][l.Value])
}
`
          fs.writeFileSync(filename, source)
          const result = await analyzer.analyzeSingleFile(source, filename)
          assert.notStrictEqual(result, false)
          const all = analyzer.getCheckerManager().resultManager.getFindings()
          assert.ok((all.taintflow || []).length > 0, 'nested indexed value must reach the sink')
        } finally {
          Object.assign(Config, saved)
          fs.rmSync(dir, { recursive: true, force: true })
        }
      })
    }
  })

  describe('runtime recovery', () => {
    for (const runtimeInvalid of [false, true]) {
      it(`fails once and ${runtimeInvalid ? 'reinitializes' : 'keeps the parser'} on the next request`, async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go-runtime-'))
        const originalProject = Parser.prototype.parseProject
        const originalInit = Parser.prototype.init
        let initCalls = 0
        let parseCalls = 0
        try {
          const file = path.join(dir, 'main.go')
          fs.writeFileSync(path.join(dir, 'go.mod'), 'module boundary\n')
          fs.writeFileSync(file, 'package p\n')
          await GoAstBuilder.ensureInitialized()
          const error = Object.assign(new Error('controlled first failure'), {
            runtimeInvalid,
            file,
            stage: runtimeInvalid ? 'parse' : 'convert',
          })
          Parser.prototype.init = function () {
            initCalls++
            return originalInit.call(this)
          }
          Parser.prototype.parseProject = () => {
            parseCalls++
            throw error
          }
          await assert.rejects(GoAstBuilder.parseProject(dir), (failure: unknown) => failure === error)
          assert.equal(parseCalls, 1, 'the failing request must not be retried')
          assert.equal(initCalls, 0, 'recovery does not start inside a failed request')
          Parser.prototype.parseProject = originalProject
          assert.equal((await GoAstBuilder.parseProject(dir)).moduleName, 'boundary')
          assert.equal(initCalls, runtimeInvalid ? 1 : 0)
        } finally {
          Parser.prototype.parseProject = originalProject
          Parser.prototype.init = originalInit
          fs.rmSync(dir, { recursive: true, force: true })
        }
      })
    }
  })
})
