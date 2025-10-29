const path = require('path')
const fs = require('fs-extra')
const simpleGit = require('simple-git')
const logger = require('../../src/util/logger')(__filename)
const { handleException } = require('../../src/engine/analyzer/common/exception-handler')
const git = simpleGit()
const BENCHMARKS_DIR = './benchmarks'

const BENCHMARK_REPO_URLS = {
  'sast-java': {
    gitRepoUrl: 'https://github.com/alipay/ant-application-security-testing-benchmark.git',
    branch: 'main-forYasaTest',
  },
}

async function cloneRepo(gitRepoUrl, targetDir, branch) {
  // 确保目标目录存在
  const absoluteTargetDir = path.resolve(targetDir)
  let done = true
  // 创建命令
  await git
    .clone(gitRepoUrl, absoluteTargetDir, ['-b', branch])
    .then(() => logger.info(`仓库克隆成功！！！仓库:${gitRepoUrl} 已克隆至 ${targetDir}`))
    .catch((err) => {
      done = false
      handleException(
        err,
        `[prepare-java-benchmark] 克隆仓库:${gitRepoUrl}失败, 请手动克隆至 ${targetDir} 错误信息${err}`,
        `[prepare-java-benchmark] 克隆仓库:${gitRepoUrl}失败, 请手动克隆至 ${targetDir} 错误信息${err}`
      )
    })
  try {
    cleanDirectoryForSastJava(absoluteTargetDir)
    moveSrcDirectoryForSastJava(absoluteTargetDir)
  } catch (e) {
    handleException(
      e,
      `[prepare-java-benchmark] 清理目录时发生错误.Error:${e}`,
      `[prepare-java-benchmark] 清理目录时发生错误.Error:${e}`
    )
    done = false
  }
  return done
}

async function prepareTest() {
  const allRepoReady = []
  for (let key in BENCHMARK_REPO_URLS) {
    const repoUrl = BENCHMARK_REPO_URLS[key].gitRepoUrl
    const branch = BENCHMARK_REPO_URLS[key].branch
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
function checkReady() {
  try {
    let rootDir = path.resolve(__dirname, BENCHMARKS_DIR)
    const dirs = fs.readdirSync(rootDir)
    let set = new Set(dirs)
    set.delete('.DS_Store')
    let ready = Object.keys(BENCHMARK_REPO_URLS).every((repo) => set.has(repo))
    return ready
  } catch (e) {
    handleException(e, `[prepare-java-benchmark] 靶场准备检查失败`, `[prepare-java-benchmark] 靶场准备检查失败`)
    return false
  }
}

async function doPrepare() {
  let ready = checkReady()
  logger.info(`检查xast的sast-java靶场是否准备：${ready}`)
  if (!ready) {
    try {
      logger.info(`开始克隆xast的sast-java靶场...`)
      await prepareTest()
    } catch (e) {
      handleException(
        e,
        `[prepare-java-benchmark] 准备测试case失败，请手动准备xast的sast-java靶场至测试目录${path.resolve(__dirname, BENCHMARKS_DIR)}`,
        `[prepare-java-benchmark] 准备测试case失败，请手动准备xast的sast-java靶场至测试目录${path.resolve(__dirname, BENCHMARKS_DIR)}`
      )
      return
    }
    logger.info(`仓库克隆成功`)
  }
  logger.info(`靶场已准备`)
}

// 遍历并删除除目标子目录以外的所有文件和文件夹
function cleanDirectoryForSastJava(directory) {
  fs.readdirSync(directory).forEach((item) => {
    const itemPath = path.join(directory, item)
    // 跳过子aaa文件夹
    if (path.basename(itemPath) === 'sast-java' && fs.lstatSync(itemPath).isDirectory()) {
      return
    }
    // 删除其他所有文件/文件夹
    fs.removeSync(itemPath)
  })
}

// 移动src目录到上层的目录
function moveSrcDirectoryForSastJava(directory) {
  const childAaaPath = path.join(directory, 'sast-java')
  const srcPath = path.join(childAaaPath, 'src')
  if (fs.existsSync(srcPath)) {
    fs.moveSync(srcPath, path.join(directory, 'src'))
  }
  fs.removeSync(childAaaPath)
}

doPrepare()
