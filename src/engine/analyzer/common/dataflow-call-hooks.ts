interface DataflowCallHookInfo {
  callInfo?: unknown
  fclos?: unknown
  ret?: unknown
  skipDataflowCallgraph?: boolean
}

const dataflowStats = require('./dataflow-edge-stats')

/** 函数调用前的 SQLite callgraph/call_args 采集入口。 */
function onFunctionCallBefore(_analyzer: unknown, scope: unknown, node: unknown, _state: unknown, info: DataflowCallHookInfo): void {
  try {
    if (info?.skipDataflowCallgraph) return
    if (!dataflowStats.SQLITE_ENABLED) return
    dataflowStats.recordCallgraphEntry(node, info?.fclos, scope, info?.callInfo)
  } catch (_e) {}
}

/** 函数调用后的 SQLite return_node 采集入口。 */
function onFunctionCallAfter(_analyzer: unknown, _scope: unknown, node: unknown, _state: unknown, info: DataflowCallHookInfo): void {
  try {
    if (!dataflowStats.SQLITE_ENABLED || !info?.ret) return
    dataflowStats.updateCallgraphReturnNode(node, info.ret, info?.fclos)
  } catch (_e) {}
}

/** NewExpression 的 SQLite callgraph/call_args 采集入口。 */
function onNewExprAfter(_analyzer: unknown, scope: unknown, node: unknown, _state: unknown, info: DataflowCallHookInfo): void {
  try {
    if (!dataflowStats.SQLITE_ENABLED) return
    dataflowStats.recordCallgraphEntry(node, info?.fclos, scope, info?.callInfo)
  } catch (_e) {}
}

module.exports = {
  onFunctionCallBefore,
  onFunctionCallAfter,
  onNewExprAfter,
}
