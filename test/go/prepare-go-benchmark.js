const path = require('path')
const fs = require('fs-extra')
const simpleGit = require('simple-git')
const logger = require('../../src/util/logger')(__filename)
const { handleException } = require('../../src/engine/analyzer/common/exception-handler')
const git = simpleGit()
const BENCHMARKS_DIR = './benchmarks'

const BENCHMARK_REPO_URLS = {
  'sast-go': 'https://github.com/alipay/ant-application-security-testing-benchmark.git',
}

async function cloneRepo(gitRepoUrl, targetDir) {
  // 确保目标目录存在
  const absoluteTargetDir = path.resolve(targetDir)
  let done = true
  // 创建命令
  await git
    .clone(gitRepoUrl, absoluteTargetDir)
    .then(() => logger.info(`仓库克隆成功！！！仓库:${gitRepoUrl} 已克隆至 ${targetDir}`))
    .catch((err) => {
      done = false
      handleException(
        err,
        `克隆仓库:${gitRepoUrl}失败, 请手动克隆至 ${targetDir} 错误信息${err}`,
        `克隆仓库:${gitRepoUrl}失败, 请手动克隆至 ${targetDir} 错误信息${err}`
      )
    })
  try {
    cleanDirectoryForSastGo(absoluteTargetDir)
    moveSrcDirectoryForSastGo(absoluteTargetDir)
  } catch (e) {
    handleException(e, `[prepare-go-benchmark] 清理目录时发生错误`, `[prepare-go-benchmark] 清理目录时发生错误`)
    done = false
  }
  return done
}

async function prepareTest() {
  const allRepoReady = []
  for (let key in BENCHMARK_REPO_URLS) {
    const repoUrl = BENCHMARK_REPO_URLS[key]
    const targetDir = path.resolve(__dirname, BENCHMARKS_DIR, key)
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true })
    }
    fs.mkdirSync(targetDir, { recursive: true })
    let repoRes = await cloneRepo(repoUrl, targetDir)
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
    handleException(
      e,
      `[prepare-go-benchmark] 靶场准备检查失败，靶场未准备`,
      `[prepare-go-benchmark] 靶场准备检查失败，靶场未准备`
    )
    return false
  }
}

async function doPrepare() {
  let ready = checkReady()
  logger.info(`检查xAST的sast-go靶场是否准备：${ready}`)
  if (!ready) {
    try {
      logger.info(`开始克隆xAST的sast-go靶场...`)
      await prepareTest()
    } catch (e) {
      handleException(
        e,
        `准备测试case失败，请手动准备xAST的sast-go靶场至测试目录${path.resolve(__dirname, BENCHMARKS_DIR)}`,
        `准备测试case失败，请手动准备xAST的sast-go靶场至测试目录${path.resolve(__dirname, BENCHMARKS_DIR)}`
      )
      return
    }
    logger.info(`仓库克隆成功`)
  }
  const directoryPath = path.resolve(__dirname, BENCHMARKS_DIR)
  processDirectory(directoryPath)
  logger.info(`靶场已准备`)
}

// 遍历并删除除目标子目录以外的所有文件和文件夹
function cleanDirectoryForSastGo(directory) {
  fs.readdirSync(directory).forEach((item) => {
    const itemPath = path.join(directory, item)
    // 跳过子aaa文件夹
    if (path.basename(itemPath) === 'sast-go' && fs.lstatSync(itemPath).isDirectory()) {
      return
    }
    // 删除其他所有文件/文件夹
    fs.removeSync(itemPath)
  })

  // 递归遍历目录树，清空所有 cross_file_package_namespace 目录内容
  ;(function traverse(dir) {
    const items = fs.readdirSync(dir, { withFileTypes: true }) // 获取带类型信息的目录项

    for (const item of items) {
      const itemPath = path.join(dir, item.name)

      if (item.isDirectory()) {
        if (item.name === 'cross_file_package_namespace') {
          fs.removeSync(itemPath)
        } else {
          // 递归处理子目录
          traverse(itemPath)
        }
      }
    }
  })(directory)
}

// 移动src目录到上层的aaa目录
function moveSrcDirectoryForSastGo(directory) {
  const childAaaPath = path.join(directory, 'sast-go')
  const srcPath = path.join(childAaaPath, 'cases')
  if (fs.existsSync(srcPath)) {
    fs.moveSync(srcPath, path.join(directory, 'cases'))
  }
  fs.removeSync(childAaaPath)
}

// 递归遍历目录并处理所有 .go 文件
function processDirectory(directoryPath) {
  fs.readdir(directoryPath, (err, files) => {
    if (err) {
      handleException(
        err,
        `[prepare-go-benchmark] Error reading directory: ${directoryPath}`,
        `[prepare-go-benchmark] Error reading directory: ${directoryPath}`
      )
      return
    }

    files.forEach((file) => {
      const fullPath = path.join(directoryPath, file)
      fs.stat(fullPath, (err, stats) => {
        if (err) {
          handleException(err, `Error reading file stats: ${fullPath}`, `Error reading file stats: ${fullPath}`)
          return
        }

        if (stats.isDirectory()) {
          // 如果是文件夹，则递归处理
          processDirectory(fullPath)
        } else if (file.endsWith('.go')) {
          // 如果是 .go 文件，则读取文件内容并处理
          processGoFile(fullPath)
        }
      })
    })
  })
}

// 处理单个 .go 文件
function processGoFile(filePath) {
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      handleException(err, `Error reading file: ${filePath}`, `Error reading file: ${filePath}`)
      return
    }

    // 查找第一个函数的名称
    const functionMatch = data.match(/func\s+([\w_]+)\(/)
    if (!functionMatch) {
      logger.info(`No functions found in file: ${filePath}`)
      return
    }

    const firstFunctionName = functionMatch[1]
    const taintSrc = '__taint_src'

    // 构造要添加的 main 函数内容
    const mainFunction = `\nfunc main() {\n  ${firstFunctionName}(${taintSrc})\n}\n`

    // 检查是否已经存在 main 函数，避免重复添加
    if (data.includes('func main()')) {
      logger.info(`File already contains main function: ${filePath}`)
      return
    }

    // 在文件内容末尾添加 main 函数
    const updatedData = data + mainFunction

    // 写回文件
    fs.writeFile(filePath, updatedData, 'utf8', (err) => {
      if (err) {
        handleException(err, `Error writing file: ${filePath}`, `Error writing file: ${filePath}`)
        return
      }
      logger.info(`Successfully updated file: ${filePath}`)
    })
  })
}

doPrepare()
