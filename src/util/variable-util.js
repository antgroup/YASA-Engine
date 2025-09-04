/**
 *
 * variable
 */
function isEmpty(variable) {
  return typeof variable === 'undefined'
}

/**
 *
 * variable
 */
function isNotEmpty(variable) {
  return typeof variable !== 'undefined'
}

module.exports = {
  isEmpty,
  isNotEmpty,
}
