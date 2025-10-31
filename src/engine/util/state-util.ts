const logger = require('../../util/logger')(__filename)

interface ExecutionState {
  einfo?: {
    loop_stack?: any[]
    [key: string]: any
  }
  [key: string]: any
}

/**
 *
 * @param state
 * @param node
 */
function pushLoopInfo(state: ExecutionState, node: any): void {
  if (!state || !state.einfo) {
    logger.info('pushLoopInfo: state.einfo is undefined')
    return
  }

  if (!state.einfo.loop_stack) {
    state.einfo.loop_stack = []
  }

  state.einfo.loop_stack.push(node)
}

/**
 *
 * @param state
 */
function popLoopInfo(state: ExecutionState): void {
  if (!state || !state.einfo || !state.einfo.loop_stack) {
    logger.info('popLoopInfo: state.einfo.loop_stack is undefined')
    return
  }

  state.einfo.loop_stack.pop()
}

/**
 *
 * @param state
 */
function isInLoop(state: ExecutionState): boolean {
  if (!state || !state.einfo || !state.einfo.loop_stack || state.einfo.loop_stack.length == 0) {
    return false
  }

  return true
}

module.exports = {
  pushLoopInfo,
  popLoopInfo,
  isInLoop,
}
