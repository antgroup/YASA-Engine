/**
 * 匹配qid
 * @param symbol 符号值
 * @param qid
 * @param pattern 支持**和*的通配符
 * @returns {boolean} 是否匹配
 */
function matchPattern(qid, pattern) {
  const qidList = qid.split('.')
  const patternList = pattern.split('.')

  let qi = 0
  let pi = 0

  while (qi < qidList.length && pi < patternList.length) {
    const pat = patternList[pi]
    if (pat === '**') {
      // 如果'**'是最后一个，直接匹配剩下所有
      if (pi === patternList.length - 1) {
        return true
      }
      // '**'后面还有其他pattern
      pi += 1
      // 尝试多次匹配，直到遇到下一个pattern
      while (qi < qidList.length) {
        if (qidList[qi] === patternList[pi]) {
          // 匹配到，继续往后处理
          break
        }
        qi += 1
      }
      // '**'已消耗，继续看下一个pattern和qid
    } else if (pat === '*') {
      // '*'匹配当前单个
      qi += 1
      pi += 1
    } else {
      if (qidList[qi] !== pat) {
        return false
      }
      qi += 1
      pi += 1
    }
  }
  // 跳过结尾的连续'**'
  while (pi < patternList.length && patternList[pi] === '**') {
    pi += 1
  }
  // 两边都完全消耗才算匹配
  return qi === qidList.length && pi === patternList.length
}

module.exports = {
  matchPattern,
}
