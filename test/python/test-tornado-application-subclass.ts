import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { beforeEach, describe, it } from 'mocha'
import {
  getUniqueTornadoHandlerApplication,
  isTornadoFrameworkCall,
  registerTornadoHandlerApplication,
  resetTornadoHandlerApplications,
} from '../../src/checker/taint/python/tornado-util'

const PythonAnalyzer = require('../../src/engine/analyzer/python/common/python-analyzer') as typeof import('../../src/engine/analyzer/python/common/python-analyzer')
const Parser = require('../../src/engine/parser/parser') as typeof import('../../src/engine/parser/parser')
const Config = require('../../src/config') as typeof import('../../src/config')

const REPO_ROOT = path.resolve(__dirname, '../..')
const UAST4PY_PATH = process.env.UAST4PY_PATH || path.join(REPO_ROOT, 'deps/uast4py/uast4py')

type ResolvedClass = {
  id?: string
  qid?: string
  sid?: string
  ast?: {
    cdef?: {
      id?: {
        name?: string
      }
    }
  }
  super?: {
    qid?: string
    sid?: string
    node_module?: boolean
  }
}

type ResolvedClassObservation = {
  className?: string
  qid?: string
  sid?: string
  superQid?: string
  superNodeModule?: boolean
}

type CallHookNode = {
  callee?: {
    type?: string
    name?: string
    property?: {
      name?: string
    }
  }
}

type CallHookObservation = {
  fclos?: {
    qid?: string
    node_module?: boolean
    super?: {
      qid?: string
      node_module?: boolean
    }
  }
}

type AnalyzerHarness = {
  fileList: string[]
  options: unknown
  pyAstParseManager: Record<string, unknown>
  topScope: ImportScope
  checkerManager: {
    checkAtFunctionCallAfter: (
      analyzer: unknown,
      scope: unknown,
      node: CallHookNode,
      state: unknown,
      observation: CallHookObservation,
    ) => void
  }
  preProcess: (directory: string) => Promise<void>
  preProcess4SingleFile: (source: string, fileName: string) => void
  processImportDirect: (scope: unknown, node: unknown, state: unknown) => ResolvedValue
  processModule: (ast: unknown, fileName: string) => unknown
  resolveClassInheritance: (classValue: ResolvedClass, state: unknown) => void
}

type ParsedCallObservation = {
  qid?: string
  nodeModule?: boolean
  superQid?: string
  superNodeModule?: boolean
}

function analyzeTornadoApplicationCall(source: string): ParsedCallObservation[] {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-python-tornado-call-'))
  const sourceFile = path.join(sourceDir, 'entry.py')
  try {
    fs.writeFileSync(sourceFile, source)
    const previousMainDir = Config.maindir
    const previousMainDirPrefix = Config.maindirPrefix
    try {
      Config.maindir = sourceDir
      Config.maindirPrefix = `${sourceDir}/`
      const analyzer = new PythonAnalyzer({
        checkerIds: [],
        checkerPackIds: [],
        printers: [],
        language: 'python',
        uastSDKPath: UAST4PY_PATH,
      }) as unknown as AnalyzerHarness
      const observed: ParsedCallObservation[] = []
      const checkAtFunctionCallAfter = analyzer.checkerManager.checkAtFunctionCallAfter.bind(analyzer.checkerManager)
      analyzer.checkerManager.checkAtFunctionCallAfter = (callAnalyzer, scope, node, state, observation): void => {
        const isApplicationCall =
          (node.callee?.type === 'Identifier' && node.callee.name === 'Application') ||
          (node.callee?.type === 'MemberAccess' && node.callee.property?.name === 'Application')
        if (isApplicationCall) {
          observed.push({
            qid: observation.fclos?.qid,
            nodeModule: observation.fclos?.node_module,
            superQid: observation.fclos?.super?.qid,
            superNodeModule: observation.fclos?.super?.node_module,
          })
        }
        checkAtFunctionCallAfter(callAnalyzer, scope, node, state, observation)
      }
      analyzer.preProcess4SingleFile(source, sourceFile)
      return observed
    } finally {
      Config.maindir = previousMainDir
      Config.maindirPrefix = previousMainDirPrefix
    }
  } finally {
    fs.rmSync(sourceDir, { recursive: true, force: true })
  }
}

type ResolvedValue = {
  qid?: string
  sid?: string
  node_module?: boolean
  getMemberValue?: (name: string) => ResolvedValue | null
}

type ImportObservation = {
  qid?: string
  sid?: string
  nodeModule?: boolean
  root?: ResolvedValue
}

type ImportScope = {
  getMemberValue?: (name: string) => ResolvedValue | null
}

function memberValue(root: ResolvedValue | undefined, path: string[]): ResolvedValue | undefined {
  return path.reduce<ResolvedValue | undefined>((value, property) => value?.getMemberValue?.(property) ?? undefined, root)
}

function observeCachedImportScopes(): ImportObservation[] {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-python-import-cache-'))
  const sourceFile = path.join(sourceDir, 'entry.py')
  try {
    const source = [
      'import tornado.web',
      '',
      'class Container:',
      '    import tornado.web',
    ].join('\n')
    fs.writeFileSync(sourceFile, source)
    const previousMainDir = Config.maindir
    const previousMainDirPrefix = Config.maindirPrefix
    try {
      Config.maindir = sourceDir
      Config.maindirPrefix = `${sourceDir}/`
      const analyzer = new PythonAnalyzer({
        checkerIds: [],
        checkerPackIds: [],
        printers: [],
        language: 'python',
        uastSDKPath: UAST4PY_PATH,
      }) as unknown as AnalyzerHarness
      const scopes: ImportScope[] = []
      const processImportDirect = analyzer.processImportDirect.bind(analyzer)
      analyzer.processImportDirect = (scope, node, state): ResolvedValue => {
        scopes.push(scope as ImportScope)
        return processImportDirect(scope, node, state)
      }
      analyzer.preProcess4SingleFile(source, sourceFile)
      return [...new Set(scopes)].map((scope) => {
        const root = scope.getMemberValue?.('tornado') ?? undefined
        const value = memberValue(root, ['web'])
        return { qid: value?.qid, sid: value?.sid, nodeModule: value?.node_module, root }
      })
    } finally {
      Config.maindir = previousMainDir
      Config.maindirPrefix = previousMainDirPrefix
    }
  } finally {
    fs.rmSync(sourceDir, { recursive: true, force: true })
  }
}

function observeImport(
  source: string,
  lexicalRoot: string,
  memberPath: string[] = [],
  localFiles: Record<string, string> = {},
): ImportObservation {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-python-import-'))
  const sourceFile = path.join(sourceDir, 'entry.py')
  try {
    fs.writeFileSync(sourceFile, source)
    for (const [relativeFile, contents] of Object.entries(localFiles)) {
      const target = path.join(sourceDir, relativeFile)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, contents)
    }
    const previousMainDir = Config.maindir
    const previousMainDirPrefix = Config.maindirPrefix
    try {
      Config.maindir = sourceDir
      Config.maindirPrefix = `${sourceDir}/`
      const analyzer = new PythonAnalyzer({
        checkerIds: [],
        checkerPackIds: [],
        printers: [],
        language: 'python',
        uastSDKPath: UAST4PY_PATH,
      }) as unknown as AnalyzerHarness
      for (const relativeFile of Object.keys(localFiles)) {
        const target = path.join(sourceDir, relativeFile)
        analyzer.fileList.push(target)
        analyzer.pyAstParseManager[target] = Parser.parseSingleFile(target, analyzer.options)
      }
      let lexicalScope: ImportScope | undefined
      const processImportDirect = analyzer.processImportDirect.bind(analyzer)
      analyzer.processImportDirect = (scope, node, state): ResolvedValue => {
        lexicalScope = scope as ImportScope
        return processImportDirect(scope, node, state)
      }
      analyzer.preProcess4SingleFile(source, sourceFile)
      const root = lexicalScope?.getMemberValue?.(lexicalRoot) ?? undefined
      const value = memberValue(root, memberPath)
      return { qid: value?.qid, sid: value?.sid, nodeModule: value?.node_module, root }
    } finally {
      Config.maindir = previousMainDir
      Config.maindirPrefix = previousMainDirPrefix
    }
  } finally {
    fs.rmSync(sourceDir, { recursive: true, force: true })
  }
}

async function observeLoadedLocalDottedImport(): Promise<ImportObservation> {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-python-loaded-import-'))
  const sourceFile = path.join(sourceDir, 'entry.py')
  const localModule = path.join(sourceDir, 'localpkg', 'submodule.py')
  try {
    fs.mkdirSync(path.dirname(localModule), { recursive: true })
    fs.writeFileSync(sourceFile, 'import localpkg.submodule\n')
    fs.writeFileSync(localModule, 'class Target:\n    pass\n')
    const previousMainDir = Config.maindir
    const previousMainDirPrefix = Config.maindirPrefix
    try {
      Config.maindir = sourceDir
      Config.maindirPrefix = `${sourceDir}/`
      const analyzer = new PythonAnalyzer({
        checkerIds: [],
        checkerPackIds: [],
        printers: [],
        language: 'python',
        uastSDKPath: UAST4PY_PATH,
      }) as unknown as AnalyzerHarness
      let lexicalScope: ImportScope | undefined
      const processImportDirect = analyzer.processImportDirect.bind(analyzer)
      analyzer.processImportDirect = (scope, node, state): ResolvedValue => {
        lexicalScope = scope as ImportScope
        return processImportDirect(scope, node, state)
      }
      await analyzer.preProcess(sourceDir)
      const root = lexicalScope?.getMemberValue?.('localpkg') ?? undefined
      const value = memberValue(root, ['submodule'])
      return { qid: value?.qid, nodeModule: value?.node_module, root }
    } finally {
      Config.maindir = previousMainDir
      Config.maindirPrefix = previousMainDirPrefix
    }
  } finally {
    fs.rmSync(sourceDir, { recursive: true, force: true })
  }
}

function observeUnloadedLocalDottedImport(): ImportObservation {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-python-unloaded-import-'))
  const sourceFile = path.join(sourceDir, 'entry.py')
  const localModule = path.join(sourceDir, 'localpkg', 'submodule.py')
  try {
    fs.mkdirSync(path.dirname(localModule), { recursive: true })
    fs.writeFileSync(sourceFile, 'import localpkg.submodule\n')
    fs.writeFileSync(localModule, 'class Target:\n    pass\n')
    const previousMainDir = Config.maindir
    const previousMainDirPrefix = Config.maindirPrefix
    try {
      Config.maindir = sourceDir
      Config.maindirPrefix = `${sourceDir}/`
      const analyzer = new PythonAnalyzer({
        checkerIds: [],
        checkerPackIds: [],
        printers: [],
        language: 'python',
        uastSDKPath: UAST4PY_PATH,
      }) as unknown as AnalyzerHarness
      analyzer.fileList.push(localModule)
      analyzer.preProcess4SingleFile(fs.readFileSync(sourceFile, 'utf8'), sourceFile)
      const root = analyzer.topScope.value.localpkg
      return { qid: root?.value?.submodule?.qid, nodeModule: root?.value?.submodule?.node_module, root }
    } finally {
      Config.maindir = previousMainDir
      Config.maindirPrefix = previousMainDirPrefix
    }
  } finally {
    fs.rmSync(sourceDir, { recursive: true, force: true })
  }
}

function analyzeClass(source: string, className: string): ResolvedClassObservation | undefined {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yasa-python-inheritance-'))
  const sourceFile = path.join(sourceDir, 'entry.py')
  try {
    fs.writeFileSync(sourceFile, source)
    return analyzeClassFile(source, sourceFile, className, sourceDir)
  } finally {
    fs.rmSync(sourceDir, { recursive: true, force: true })
  }
}

function analyzeFixtureClass(sourceFile: string, className: string): ResolvedClassObservation | undefined {
  return analyzeClassFile(fs.readFileSync(sourceFile, 'utf8'), sourceFile, className, path.dirname(sourceFile))
}

function analyzeClassFile(source: string, sourceFile: string, className: string, mainDir: string): ResolvedClassObservation | undefined {
  const previousMainDir = Config.maindir
  const previousMainDirPrefix = Config.maindirPrefix
  try {
    Config.maindir = mainDir
    Config.maindirPrefix = `${mainDir}/`
    const analyzer = new PythonAnalyzer({
      checkerIds: [],
      checkerPackIds: [],
      printers: [],
      language: 'python',
      uastSDKPath: UAST4PY_PATH,
    }) as unknown as AnalyzerHarness
    const resolved: ResolvedClass[] = []
    const resolveClassInheritance = analyzer.resolveClassInheritance.bind(analyzer)
    analyzer.resolveClassInheritance = (classValue, state): void => {
      resolveClassInheritance(classValue, state)
      resolved.push(classValue)
    }
    analyzer.preProcess4SingleFile(source, sourceFile)
    const classValue = resolved.find((candidate) => candidate.ast?.cdef?.id?.name === className) ?? resolved.at(-1)
    if (!classValue) return undefined
    return {
      className: classValue.ast?.cdef?.id?.name,
      qid: classValue.qid,
      sid: classValue.sid,
      superQid: classValue.super?.qid,
      superNodeModule: classValue.super?.node_module,
    }
  } finally {
    Config.maindir = previousMainDir
    Config.maindirPrefix = previousMainDirPrefix
  }
}

type CallExpression = {
  type: 'CallExpression'
  callee: {
    type: 'Identifier'
    name: string
  }
}

type CallableValue = {
  node_module?: boolean
  qid?: string
  sid?: string
  super?: CallableValue
  ast?: {
    node?: { type?: string }
    cdef?: { type?: string }
  }
}

type TornadoApplicationInstance = {
  setFieldValue: (name: string, value: unknown) => void
}

type PythonAnalyzerTornadoInjector = {
  injectTornadoApplication: (instance: TornadoApplicationInstance, handler: CallableValue) => void
}

type TornadoTaintLifecycle = {
  triggerAtStartOfAnalyze: (analyzer: unknown, scope: unknown, node: unknown, state: unknown, info: unknown) => void
}

const TornadoTaintChecker = require('../../src/checker/taint/python/tornado-taint-checker') as new (...args: unknown[]) => TornadoTaintLifecycle

function injectTornadoApplication(instance: TornadoApplicationInstance, handler: CallableValue): void {
  const prototype = PythonAnalyzer.prototype as PythonAnalyzerTornadoInjector
  prototype.injectTornadoApplication.call(prototype, instance, handler)
}

function call(targetName: string): CallExpression {
  return {
    type: 'CallExpression',
    callee: { type: 'Identifier', name: targetName },
  }
}

function directTornadoApplication(): CallableValue {
  return { node_module: true, qid: 'tornado.web.Application' }
}

function localApplicationSubclass(superclass: CallableValue = directTornadoApplication()): CallableValue {
  return {
    qid: 'app.LocalApplication',
    ast: { node: { type: 'ClassDefinition' } },
    super: superclass,
  }
}

describe('Python dotted import provenance', () => {
  it('preserves the canonical external root chain for a dotted import', function () {
    this.timeout(30000)
    const imported = observeImport('import tornado.web', 'tornado', ['web'])

    assert.strictEqual(imported.nodeModule, true)
    assert.ok(imported.qid?.endsWith('tornado.web'))
    assert.strictEqual(imported.root?.getMemberValue?.('web')?.node_module, true)
    assert.ok(imported.root?.getMemberValue?.('web')?.qid?.endsWith('tornado.web'))
  })

  it('rebinds a cached dotted import into every lexical scope', function () {
    this.timeout(30000)
    const imports = observeCachedImportScopes()

    assert.strictEqual(imports.length, 2)
    for (const imported of imports) {
      assert.strictEqual(imported.nodeModule, true)
      assert.ok(imported.qid?.endsWith('tornado.web'))
      assert.strictEqual(imported.root?.getMemberValue?.('web')?.node_module, true)
    }
    assert.notStrictEqual(imports[0].root, imports[1].root)
  })

  it('binds a dotted import alias to the terminal module only', function () {
    this.timeout(30000)
    const imported = observeImport('import tornado.web as tw', 'tw')

    assert.strictEqual(imported.nodeModule, true)
    assert.ok(imported.qid?.endsWith('tornado.web'))
    assert.strictEqual(imported.root?.getMemberValue?.('web'), null)
  })

  it('retains terminal aliases without creating a root hierarchy', function () {
    this.timeout(30000)
    const aliases = ['x', '别名']

    for (const alias of aliases) {
      const imported = observeImport(`import tornado.web as ${alias}`, alias)

      assert.strictEqual(imported.nodeModule, true)
      assert.ok(imported.qid?.endsWith('tornado.web'))
      assert.strictEqual(imported.root?.getMemberValue?.('web'), null)
    }
  })

  it('retains escaped-continuation aliases without creating a root hierarchy', function () {
    this.timeout(30000)
    const imported = observeImport('import tornado.web as \\\n  x', 'x')

    assert.strictEqual(imported.nodeModule, true)
    assert.ok(imported.qid?.endsWith('tornado.web'))
    assert.strictEqual(imported.root?.getMemberValue?.('web'), null)
  })

  it('keeps from-import provenance exact', function () {
    this.timeout(30000)
    const imported = observeImport('from tornado.web import Application', 'Application')

    assert.strictEqual(imported.nodeModule, true)
    assert.ok(imported.qid?.endsWith('tornado.web.Application'))
  })

  it('preserves every external segment in a three-segment dotted import', function () {
    this.timeout(30000)
    const imported = observeImport('import tornado.httputil.HTTPHeaders', 'tornado', ['httputil', 'HTTPHeaders'])

    assert.strictEqual(imported.nodeModule, true)
    assert.ok(imported.qid?.endsWith('tornado.httputil.HTTPHeaders'))
    assert.strictEqual(imported.root?.getMemberValue?.('httputil')?.node_module, true)
    assert.strictEqual(imported.root?.getMemberValue?.('httputil')?.getMemberValue?.('HTTPHeaders')?.node_module, true)
  })

  it('keeps a fully preprocessed project-local dotted import local', async function () {
    this.timeout(30000)
    const imported = await observeLoadedLocalDottedImport()

    assert.strictEqual(imported.nodeModule, undefined)
    assert.notStrictEqual(imported.qid, 'localpkg')
  })

  it('does not inject external metadata for an unloaded local dotted import', function () {
    this.timeout(30000)
    const imported = observeUnloadedLocalDottedImport()

    assert.strictEqual(imported.nodeModule, undefined)
    assert.notStrictEqual(imported.root?.qid, 'localpkg')
  })
})

describe('Parsed Tornado Application call provenance', () => {
  it('preserves external provenance at a parsed from-import Application call', function () {
    this.timeout(30000)
    const observed = analyzeTornadoApplicationCall([
      'from tornado.web import Application',
      'app = Application([])',
    ].join('\n'))

    assert.strictEqual(observed.length, 1)
    assert.strictEqual(observed[0].nodeModule, true)
    assert.ok(observed[0].qid?.endsWith('tornado.web.Application'))
  })

  it('preserves external provenance at a parsed qualified Application call', function () {
    this.timeout(30000)
    const observed = analyzeTornadoApplicationCall([
      'import tornado.web',
      'app = tornado.web.Application([])',
    ].join('\n'))

    assert.strictEqual(observed.length, 1)
    assert.strictEqual(observed[0].nodeModule, true, JSON.stringify(observed))
    assert.ok(observed[0].qid?.endsWith('tornado.web.Application'), JSON.stringify(observed))
  })

  it('preserves the direct external superclass at a parsed local Application call', function () {
    this.timeout(30000)
    const observed = analyzeTornadoApplicationCall([
      'import tornado.web',
      '',
      'class Application(tornado.web.Application):',
      '    pass',
      '',
      'app = Application([])',
    ].join('\n'))

    assert.strictEqual(observed.length, 1)
    assert.strictEqual(observed[0].nodeModule, undefined)
    assert.strictEqual(observed[0].superNodeModule, true)
    assert.ok(observed[0].superQid?.endsWith('tornado.web.Application'))
  })
})

describe('Tornado handler Application registration', () => {
  const handler = (): CallableValue => ({
    qid: 'app.Handler',
    ast: { node: { type: 'ClassDefinition' } },
  })

  beforeEach(() => {
    resetTornadoHandlerApplications()
  })

  it('injects the application for one registered handler application', () => {
    const application = { qid: 'app.one' }
    const fields = new Map<string, unknown>()
    registerTornadoHandlerApplication(handler(), application)

    injectTornadoApplication({ setFieldValue: (name, value): void => fields.set(name, value) }, handler())

    assert.strictEqual(fields.get('application'), application)
  })

  it('does not inject an application when a handler has no registration', () => {
    const fields = new Map<string, unknown>()

    injectTornadoApplication({ setFieldValue: (name, value): void => fields.set(name, value) }, handler())

    assert.strictEqual(fields.has('application'), false)
  })

  it('fails closed without injection when a handler belongs to multiple applications', () => {
    const fields = new Map<string, unknown>()
    registerTornadoHandlerApplication(handler(), { qid: 'app.one' })
    registerTornadoHandlerApplication(handler(), { qid: 'app.two' })

    injectTornadoApplication({ setFieldValue: (name, value): void => fields.set(name, value) }, handler())

    assert.strictEqual(fields.has('application'), false)
  })

  it('clears registrations at the next analysis lifecycle start', () => {
    const checker = new TornadoTaintChecker({})
    registerTornadoHandlerApplication(handler(), { qid: 'previous.app' })

    checker.triggerAtStartOfAnalyze(undefined, undefined, undefined, undefined, undefined)

    assert.strictEqual(getUniqueTornadoHandlerApplication(handler()), undefined)
  })
})

describe('Tornado Application subclass provenance', () => {
  it('resolves qualified external and local direct bases without creating self-cycles', function () {
    this.timeout(30000)
    const qualifiedApplication = analyzeClass([
      'import tornado.web',
      '',
      'class Application(tornado.web.Application):',
      '    pass',
    ].join('\n'), 'Application')
    const selfReferentialApplication = analyzeClass([
      'class Application(Application):',
      '    pass',
    ].join('\n'), 'Application')
    const child = analyzeClass([
      'class Base:',
      '    pass',
      '',
      'class Child(Base):',
      '    pass',
    ].join('\n'), 'Child')

    assert.strictEqual(qualifiedApplication?.superQid, '<global>.entry.tornado.web.Application')
    assert.strictEqual(qualifiedApplication?.superNodeModule, true)
    assert.strictEqual(selfReferentialApplication?.superQid, undefined)
    assert.strictEqual(child?.superQid, '<global>.entry.Base')
  })

  it('accepts a direct external Application', () => {
    assert.strictEqual(isTornadoFrameworkCall(call('Application'), 'Application', directTornadoApplication()), true)
  })

  it('accepts a local class whose immediate resolved base is tornado.web.Application', () => {
    assert.strictEqual(isTornadoFrameworkCall(call('Application'), 'Application', localApplicationSubclass()), true)
  })

  it('rejects a same-named local class with no base', () => {
    assert.strictEqual(
      isTornadoFrameworkCall(call('Application'), 'Application', { qid: 'app.Application', ast: { node: { type: 'ClassDefinition' } } }),
      false,
    )
  })

  it('rejects a local class with an unresolved parent', () => {
    assert.strictEqual(isTornadoFrameworkCall(call('Application'), 'Application', localApplicationSubclass({ qid: 'app.Base' })), false)
  })

  it('rejects a direct external Tornado class other than Application', () => {
    assert.strictEqual(isTornadoFrameworkCall(call('Application'), 'Application', { node_module: true, qid: 'tornado.web.Other' }), false)
  })

  it('rejects a local class whose immediate base is another Tornado class', () => {
    assert.strictEqual(
      isTornadoFrameworkCall(call('Application'), 'Application', localApplicationSubclass({ node_module: true, qid: 'tornado.web.Other' })),
      false,
    )
  })

  it('rejects non-ClassDefinition values with a matching direct super', () => {
    assert.strictEqual(
      isTornadoFrameworkCall(call('Application'), 'Application', { qid: 'app.NotAClass', ast: { node: { type: 'FunctionDefinition' } }, super: directTornadoApplication() }),
      false,
    )
  })

  it('rejects a local Application subclass when evaluating another target', () => {
    assert.strictEqual(isTornadoFrameworkCall(call('RequestHandler'), 'RequestHandler', localApplicationSubclass()), false)
  })

  it('rejects a multi-inheritance value whose retained direct super is not Tornado Application', () => {
    const tornadoBase = directTornadoApplication()
    assert.strictEqual(
      isTornadoFrameworkCall(
        call('Application'),
        'Application',
        localApplicationSubclass({ node_module: true, qid: 'app.FinalBase', super: tornadoBase }),
      ),
      false,
    )
  })
})
