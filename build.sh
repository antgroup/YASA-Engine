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

# 步骤 1: 安装依赖
info "步骤 1/6: 安装依赖 (npm install)"
if ! npm install; then
    alert "npm install 失败"
fi
success "依赖安装完成"

# 步骤 2: 类型检查
info "步骤 2/6: 类型检查 (npx tsc --noEmit)"
if ! npx tsc --noEmit; then
    alert "类型检查失败，请修复 TypeScript 错误"
fi
success "类型检查通过"

# 步骤 3: 运行所有测试
info "步骤 3/6: 运行所有测试 (npm run test-all)"
if ! npm run test-all; then
    alert "测试失败，请修复测试错误"
fi
success "所有测试通过"

# 步骤 4: 编译 TypeScript
info "步骤 4/6: 编译 TypeScript (npx tsc)"
if ! npx tsc; then
    alert "TypeScript 编译失败"
fi
success "TypeScript 编译完成"

# 步骤 5: 打包二进制
info "步骤 5/6: 打包二进制 (npx pkg)"
if ! npx pkg . --options max-old-space-size=13312; then
    alert "打包失败"
fi
success "打包完成"

# 步骤 6: 删除 dist 文件
info "步骤 6/6: 删除 dist 文件"
if [ -d "dist" ]; then
    rm -rf dist
    success "dist 文件已删除"
else
    info "dist 目录不存在，跳过删除"
fi

info "构建流程全部完成！"

