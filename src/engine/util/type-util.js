/**
 *
 * @param tp1
 * @param tp2
 */
function isCompatibleTypes(tp1, tp2) {
  switch (tp1) {
    case 'uint':
      if (tp2 == 'uint256') return true
      break
    case 'uint256':
      if (tp2 == 'uint') return true
      break

    case 'int':
      if (tp2 == 'int256') return true
      break
    case 'int256':
      if (tp2 == 'int') return true
      break
  }
  return tp1 == tp2
}

/**
 * tp1 < tp2 ?
 * @param tp1
 * @param tp2
 * @returns {boolean}
 */
function isLossyConversion(tp1, tp2) {
  if (tp1 == tp2) return false
  if (!tp1 || !tp2) return false

  if (tp1.startsWith('uint')) {
    if (tp2.startsWith('int')) return true
    if (tp2.startsWith('uint')) {
      let i1 = tp1.substring(4)
      let i2 = tp2.substring(4)
      if (!i1) i1 = '256'
      if (!i2) i2 = '256'
      return parseInt(i1) < parseInt(i2)
    }
  } else if (tp1.startsWith('int')) {
    if (tp2.startsWith('uint')) return true
    if (tp2.startsWith('int')) {
      let i1 = tp1.substring(3)
      let i2 = tp2.substring(3)
      if (!i1) i1 = '256'
      if (!i2) i2 = '256'
      return parseInt(i1) < parseInt(i2)
    }
  }

  // return tp1 == tp2;
  return false // unknown, not sure
}

/**
 * Pre-computed arrays for integer bits
 * @type {Array}
 */
const UintBytes = []
const IntBytes = []
for (let i = 8; i <= 256; i += 8) {
  UintBytes.push({ k: 2 ^ i, tp: { name: `uint${i}` } })
}
for (let i = 256; i >= 8; i -= 8) {
  IntBytes.push({ k: -2 ^ i, tp: { name: `int${i}` } })
}

/**
 *
 * @param node
 * @returns {*}
 */
function inferType(node) {
  if (!node) return
  if (node.typeName) return node.typeName
  switch (node.type) {
    case 'Literal': {
      const n = node.value
      if (Number.isInteger(n)) {
        if (n >= 0) {
          // simply return uint256
          return UintBytes[UintBytes.length - 1]
          // for (let pr of UintBytes) {
          //     if (n < pr.k)
          //         return pr.tp;
          // }
        }
        for (const pr of IntBytes) {
          if (n <= pr.k) return pr.tp
        }
      }
    }
    case 'Identifier':
      return node.sort
    case 'MemberAccess': {
      const obj = node.object
      if (obj && obj.sort) {
        return obj.sort.valueType
      }
      return inferType(obj)
    }
    case 'Conditional': {
      return inferType(node.trueExpression)
    }
    default:
      if (node.sort) return node.sort
  }
}

module.exports = {
  isCompatibleTypes,
  inferType,
  isLossyConversion,
}
