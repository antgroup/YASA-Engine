import assert from 'assert'
import { describe, it } from 'mocha'
import { buildJavaCandidateFinding, getJavaFindingSignature } from '../src/checker/taint/java/java-finding-candidate'
import { getCalleeEntry } from '../src/checker/taint/java/callee-entry'

type Node = { loc: { sourcefile: string; start: { line: number }; end: { line: number } }; _meta: { nodehash: string }; id?: { name: string; loc?: Node['loc'] }; body?: { loc: Node['loc'] } }
const node = (file: string, line: number, hash: string, name = 'method'): Node => ({
  loc: { sourcefile: file, start: { line }, end: { line } },
  _meta: { nodehash: hash },
  id: { name },
})

function finding() {
  const sourceNode = node('Source.java', 3, 'source')
  const outerNode = node('Controller.java', 10, 'outer', 'outer')
  const innerNode = node('Service.java', 20, 'inner', 'inner')
  const sinkNode = node('Sink.java', 30, 'sink')
  return {
    type: 'taint_flow_java_input',
    traceRejectReason: 'ARG_PASS_ORDER_OUT_OF_CALLSTACK',
    sinkAttribute: ['body'],
    trace: [
      { file: 'Source.java', line: 3, tag: 'SOURCE: ', node: sourceNode },
      { file: 'Service.java', line: 21, tag: 'ARG PASS: ', node: innerNode },
      { file: 'Controller.java', line: 11, tag: 'ARG PASS: ', node: outerNode },
      { file: 'Sink.java', line: 30, tag: 'SINK: ', node: sinkNode },
    ],
    callstack: [
      { vtype: 'fclos', ast: { node: outerNode } },
      { vtype: 'fclos', ast: { node: innerNode } },
    ],
    callsites: [
      { nodeHash: 'outer-call', loc: { sourcefile: 'Entry.java', start: { line: 5 }, end: { line: 5 } } },
      { nodeHash: 'inner-call', loc: { sourcefile: 'Controller.java', start: { line: 11 }, end: { line: 11 } } },
    ],
  }
}

describe('Java finding candidate reconstruction', () => {
  it('rebuilds a concise source-call-arg-sink trace without accepting the rejected trace', () => {
    const original = finding()
    const candidate = buildJavaCandidateFinding(original)
    assert.ok(candidate)
    assert.deepStrictEqual(candidate?.trace?.map((step) => step.tag), ['SOURCE: ', 'CALL: ', 'ARG PASS: ', 'SINK: '])
    assert.strictEqual(candidate?.callstack?.length, 2)
    assert.strictEqual(candidate?.callsites?.length, 2)
    assert.deepStrictEqual(original.trace?.map((step) => step.tag), ['SOURCE: ', 'ARG PASS: ', 'ARG PASS: ', 'SINK: '])
    assert.strictEqual(getJavaFindingSignature(candidate), getJavaFindingSignature({ ...original, trace: candidate?.trace }))
  })


  it('places candidate ARG PASS on the callee method entry instead of annotation range', () => {
    const original = finding()
    const innerNode = original.callstack[1].ast.node
    innerNode.loc = { sourcefile: 'Service.java', start: { line: 18 }, end: { line: 28 } }
    innerNode.id = { name: 'queryAisTaskStatus', loc: { sourcefile: 'Service.java', start: { line: 22 }, end: { line: 22 } } }
    const candidate = buildJavaCandidateFinding(original)
    const argPass = candidate?.trace?.find((step) => step.tag === 'ARG PASS: ')
    assert.strictEqual(argPass?.line, 22)
    assert.strictEqual(argPass?.node?.loc?.start?.line, 22)
    assert.strictEqual(argPass?.node?._meta?.nodehash, 'inner')
    assert.strictEqual(argPass?.affectedNodeName, 'queryAisTaskStatus')
  })

  it('skips an AST-less library frame while preserving edgePairs plus one method', () => {
    const original = finding()
    const libraryFrame = { vtype: 'fclos' }
    original.callstack = [original.callstack[0], libraryFrame, original.callstack[1]]
    original.callsites = [
      original.callsites[0],
      { nodeHash: 'library-call', loc: { sourcefile: 'Library.java', start: { line: 50 }, end: { line: 50 } } },
      original.callsites[1],
    ]
    const candidate = buildJavaCandidateFinding(original)
    assert.ok(candidate)
    const trace = candidate?.trace ?? []
    const edgePairs = trace.filter((step) => step.tag === 'CALL: ').length
    assert.strictEqual(candidate?.callstack?.length, edgePairs + 1)
    assert.strictEqual(trace[0]?.tag, 'SOURCE: ')
    assert.strictEqual(trace[trace.length - 1]?.tag, 'SINK: ')
  })


  it('keeps same-line distinct node hashes distinct in signatures', () => {
    const first = finding()
    const second = finding()
    second.trace[0].node._meta.nodehash = 'different-source'
    assert.notStrictEqual(getJavaFindingSignature(first), getJavaFindingSignature(second))
  })

  it('uses callee entry location priority, single-line loc, frame hash, and cleaned name', () => {
    const frame = {
      vtype: 'fclos',
      fname: '<global>.queryAisTaskStatus',
      ast: { node: { ...node('Controller.java', 10, 'frame'), id: { name: '<global>.queryAisTaskStatus', loc: { sourcefile: 'Controller.java', start: { line: 12 }, end: { line: 12 } } }, body: { loc: { sourcefile: 'Controller.java', start: { line: 13 }, end: { line: 20 } } } } },
    }
    const entry = getCalleeEntry(frame)
    assert.ok(entry)
    assert.strictEqual(entry?.line, 12)
    assert.deepStrictEqual(entry?.loc.start, { line: 12, column: 0 })
    assert.deepStrictEqual(entry?.loc.end, { line: 12, column: 0 })
    assert.strictEqual(entry?.node._meta?.nodehash, 'frame')
    assert.strictEqual(entry?.name, 'queryAisTaskStatus')

    const fallbackFrame = { vtype: 'fclos', ast: { node: { ...node('Controller.java', 10, 'fallback'), body: { loc: { sourcefile: 'Controller.java', start: { line: 14 }, end: { line: 18 } } } } } }
    assert.strictEqual(getCalleeEntry(fallbackFrame)?.line, 14)
    const frameLoc = { vtype: 'fclos', ast: { node: node('Controller.java', 16, 'frame-only') } }
    assert.strictEqual(getCalleeEntry(frameLoc)?.line, 16)
  })

  it('rejects incomplete structure and non-Java findings', () => {
    const malformed = finding()
    malformed.callsites = malformed.callsites.slice(0, 1)
    assert.strictEqual(buildJavaCandidateFinding(malformed), undefined)
    assert.strictEqual(getJavaFindingSignature({ ...finding(), type: 'taint_flow_go_input' }), undefined)
  })
})
