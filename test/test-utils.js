const path = require('path')
const fs = require('fs')
const simpleGit = require('simple-git')
const logger = require('../src/util/logger')(__filename)
const { handleException } = require('../src/engine/analyzer/common/exception-handler')
const git = simpleGit()
const CHAIR_BENCHMARK = 'chairbenchmark'
const NODEJS_BENCHMARK = 'yasaNodeJsBenchmark'
const BENCHMARKS_DIR = './benchmarks'
const XAST_JS_BENCHMARK = 'jsbenchmark'

function checkBenchmarkReady(rootDir, benchmarkRepoSet) {
  const allRepoReady = []
  for (let key in benchmarkRepoSet) {
    const repoUrl = benchmarkRepoSet[key]
    const targetDir = path.resolve(__dirname, rootDir, key)
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true })
    }
    fs.mkdirSync(targetDir, { recursive: true })
    let repoRes = cloneRepo(repoUrl, targetDir)
    allRepoReady.push(repoRes)
  }
  return allRepoReady.length > 0 && allRepoReady.every((ready) => ready)
}

function cloneRepo(gitRepoUrl, targetDir) {
  // 确保目标目录存在
  const absoluteTargetDir = path.resolve(targetDir)
  let done = true
  try {
    git.clone(gitRepoUrl, absoluteTargetDir)
    logger.info(`仓库克隆成功！！！仓库:${gitRepoUrl} 已克隆至 ${targetDir}`)
  } catch (e) {
    done = false
    handleException(
      e,
      `克隆仓库:${gitRepoUrl}失败, 请手动克隆至 ${targetDir} 错误信息${e}`,
      `克隆仓库:${gitRepoUrl}失败, 请手动克隆至 ${targetDir} 错误信息${e}`
    )
  }
  return done
}

function recordFindingStr() {
  let resStr = ''

  function append(...args) {
    let argStr = args.map((arg) => {
      return arg ? (typeof arg === 'object' ? JSON.stringify(arg) : arg.toString()) : String(arg)
    })
    resStr = resStr.concat(...argStr).concat('\n')
  }

  function printAndAppend(...args) {
    logger.info(...args)
    append(...args)
  }
  function getRawResult() {
    return resStr
  }

  function getFormatResult() {
    // 重新合并成一个字符串,并去除首位空格
    return resStr
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trim()
  }

  function clearResult() {
    resStr = ''
  }

  return {
    append,
    printAndAppend,
    getRawResult,
    getFormatResult,
    clearResult,
  }
}

function readExpectRes(expectResPath) {
  let res = ''
  if (fs.existsSync(expectResPath) && path.extname(expectResPath) === '.result') {
    try {
      res = fs.readFileSync(expectResPath)
    } catch (e) {
      handleException(e, `fail to read back up ${expectResPath}`, `fail to read back up ${expectResPath}`)
      res = ''
    }
  }
  return res.toString()
}

function resolveFindingResult(resTxt) {
  let resMap = new Map()

  if (!resTxt || typeof resTxt !== 'string' || resTxt === '') return resMap

  // 解析每个链路的开始字符串 形如------------- 1: taint_flow_egg_input-------------
  const splitRegexStr = '-+\\s+\\d+:\\s+\\w+-+\\s'
  const splitRegex = new RegExp(splitRegexStr, 'g')
  let chains = resTxt.split(splitRegex)
  // 解析entrypoint 形如
  // entrypoint:
  // {"filePath":"/sast-java/src/main/java/com/sast/astbenchmark/other_preference/MayTaintKind_001_T.java","functionName":"testcase","attribute":"HTTP","type":"functionCall","packageName":"com.sast.astbenchmark.other_preference.MayTaintKind_001_T","funcReceiverType":""}
  const entrypointRegexStr = '^entrypoint:\\s*\\{.*\\}'
  const entrypointRegex = new RegExp(entrypointRegexStr, 'm')
  // 解析最后的统计结果 形如
  // ==========================================================
  //   #taint_flow_egg_input:50
  // ==========================================================
  const lastRegexStr = '^={5,}\\s.*\\s={5,}$'
  const lastRegex = new RegExp(lastRegexStr, 'm')

  // chains的第0个元素无用 最后一个元素包含链路数量信息
  for (let i = 1; i < chains.length; i++) {
    let chain = chains[i]
    if (i === chains.length - 1) {
      const matches = lastRegex.exec(chain)
      const lastContent = Array.isArray(matches) ? matches[0] : ''
      chain = chain.substring(0, chain.search(lastRegex))
      resMap.set(getEntryPointName(chain, resMap), chain)
      let chainsNumberArray = lastContent.replaceAll('=', '').trim().split('\n')
      for (const chainNumber of chainsNumberArray) {
        let entry = chainNumber.split(':')
        resMap.set(entry[0], entry[1])
      }
    } else {
      resMap.set(getEntryPointName(chain, resMap), chain)
    }
  }

  function getEntryPointName(chain, resMap) {
    const matches = entrypointRegex.exec(chain)
    if (matches) {
      let entrypointStr = Array.isArray(matches) ? matches[0] : ''
      let entrypointFormat = entrypointStr.replaceAll('\n', '').replaceAll('entrypoint:', '')
      try {
        let entrypoint = JSON.parse(entrypointFormat)
        if (entrypoint) {
          let i = 0
          let entrypointKey = entrypointFormat
          const baseKey = `${entrypoint?.filePath}-${entrypoint?.functionName}-${entrypoint?.attribute}`
          do {
            entrypointKey = `${baseKey}-${i++}`
          } while (resMap.has(entrypointKey))
          return entrypointKey
        }
        return entrypointFormat
      } catch (e) {
        handleException(
          e,
          `Exception in getEntryPointName JSON.parse: ${e.toString()}\nentrypointFormat: ${entrypointFormat}`,
          `Exception in getEntryPointName JSON.parse: ${e.toString()}\nentrypointFormat: ${entrypointFormat}`
        )
      }
    }
  }
  return resMap
}

function getExpectResultPath(dir) {
  return dir.includes(CHAIR_BENCHMARK)
    ? path.join(dir, '..', '..', 'expect', 'chairbenchmark-expect.result')
    : dir.includes(NODEJS_BENCHMARK)
      ? path.join(dir, '..', '..', 'expect', 'yasaNodeJsBenchmark-expect.result')
      : ''
}

function resolveTestFindingResult(resTxt) {
  let resMap = new Map()

  if (!resTxt || typeof resTxt !== 'string' || resTxt === '') return resMap

  // 解析每个链路的开始字符串 形如------------- 1: taint_flow_egg_input-------------
  const splitRegexStr = '-+\\s+\\d+:\\s+\\w+-+\\s'
  const splitRegex = new RegExp(splitRegexStr, 'g')
  let chains = resTxt.split(splitRegex)

  // 解析最后的统计结果 形如
  // ==========================================================
  //   #taint_flow_egg_input:50
  // ==========================================================
  const lastRegexStr = '^={5,}\\s.*\\s={5,}$'
  const lastRegex = new RegExp(lastRegexStr, 'm')

  // chains的第0个元素无用 最后一个元素包含链路数量信息
  for (let i = 1; i < chains.length; i++) {
    let chain = chains[i]
    if (i === chains.length - 1) {
      const matches = lastRegex.exec(chain)
      const lastContent = Array.isArray(matches) ? matches[0] : ''
      chain = chain.substring(0, chain.search(lastRegex))
      const testFileName = getTestFileName(chain)
      if (!resMap.has(testFileName)) {
        resMap.set(testFileName, [])
      }
      resMap.get(testFileName).push(chain)
      let chainsNumberArray = lastContent.replaceAll('=', '').trim().split('\n')
      for (const chainNumber of chainsNumberArray) {
        let entry = chainNumber.split(':')
        resMap.set(entry[0], entry[1])
      }
    } else {
      const testFileName = getTestFileName(chain)
      if (!resMap.has(testFileName)) {
        resMap.set(testFileName, [])
      }
      resMap.get(testFileName).push(chain)
    }
  }

  function getTestFileName(chain) {
    const regex = /File:[^\s]+\.py/g
    const match = chain.match(regex)
    return match[0].replace('File:', '')
  }
  return resMap
}

module.exports = {
  recordFindingStr,
  readExpectRes,
  resolveFindingResult,
  getExpectResultPath,
  BENCHMARKS_DIR,
  XAST_JS_BENCHMARK,
  CHAIR_BENCHMARK,
  NODEJS_BENCHMARK,
  resolveTestFindingResult,
  checkBenchmarkReady,
}
