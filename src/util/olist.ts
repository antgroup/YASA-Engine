/**
 * Implementation of sets of numbers as sorted lists. Singleton sets
 * are represented as single numbers, the empty set as undefined.
 */

/**
 * Get the size of a set
 * @param a - The set (number, array, or undefined)
 */
function size(a: number | number[] | undefined): number {
  if (typeof a === 'undefined') return 0

  if (typeof a === 'number') return 1

  return a.length
}

/**
 * Check whether set a contains number x.
 * @param a - The set (number, array, or undefined)
 * @param x - The number to check for
 */
function contains(a: number | number[] | undefined, x: number): boolean {
  if (typeof a === 'undefined') return false

  if (typeof a === 'number') return a === x

  let lo = 0
  let hi = a.length - 1
  let mid: number
  let elt: number
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
 * @param a - The set (number, array, or undefined)
 * @param x - The number to add
 */
function add(a: number | number[] | undefined, x: number): number | number[] | undefined {
  if (typeof a === 'undefined') return x

  if (typeof a === 'number') {
    if (a < x) return [a, x]
    if (a > x) return [x, a]
    return a
  }

  let lo = 0
  let hi = a.length - 1
  let mid: number
  let elt: number
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
 * @param a - The first set (number, array, or undefined)
 * @param b - The second set (number, array, or undefined)
 */
function addAll(a: number | number[] | undefined, b: number | number[] | undefined): number | number[] | undefined {
  if (typeof a === 'undefined') return copy(b)
  if (typeof b === 'undefined') return a

  if (typeof a === 'number' && typeof b === 'object') return add(b.slice(0), a)

  // 'a' must be an array; check 'b'
  const l1 = (a as number[]).length
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
    while (i < l1 && (j >= l2 || (a as any)[i] <= (b as any)[j])) res[k++] = (a as any)[i++]
    while (k > 0 && j < l2 && (b as any)[j] === res[k - 1]) ++j
    while (j < l2 && (i >= l1 || (b as any)[j] < (a as any)[i])) res[k++] = (b as any)[j++]
  }
  res.length = k
  return res
}

/**
 * Remove number x from set a
 * @param a - The set (number, array, or undefined)
 * @param x - The number to remove
 */
function remove(a: number | number[] | undefined, x: number): number | number[] | undefined {
  if (typeof a === 'undefined') return a

  if (typeof a === 'number') return a === x ? void 0 : a

  let lo = 0
  let hi = a.length - 1
  let mid: number
  let elt: number

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
 * Remove all elements in set b from set a
 * @param a - The first set (number, array, or undefined)
 * @param b - The second set (number, array, or undefined)
 */
function removeAll(a: number | number[] | undefined, b: number | number[] | undefined): number | number[] | undefined {
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
 * Create a copy of set a
 * @param a - The set (number, array, or undefined)
 */
function copy(a: number | number[] | undefined): number | number[] | undefined {
  if (typeof a === 'undefined' || typeof a === 'number') return a

  return a.slice(0)
}

/**
 * Iterate over set a with callback cb
 * @param a - The set (number, array, or undefined)
 * @param cb - The callback function
 */
function iter(a: number | number[] | undefined, cb: (x: number) => void): void {
  if (a !== undefined) {
    if (typeof a === 'number') cb(a)
    else a.forEach(cb)
  }
}

/**
 * Map over set a with function f
 * @param a - The set (number, array, or undefined)
 * @param f - The mapping function
 */
function map<T>(a: number | number[] | undefined, f: (x: number) => T): T[] {
  if (a !== undefined) {
    if (typeof a === 'number') return [f(a)]
    return a.map(f)
  }
  return []
}

/**
 * Check if some elements in set a satisfy function f
 * @param a - The set (number, array, or undefined)
 * @param f - The predicate function
 */
function some(a: number | number[] | undefined, f: (x: number) => boolean): boolean {
  let r = false
  if (a !== undefined) {
    if (typeof a === 'number') return f(a)
    for (let i = 0, l = a.length; i < l; ++i) {
      r = f(a[i])
      if (r) return r
    }
  }
  return r
}

/**
 * Check if all elements in set a satisfy function f
 * @param a - The set (number, array, or undefined)
 * @param f - The predicate function
 */
function all(a: number | number[] | undefined, f: (x: number) => boolean): boolean {
  let r = true
  if (a !== undefined) {
    if (typeof a === 'number') return f(a)
    for (let i = 0, l = a.length; i < l; ++i) {
      r = f(a[i])
      if (!r) return r
    }
  }
  return r
}

/**
 * Create a set from an array
 * @param ary - The input array
 */
function fromArray(ary: number[]): number | number[] | undefined {
  let a: number | number[] | undefined
  ary.forEach(function (x: number) {
    a = add(a, x)
  })
  return a
}

/**
 * Convert set a to an array
 * @param a - The set (number, array, or undefined)
 */
function toArray(a: number | number[] | undefined): number[] {
  return map(a, function f(x: number) {
    return x
  })
}

export { copy, size, contains, add, addAll, remove, removeAll, iter, map, some, all, fromArray, toArray }
