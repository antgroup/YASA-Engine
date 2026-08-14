import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, it } from 'mocha'
import { TypeScriptAliasResolver } from '../../src/engine/analyzer/javascript/egg/tsconfig-alias-resolver'

const { execute } = require('../../src/interface/starter')
const FileUtil = require('../../src/util/file-util')

const temporaryDirectories: string[] = []

function createProject(config: Record<string, unknown>, files: Record<string, string> = {}, configName = 'tsconfig.json'): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-tsconfig-alias-'))
  temporaryDirectories.push(projectRoot)
  fs.writeFileSync(path.join(projectRoot, configName), JSON.stringify(config))
  for (const [relativePath, content] of Object.entries(files)) {
    const filename = path.join(projectRoot, relativePath)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, content)
  }
  return projectRoot
}

async function waitForFile(filename: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (fs.existsSync(filename)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(`输出文件未生成: ${filename}`)
}

describe('TypeScriptAliasResolver', () => {
  afterEach(() => {
    while (temporaryDirectories.length > 0) {
      fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
    }
  })

  it('resolves a baseUrl alias from scanned modules', () => {
    const root = createProject({ compilerOptions: { baseUrl: './app' } })
    const module = {}
    const resolver = TypeScriptAliasResolver.load(root)
    const modules = new Map([[path.join(root, 'app/common/util.ts'), module]])

    assert.strictEqual(resolver?.resolveScannedModulePath('common/util', modules), path.join(root, 'app/common/util.ts'))
  })

  it('resolves a paths alias inherited through extends', () => {
    const root = createProject(
      { extends: './tsconfig.base.json' },
      { 'tsconfig.base.json': JSON.stringify({ compilerOptions: { baseUrl: './', paths: { '@app/*': ['src/*'] } } }) }
    )
    const module = {}
    const resolver = TypeScriptAliasResolver.load(root)
    const modules = new Map([[path.join(root, 'src/common/util.ts'), module]])

    assert.strictEqual(resolver?.resolveScannedModulePath('@app/common/util', modules), path.join(root, 'src/common/util.ts'))
  })

  it('uses jsconfig when tsconfig is absent', () => {
    const root = createProject({ compilerOptions: { baseUrl: './app' } }, {}, 'jsconfig.json')
    const module = {}
    const resolver = TypeScriptAliasResolver.load(root)
    const modules = new Map([[path.join(root, 'app/common/util.ts'), module]])

    assert.strictEqual(resolver?.resolveScannedModulePath('common/util', modules), path.join(root, 'app/common/util.ts'))
  })

  it('uses pathsBasePath from an extended config without baseUrl', () => {
    const root = createProject(
      { extends: './configs/base.json' },
      { 'configs/base.json': JSON.stringify({ compilerOptions: { paths: { '@app/*': ['src/*'] } } }) }
    )
    const module = {}
    const resolver = TypeScriptAliasResolver.load(root)
    const modules = new Map([[path.join(root, 'configs/src/common/util.ts'), module]])

    assert.strictEqual(resolver?.resolveScannedModulePath('@app/common/util', modules), path.join(root, 'configs/src/common/util.ts'))
  })

  it('rejects paths mappings that escape the project root', () => {
    const root = createProject({ compilerOptions: { paths: { '@app/*': ['../outside/*'] } } })
    const resolver = TypeScriptAliasResolver.load(root)
    const modules = new Map([[path.resolve(root, '../outside/util.ts'), {}]])

    assert.strictEqual(resolver?.resolveScannedModulePath('@app/util', modules), undefined)
  })

  it('rejects an existing alias candidate that escapes through a symlink', () => {
    const root = createProject({ compilerOptions: { baseUrl: './app' } })
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-tsconfig-alias-outside-'))
    temporaryDirectories.push(outside)
    fs.mkdirSync(path.join(root, 'app'), { recursive: true })
    fs.writeFileSync(path.join(outside, 'util.ts'), 'export const escaped = true')
    fs.symlinkSync(outside, path.join(root, 'app', 'linked'))
    const resolver = TypeScriptAliasResolver.load(root)
    const modules = new Map([[path.join(root, 'app/linked/util.ts'), {}]])

    assert.strictEqual(resolver?.resolveScannedModulePath('linked/util', modules), undefined)
  })

  it('returns undefined for unresolved bare specifiers so callers preserve third-party fallback', () => {
    const root = createProject({ compilerOptions: { baseUrl: './app' } })
    const resolver = TypeScriptAliasResolver.load(root)

    assert.strictEqual(resolver?.resolveScannedModulePath('third-party-package', new Map()), undefined)
  })

  it('resolves direct rpc and reverse-order service aliases', async function () {
    this.timeout(30000)
    const root = createProject(
      { compilerOptions: { baseUrl: './app' } },
      {
        'package.json': JSON.stringify({ dependencies: { 'egg-bin': '1.0.0' } }),
        'config/config.default.ts': 'export default {}',
        'app/controller/entry.ts': "import { receiveFn } from 'rpc/gift/receive'\nexport const controllerEntry = (): string => receiveFn()\n",
        'app/rpc/entry.ts': "import { serviceFn } from 'service/target'\nexport const rpcEntry = (): string => serviceFn()\n",
        'app/rpc/gift/receive.ts': "export const receiveFn = (): string => 'received'\n",
        'app/service/target.ts': "export const serviceFn = (): string => 'ok'\n",
      }
    )
    const appRoot = path.join(root, 'app')
    const scannedFiles = FileUtil.loadAllFileTextGlobby(['**/*.(js|ts|mjs|cjs)'], appRoot).map((file: { file: string }) => file.file)
    assert.ok(scannedFiles.indexOf(path.join(appRoot, 'rpc/entry.ts')) < scannedFiles.indexOf(path.join(appRoot, 'service/target.ts')))
    assert.ok(scannedFiles.indexOf(path.join(appRoot, 'controller/entry.ts')) < scannedFiles.indexOf(path.join(appRoot, 'rpc/gift/receive.ts')))

    const reportDir = path.join(root, 'report')
    await execute(null, [root, '--language', 'javascript', '--analyzer', 'EggAnalyzer', '--dumpAllCG', '--report', reportDir], () => undefined, false)

    const callgraphFile = path.join(reportDir, 'callgraph.json')
    await waitForFile(callgraphFile)
    const callgraph = JSON.parse(fs.readFileSync(callgraphFile, 'utf8'))
    const nodes = Object.entries(callgraph.nodes) as Array<[string, { funcDef: unknown }]>
    assert.strictEqual(nodes.some(([key]) => key.startsWith('service/target.serviceFn')), false)
    assert.strictEqual(nodes.some(([key]) => key.startsWith('rpc/gift/receive.receiveFn')), false)
    assert.ok(
      nodes.some(([, node]) => {
        const definition = node.funcDef as { loc?: { sourcefile?: string } }
        return definition.loc?.sourcefile === path.join(appRoot, 'service/target.ts')
      })
    )
    assert.ok(
      nodes.some(([, node]) => {
        const definition = node.funcDef as { loc?: { sourcefile?: string } }
        return definition.loc?.sourcefile === path.join(appRoot, 'rpc/gift/receive.ts')
      })
    )
  })
})
