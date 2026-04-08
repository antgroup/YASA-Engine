import path from 'path'
import fs from 'fs-extra'

const logger = require('./logger')(__filename)
const FileUtil = require('./file-util')

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
function eggSanityCheck(appEntryDir: string): boolean {
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

  return true
}

/**
 * 自动识别YASA目前支持的analyzer
 * YASA support EggAnalyzer|JavaScriptAnalyzer|JavaAnalyzer|SpringAnalyzer|GoAnalyzer|PythonAnalyzer
 * @param language
 * @param dir
 */
function detectAnalyzer(language: string, dir: string): string {
  let analyzer = ''

  if (!language || language === '' || !dir || dir === '') {
    return analyzer
  }

  if (language === 'java') {
    // 检查 Maven/Gradle 配置文件
    const mavenOrGradleFiles = FileUtil.loadAllFileTextGlobby(['**/pom.xml', '**/build.gradle'], dir)
    for (const mavenOrGradleFile of mavenOrGradleFiles) {
      try {
        const { content } = mavenOrGradleFile
        if (
          (content &&
            content.trim() !== '' &&
            content.includes('org.springframework') &&
            (content.includes('spring-web') || content.includes('spring-boot'))) ||
          (content.includes('com.alipay.sofa') &&
            (content.includes('sofaboot') || content.includes('sofa-boot') || content.includes('sofa.web.mvc')))
        ) {
          analyzer = 'SpringAnalyzer'
          break
        }
      } catch (e) {}
    }
    if (analyzer === '') {
      analyzer = 'JavaAnalyzer'
    }
  } else if (language === 'javascript') {
    // 检查 package.json
    const pkgPath = path.join(dir, 'package.json')
    try {
      const content = fs.readFileSync(pkgPath, 'utf8')
      const isEgg = (content: any, dir: any) => {
        return (content.includes('egg-bin') || content.includes('chair') || content.includes('eggjs')) && eggSanityCheck(dir)
      }
      const isExpress = (content: any) => {
        return content.includes('express')
      }
      if (content && content.trim() !== '' && isEgg(content, dir)) {
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

export { eggSanityCheck, detectAnalyzer }
