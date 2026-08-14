import { describe, it, beforeEach } from 'mocha'
import * as assert from 'assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type { BaseNode, CallExpression, CompileUnit, Identifier, MemberAccess, Node } from '../../src/types/uast'

const Config = require('../../src/config')
const BasicRuleHandler = require('../../src/checker/common/rules-basic-handler')
const ResultManager = require('../../src/engine/analyzer/common/result-manager')
const { PrimitiveValue } = require('../../src/engine/analyzer/common/value/primitive')
const NodejsCliTaintChecker = require('../../src/checker/taint/js/nodejs-cli-taint-checker')
const {
  hasCliEntrypointEvidence,
  hasCliNodeEvidence,
  isKnownCliFrameworkArgvMemberAccess,
  isKnownCliFrameworkReturnCall,
  isKnownCliParserCall,
  isProcessArgvAccess,
  isProcessArgvDerivedCall,
} = NodejsCliTaintChecker

type FindingLike = {
  ruleName?: string
  trace?: Array<{ tag?: string; affectedNodeName?: string }>
}

const SOURCE_FILE = '/tmp/nodejs-cli-taint-checker/bin/cli.js'
const HELPER_FILE = '/tmp/nodejs-cli-taint-checker/src/helper.js'
const SRC_INDEX_FILE = '/tmp/nodejs-cli-taint-checker/src/index.ts'
const ENTRY_FCLOS = {
  vtype: 'fclos',
  ast: { node: { loc: loc(1) } },
}
const ENTRY_STATE = { callstack: [ENTRY_FCLOS] }

function loc(line: number, sourcefile = SOURCE_FILE): BaseNode['loc'] {
  return { sourcefile, start: { line, column: 0 }, end: { line, column: 0 } }
}

function identifier(name: string, line = 1, sourcefile = SOURCE_FILE): Identifier {
  return { type: 'Identifier', name, loc: loc(line, sourcefile), _meta: {} } as Identifier
}

function member(object: Node, propertyName: string, line = 1, sourcefile = object.loc?.sourcefile || SOURCE_FILE): MemberAccess {
  return { type: 'MemberAccess', object, property: identifier(propertyName, line, sourcefile), computed: false, loc: loc(line, sourcefile), _meta: {} } as MemberAccess
}

function call(callee: Node, line = 1, sourcefile = callee.loc?.sourcefile || SOURCE_FILE, args: Node[] = []): CallExpression {
  return { type: 'CallExpression', callee, arguments: args, loc: loc(line, sourcefile), _meta: {} } as CallExpression
}

function compileUnit(sourcefile = SOURCE_FILE, extra: Partial<CompileUnit> = {}): CompileUnit {
  return {
    type: 'CompileUnit',
    body: [],
    language: 'javascript',
    uri: sourcefile,
    version: 'test',
    loc: loc(1, sourcefile),
    _meta: {},
    ...extra,
  } as CompileUnit
}

function makeStringValue(name: string): InstanceType<typeof PrimitiveValue> {
  return new PrimitiveValue('', name, name, 'string')
}

function makeChecker(): InstanceType<typeof NodejsCliTaintChecker> {
  const checker = new NodejsCliTaintChecker(new ResultManager())
  checker.checkerRuleConfigContent = {
    sources: {},
    sinks: {
      FuncCallTaintSink: [
        { fsig: 'spawnSync', calleeType: '', args: ['1'], attribute: 'NodejsExec' },
        { fsig: 'child_process.spawnSync', calleeType: '', args: ['1'], attribute: 'NodejsExec' },
      ],
    },
  }
  return checker
}

function collectFindings(checker: InstanceType<typeof NodejsCliTaintChecker>): FindingLike[] {
  const findings = checker.resultManager.getFindings()
  return (findings.taintflow || []) as FindingLike[]
}

function scanFilesForEntrypoints(
  checker: InstanceType<typeof NodejsCliTaintChecker>,
  files: Array<{ uuid: string; node: CompileUnit }>
): void {
  const fileManager: Record<string, string> = {}
  const symbolTable = new Map<string, unknown>()
  for (const file of files) {
    const sourcefile = file.node.loc?.sourcefile || file.uuid
    fileManager[sourcefile] = file.uuid
    symbolTable.set(file.uuid, { ast: { node: file.node } })
  }
  checker.prepareEntryPoints({ fileManager, symbolTable }, null, fileManager)
}

function withPackageJson(packageJson: object, callback: (projectRoot: string, indexFile: string) => void): void {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nodejs-cli-taint-checker-'))
  try {
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify(packageJson), 'utf8')
    callback(projectRoot, path.join(projectRoot, 'src/index.ts'))
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true })
  }
}

describe('nodejs-cli-taint-checker source 边界', () => {
  it('process.argv 应识别为 Node.js CLI source 访问', () => {
    assert.strictEqual(isProcessArgvAccess(member(identifier('process'), 'argv')), true)
  })

  it('process.argv.slice(2) 应识别为 Node.js CLI 派生 source', () => {
    assert.strictEqual(isProcessArgvDerivedCall(call(member(member(identifier('process'), 'argv'), 'slice'))), true)
  })

  it('普通 argv 对象不应识别为 Node.js CLI source', () => {
    assert.strictEqual(isProcessArgvAccess(member(identifier('options'), 'argv')), false)
  })

  it('minimist/mri/arg parser 需要 callee/import 证据', () => {
    assert.strictEqual(isKnownCliParserCall(call(identifier('minimist')), { qid: 'node_modules.minimist.exports' }), true)
    assert.strictEqual(isKnownCliParserCall(call(identifier('parse')), { qid: 'src.parse' }), false)
  })

  it('commander/yargs return source 需要框架 receiver 证据', () => {
    assert.strictEqual(isKnownCliFrameworkReturnCall(call(member(identifier('program'), 'opts')), { qid: 'commander.Command.opts' }), true)
    assert.strictEqual(isKnownCliFrameworkReturnCall(call(member(identifier('ordinary'), 'opts')), { qid: 'src.ordinary.opts' }), false)
  })

  it('yargs argv member access 需要框架 import 证据', () => {
    const argvSliceCall = call(member(member(identifier('process'), 'argv', 8), 'slice', 8), 8)
    const yargsArgv = member(call(identifier('yargs'), 9, SOURCE_FILE, [argvSliceCall]), 'argv')
    assert.strictEqual(isKnownCliFrameworkArgvMemberAccess(yargsArgv, { qid: 'node_modules.yargs.exports' }), true)
    assert.strictEqual(isKnownCliFrameworkArgvMemberAccess(yargsArgv, { qid: 'src.yargs' }), false)
  })

  it('shebang 应作为非 bin/cli 路径的 CLI 文件证据', () => {
    assert.strictEqual(
      hasCliNodeEvidence(compileUnit(SRC_INDEX_FILE, { shebang: '#!/usr/bin/env node' } as Partial<CompileUnit>)),
      true
    )
  })

  it('CLI entrypoint evidence 应限定 bin/cli 路径、package 映射或专用 attribute', () => {
    assert.strictEqual(hasCliEntrypointEvidence({ filePath: 'bin/cli.js' }), true)
    assert.strictEqual(hasCliEntrypointEvidence({ attribute: 'nodejs-cli' }), true)
    assert.strictEqual(
      hasCliEntrypointEvidence({ filePath: SRC_INDEX_FILE }, { bin: { apispace: './src/index.ts' } }, '/tmp/nodejs-cli-taint-checker'),
      true
    )
    assert.strictEqual(hasCliEntrypointEvidence({ filePath: 'src/helper.js' }), false)
  })

  it('prepareEntryPoints 不应把普通 helper 文件作为 CLI 入口', () => {
    const checker = makeChecker()
    const cliFile = { ast: { node: compileUnit(SOURCE_FILE) } }
    const helperFile = { ast: { node: compileUnit(HELPER_FILE) } }
    const analyzer = {
      fileManager: { [SOURCE_FILE]: 'cli-uuid', [HELPER_FILE]: 'helper-uuid' },
      symbolTable: new Map<string, unknown>([
        ['cli-uuid', cliFile],
        ['helper-uuid', helperFile],
      ]),
    }

    checker.prepareEntryPoints(analyzer, null, analyzer.fileManager)

    assert.strictEqual(checker.entryPoints.length, 1)
    assert.strictEqual(checker.entryPoints[0].type, 'fileBegin')
    assert.strictEqual(checker.entryPoints[0].filePath, SOURCE_FILE)
    assert.strictEqual(checker.entryPoints[0].attribute, 'nodejs-cli')
  })
})

describe('nodejs-cli-taint-checker 端到端 finding', () => {
  beforeEach(() => {
    Config.analyzer = 'JavaScriptAnalyzer'
    Config.language = 'javascript'
    Config.entryPointMode = 'BOTH'
    BasicRuleHandler.setPreprocessReady(true)
  })

  it('process.argv.slice(2) 传播到 spawnSync argv 参数', () => {
    const checker = makeChecker()
    const argvSliceValue = makeStringValue('process.argv.slice(2)')
    scanFilesForEntrypoints(checker, [{ uuid: 'cli-uuid', node: compileUnit(SOURCE_FILE) }])

    checker.triggerAtFunctionCallAfter(null, null, call(member(member(identifier('process'), 'argv', 8), 'slice', 8), 8), null, {
      ret: argvSliceValue,
    })

    checker.triggerAtFunctionCallBefore(null, null, call(identifier('spawnSync'), 18), ENTRY_STATE, {
      fclos: { vtype: 'fclos' },
      callInfo: {
        callArgs: {
          args: [
            { index: 0, value: makeStringValue('node'), kind: 'positional' },
            { index: 1, value: argvSliceValue, kind: 'positional' },
          ],
        },
      },
    })

    const findings = collectFindings(checker)
    assert.strictEqual(findings.length, 1)
    assert.ok(findings[0].ruleName?.includes('spawnSync'))
    assert.ok(findings[0].trace?.some((item) => item.tag === 'SOURCE: ' && item.affectedNodeName?.includes('process.argv.slice')))
  })

  it('非 CLI 普通 argv.slice 不应标记 source', () => {
    const checker = makeChecker()
    const ordinaryArgvValue = makeStringValue('options.argv.slice(2)')

    checker.triggerAtFunctionCallAfter(null, null, call(member(member(identifier('options'), 'argv', 8), 'slice', 8), 8), null, {
      ret: ordinaryArgvValue,
    })

    checker.triggerAtFunctionCallBefore(null, null, call(identifier('spawnSync'), 18), ENTRY_STATE, {
      fclos: { vtype: 'fclos' },
      callInfo: {
        callArgs: {
          args: [
            { index: 0, value: makeStringValue('node'), kind: 'positional' },
            { index: 1, value: ordinaryArgvValue, kind: 'positional' },
          ],
        },
      },
    })

    assert.strictEqual(collectFindings(checker).length, 0)
  })

  it('非 CLI helper 文件中的 process.argv.slice 不应标记 source', () => {
    const checker = makeChecker()
    const helperArgvValue = makeStringValue('helper process.argv.slice(2)')
    const helperProcessArgv = member(identifier('process', 8, HELPER_FILE), 'argv', 8, HELPER_FILE)

    checker.triggerAtFunctionCallAfter(null, null, call(member(helperProcessArgv, 'slice', 8, HELPER_FILE), 8, HELPER_FILE), null, {
      ret: helperArgvValue,
    })

    checker.triggerAtFunctionCallBefore(null, null, call(identifier('spawnSync'), 18), ENTRY_STATE, {
      fclos: { vtype: 'fclos' },
      callInfo: {
        callArgs: {
          args: [
            { index: 0, value: makeStringValue('node'), kind: 'positional' },
            { index: 1, value: helperArgvValue, kind: 'positional' },
          ],
        },
      },
    })

    assert.strictEqual(collectFindings(checker).length, 0)
  })

  it('src/index.ts 通过 shebang 文件级证据标记 process.argv.slice source', () => {
    const checker = makeChecker()
    const indexArgvValue = makeStringValue('shebang src/index.ts process.argv.slice(2)')
    scanFilesForEntrypoints(checker, [
      { uuid: 'index-uuid', node: compileUnit(SRC_INDEX_FILE, { shebang: '#!/usr/bin/env node' } as Partial<CompileUnit>) },
    ])
    const indexProcessArgv = member(identifier('process', 8, SRC_INDEX_FILE), 'argv', 8, SRC_INDEX_FILE)
    const indexSliceCall = call(member(indexProcessArgv, 'slice', 8, SRC_INDEX_FILE), 8, SRC_INDEX_FILE)

    checker.triggerAtFunctionCallAfter(null, null, indexSliceCall, null, {
      ret: indexArgvValue,
    })

    checker.triggerAtFunctionCallBefore(null, null, call(identifier('spawnSync'), 18), ENTRY_STATE, {
      fclos: { vtype: 'fclos' },
      callInfo: {
        callArgs: {
          args: [
            { index: 0, value: makeStringValue('node'), kind: 'positional' },
            { index: 1, value: indexArgvValue, kind: 'positional' },
          ],
        },
      },
    })

    const findings = collectFindings(checker)
    assert.strictEqual(findings.length, 1)
    assert.ok(findings[0].trace?.some((item) => item.tag === 'SOURCE: ' && item.affectedNodeName?.includes('process.argv.slice')))
  })

  it('src/index.ts 通过 package bin 映射标记 process.argv.slice source', () => {
    withPackageJson({ bin: { apispace: './src/index.ts' }, scripts: { dev: 'ts-node src/index.ts' } }, (projectRoot, indexFile) => {
      const previousMaindirPrefix = Config.maindirPrefix
      Config.maindirPrefix = projectRoot
      try {
        const checker = makeChecker()
        const indexArgvValue = makeStringValue('src/index.ts process.argv.slice(2)')
        scanFilesForEntrypoints(checker, [
          { uuid: 'index-uuid', node: compileUnit(indexFile) },
        ])
        const indexProcessArgv = member(identifier('process', 8, indexFile), 'argv', 8, indexFile)
        const indexSliceCall = call(member(indexProcessArgv, 'slice', 8, indexFile), 8, indexFile)

        checker.triggerAtFunctionCallAfter(null, null, indexSliceCall, null, {
          ret: indexArgvValue,
        })

        checker.triggerAtFunctionCallBefore(null, null, call(identifier('spawnSync'), 18), ENTRY_STATE, {
          fclos: { vtype: 'fclos' },
          callInfo: {
            callArgs: {
              args: [
                { index: 0, value: makeStringValue('node'), kind: 'positional' },
                { index: 1, value: indexArgvValue, kind: 'positional' },
              ],
            },
          },
        })

        const findings = collectFindings(checker)
        assert.strictEqual(findings.length, 1)
        assert.ok(findings[0].trace?.some((item) => item.tag === 'SOURCE: ' && item.affectedNodeName?.includes('process.argv.slice')))
      } finally {
        Config.maindirPrefix = previousMaindirPrefix
      }
    })
  })

  it('minimist 返回对象在入参来自 process.argv 时标记 source', () => {
    const checker = makeChecker()
    const parserValue = makeStringValue('minimist(process.argv.slice(2))')
    const argvSliceCall = call(member(member(identifier('process'), 'argv', 8), 'slice', 8), 8)
    scanFilesForEntrypoints(checker, [{ uuid: 'cli-uuid', node: compileUnit(SOURCE_FILE) }])

    checker.triggerAtFunctionCallAfter(null, null, call(identifier('minimist'), 9, SOURCE_FILE, [argvSliceCall]), null, {
      fclos: { qid: 'node_modules.minimist.exports' },
      ret: parserValue,
    })

    checker.triggerAtFunctionCallBefore(null, null, call(identifier('spawnSync'), 18), ENTRY_STATE, {
      fclos: { vtype: 'fclos' },
      callInfo: {
        callArgs: {
          args: [
            { index: 0, value: makeStringValue('node'), kind: 'positional' },
            { index: 1, value: parserValue, kind: 'positional' },
          ],
        },
      },
    })

    const findings = collectFindings(checker)
    assert.strictEqual(findings.length, 1)
    assert.ok(findings[0].trace?.some((item) => item.affectedNodeName?.includes('minimist')))
  })

  it('同名 parser 函数缺少 import 证据时不应标记 source', () => {
    const checker = makeChecker()
    const parserValue = makeStringValue('local minimist(process.argv.slice(2))')
    const argvSliceCall = call(member(member(identifier('process'), 'argv', 8), 'slice', 8), 8)
    scanFilesForEntrypoints(checker, [{ uuid: 'cli-uuid', node: compileUnit(SOURCE_FILE) }])

    checker.triggerAtFunctionCallAfter(null, null, call(identifier('minimist'), 9, SOURCE_FILE, [argvSliceCall]), null, {
      fclos: { qid: 'src.minimist' },
      ret: parserValue,
    })

    checker.triggerAtFunctionCallBefore(null, null, call(identifier('spawnSync'), 18), ENTRY_STATE, {
      fclos: { vtype: 'fclos' },
      callInfo: {
        callArgs: {
          args: [
            { index: 0, value: makeStringValue('node'), kind: 'positional' },
            { index: 1, value: parserValue, kind: 'positional' },
          ],
        },
      },
    })

    assert.strictEqual(collectFindings(checker).length, 0)
  })

  it('commander opts 返回对象在框架 receiver 证据明确时标记 source', () => {
    const checker = makeChecker()
    const optsValue = makeStringValue('program.opts()')
    scanFilesForEntrypoints(checker, [{ uuid: 'cli-uuid', node: compileUnit(SOURCE_FILE) }])

    checker.triggerAtFunctionCallAfter(null, null, call(member(identifier('program'), 'opts'), 12), null, {
      fclos: { qid: 'commander.Command.opts' },
      ret: optsValue,
    })

    checker.triggerAtFunctionCallBefore(null, null, call(identifier('spawnSync'), 18), ENTRY_STATE, {
      fclos: { vtype: 'fclos' },
      callInfo: {
        callArgs: {
          args: [
            { index: 0, value: makeStringValue('node'), kind: 'positional' },
            { index: 1, value: optsValue, kind: 'positional' },
          ],
        },
      },
    })

    const findings = collectFindings(checker)
    assert.strictEqual(findings.length, 1)
    assert.ok(findings[0].trace?.some((item) => item.affectedNodeName?.includes('program.opts')))
  })

  it('普通对象 opts 返回值不应标记 source', () => {
    const checker = makeChecker()
    const optsValue = makeStringValue('ordinary.opts()')
    scanFilesForEntrypoints(checker, [{ uuid: 'cli-uuid', node: compileUnit(SOURCE_FILE) }])

    checker.triggerAtFunctionCallAfter(null, null, call(member(identifier('ordinary'), 'opts'), 12), null, {
      fclos: { qid: 'src.ordinary.opts' },
      ret: optsValue,
    })

    checker.triggerAtFunctionCallBefore(null, null, call(identifier('spawnSync'), 18), ENTRY_STATE, {
      fclos: { vtype: 'fclos' },
      callInfo: {
        callArgs: {
          args: [
            { index: 0, value: makeStringValue('node'), kind: 'positional' },
            { index: 1, value: optsValue, kind: 'positional' },
          ],
        },
      },
    })

    assert.strictEqual(collectFindings(checker).length, 0)
  })

  it('yargs argv 属性在框架 import 证据明确时标记 source', () => {
    const checker = makeChecker()
    const argvValue = makeStringValue('yargs(process.argv.slice(2)).argv')
    const argvSliceCall = call(member(member(identifier('process'), 'argv', 8), 'slice', 8), 8)
    const yargsArgv = member(call(identifier('yargs'), 9, SOURCE_FILE, [argvSliceCall]), 'argv', 9)
    scanFilesForEntrypoints(checker, [{ uuid: 'cli-uuid', node: compileUnit(SOURCE_FILE) }])

    checker.triggerAtMemberAccess(null, null, yargsArgv, null, {
      fclos: { qid: 'node_modules.yargs.exports' },
      res: argvValue,
    })

    checker.triggerAtFunctionCallBefore(null, null, call(identifier('spawnSync'), 18), ENTRY_STATE, {
      fclos: { vtype: 'fclos' },
      callInfo: {
        callArgs: {
          args: [
            { index: 0, value: makeStringValue('node'), kind: 'positional' },
            { index: 1, value: argvValue, kind: 'positional' },
          ],
        },
      },
    })

    const findings = collectFindings(checker)
    assert.strictEqual(findings.length, 1)
    assert.ok(findings[0].trace?.some((item) => item.affectedNodeName?.includes('yargs')))
  })

  it('同名 yargs 本地函数不应通过 argv 属性标记 source', () => {
    const checker = makeChecker()
    const argvValue = makeStringValue('local yargs(process.argv.slice(2)).argv')
    const argvSliceCall = call(member(member(identifier('process'), 'argv', 8), 'slice', 8), 8)
    const yargsArgv = member(call(identifier('yargs'), 9, SOURCE_FILE, [argvSliceCall]), 'argv', 9)
    scanFilesForEntrypoints(checker, [{ uuid: 'cli-uuid', node: compileUnit(SOURCE_FILE) }])

    checker.triggerAtMemberAccess(null, null, yargsArgv, null, {
      fclos: { qid: 'src.yargs' },
      res: argvValue,
    })

    checker.triggerAtFunctionCallBefore(null, null, call(identifier('spawnSync'), 18), ENTRY_STATE, {
      fclos: { vtype: 'fclos' },
      callInfo: {
        callArgs: {
          args: [
            { index: 0, value: makeStringValue('node'), kind: 'positional' },
            { index: 1, value: argvValue, kind: 'positional' },
          ],
        },
      },
    })

    assert.strictEqual(collectFindings(checker).length, 0)
  })
})
