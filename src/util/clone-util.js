const _ = require('lodash')
const { checkMemoryUsage } = require('./memory-util')

/**
 * 带深度限制的深拷贝
 * @param {any} obj - 要拷贝的对象
 * @param {number} maxDepth - 最大拷贝深度，默认为1
 * @param {number} currentDepth - 当前深度（内部使用）
 * @returns {any} 拷贝后的对象
 */
function cloneWithDepth(obj, maxDepth = 1, currentDepth = 0) {
  // 如果达到最大深度或不是对象/数组，直接返回浅拷贝
  if (currentDepth >= maxDepth || typeof obj !== 'object' || !obj || Object.keys(obj).length === 0) {
    return obj
  }
  const val = _.clone(obj)
  const filterKey = ['ast', 'sort', '_sid', '_qid', '_id', 'decl', 'name', 'vtype', 'rtype', 'decls']

  if (checkMemoryUsage()) {
    // 对下一层递归处理
    for (const key in val) {
      if (filterKey.includes(key)) {
        continue
      }
      if (Object.prototype.hasOwnProperty.call(val, key)) {
        val[key] = cloneWithDepth(val[key], maxDepth, currentDepth + 1)
      }
    }
  }

  return val
}

module.exports = {
  cloneWithDepth,
}
