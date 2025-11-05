import * as crypto from 'crypto'

/**
 * 计算 MD5 哈希
 * @param str 输入字符串
 * @returns MD5 哈希值（32位十六进制字符串）
 */
function md5(str: string): string {
  return crypto.createHash('md5').update(str).digest('hex')
}

export { md5 }
