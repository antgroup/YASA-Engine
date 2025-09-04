const path = require('path')
const fs = require('fs-extra')
const { describe, it } = require('mocha')
const { XAST_JS_BENCHMARK, BENCHMARKS_DIR, checkBenchmarkReady } = require('../test-utils')
const { handleException } = require('../../src/engine/analyzer/common/exception-handler')
const logger = require('../../src/util/logger')(__filename)
const XAST_JS_BENCHMARK_REPO_URL = 'https://github.com/alipay/ant-application-security-testing-benchmark.git'

const JS_ALL_BENCHMARK_REPO_URLS = {
  yasaNodeJsBenchmark: 'git@code.alipay.com:jiufo_test/yasaNodeJsBenchmark.git',
  chairbenchmark: 'git@code.alipay.com:jiufo_test/chairbenchmark.git',
  // XAST_JS_BENCHMARK: XAST_JS_BENCHMARK_REPO_URL,
}

describe(`YASA auto prepare js benchmark`, function () {
  this.timeout(100000)
  it(`do preparing benchmark`, async function () {
    prepareJsBenchmark()
  })
})

function prepareJsBenchmark() {
  try {
    let rootDir = path.resolve(__dirname, BENCHMARKS_DIR)
    let ready = checkBenchmarkReady(rootDir, JS_ALL_BENCHMARK_REPO_URLS)
    if (!ready) {
      logger.info(`靶场未准备成功`)
      // await downloadXastJsBenchmark()
      // const targetDir = path.resolve(__dirname, BENCHMARKS_DIR, XAST_JS_BENCHMARK)
      // cleanDirectoryForJs(targetDir)
      // moveSrcDirectoryForJs(targetDir)
    } else {
      logger.info(`靶场准备成功`)
    }
  } catch (e) {
    handleException(e, 'Error in prepareJsBenchmark ', 'Error in prepareJsBenchmark ')
    return false
  }
  return true
}

async function downloadXastJsBenchmark() {
  const targetDir = path.resolve(__dirname, BENCHMARKS_DIR, XAST_JS_BENCHMARK)
  let cloneSuccess = await cloneRepo(XAST_JS_BENCHMARK_REPO_URL, targetDir)
  return cloneSuccess
}

// 遍历并删除除目标子目录以外的所有文件和文件夹
function cleanDirectoryForJs(directory) {
  fs.readdirSync(directory).forEach((item) => {
    const itemPath = path.join(directory, item)
    // 跳过子aaa文件夹
    if (path.basename(itemPath) === 'sast-js' && fs.lstatSync(itemPath).isDirectory()) {
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

// 移动case目录到上层的aaa目录
function moveSrcDirectoryForJs(directory) {
  const childAaaPath = path.join(directory, 'sast-js')
  const srcPath = path.join(childAaaPath, 'case')
  if (fs.existsSync(srcPath)) {
    fs.moveSync(srcPath, directory)
  }
  fs.removeSync(childAaaPath)
}

module.exports = {
  prepareJsBenchmark,
}
