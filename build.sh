#!/bin/bash

# 设置错误时退出
set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 报警函数
alert() {
    echo -e "${RED}❌ 错误: $1${NC}" >&2
    exit 1
}

# 成功信息
success() {
    echo -e "${GREEN}✅ $1${NC}"
}

# 信息提示
info() {
    echo -e "${YELLOW}ℹ️  $1${NC}"
}

info "开始构建流程..."

# 步骤 0: 清理历史结果
info "步骤 0/8: 清理历史结果 (rm -rf dist)"
if ! rm -rf dist > /dev/null; then
    alert "清理历史结果失败"
fi
success "清理历史结果完成"

# 步骤 1: 安装依赖
info "步骤 1/8: 安装依赖 (npm install --ignore-scripts --package-lock=false)"
if ! npm install --ignore-scripts --package-lock=false > /dev/null; then
    alert "npm install 失败"
fi
success "依赖安装完成"

# 步骤 1.5: 下载并校验 SQLite native addon
info "步骤 1.5/8: 准备 better-sqlite3 三平台 native addon"
if ! bash scripts/download-better-sqlite3-native.sh; then
    alert "better-sqlite3 native addon 准备失败"
fi
success "better-sqlite3 native addon 准备完成"

# 步骤 1.6: patch @ant-yasa/uast-parser-php 规避 pkg 对 require.resolve('*.wasm') 的 UTF-8 mangle
info "步骤 1.6/8: patch uast-parser-php (node scripts/patch-uast-parser-php.js)"
mkdir -p dist
UAST_PHP_PATCH_LOG="$(pwd)/dist/uast-parser-php-patch.log"
if ! node scripts/patch-uast-parser-php.js > "$UAST_PHP_PATCH_LOG" 2>&1; then
    cat "$UAST_PHP_PATCH_LOG" >&2
    alert "uast-parser-php patch 失败"
fi
success "uast-parser-php patch 完成"

# 步骤 2: 类型检查
info "步骤 2/8: 类型检查 (npx tsc --noEmit)"
# 只重定向 stdout，保留 stderr 以便显示错误信息
set +e
npx tsc --noEmit > /dev/null
TSC_CHECK_EXIT_CODE=$?
set -e
if [ $TSC_CHECK_EXIT_CODE -ne 0 ]; then
    alert "类型检查失败，请修复 TypeScript 错误"
fi
success "类型检查通过"

# 步骤 3: 检查 require() 调用
info "步骤 3/8: 检查 require() 调用 (node check-requires.js)"
if ! node check-requires.js > /dev/null; then
    alert "require() 检查失败，请修复模块引用错误"
fi
success "require() 检查通过"

# 步骤 4: 运行所有测试
info "步骤 4/8: 运行所有测试 (npm run test-all)"
if ! npm run test-all > /dev/null; then
    alert "测试失败，请修复测试错误"
fi
success "所有测试通过"

# 步骤 5: 生成构建版本信息
info "步骤 5/8: 生成构建版本信息"
BUILD_DATE=$(date +%Y%m%d)
COMMIT_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# 创建 dist 目录（如果不存在）
mkdir -p dist

# 生成版本信息文件（编译后代码会读取此文件）
cat > dist/build-version.json <<EOF
{
  "buildDate": "${BUILD_DATE}",
  "commitHash": "${COMMIT_HASH}"
}
EOF

success "构建版本信息已生成 (build ${BUILD_DATE}, commit ${COMMIT_HASH})"

# 步骤 6: 编译 TypeScript
info "步骤 6/8: 编译 TypeScript (npx tsc)"
# 只重定向 stdout，保留 stderr 以便显示错误信息
set +e
npx tsc > /dev/null
TSC_EXIT_CODE=$?
set -e
if [ $TSC_EXIT_CODE -ne 0 ]; then
    alert "TypeScript 编译失败，请查看上方的错误信息"
fi
success "TypeScript 编译完成"

# 确保版本文件在编译后仍然存在（因为 tsc 可能会清理 dist）
mkdir -p dist
cat > dist/build-version.json <<EOF
{
  "buildDate": "${BUILD_DATE}",
  "commitHash": "${COMMIT_HASH}"
}
EOF

# 步骤 7: 打包二进制
info "步骤 7/8: 打包二进制 (npx pkg)"
PKG_BUILD_LOG="$(pwd)/dist/pkg-build.log"
set +e
npx pkg . --options max-old-space-size=11264,expose-gc > /dev/null 2> "$PKG_BUILD_LOG"
PKG_EXIT_CODE=$?
set -e
if [ $PKG_EXIT_CODE -ne 0 ]; then
    cat "$PKG_BUILD_LOG" >&2
    alert "打包失败 (退出码: $PKG_EXIT_CODE)，请查看上方的错误信息"
fi
success "打包完成"

# 步骤 7.5: 为每个可执行文件附带匹配的 native addon
info "步骤 7.5/8: 布置 better-sqlite3 native addon"
for target in linux-x64 macos-x64 macos-arm64; do
    executable="yasa-engine-${target}"
    native_platform="${target/macos/darwin}"
    native_source="native/better-sqlite3/${native_platform}/better_sqlite3.node"
    native_destination="${executable}.native/better-sqlite3.node"

    if [ ! -f "$executable" ]; then
        alert "未找到 pkg 产物: $executable"
    fi
    if [ ! -f "$native_source" ]; then
        alert "未找到 native addon: $native_source"
    fi

    rm -rf "${executable}.native"
    mkdir -p "${executable}.native"
    cp "$native_source" "$native_destination"
done
success "better-sqlite3 native addon 布置完成"

# 步骤 8: 删除 dist 文件
info "步骤 8/8: 删除 dist 文件"
if [ -d "dist" ]; then
    rm -rf dist
    success "dist 文件已删除"
else
    info "dist 目录不存在，跳过删除"
fi

info "构建流程全部完成！"
