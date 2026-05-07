/**
 * Python 内建函数的 runtime.execute 注册
 *
 * 仿 Java java-initializer.ts 模式，将 Python 内建函数（如 enumerate）
 * 注册为 topScope 中带 runtime.execute 的 FunctionValue，
 * 使引擎在 executeCall 时走内建执行路径而非 processLibArgToRet 兜底。
 */
import { FunctionValue } from '../../../common/value/function'
import { SymbolValue } from '../../../common/value/symbolic'
import { PrimitiveValue } from '../../../common/value/primitive'
import type { Scoped } from '../../../common/value/scoped'
import type { State } from '../../../../../types/analyzer'

/**
 * enumerate 的 runtime.execute 实现
 *
 * 将 iterable 包装为带 members{"0": index, "1": element} 的结构化值，
 * 使 processRangeStatement 的 TupleExpression 解包能精确传播 taint。
 */
function enumerateExecute(
  this: any,
  _fclos: FunctionValue,
  argvalues: any[],
  _state: State,
  node: any,
  _scope: any
): SymbolValue {
  const iterable = argvalues[0]
  const resultQid = `<builtin>.enumerate`

  /* 构造返回值：SymbolValue 的 value 是一个对象，
   * 键为数字字符串("0","1",...), 值为带 members 的 tuple 结构 */
  const resultValue: Record<string, SymbolValue> = {}

  if (iterable && typeof iterable.getRawValue === 'function') {
    const rawFields = iterable.getRawValue()
    let idx = 0
    for (const key in rawFields) {
      if (typeof key === 'string' && key.includes('__yasa')) continue
      if (typeof rawFields.hasOwnProperty === 'function' && rawFields.hasOwnProperty(key)) {
        const element = rawFields[key]
        /* 每个 tuple 项：members "0"=index, "1"=原始元素（保留 taint） */
        const tupleItem = new SymbolValue(resultQid, {
          sid: `enumerate_item_${idx}`,
          qid: `${resultQid}.item_${idx}`,
        })
        tupleItem.members.set('0', new PrimitiveValue(resultQid, String(idx), idx, 'number'))
        tupleItem.members.set('1', element)
        resultValue[String(idx)] = tupleItem
        idx++
      }
    }

    /* iterable 没有可枚举字段时（如扁平 SymbolValue），
     * 生成单个 tuple 项将整个 iterable 作为元素传播 taint */
    if (idx === 0) {
      const tupleItem = new SymbolValue(resultQid, {
        sid: 'enumerate_item_0',
        qid: `${resultQid}.item_0`,
      })
      tupleItem.members.set('0', new PrimitiveValue(resultQid, '0', 0, 'number'))
      tupleItem.members.set('1', iterable)
      resultValue['0'] = tupleItem
    }
  } else if (iterable) {
    /* iterable 不支持 getRawValue 时，兜底：将整体作为单元素 */
    const tupleItem = new SymbolValue(resultQid, {
      sid: 'enumerate_item_0',
      qid: `${resultQid}.item_0`,
    })
    tupleItem.members.set('0', new PrimitiveValue(resultQid, '0', 0, 'number'))
    tupleItem.members.set('1', iterable)
    resultValue['0'] = tupleItem
  }

  const result = new SymbolValue(resultQid, {
    sid: 'enumerate_result',
    qid: `${resultQid}.result`,
    value: resultValue,
  })

  return result
}

/**
 * 在 topScope 中注册 Python 内建函数
 *
 * 在 preProcess 阶段调用，确保符号解释前完成注册。
 */
export function initPythonBuiltins(topScope: Scoped): void {
  const builtinQid = `${topScope.qid}.<builtins>`

  const enumFv = new FunctionValue('', {
    sid: 'enumerate',
    qid: `${builtinQid}.enumerate`,
    parent: topScope,
  })
  enumFv.runtime = { execute: enumerateExecute }
  topScope.value['enumerate'] = enumFv
}
