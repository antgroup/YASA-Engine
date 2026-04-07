#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { globSync } = require('fast-glob')

/**
 * 检查 require() 调用是否有效
 * 只检查 TypeScript 会编译的文件（根据 tsconfig.json 配置）
 */

// 配置
const PROJECT_ROOT = __dirname
const TSCONFIG_PATH = path.join(PROJECT_ROOT, 'tsconfig.json')

/**
 * 使用 TypeScript 编译器获取实际会编译的文件列表
 */
function getTypeScriptFiles() {
  const { execSync } = require('child_process')
  
  try {
    // 使用 tsc --listFiles 获取实际编译的文件列表
    const output = execSync('npx tsc --listFiles --noEmit', {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    
    // 解析输出，提取文件路径
    const files = output
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('TS') && !line.includes('node_modules'))
      .filter(line => {
        // 只保留源文件，排除 .d.ts 和输出文件
        return line.endsWith('.ts') || line.endsWith('.js')
      })
      .map(line => {
        // 转换为绝对路径
        if (path.isAbsolute(line)) {
          return line
        }
        return path.resolve(PROJECT_ROOT, line)
      })
      .filter(file => {
        // 排除输出目录中的文件
        return !file.includes('/dist/') && !file.includes('\\dist\\')
      })
    
    return [...new Set(files)] // 去重
  } catch (error) {
    // 如果 tsc 执行失败，回退到使用 tsconfig.json
    const tsconfigContent = fs.readFileSync(TSCONFIG_PATH, 'utf-8')
    const tsconfig = JSON.parse(tsconfigContent)
    const include = tsconfig.include || ['src/**/*.ts', 'src/**/*.js']
    const exclude = tsconfig.exclude || ['node_modules', 'test/**/*', 'dist']
    
    // 使用 globSync 查找文件（同步方式）
    return globSync(include, {
      cwd: PROJECT_ROOT,
      ignore: exclude,
      absolute: true,
    })
  }
}

// 统计
let totalFiles = 0
let totalRequires = 0
let invalidRequires = 0
const invalidList = []

/**
 * 解析 require 语句，提取模块路径
 */
function extractRequires(content, filePath) {
  const requires = []
  
  // 匹配 require('xxx') 或 require("xxx")
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  let match
  
  while ((match = requireRegex.exec(content)) !== null) {
    const modulePath = match[1]
    const lineNumber = content.substring(0, match.index).split('\n').length
    
    requires.push({
      module: modulePath,
      line: lineNumber,
      column: match.index - content.lastIndexOf('\n', match.index) - 1,
    })
  }
  
  return requires
}

/**
 * 检查模块是否存在
 */
function checkModuleExists(modulePath, currentFile) {
  // 相对路径
  if (modulePath.startsWith('.')) {
    const currentDir = path.dirname(currentFile)
    const resolvedPath = path.resolve(currentDir, modulePath)
    
    // 检查 .js, .ts, .json, 或目录下的 index.js/index.ts
    const extensions = ['.js', '.ts', '.json', '']
    for (const ext of extensions) {
      const fullPath = resolvedPath + ext
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        return { exists: true, path: fullPath }
      }
    }
    
    // 检查目录下的 index 文件
    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
      for (const ext of ['.js', '.ts', '.json']) {
        const indexPath = path.join(resolvedPath, 'index' + ext)
        if (fs.existsSync(indexPath)) {
          return { exists: true, path: indexPath }
        }
      }
      // 目录存在但没有 index 文件，也算存在（可能是 package.json 的 main）
      return { exists: true, path: resolvedPath, note: 'directory without index' }
    }
    
    return { exists: false, path: resolvedPath }
  }
  
  // node_modules 中的模块
  // 检查是否是内置模块
  const builtinModules = require('module').builtinModules
  if (builtinModules.includes(modulePath)) {
    return { exists: true, path: 'builtin', note: 'Node.js builtin module' }
  }
  
  // 检查 node_modules
  let checkPath = currentFile
  while (checkPath !== path.dirname(checkPath)) {
    const nodeModulesPath = path.join(checkPath, 'node_modules', modulePath)
    if (fs.existsSync(nodeModulesPath)) {
      return { exists: true, path: nodeModulesPath }
    }
    checkPath = path.dirname(checkPath)
  }
  
  // 检查项目根目录的 node_modules
  const rootNodeModules = path.join(PROJECT_ROOT, 'node_modules', modulePath)
  if (fs.existsSync(rootNodeModules)) {
    return { exists: true, path: rootNodeModules }
  }
  
  return { exists: false, path: modulePath }
}

/**
 * 检查单个文件
 */
function checkFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const requires = extractRequires(content, filePath)
    
    if (requires.length === 0) {
      return
    }
    
    totalFiles++
    totalRequires += requires.length
    
    for (const req of requires) {
      const checkResult = checkModuleExists(req.module, filePath)
      
      if (!checkResult.exists) {
        invalidRequires++
        invalidList.push({
          file: path.relative(PROJECT_ROOT, filePath),
          line: req.line,
          column: req.column,
          module: req.module,
          resolved: checkResult.path,
        })
      }
    }
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error.message)
  }
}

/**
 * 主函数
 */
function main() {
  // 使用 TypeScript 编译器获取实际会编译的文件
  const files = getTypeScriptFiles()
  
  // 检查每个文件
  for (const file of files) {
    checkFile(file)
  }
  
  // 输出结果（简化版，类似编译器错误输出）
  if (invalidRequires > 0) {
    // 按文件分组
    const grouped = {}
    for (const item of invalidList) {
      if (!grouped[item.file]) {
        grouped[item.file] = []
      }
      grouped[item.file].push(item)
    }
    
    // 输出错误，格式类似 TypeScript 编译器
    for (const [file, items] of Object.entries(grouped).sort()) {
      for (const item of items) {
        console.error(`${file}(${item.line},${item.column + 1}): error: Cannot find module '${item.module}'`)
      }
    }
    
    console.error(`\nFound ${invalidRequires} error(s).`)
    process.exit(1)
  }
  
  // 成功时输出简要信息
  console.log(`Checked ${totalRequires} require() call(s) in ${totalFiles} file(s). All valid.`)
  process.exit(0)
}

// 运行
try {
  main()
} catch (error) {
  console.error('执行出错:', error)
  process.exit(1)
}

