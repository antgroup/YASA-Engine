/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
const fs = require('fs')
const path = require('path')

export const ENGIN_START_FUNCALL = 'functionCall'
export const ENGIN_START_FILE_BEGIN = 'fileBegin'
export const YASA_DEFAULT = 'YASADefault'

// 基础版本号
const BASE_VERSION = '0.3.1'

/**
 * 尝试读取构建时生成的版本信息文件
 * @returns {string} 完整版本号字符串
 */
function getBuildVersion(): string {
  try {
    // 在编译后的 dist 目录中查找版本文件
    const versionFile = path.join(__dirname, '../build-version.json')
    if (fs.existsSync(versionFile)) {
      const versionInfo = JSON.parse(fs.readFileSync(versionFile, 'utf-8'))
      return `${BASE_VERSION} (build ${versionInfo.buildDate}, commit ${versionInfo.commitHash})`
    }
  } catch (error) {
    // 忽略错误，使用基础版本
  }
  return BASE_VERSION
}

export const YASA_VERSION = getBuildVersion()

// 同时支持 CommonJS require
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ENGIN_START_FUNCALL,
    ENGIN_START_FILE_BEGIN,
    YASA_DEFAULT,
    YASA_VERSION,
  }
}
