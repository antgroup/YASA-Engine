/**
 *
 * variable
 * @param variable
 */
function isEmpty(variable: unknown): boolean {
  return typeof variable === 'undefined'
}

/**
 *
 * variable
 * @param variable
 */
function isNotEmpty(variable: unknown): boolean {
  return typeof variable !== 'undefined'
}

export { isEmpty, isNotEmpty }
