import * as assert from 'assert'
import { describe, it } from 'mocha'

const JavaMap = require('../../src/engine/analyzer/java/common/builtins/map-builtins')
const JavaCollection = require('../../src/engine/analyzer/java/common/builtins/collection-builtins')
const JavaStream = require('../../src/engine/analyzer/java/common/builtins/stream-builtins')
const JavaAnalyzerModule = require('../../src/engine/analyzer/java/common/java-analyzer')
const { __javaAnalyzerTestHooks } = JavaAnalyzerModule
const { ObjectValue } = require('../../src/engine/analyzer/common/value/object')
const { PrimitiveValue } = require('../../src/engine/analyzer/common/value/primitive')
const { SymbolValue } = require('../../src/engine/analyzer/common/value/symbolic')

describe('Java Map builtins', function () {
  it('propagates tainted dynamic key to unresolved Map.get value', function () {
    const mapValue = new ObjectValue('', { sid: 'regionMap', qid: 'regionMap', valueType: 'java.lang.String' })
    JavaMap.Map(mapValue, [], {}, {}, {})

    const keyValue = new PrimitiveValue('', 'regnCode', 'userRegion', 'string', 'Literal')
    keyValue.taint.addTag('JAVA_INPUT')
    keyValue.taint.markSource()

    const result = JavaMap.get({ getThisObj: () => mapValue }, [keyValue], {}, { type: 'CallExpression' }, { qid: '<test>' })

    assert.strictEqual(result?.taint?.isTainted, true)
    assert.deepStrictEqual(result.taint.getTags(), ['JAVA_INPUT'])
    assert.strictEqual(result.getMisc('buffer')[0], keyValue)
  })



  it('merges buffered element source trace onto Collection.stream result', function () {
    const collectionValue = new ObjectValue('', { sid: 'items', qid: 'items' })
    JavaCollection.Collection(collectionValue, [], {}, {}, {})

    const elementValue = new ObjectValue('', { sid: 'item', qid: 'items.0' })
    elementValue.taint.addTag('JAVA_INPUT')
    elementValue.taint.addTraceToTag('JAVA_INPUT', { tag: 'SOURCE: ', file: 'Item.java', line: 1 })
    elementValue.taint.markSource()

    collectionValue.setMisc('buffer', [elementValue])
    const streamClass = new ObjectValue('', { sid: 'Stream', qid: 'java.util.stream.Stream' })
    const javaUtilStream = new ObjectValue('', { sid: 'stream', qid: 'java.util.stream' })
    const javaUtil = new ObjectValue('', { sid: 'util', qid: 'java.util' })
    const javaPackage = new ObjectValue('', { sid: 'java', qid: 'java' })
    javaUtilStream.setMemberValue('Stream', streamClass)
    javaUtil.setMemberValue('stream', javaUtilStream)
    javaPackage.setMemberValue('util', javaUtil)

    const streamValue = JavaCollection.stream.call(
      { topScope: { context: { packages: javaPackage } } },
      { getThisObj: () => collectionValue },
      [],
      {},
      { type: 'CallExpression' },
      {}
    )

    assert.strictEqual(streamValue.getMisc('buffer')[0], elementValue)
    assert.deepStrictEqual(streamValue.taint.getTags(), ['JAVA_INPUT'])
    assert.strictEqual(streamValue.taint.getTrace('JAVA_INPUT')[0].tag, 'SOURCE: ')
  })

  it('prefers non-empty buffer over precise flag for Collection.stream elements', function () {
    const collectionValue = new ObjectValue('', { sid: 'items', qid: 'items' })
    JavaCollection.Collection(collectionValue, [], {}, {}, {})

    const elementValue = new ObjectValue('', { sid: 'item', qid: 'items.0' })
    elementValue.taint.addTag('JAVA_INPUT')
    elementValue.taint.addTraceToTag('JAVA_INPUT', { tag: 'SOURCE: ', file: 'Item.java', line: 1 })
    elementValue.taint.markSource()

    collectionValue.setMisc('precise', true)
    collectionValue.setMisc('buffer', [elementValue])
    const streamClass = new ObjectValue('', { sid: 'Stream', qid: 'java.util.stream.Stream' })
    const javaUtilStream = new ObjectValue('', { sid: 'stream', qid: 'java.util.stream' })
    const javaUtil = new ObjectValue('', { sid: 'util', qid: 'java.util' })
    const javaPackage = new ObjectValue('', { sid: 'java', qid: 'java' })
    javaUtilStream.setMemberValue('Stream', streamClass)
    javaUtil.setMemberValue('stream', javaUtilStream)
    javaPackage.setMemberValue('util', javaUtil)

    const streamValue = JavaCollection.stream.call(
      { topScope: { context: { packages: javaPackage } } },
      { getThisObj: () => collectionValue },
      [],
      {},
      { type: 'CallExpression' },
      {}
    )

    assert.strictEqual(streamValue.getMisc('buffer')[0], elementValue)
    assert.deepStrictEqual(streamValue.taint.getTags(), ['JAVA_INPUT'])
    assert.strictEqual(streamValue.taint.getTrace('JAVA_INPUT')[0].tag, 'SOURCE: ')
  })

  it('preserves source trace when collecting stream into grouped map carrier', function () {
    const streamValue = new ObjectValue('', { sid: 'stream', qid: 'items.stream()' })
    const elementValue = new ObjectValue('', { sid: 'item', qid: 'items.0' })
    elementValue.taint.addTag('JAVA_INPUT')
    elementValue.taint.addTraceToTag('JAVA_INPUT', { tag: 'SOURCE: ', file: 'Item.java', line: 1 })
    elementValue.taint.markSource()
    streamValue.setMisc('buffer', [elementValue])
    streamValue.taint.addTag('JAVA_INPUT')
    streamValue.taint.addTraceToTag('JAVA_INPUT', { tag: 'SOURCE: ', file: 'Item.java', line: 1 })
    streamValue.taint.markSource()

    const mapClass = new ObjectValue('', { sid: 'Map', qid: 'java.util.Map' })
    const listClass = new ObjectValue('', { sid: 'List', qid: 'java.util.List' })
    const javaUtil = new ObjectValue('', { sid: 'util', qid: 'java.util' })
    const javaPackage = new ObjectValue('', { sid: 'java', qid: 'java' })
    javaUtil.setMemberValue('Map', mapClass)
    javaUtil.setMemberValue('ArrayList', listClass)
    javaUtil.setMemberValue('List', listClass)
    javaPackage.setMemberValue('util', javaUtil)

    const collected = JavaStream.collect.call(
      { topScope: { context: { packages: javaPackage } } },
      { getThisObj: () => streamValue },
      [new ObjectValue('', { sid: 'groupingBy', qid: 'java.util.stream.Collectors.groupingBy' })],
      {},
      { type: 'CallExpression' },
      {}
    )
    assert.deepStrictEqual(collected.taint.getTags(), ['JAVA_INPUT'])
    assert.strictEqual(collected.taint.getTrace('JAVA_INPUT')[0].tag, 'SOURCE: ')
  })


  it('collects toList into list carrier while preserving element identity', function () {
    const streamValue = new ObjectValue('', { sid: 'strategyStream', qid: 'sourceMap.values().stream().sorted()' })
    const elementValue = new ObjectValue('', { sid: 'strategy', qid: 'strategyList.0' })
    elementValue.taint.addTag('JAVA_INPUT')
    elementValue.taint.addTraceToTag('JAVA_INPUT', { tag: 'SOURCE: ', file: 'Strategy.java', line: 1 })
    elementValue.taint.markSource()
    const sourceBuffer = [elementValue]
    streamValue.setMisc('buffer', sourceBuffer)

    const listClass = new ObjectValue('', { sid: 'List', qid: 'java.util.List' })
    const collectorsClass = new ObjectValue('', { sid: 'Collectors', qid: 'java.util.stream.Collectors' })
    const javaUtil = new ObjectValue('', { sid: 'util', qid: 'java.util' })
    const javaPackage = new ObjectValue('', { sid: 'java', qid: 'java' })
    javaUtil.setMemberValue('List', listClass)
    javaUtil.setMemberValue('ArrayList', listClass)
    const javaUtilStream = new ObjectValue('', { sid: 'stream', qid: 'java.util.stream' })
    javaUtilStream.setMemberValue('Collectors', collectorsClass)
    javaUtilStream.setMemberValue('Stream', new ObjectValue('', { sid: 'Stream', qid: 'java.util.stream.Stream' }))
    javaUtil.setMemberValue('stream', javaUtilStream)
    javaPackage.setMemberValue('util', javaUtil)

    const collected = JavaStream.collect.call(
      { topScope: { context: { packages: javaPackage } } },
      { getThisObj: () => streamValue },
      [new ObjectValue('', { sid: 'toList', qid: 'java.util.stream.Collectors.toList' })],
      {},
      { type: 'CallExpression' },
      {}
    )

    assert.strictEqual(collected.getMisc('buffer')[0], elementValue)
    assert.notStrictEqual(collected, streamValue)
    assert.notStrictEqual(collected.getMisc('buffer'), sourceBuffer)
    assert.deepStrictEqual(streamValue.getMisc('buffer'), [elementValue])
    assert.deepStrictEqual(collected.taint.getTags(), ['JAVA_INPUT'])
    assert.strictEqual(collected.taint.getTrace('JAVA_INPUT')[0].tag, 'SOURCE: ')
  })

  it('delegates map-like Collection.forEach to two-argument map callback semantics', function () {
    const mapValue = new ObjectValue('', { sid: 'fillSourceMap', qid: 'fillSourceMap' })
    JavaMap.Map(mapValue, [], {}, {}, {})
    mapValue.rtype = { definiteType: { name: 'java.util.concurrent.ConcurrentHashMap' } }

    const elementValue = new ObjectValue('', { sid: 'itemList', qid: 'fillSourceMap.value' })
    elementValue.taint.addTag('JAVA_INPUT')
    elementValue.taint.addTraceToTag('JAVA_INPUT', { tag: 'SOURCE: ', file: 'Item.java', line: 1 })
    elementValue.taint.markSource()
    mapValue.setMisc('buffer', [elementValue])
    mapValue.taint.addTag('JAVA_INPUT')
    mapValue.taint.addTraceToTag('JAVA_INPUT', { tag: 'SOURCE: ', file: 'Item.java', line: 1 })
    mapValue.taint.markSource()

    let lambdaArgs: unknown[] | undefined
    const analyzer = {
      buildCallArgs(_node: unknown, values: unknown[]) {
        lambdaArgs = values
        return { args: values.map((value, index) => ({ index, value })) }
      },
      executeCall() {},
    }
    const callback = { vtype: 'fclos', ast: { fdef: { parameters: [{}, {}] } } }

    JavaCollection.forEach.call(
      analyzer,
      { getThisObj: () => mapValue },
      [callback],
      {},
      { type: 'CallExpression' },
      {}
    )

    const valueArg = lambdaArgs?.[1] as typeof elementValue | undefined
    assert.strictEqual(valueArg, elementValue)
    assert.deepStrictEqual(valueArg?.taint.getTags(), ['JAVA_INPUT'])
    assert.strictEqual(valueArg?.taint.getTrace('JAVA_INPUT')[0].tag, 'SOURCE: ')
  })

  it('passes grouped map value source trace to forEach lambda', function () {
    const streamValue = new ObjectValue('', { sid: 'stream', qid: 'items.stream()' })
    const elementValue = new ObjectValue('', { sid: 'item', qid: 'items.0' })
    elementValue.taint.addTag('JAVA_INPUT')
    elementValue.taint.addTraceToTag('JAVA_INPUT', { tag: 'SOURCE: ', file: 'Item.java', line: 1 })
    elementValue.taint.markSource()
    const sourceBuffer = [elementValue]
    streamValue.setMisc('buffer', sourceBuffer)
    streamValue.taint.addTag('JAVA_INPUT')
    streamValue.taint.addTraceToTag('JAVA_INPUT', { tag: 'SOURCE: ', file: 'Item.java', line: 1 })
    streamValue.taint.markSource()

    const mapClass = new ObjectValue('', { sid: 'Map', qid: 'java.util.Map' })
    const listClass = new ObjectValue('', { sid: 'List', qid: 'java.util.List' })
    const javaUtil = new ObjectValue('', { sid: 'util', qid: 'java.util' })
    const javaPackage = new ObjectValue('', { sid: 'java', qid: 'java' })
    javaUtil.setMemberValue('Map', mapClass)
    javaUtil.setMemberValue('ArrayList', listClass)
    javaUtil.setMemberValue('List', listClass)
    javaPackage.setMemberValue('util', javaUtil)

    const collected = JavaStream.collect.call(
      { topScope: { context: { packages: javaPackage } } },
      { getThisObj: () => streamValue },
      [new ObjectValue('', { sid: 'groupingBy', qid: 'java.util.stream.Collectors.groupingBy' })],
      {},
      { type: 'CallExpression' },
      {}
    )
    const keyRefSet = collected.getFieldValue('keyRefSet') as Set<string>
    assert.deepStrictEqual(streamValue.getMisc('buffer'), [elementValue])

    let lambdaArgs: unknown[] | undefined
    const analyzer = {
      buildCallArgs(_node: unknown, values: unknown[]) {
        lambdaArgs = values
        return { args: values.map((value, index) => ({ index, value })) }
      },
      executeCall() {},
    }

    JavaMap.forEach.call(
      analyzer,
      { getThisObj: () => collected },
      [{ vtype: 'fclos' }],
      {},
      { type: 'CallExpression' },
      {}
    )

    const valueArg = lambdaArgs?.[1] as typeof elementValue | undefined
    assert.ok(valueArg)
    assert.deepStrictEqual(valueArg.taint.getTags(), ['JAVA_INPUT'])
    assert.strictEqual(valueArg.taint.getTrace('JAVA_INPUT')[0].tag, 'SOURCE: ')
  })

  it('keeps receiver buffer donor when reading existing object member', function () {
    const requestValue = new ObjectValue('', { sid: 'req', qid: 'req' })
    const fieldValue = new ObjectValue('', { sid: 'entityList', qid: 'req.entityList' })
    const donorValue = new ObjectValue('', { sid: 'source', qid: 'source' })
    donorValue.taint.addTag('JAVA_INPUT')
    donorValue.taint.addTraceToTag('JAVA_INPUT', { tag: 'SOURCE: ', file: 'Item.java', line: 1 })
    donorValue.taint.markSource()
    requestValue.setFieldValue('entityList', fieldValue)
    requestValue.setMisc('buffer', [donorValue])
    requestValue.taint.markSource()

    const MemSpace = require('../../src/engine/analyzer/common/memSpace')
    const memSpace = new MemSpace()
    const result = memSpace._getMemberValueDirect(
      requestValue,
      { type: 'Identifier', name: 'entityList' },
      {},
      true,
      0,
      new Set()
    )

    assert.strictEqual(result, fieldValue)
    assert.strictEqual(result.getMisc('buffer')[0], requestValue)
    assert.strictEqual(result.getMisc('buffer')[0].getMisc('buffer')[0], donorValue)
    assert.strictEqual(result.getMisc('buffer')[0].getMisc('buffer')[0].taint.getTrace('JAVA_INPUT')[0].tag, 'SOURCE: ')
  })

  it('keeps unresolved clean key as undefined', function () {
    const mapValue = new ObjectValue('', { sid: 'regionMap', qid: 'regionMap' })
    JavaMap.Map(mapValue, [], {}, {}, {})

    const keyValue = new PrimitiveValue('', 'regnCode', 'cleanRegion', 'string', 'Literal')
    const result = JavaMap.get({ getThisObj: () => mapValue }, [keyValue], {}, { type: 'CallExpression' }, { qid: '<test>' })

    assert.strictEqual(result?.vtype, 'undefine')
  })

  it('keeps body-backed member return clean when return expression is independent from tainted arg', function () {
    const requestValue = new ObjectValue('', { sid: 'request', qid: 'request' })
    requestValue.taint.addTag('JAVA_INPUT')
    requestValue.taint.addTraceToTag('JAVA_INPUT', { tag: 'SOURCE: ', file: 'Controller.java', line: 10 })
    requestValue.taint.markSource()
    const responseValue = new ObjectValue('', { sid: 'response', qid: 'response' })
    const fdef = {
      type: 'FunctionDefinition',
      parameters: [{ type: 'Identifier', name: 'request' }],
      body: [{ type: 'ReturnStatement', argument: { type: 'Identifier', name: 'cachedResponse' } }],
    }

    assert.strictEqual(__javaAnalyzerTestHooks.findJavaInputArgumentDonor([requestValue]), requestValue)
    assert.strictEqual(__javaAnalyzerTestHooks.javaReturnExpressionReferencesParameter(fdef), false)

    if (__javaAnalyzerTestHooks.javaReturnExpressionReferencesParameter(fdef)) {
      __javaAnalyzerTestHooks.attachJavaInputTraceToReturnGraph(responseValue, requestValue)
    }

    assert.strictEqual(responseValue.taint.isTainted, false)
    assert.deepStrictEqual(responseValue.taint.getTags(), [])
    assert.strictEqual(responseValue.getMisc('buffer'), undefined)
  })

  it('requires a real JAVA_INPUT source trace before using an argument as return donor', function () {
    const requestValue = new ObjectValue('', { sid: 'request', qid: 'request' })
    requestValue.taint.addTag('JAVA_INPUT')
    requestValue.taint.markSource()

    assert.strictEqual(__javaAnalyzerTestHooks.findJavaInputArgumentDonor([requestValue]), null)
  })

  it('allows body-backed member return carrier when return expression references an argument', function () {
    const requestValue = new ObjectValue('', { sid: 'request', qid: 'request' })
    requestValue.taint.addTag('JAVA_INPUT')
    requestValue.taint.addTraceToTag('JAVA_INPUT', { tag: 'SOURCE: ', file: 'Controller.java', line: 10 })
    requestValue.taint.markSource()
    const responseValue = new ObjectValue('', { sid: 'response', qid: 'response' })
    const childValue = new ObjectValue('', { sid: 'child', qid: 'response.child' })
    responseValue.setMisc('buffer', [childValue])
    const fdef = {
      type: 'FunctionDefinition',
      parameters: [{ type: 'Identifier', name: 'request' }],
      body: [{
        type: 'ReturnStatement',
        argument: {
          type: 'CallExpression',
          callee: { type: 'Identifier', name: 'select' },
          arguments: [{ type: 'Identifier', name: 'request' }],
        },
      }],
    }

    assert.strictEqual(__javaAnalyzerTestHooks.javaReturnExpressionReferencesParameter(fdef), true)
    __javaAnalyzerTestHooks.attachJavaInputTraceToReturnGraph(responseValue, requestValue)

    assert.deepStrictEqual(responseValue.taint.getTags(), ['JAVA_INPUT'])
    assert.strictEqual(responseValue.taint.getTrace('JAVA_INPUT')[0].tag, 'SOURCE: ')
    assert.strictEqual(childValue.taint.getTrace('JAVA_INPUT')[0].tag, 'SOURCE: ')
  })

  it('copies direct receiver tags for zero-argument wrapper getters', function () {
    const JavaAnalyzer = require('../../src/engine/analyzer/java/common/java-analyzer')
    const analyzer = Object.create(JavaAnalyzer.prototype)
    const receiver = new ObjectValue('', { sid: 'item', qid: 'item' })
    receiver.taint.addTag('JAVA_INPUT')
    receiver.taint.markSource()

    const result = new SymbolValue('', { sid: 'getRawContent()', qid: 'item.getRawContent()' })
    const fclos = { _this: receiver }
    const node = {
      type: 'FunctionCall',
      callee: { type: 'MemberAccess', property: { type: 'Identifier', name: 'getRawContent' } },
      arguments: [],
    }

    analyzer.propagateReadWrapperReceiverTrace(node, fclos, result)

    assert.strictEqual(result.taint.isTainted, true)
    assert.deepStrictEqual(result.taint.getTags(), ['JAVA_INPUT'])
    assert.strictEqual(result.getMisc('buffer'), undefined)
  })

  it('keeps nested receiver buffer donor for zero-argument wrapper getters', function () {
    const JavaAnalyzer = require('../../src/engine/analyzer/java/common/java-analyzer')
    const analyzer = Object.create(JavaAnalyzer.prototype)
    const receiver = new ObjectValue('', { sid: 'immutableFillReq', qid: 'immutableFillReq' })
    const requestBuffer = new ObjectValue('', { sid: 'requestBuffer', qid: 'immutableFillReq.buffer' })
    const donorValue = new ObjectValue('', { sid: 'entityListSource', qid: 'entityListSource' })
    donorValue.taint.addTag('JAVA_INPUT')
    donorValue.taint.addTraceToTag('JAVA_INPUT', { tag: 'SOURCE: ', file: 'Item.java', line: 1 })
    donorValue.taint.markSource()
    requestBuffer.setMisc('buffer', [donorValue])
    receiver.setMisc('buffer', [requestBuffer])
    receiver.taint.markSource()

    const result = new SymbolValue('', { sid: 'entityList', qid: 'immutableFillReq.entityList' })
    const fclos = { getThisObj: () => receiver }
    const node = {
      type: 'FunctionCall',
      callee: { type: 'MemberAccess', property: { type: 'Identifier', name: 'getEntityList' } },
      arguments: [],
    }

    analyzer.propagateReadWrapperReceiverTrace(node, fclos, result)

    assert.strictEqual(result.taint.getTags().length, 0)
    assert.strictEqual(result.getMisc('buffer')[0], receiver)
    assert.strictEqual(result.getMisc('buffer')[0].getMisc('buffer')[0].getMisc('buffer')[0], donorValue)
    assert.strictEqual(result.getMisc('buffer')[0].getMisc('buffer')[0].getMisc('buffer')[0].taint.getTrace('JAVA_INPUT')[0].tag, 'SOURCE: ')
  })

  it('copies direct receiver tags for one-argument get-key wrapper reads', function () {
    const JavaAnalyzer = require('../../src/engine/analyzer/java/common/java-analyzer')
    const analyzer = Object.create(JavaAnalyzer.prototype)
    const receiver = new ObjectValue('', { sid: 'rawContent', qid: 'rawContent' })
    receiver.taint.addTag('JAVA_INPUT')
    receiver.taint.markSource()

    const result = new SymbolValue('', { sid: 'get(key)', qid: 'rawContent.get(key)' })
    const keyValue = new PrimitiveValue('', 'material_ids', 'material_ids', 'string', 'Literal')
    const fclos = { getThisObj: () => receiver }
    const node = {
      type: 'FunctionCall',
      callee: { type: 'MemberAccess', property: { type: 'Identifier', name: 'getContentValue' } },
      arguments: [{ type: 'Literal', value: 'material_ids' }],
    }

    analyzer.propagateReadWrapperReceiverTrace(node, fclos, result)

    assert.strictEqual(keyValue.taint.isTainted, false)
    assert.strictEqual(result.taint.isTainted, true)
    assert.deepStrictEqual(result.taint.getTags(), ['JAVA_INPUT'])
    assert.strictEqual(result.getMisc('buffer'), undefined)
  })
})
