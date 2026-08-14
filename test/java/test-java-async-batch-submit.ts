import * as assert from 'assert'
import { describe, it } from 'mocha'

const JavaAnalyzer = require('../../src/engine/analyzer/java/common/java-analyzer')
const List = require('../../src/engine/analyzer/java/common/builtins/list-builtins')
const { ObjectValue } = require('../../src/engine/analyzer/common/value/object')
const { FunctionValue } = require('../../src/engine/analyzer/common/value/function')

describe('Java async submit modeling', function () {
  it('executes Callable lambdas stored in task lists', function () {
    const analyzer = Object.create(JavaAnalyzer.prototype)
    let executed = 0
    analyzer.buildCallArgs = () => []
    analyzer.executeCall = () => {
      executed++
    }

    const taskList = new ObjectValue('', { sid: 'mainTasks', qid: 'mainTasks' })
    List.List(taskList, [], {}, {}, {})
    const callable = new FunctionValue('', { sid: '<anonymousCallable>', qid: '<anonymousCallable>' })
    List.add.call({ symbolTable: { calculateUUID: () => 'callable-snapshot', has: () => false } }, { getThisObj: () => taskList }, [callable], {}, {}, {})

    const batchSubmit = { vtype: 'symbol', sid: 'batchSubmit' }
    const node = {
      type: 'FunctionCall',
      callee: { type: 'MemberAccess', property: { name: 'batchSubmit' } },
    }

    analyzer.executeAsyncBatchSubmitTasks(batchSubmit, [taskList], node, { callstack: [], callsites: [] }, { qid: '<test>' })

    assert.strictEqual(executed, 1)
  })

  it('dispatches submitTask to anonymous execTask with captured taint', function () {
    const analyzer = Object.create(JavaAnalyzer.prototype)
    let executedThis: unknown
    analyzer.buildCallArgs = () => []
    analyzer.executeCall = (_node: unknown, fclos: unknown) => {
      executedThis = (fclos as { _thisRef?: { _direct?: unknown } })._thisRef?._direct
    }

    const source = new ObjectValue('', { sid: 'request', qid: 'request' })
    source.taint.addTag('JAVA_INPUT')
    source.taint.addTraceToTag('JAVA_INPUT', { tag: 'SOURCE: ', file: 'SampleController.java', line: 89 })
    source.taint.markSource()

    const task = new ObjectValue('', { sid: 'task', qid: 'AsyncCallTask<anonymous>' })
    task.setFieldValue('request', source)
    task.setMisc('buffer', [source])
    const execTask = new FunctionValue('', { sid: 'execTask', qid: 'AsyncCallTask<anonymous>.execTask' })
    task.members.set('execTask', execTask)

    const submitTask = { vtype: 'symbol', sid: 'submitTask' }
    const node = {
      type: 'FunctionCall',
      callee: { type: 'MemberAccess', property: { name: 'submitTask' } },
    }

    analyzer.executeAsyncBatchSubmitTasks(submitTask, [task], node, { callstack: [], callsites: [] }, { qid: '<test>' })

    assert.strictEqual(executedThis, task)
    assert.strictEqual(task.getMisc('buffer')[0], source)
    assert.deepStrictEqual(source.taint.getTags(), ['JAVA_INPUT'])
    assert.strictEqual(source.taint.getTrace('JAVA_INPUT')[0].tag, 'SOURCE: ')
  })
})
