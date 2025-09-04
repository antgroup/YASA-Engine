const logger = require('../../util/logger')(__filename)

/**
 *
 * @param state
 * @param node
 */
function pushLoopInfo(state, node) {
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
function popLoopInfo(state) {
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
function isInLoop(state) {
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
