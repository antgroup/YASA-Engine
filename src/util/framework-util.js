const logger = require('./logger')(__filename)
const path = require('path')
const fs = require('fs-extra')
const { handleException } = require('../engine/analyzer/common/exception-handler')

/**
 egg sanity check, must follow the convention below
 | - app
 |    - controller (required)
 |    - service
 |    - model
 |    - midware
 |    - current-entrypoint.js
 | - config
 |    - config.x.js
 * @param appEntryDir
 * */
function eggSanityCheck(appEntryDir) {
  if (!fs.existsSync(appEntryDir)) {
    return false
  }

  const appDir = path.join(appEntryDir, 'app')
  const configDir = path.join(appEntryDir, 'config')
  if (!fs.existsSync(appDir)) {
    return false
  }
  if (!fs.existsSync(configDir)) {
    return false
  }

  const controllerDir = path.join(appDir, 'controller')
  if (!fs.existsSync(controllerDir)) {
    return false
  }
  return true
}

/**
 * 自动识别YASA目前支持的analyzer
 * YASA support EggAnalyzer|JavaScriptAnalyzer|GoAnalyzer|PythonAnalyzer
 * @param language
 * @param dir
 */
function detectAnalyzer(language, dir) {
  let analyzer = ''

  if (!language || language === '' || !dir || dir === '') {
    return analyzer
  }

  if (language === 'javascript') {
    // 检查 package.json
    const pkgPath = path.join(dir, 'package.json')
    try {
      const content = fs.readFileSync(pkgPath, 'utf8')
      if (
        content &&
        content.trim() !== '' &&
        (content.includes('egg-bin') || content.includes('chair') || content.includes('eggjs')) &&
        eggSanityCheck(dir)
      ) {
        analyzer = 'EggAnalyzer'
      }
    } catch (e) {
      logger.info("detect Javascript's Analyzer failed, use default JavaScriptAnalyzer")
    }

    if (analyzer === '') {
      analyzer = 'JavaScriptAnalyzer'
    }
  } else if (language === 'golang') {
    analyzer = 'GoAnalyzer'
  } else if (language === 'python') {
    analyzer = 'PythonAnalyzer'
  }

  return analyzer
}

module.exports = {
  eggSanityCheck,
  detectAnalyzer,
}
