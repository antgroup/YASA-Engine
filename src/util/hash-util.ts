import * as crypto from 'crypto'

/**
 *
 * @param str
 */
function md5(str: string): string {
  return crypto.createHash('md5').update(str).digest('hex')
}

export { md5 }
