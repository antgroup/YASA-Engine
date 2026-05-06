#!/usr/bin/env node
/**
 * build-time patch：规避 pkg 对静态 require.resolve('*.wasm') 的 UTF-8 mangle。
 *
 * 背景：pkg@5.8.1 扫描源码时，把 require.resolve(<literal>.wasm) 命中的文件归类为 script
 * 走 bytecompile 管道，而该管道会把 wasm 当 UTF-8 文本做 decode/encode round-trip，
 * 非法 UTF-8 字节（如 f0/e4）被替换成 EF BF BD（U+FFFD），wasm 字节错位 → WebAssembly
 * instantiate 失败。
 *
 * 本 patch 把 uast-parser-php 里那行 require.resolve 改成 path.join(__dirname, ...)，
 * 使 pkg 静态扫描不再命中 wasm 文件；配合 pkg.assets 的 `node_modules/tree-sitter-php/*.wasm`
 * 条目，wasm 走 asset 路径原始字节嵌入。
 *
 * 幂等：已 patch 时检测 marker 跳过。
 * 自检：找不到原始 pattern 或 uast-parser-php 版本不匹配 → exit 1。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const TARGET_FILE = path.join(
  ROOT,
  'node_modules',
  '@ant-yasa',
  'uast-parser-php',
  'dist',
  'src',
  'parser.js'
)
const PKG_JSON = path.join(
  ROOT,
  'node_modules',
  '@ant-yasa',
  'uast-parser-php',
  'package.json'
)

const SUPPORTED_VERSIONS = ['0.2.12', '0.2.13']

// ─── 原始 pattern ───
// require.resolve('tree-sitter-php/tree-sitter-php.wasm')
// 用正则以容忍 `'` 或 `"`，不容忍其他改写（上游真变了我们想 fail fast）。
const ORIGINAL_PATTERN = /require\.resolve\(\s*['"]tree-sitter-php\/tree-sitter-php\.wasm['"]\s*\)/

// ─── patched 后的表达式 ───
// 从 dist/src/parser.js 回溯 4 级到 node_modules/，再 tree-sitter-php/tree-sitter-php.wasm：
//   src → dist → uast-parser-php → @ant-yasa → node_modules
// 用 inline require('path') 避免修改文件头部 import 区。
const PATCHED_EXPR =
  "require('path').join(__dirname, '..', '..', '..', '..', 'tree-sitter-php', 'tree-sitter-php.wasm')"

// ─── marker：已被 patch 的标志（检测用于幂等）───
const PATCHED_MARKER = "require('path').join(__dirname, '..', '..', '..', '..', 'tree-sitter-php'"

function log(msg) {
  console.log(`[patch-uast-parser-php] ${msg}`)
}

function fail(msg) {
  console.error(`[patch-uast-parser-php] ERROR: ${msg}`)
  process.exit(1)
}

function main() {
  // 前置：目标文件存在
  if (!fs.existsSync(TARGET_FILE)) {
    fail(`target file not found: ${TARGET_FILE}\nrun \`npm install\` first`)
  }
  if (!fs.existsSync(PKG_JSON)) {
    fail(`uast-parser-php package.json not found: ${PKG_JSON}`)
  }

  // 版本断言
  const pkg = JSON.parse(fs.readFileSync(PKG_JSON, 'utf-8'))
  const version = pkg.version
  if (!SUPPORTED_VERSIONS.includes(version)) {
    fail(
      `uast-parser-php version ${version} not in supported list [${SUPPORTED_VERSIONS.join(
        ', '
      )}]. 升级了 uast-parser-php 请同步更新 scripts/patch-uast-parser-php.js 的 SUPPORTED_VERSIONS 和 pattern。`
    )
  }

  const content = fs.readFileSync(TARGET_FILE, 'utf-8')

  // 幂等：已被 patch 直接返回
  if (content.includes(PATCHED_MARKER)) {
    log(`already patched (uast-parser-php@${version}), skip`)
    return
  }

  // 自检：必须能匹配原始 pattern
  const match = content.match(ORIGINAL_PATTERN)
  if (!match) {
    fail(
      `original pattern not found in ${TARGET_FILE}\n` +
        `expected regex: ${ORIGINAL_PATTERN}\n` +
        `uast-parser-php@${version} 的 parser.js 可能已改写 wasm 加载方式，请 review 并更新本 patch script。`
    )
  }

  // 执行替换
  const patched = content.replace(ORIGINAL_PATTERN, PATCHED_EXPR)

  // 后置自检：替换后必须能检到 marker
  if (!patched.includes(PATCHED_MARKER)) {
    fail(`post-patch sanity check failed: marker not found after replace`)
  }

  fs.writeFileSync(TARGET_FILE, patched, 'utf-8')
  log(`patched uast-parser-php@${version} parser.js: require.resolve → path.join`)
  log(`file: ${TARGET_FILE}`)
}

main()
