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
info "步骤 1/8: 安装依赖 (npm install --package-lock=false)"
if ! npm install --package-lock=false > /dev/null; then
    alert "npm install 失败"
fi
success "依赖安装完成"

# 步骤 1.5: patch @ant-yasa/uast-parser-php 规避 pkg 对 require.resolve('*.wasm') 的 UTF-8 mangle
info "步骤 1.5/8: patch uast-parser-php (node scripts/patch-uast-parser-php.js)"
if ! node scripts/patch-uast-parser-php.js; then
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
# 只重定向 stdout，保留 stderr 以便显示错误信息
set +e
npx pkg . --options max-old-space-size=11264 > /dev/null
PKG_EXIT_CODE=$?
set -e
if [ $PKG_EXIT_CODE -ne 0 ]; then
    alert "打包失败 (退出码: $PKG_EXIT_CODE)，请查看上方的错误信息"
fi
success "打包完成"

# 步骤 8: 删除 dist 文件
info "步骤 8/8: 删除 dist 文件"
if [ -d "dist" ]; then
    rm -rf dist
    success "dist 文件已删除"
else
    info "dist 目录不存在，跳过删除"
fi

info "构建流程全部完成！"
