const config = require('../config')

/**
 * 检查YASA内存使用, 通过YASA_MEMORY环境变量进行限制，以MB为单位
 */
function checkMemoryUsage(): boolean {
  if (process.env.hasOwnProperty('YASA_MEMORY')) {
    config.YASA_MEMORY = parseInt(process.env.YASA_MEMORY || '0')
  }
  const bytesUsed = process.memoryUsage().heapUsed
  const megabytesUsed = bytesUsed / 1000000
  return megabytesUsed <= config.YASA_MEMORY
}

export { checkMemoryUsage }
