const logger = require('../../../util/logger')(__filename)

interface ErrorStats {
  parseErrors: number
  nodeErrors: number
  checkerErrors: number
  otherErrors: number
}

let errorStats: ErrorStats = { parseErrors: 0, nodeErrors: 0, checkerErrors: 0, otherErrors: 0 }

function incrementErrorStat(category: keyof ErrorStats): void {
  errorStats[category]++
}

function getErrorStats(): ErrorStats {
  return { ...errorStats }
}

function clearErrorStats(): void {
  errorStats = { parseErrors: 0, nodeErrors: 0, checkerErrors: 0, otherErrors: 0 }
}

let totalErrors: any[]
/**
 *
 * @param {Error} error
 * @param infoMsg
 * @param errorMsg
 */
function handleException(error: any, infoMsg: any, errorMsg: any): void {
  if (infoMsg && typeof infoMsg === 'string' && infoMsg.length >= 1) {
    logger.info(infoMsg)
  }
  if (errorMsg && typeof errorMsg === 'string' && errorMsg.length >= 1) {
    logger.error(errorMsg)
  }
  if (error) {
    logger.error(error)
  }
  totalErrors = totalErrors || []
  totalErrors.push({ errorMsg, error })
}

/**
 *
 */
function clearTotalErrorsExceptionHandler(): void {
  totalErrors = []
  clearErrorStats()
}

/**
 *
 */
function outputTotalErrorsExceptionHandler(): void {
  if (Array.isArray(totalErrors) && totalErrors.length > 0) {
    for (const error of totalErrors) {
      logger.info(error.errorMsg)
      logger.info(error.error)
    }
  }
  // 输出分类错误统计
  const stats = getErrorStats()
  const totalCount = stats.parseErrors + stats.nodeErrors + stats.checkerErrors + stats.otherErrors
  if (totalCount > 0) {
    logger.info(`Error statistics: parse=${stats.parseErrors}, node=${stats.nodeErrors}, checker=${stats.checkerErrors}, other=${stats.otherErrors}, total=${totalCount}`)
  }
}

export {
  handleException,
  clearTotalErrorsExceptionHandler as clearTotalErrors,
  outputTotalErrorsExceptionHandler as outputTotalErrors,
  incrementErrorStat,
  getErrorStats,
}
