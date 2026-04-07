import * as path from 'path'
import * as fs from 'fs-extra'
const { describe, it } = require('mocha')
const simpleGit = require('simple-git')
const git = simpleGit()
const { XAST_JS_BENCHMARK, BENCHMARKS_DIR, checkBenchmarkReady } = require('../test-utils')
const { handleException } = require('../../src/engine/analyzer/common/exception-handler')
const logger = require('../../src/util/logger')(__filename)
const XAST_JS_BENCHMARK_REPO_URL = 'https://github.com/alipay/ant-application-security-testing-benchmark.git'

interface BenchmarkRepo {
  gitRepoUrl: string
  branch: string
}

interface BenchmarkRepoUrls {
  [key: string]: BenchmarkRepo
}

const JS_ALL_BENCHMARK_REPO_URLS: BenchmarkRepoUrls = {
  jsbenchmark: {
    gitRepoUrl: XAST_JS_BENCHMARK_REPO_URL,
    branch: 'main-forYasaTest',
  },
}

async function cloneRepo(gitRepoUrl: string, targetDir: string, branch: string): Promise<boolean> {
  // 确保目标目录存在
  const absoluteTargetDir = path.resolve(targetDir)
  let done = true
  // 创建命令
  await git
    .clone(gitRepoUrl, absoluteTargetDir, ['-b', branch])
    .then(() => logger.info(`仓库克隆成功！！！仓库:${gitRepoUrl} 已克隆至 ${targetDir}`))
    .catch((err: any) => {
      done = false
      handleException(
        err,
        `克隆仓库:${gitRepoUrl}失败, 请手动克隆至 ${targetDir} 错误信息${err}`,
        `克隆仓库:${gitRepoUrl}失败, 请手动克隆至 ${targetDir} 错误信息${err}`
      )
    })

  try {
    if (gitRepoUrl === XAST_JS_BENCHMARK_REPO_URL) {
      cleanDirectoryForSastJs(absoluteTargetDir)
      moveSrcDirectoryForJs(absoluteTargetDir)
    }
  } catch (e) {
    handleException(
      e,
      `[prepare-js-benchmark] 清理目录时发生错误.Error:${e}`,
      `[prepare-js-benchmark] 清理目录时发生错误.Error:${e}`
    )
    done = false
  }
  return done
}

async function prepareTest(): Promise<boolean> {
  const allRepoReady: boolean[] = []
  for (let key in JS_ALL_BENCHMARK_REPO_URLS) {
    const repoUrl = JS_ALL_BENCHMARK_REPO_URLS[key].gitRepoUrl
    const branch = JS_ALL_BENCHMARK_REPO_URLS[key].branch
    const targetDir = path.resolve(__dirname, BENCHMARKS_DIR, key)
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true })
    }
    fs.mkdirSync(targetDir, { recursive: true })
    let repoRes = await cloneRepo(repoUrl, targetDir, branch)
    allRepoReady.push(repoRes)
  }
  return allRepoReady.length > 0 && allRepoReady.every((ready) => ready)
}

/**
 * 执行脚本需要做的准备工作是否ready
 * @returns {boolean}
 */
function checkReady(): boolean {
  try {
    let rootDir = path.resolve(__dirname, BENCHMARKS_DIR)
    const dirs = fs.readdirSync(rootDir)
    let set = new Set(dirs)
    set.delete('.DS_Store')
    let ready = Object.keys(JS_ALL_BENCHMARK_REPO_URLS).every((repo) => set.has(repo))
    return ready
  } catch (e) {
    handleException(e, `[prepare-js-benchmark] 靶场准备检查失败`, `[prepare-js-benchmark] 靶场准备检查失败`)
    return false
  }
}

async function doPrepare(): Promise<void> {
  let ready = false
  // let ready = checkReady()
  // logger.info(`检查sast-js靶场是否准备：${ready}`)
  if (!ready) {
    try {
      logger.info(`开始克隆sast-js靶场...`)
      await prepareTest()
    } catch (e) {
      handleException(
        e,
        `[prepare-js-benchmark] 准备测试case失败，请手动准备sast-js靶场至测试目录${path.resolve(__dirname, BENCHMARKS_DIR)}`,
        `[prepare-js-benchmark] 准备测试case失败，请手动准备sast-js靶场至测试目录${path.resolve(__dirname, BENCHMARKS_DIR)}`
      )
      return
    }
    logger.info(`仓库克隆成功`)
  }
  logger.info(`靶场已准备`)
}

// 遍历并删除除目标子目录以外的所有文件和文件夹
function cleanDirectoryForSastJs(directory: string): void {
  fs.readdirSync(directory).forEach((item) => {
    const itemPath = path.join(directory, item)
    // 跳过子aaa文件夹
    if (path.basename(itemPath) === 'sast-js' && fs.lstatSync(itemPath).isDirectory()) {
      return
    }
    // 删除其他所有文件/文件夹
    fs.removeSync(itemPath)
  })
}

// 移动case目录到上层的aaa目录
function moveSrcDirectoryForJs(directory: string): void {
  const childAaaPath = path.join(directory, 'sast-js')
  const srcPath = path.join(childAaaPath, 'case')
  if (fs.existsSync(srcPath)) {
    fs.moveSync(srcPath, directory)
  }
  fs.removeSync(childAaaPath)
}

doPrepare()
