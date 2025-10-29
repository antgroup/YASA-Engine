/**
 * Implementation of sets of non-negative integers as bitsets.
 */

// Wegner's algorithm
/**
 *
 * @param w
 */
function countBitsInWord(w: number): number {
  let cnt = 0
  while (w) {
    ++cnt
    w &= w - 1
  }
  return cnt
}

/**
 *
 * @param a
 */
function countBits(a: number[]): number {
  let cnt = 0
  a.forEach(function (w) {
    cnt += countBitsInWord(w)
  })
  return cnt
}

/**
 *
 * @param a
 */
function size(a: number | number[] | undefined): number {
  if (typeof a === 'undefined') return 0

  if (typeof a === 'number') return 1

  return countBits(a)
}

/**
 * Check whether set a contains number x.
 * @param a
 * @param x
 */
function contains(a: number | number[] | undefined, x: number): boolean {
  if (typeof a === 'undefined') return false

  if (typeof a === 'number') return a === x

  const word_off = x >> 5
  const word_idx = x % 32

  if (word_off >= a.length) return false

  return !!(a[word_off] & (1 << word_idx))
}

/**
 *
 * @param x
 */
function createSingletonBitset(x: number): number[] {
  const word_off = x >> 5
  const word_idx = x % 32
  const a = new Array(word_off + 1)
  a[word_off] = 1 << word_idx
  return a
}

/**
 * Add number x to set a, and return the possibly modified a.
 * @param a
 * @param x
 */
function add(a: number | number[] | undefined, x: number): number | number[] {
  if (typeof a === 'undefined') return x

  if (typeof a === 'number') a = createSingletonBitset(a)

  const word_off = x >> 5
  const word_idx = x % 32
  a[word_off] = (a[word_off] || 0) | (1 << word_idx)
  return a
}

/**
 * Add all elements in set b to set a, returning the resulting set.
 * While set a may be modified, set b never is.
 * @param a
 * @param b
 */
function addAll(a: number | number[] | undefined, b: number | number[] | undefined): number | number[] | undefined {
  if (typeof a === 'undefined') return copy(b)

  if (typeof b === 'undefined') return a

  if (typeof b === 'number') return add(a, b)

  if (typeof a === 'number') return add(copy(b), a)

  // both a and b must be bitsets
  for (let i = 0; i < b.length; ++i) if (b[i]) a[i] = (a[i] || 0) | b[i]
  return a
}

/**
 *
 * @param a
 * @param x
 */
function remove(a: number | number[] | undefined, x: number): number | number[] | undefined {
  if (typeof a === 'undefined') return a

  if (typeof a === 'number') return a === x ? void 0 : a

  const word_off = x >> 5
  const word_idx = x % 32
  a[word_off] = (a[word_off] || 0) & ~(1 << word_idx)
  return a
}

/**
 *
 * @param a
 * @param b
 */
function removeAll(a: number | number[] | undefined, b: number | number[] | undefined): number | number[] | undefined {
  if (typeof a === 'undefined' || typeof b === 'undefined') return a

  if (typeof a === 'number') return contains(b, a) ? void 0 : a

  if (typeof b === 'number') return remove(a, b)

  a.forEach(function (w, i) {
    if (b[i]) a[i] = a[i] & ~b[i]
  })
  return a
}

/**
 *
 * @param a
 */
function copy(a: number | number[] | undefined): number | number[] | undefined {
  if (typeof a === 'undefined' || typeof a === 'number') return a

  return a.slice(0)
}

/**
 *
 * @param a
 * @param cb
 */
function iter(a: number | number[] | undefined, cb: (x: number) => void): void {
  if (a) {
    if (typeof a === 'number') cb(a)
    else
      a.forEach(function (w, i) {
        for (let j = 0; j < 32; ++j) if (w & (1 << j)) cb(32 * i + j)
      })
  }
}

/**
 *
 * @param a
 * @param f
 */
function map<T>(a: number | number[] | undefined, f: (x: number) => T): T[] {
  if (a) {
    if (typeof a === 'number') return [f(a)]

    const res: T[] = []
    iter(a, function (x) {
      res[res.length] = f(x)
    })
    return res
  }
  return []
}

/**
 *
 * @param a
 * @param f
 */
function some(a: number | number[] | undefined, f: (x: number) => boolean): boolean {
  if (a) {
    if (typeof a === 'number') return f(a)
    for (let i = 0; i < a.length; ++i)
      if (a[i]) for (let j = 0; j < 32; ++j) if (a[i] & (1 << j)) if (f(32 * i + j)) return true
  }
  return false
}

/**
 *
 * @param a
 * @param f
 */
function all(a: number | number[] | undefined, f: (x: number) => boolean): boolean {
  if (a) {
    if (typeof a === 'number') return f(a)
    for (let i = 0; i < a.length; ++i)
      if (a[i]) for (let j = 0; j < 32; ++j) if (a[i] & (1 << j)) if (!f(32 * i + j)) return false
  }
  return true
}

/**
 *
 * @param ary
 */
function fromArray(ary: number[]): number | number[] | undefined {
  let a: number | number[] | undefined
  ary.forEach(function (x) {
    a = add(a, x)
  })
  return a
}

/**
 *
 * @param a
 */
function toArray(a: number | number[] | undefined): number[] {
  return map(a, function f(x) {
    return x
  })
}

export { copy, size, contains, add, addAll, remove, removeAll, iter, map, some, all, fromArray, toArray }
