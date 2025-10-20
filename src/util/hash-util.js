const crypto = require('crypto')

/**
 *
 * @param str
 */
function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex')
}

module.exports = {
  md5,
}
