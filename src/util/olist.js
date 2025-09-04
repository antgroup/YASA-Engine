/**
 * Implementation of sets of numbers as sorted lists. Singleton sets
 * are represented as single numbers, the empty set as undefined.
 */

/**
 *
 * @param a
 */
function size(a) {
  if (typeof a === 'undefined') return 0

  if (typeof a === 'number') return 1

  return a.length
}

/**
 * Check whether set a contains number x.
 * @param a
 * @param x
 */
function contains(a, x) {
  if (typeof a === 'undefined') return false

  if (typeof a === 'number') return a === x

  let lo = 0
  let hi = a.length - 1
  let mid
  let elt
  while (lo <= hi) {
    mid = (lo + hi) >> 1
    elt = a[mid]
    if (elt === x) {
      return true
    }
    if (elt < x) {
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }

  return false
}

/**
 * Add number x to set a, and return the possibly modified a.
 * @param a
 * @param x
 */
function add(a, x) {
  if (typeof a === 'undefined') return x

  if (typeof a === 'number') {
    if (a < x) return [a, x]
    if (a > x) return [x, a]
    return a
  }

  let lo = 0
  let hi = a.length - 1
  let mid
  let elt
  while (lo <= hi) {
    mid = (lo + hi) >> 1
    elt = a[mid]
    if (elt < x) {
      lo = mid + 1
    } else if (elt > x) {
      hi = mid - 1
    } else {
      return a
    }
  }
  a.splice(lo, 0, x)
  return a
}

/**
 * Add all elements in set b to set a, returning the resulting set.
 * While set a may be modified, set b never is.
 * @param a
 * @param b
 */
function addAll(a, b) {
  if (typeof a === 'undefined') return copy(b)
  if (typeof b === 'undefined') return a

  if (typeof a === 'number' && typeof b === 'object') return add(b.slice(0), a)

  // 'a' must be an array; check 'b'
  const l1 = a.length
  if (l1 === 0) return copy(b)

  if (typeof b === 'number') {
    return add(a, b)
  }
  const l2 = b.length
  if (l2 === 0) return a

  const res = new Array(l1 + l2)
  let i = 0
  let j = 0
  let k = 0
  while (i < l1 || j < l2) {
    while (i < l1 && (j >= l2 || a[i] <= b[j])) res[k++] = a[i++]
    while (k > 0 && j < l2 && b[j] === res[k - 1]) ++j
    while (j < l2 && (i >= l1 || b[j] < a[i])) res[k++] = b[j++]
  }
  res.length = k
  return res
}

/**
 *
 * @param a
 * @param x
 */
function remove(a, x) {
  if (typeof a === 'undefined') return a

  if (typeof a === 'number') return a === x ? void 0 : a

  let lo = 0
  let hi = a.length - 1
  let mid
  let elt

  if (lo === hi) return a[0] === x ? void 0 : a

  while (lo <= hi) {
    mid = (lo + hi) >> 1
    elt = a[mid]
    if (elt < x) {
      lo = mid + 1
    } else if (elt > x) {
      hi = mid - 1
    } else {
      a.splice(mid, 1)
      return a
    }
  }
  return a
}

/**
 *
 * @param a
 * @param b
 */
function removeAll(a, b) {
  if (typeof a === 'undefined' || typeof b === 'undefined') return a

  if (typeof a === 'number') return contains(b, a) ? void 0 : a

  if (typeof b === 'number') return remove(a, b)

  let i = 0
  let j = 0
  let k = 0
  const m = a.length
  const n = b.length
  while (i < m && j < n) {
    while (i < m && a[i] < b[j]) a[k++] = a[i++]

    if (i < m && a[i] === b[j]) ++i

    if (i < m) while (j < n && a[i] > b[j]) ++j
  }
  while (i < m) a[k++] = a[i++]

  if (k) {
    a.length = k
    return a
  }
  return void 0
}

/**
 *
 * @param a
 */
function copy(a) {
  if (typeof a === 'undefined' || typeof a === 'number') return a

  return a.slice(0)
}

/**
 *
 * @param a
 * @param cb
 */
function iter(a, cb) {
  if (a !== undefined) {
    if (typeof a === 'number') cb(a)
    else a.forEach(cb)
  }
}

/**
 *
 * @param a
 * @param f
 */
function map(a, f) {
  if (a !== undefined) {
    if (typeof a === 'number') return [f(a)]
    return a.map(f)
  }
  return []
}

/**
 *
 * @param a
 * @param f
 */
function some(a, f) {
  let r = false
  if (a !== undefined) {
    if (typeof a === 'number') return f(a)
    for (let i = 0, l = a.length; i < l; ++i) {
      r = f(a)
      if (r) return r
    }
  }
  return r
}

/**
 *
 * @param a
 * @param f
 */
function all(a, f) {
  let r = true
  if (a !== undefined) {
    if (typeof a === 'number') return f(a)
    for (let i = 0, l = a.length; i < l; ++i) {
      r = f(a)
      if (!r) return r
    }
  }
  return r
}

/**
 *
 * @param ary
 */
function fromArray(ary) {
  let a
  ary.forEach(function (x) {
    a = add(a, x)
  })
  return a
}

/**
 *
 * @param a
 */
function toArray(a) {
  return map(a, function f(x) {
    return x
  })
}

exports.copy = copy
exports.size = size
exports.contains = contains
exports.add = add
exports.addAll = addAll
exports.remove = remove
exports.removeAll = removeAll
exports.iter = iter
exports.map = map
exports.some = some
exports.all = all
exports.fromArray = fromArray
exports.toArray = toArray
