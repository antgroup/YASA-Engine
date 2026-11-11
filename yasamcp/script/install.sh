#!/usr/bin/env bash
# ============================================================================
# install.sh —— yasamcp 一键安装脚本（纯 shell，不依赖 python）
#
# 安装布局（默认 ~/.yasamcp，可用 --home 或环境变量 YASAMCP_HOME 自定义）：
#   <安装目录>/
#     ├─ tools/<平台>/{yasa,codegraph,ripgrep,scc}   # native 工具
#     ├─ yasamcp-cli/yasamcp                          # yasamcp 二进制(onedir) + lib
#     └─ config.json                                  # {"binary_path": "<安装目录>/tools"}
#   PATH 入口：<安装目录>/yasamcp-cli  (直接把可执行目录放 PATH，不再多一层 bin)
#
# 做五件事：
#   1. 检测系统/架构（仅支持 mac-arm64 / mac-x64 / linux-x64）
#   2. 从 OSS 下载 native 工具并解压到 <安装目录>/tools/<平台>/
#   3. 下载 yasamcp 二进制到 <安装目录>/yasamcp-cli/，确认 --version 能运行
#   4. 写入 <安装目录>/config.json
#   5. 把 <安装目录>/yasamcp-cli 加入 PATH，并导出 YASA_MCP_BIN_DIR=<安装目录>/tools
#      （这样 yasamcp init 不传 -b 也能找到 native 工具）
#
# 两种安装方式：
#   A) 联网从 0 到 1：    ./install.sh
#   B) 离线/已下载本地包：./install.sh --tools ./darwin-aarch64.zip --yasamcp ./yasamcp.zip
#
# 用法示例：
#   ./install.sh                                  # 联网安装到 ~/.yasamcp
#   ./install.sh --home /opt/yasamcp              # 自定义安装目录
#   ./install.sh --skip-path                       # 不改 shell rc
#   ./install.sh --tools ./a.zip --yasamcp ./b.zip
#
# 环境变量：
#   YASAMCP_HOME      安装根目录，默认 ~/.yasamcp
#   YASAMCP_VERSION   要安装的 release tag，默认 latest(解析最新版);可设 yasamcp-vX.Y.z 固定版本
# ============================================================================

set -euo pipefail

# ── 终端彩色输出，便于阅读 ───────────────────────────────────────────────
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BLUE=$'\033[36m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
info()    { printf "${BLUE}[INFO]${RESET} %s\n" "$*"; }
warn()    { printf "${YELLOW}[WARN]${RESET} %s\n" "$*"; }
success() { printf "${GREEN}${BOLD}[OK]${RESET} %s\n" "$*"; }
die()     { printf "${RED}${BOLD}[ERROR]${RESET} %s\n" "$*" >&2; exit 1; }

# ============================================================================
# 下载链接配置区
# ============================================================================

# ── yasamcp 二进制发布仓库(GitHub Releases)───────────────────────────────
# yasamcp 与 yasa 同在仓库 antgroup/YASA-Engine,但二者 release tag 不同:
#   · yasa 走 v0.3.2 之类 tag;
#   · yasamcp 走 yasamcp-v1.0.x 之类 tag。
# 默认安装「最新版」yasamcp:YASAMCP_VERSION=latest 时,优先用 releases/latest 重定向解析 tag,
# 若该 tag 不是 yasamcp-(例如 latest 被新发布的 yasa 占位),则回退到 API 列出 releases 并取首个
# yasamcp-v* tag。也可指定具体 tag:YASAMCP_VERSION=yasamcp-vX.Y.z;离线安装:--yasamcp 指本地包。
# ⚠️ 这里只取「yasamcp 二进制」制品(命名 yasamcp-*),绝不取 yasa-* 原生工具包;
#   yasa 原生工具走 OSS(见上方 TOOLS_URL_*),不经过 GitHub release。
YASAMCP_REPO="${YASAMCP_REPO:-antgroup/YASA-Engine}"
YASAMCP_VERSION="${YASAMCP_VERSION:-latest}"  # 默认取最新版
YASAMCP_ASSET="${YASAMCP_ASSET:-}"          # 可选:资源文件名,默认 yasamcp-<平台>.tar.gz

# ── native 工具压缩包下载链接（已上传 OSS，按平台区分）────────────────────
# 每个 zip 解压后应包含 yasa / codegraph / ripgrep / scc 工具目录（或带平台顶层目录）。
TOOLS_URL_DARWIN_AARCH64="https://yasa.oss-cn-beijing.aliyuncs.com/darwin-aarch64.zip"
TOOLS_URL_DARWIN_X64="https://yasa.oss-cn-beijing.aliyuncs.com/darwin-x86-64.zip"
TOOLS_URL_LINUX_X64="https://yasa.oss-cn-beijing.aliyuncs.com/linux-x86-64.zip"

# ============================================================================
# 可配置参数（默认值 + 命令行解析）
# ============================================================================

YASAMCP_HOME="${YASAMCP_HOME:-$HOME/.yasamcp}"   # 安装根目录，默认 ~/.yasamcp，可用 --home 覆盖
TOOLS_ARCHIVE=""                                     # 本地 native 工具压缩包(--tools)
YASAMCP_ARCHIVE=""                                   # 本地 yasamcp 二进制压缩包(--yasamcp)
SKIP_PATH=0                                       # 1=不改 shell rc(--skip-path)

# 解析命令行参数。
parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --tools)    TOOLS_ARCHIVE="$2"; shift 2 ;;
      --yasamcp)  YASAMCP_ARCHIVE="$2"; shift 2 ;;
      --home)         YASAMCP_HOME="$2"; shift 2 ;;
      --skip-path)    SKIP_PATH=1; shift ;;
      -h|--help)      sed -n '2,30p' "$0"; exit 0 ;;
      *) die "未知参数: $1 (运行 ./install.sh --help 查看用法)" ;;
    esac
  done
}

# ============================================================================
# 平台检测（与 yasamcp 内部 detect_platform() 及 OSS zip 名一致）
# ============================================================================
detect_platform() {
  local os arch
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os/$arch" in
    Darwin/arm64|Darwin/aarch64) echo "darwin-aarch64" ;;
    Darwin/x86_64)               echo "darwin-x86-64" ;;
    Linux/x86_64)                echo "linux-x86-64" ;;
    *) die "不支持的系统/架构: $os/$arch（仅支持 mac-arm64 / mac-x64 / linux-x64）" ;;
  esac
}

# 平台 → native 工具 OSS 链接
tools_url_for() {
  case "$1" in
    darwin-aarch64) echo "$TOOLS_URL_DARWIN_AARCH64" ;;
    darwin-x86-64)  echo "$TOOLS_URL_DARWIN_X64" ;;
    linux-x86-64)   echo "$TOOLS_URL_LINUX_X64" ;;
  esac
}

# resolve_latest_yasamcp_version <repo>:解析 yasamcp 最新 release tag。
# 参考 codegraph:优先用 releases/latest 的网页重定向(不受未鉴权 API 60次/小时限流影响,
# 失败再回退 API)。但本仓库 yasa / yasamcp 共用同一个 releases 列表,releases/latest
# 可能指向 yasa 的 tag(v0.3.x),因此对重定向结果做一次 tag 前缀校验:非 yasamcp-v* 则
# 回退到 API 列出最近 100 个 release,取首个 yasamcp-v* tag。
resolve_latest_yasamcp_version() {
  local repo="$1" version=""
  version="$(curl -fsSLI --connect-timeout 30 --max-time 60 -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest" 2>/dev/null \
    | sed -n 's#.*/releases/tag/##p' | head -n1)"
  case "$version" in
    yasamcp-v*) echo "$version"; return 0 ;;
  esac
  # 回退:API 列出最近 100 个 release,取首个 yasamcp-v* tag。
  version="$(curl -fsSL --connect-timeout 30 --max-time 60 "https://api.github.com/repos/$repo/releases?per_page=100" 2>/dev/null \
    | sed -n 's/.*"tag_name": *"\(yasamcp-v[^"]*\)".*/\1/p' | head -n1)"
  [ -n "$version" ] || die "无法解析 $repo 的最新 yasamcp 版本;请稍后重试,或用 --yasamcp 指定本地包"
  echo "$version"
}

# YASAMCP_RESOLVED_VERSION:本次实际下载的版本 tag(latest 已解析为具体 tag;固定版本则原样)。
# 由 resolve_yasamcp_tag 直接(非子 shell)设置,供下载链接与日志使用。
YASAMCP_RESOLVED_VERSION=""
# resolve_yasamcp_tag:把 YASAMCP_VERSION(latest 默认,或具体 tag)解析为具体 tag,写入上面的全局变量。
resolve_yasamcp_tag() {
  local repo="$YASAMCP_REPO"
  [ -n "$repo" ] || die "未配置 yasamcp 发布仓库:请设环境变量 YASAMCP_REPO=<owner/repo>(或在脚本顶部填入),或用 --yasamcp 指定本地包"
  if [ "$YASAMCP_VERSION" = "latest" ]; then
    YASAMCP_RESOLVED_VERSION="$(resolve_latest_yasamcp_version "$repo")"
    info "解析到 yasamcp 最新版本: $YASAMCP_RESOLVED_VERSION"
  else
    YASAMCP_RESOLVED_VERSION="$YASAMCP_VERSION"
    info "使用指定的 yasamcp 版本: $YASAMCP_RESOLVED_VERSION"
  fi
}

# ============================================================================
# 基础工具函数
# ============================================================================
# 检查命令是否存在
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "缺少必要命令: $1"; }

# extract_archive <归档文件> <目标目录>：按扩展名自动选解压器(.zip / .tar.gz / .tgz)
extract_archive() {
  local archive="$1" dest="$2"
  mkdir -p "$dest"
  case "$archive" in
    *.zip)           unzip -q -o "$archive" -d "$dest" ;;
    *.tar.gz|*.tgz)  tar -xzf "$archive" -C "$dest" ;;
    *) die "不支持的压缩格式: $archive (仅支持 .zip / .tar.gz)" ;;
  esac
}

# download_to <url> <输出文件>：优先 curl，回退 wget
download_to() {
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --connect-timeout 30 -o "$out" "$url" || die "下载失败: $url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --tries=3 --timeout=30 -O "$out" "$url" || die "下载失败: $url"
  else
    die "需要 curl 或 wget 来下载文件"
  fi
}

# ============================================================================
# 安装步骤
# ============================================================================

# extract_tools <zip路径>：解压 native 工具到 <安装目录>/tools/<平台>/
# 兼容两种 zip 结构：
#   A) 顶层是平台目录：darwin-aarch64/yasa/...  → 取 zip/<平台> 作为安装内容
#   B) 顶层直接是工具：yasa/...                 → 取 zip 根作为安装内容
# 统一安放到 tools/<平台>/，保证与 yasamcp 的 BinaryLayout(<根>/tools/<平台>) 对齐。
extract_tools() {
  local zip_path="$1"
  local dest="$TOOLS_PLATFORM_DIR"          # <安装目录>/tools/<平台>
  local stage="$STAGE/tools"
  mkdir -p "$stage"
  info "解压 native 工具包: $zip_path"
  unzip -q -o "$zip_path" -d "$stage"

  # 找到「包含 yasa 子目录」的那个目录，作为本次安装内容来源
  local root=""
  if   [ -d "$stage/$PLATFORM/yasa" ]; then root="$stage/$PLATFORM"
  elif [ -d "$stage/yasa" ];          then root="$stage"
  else
    root="$(find "$stage" -maxdepth 2 -type d -name yasa -print -quit 2>/dev/null | head -1)"
    [ -n "$root" ] && root="$(dirname "$root")"
  fi
  [ -n "$root" ] && [ -d "$root/yasa" ] || die "工具压缩包内容不符合预期: 找不到包含 yasa/ 的目录"

  mkdir -p "$TOOLS_ROOT"
  rm -rf "$dest"
  mv "$root" "$dest"
  info "native 工具已安装: $dest"
}

# install_yasamcp：下载/解压 yasamcp 二进制，直接安放到 <安装目录>/yasamcp-cli/。
# 兼容单文件(onefile)与目录式(onedir)两种分发：找到名为 yasamcp 的可执行文件，
# 把它所在目录整体放到 yasamcp-cli/。把这个目录直接放 PATH 即可运行 yasamcp 命令。
install_yasamcp() {
  # ⚠️ 仅下载 yasamcp 二进制制品(yasamcp-*),不可误拉 yasa-* 原生工具包;
  #   下载文件名取自资源 URL basename 以保留真实扩展名(.zip/.tar.gz)。
  local src_archive=""
  if [ -n "$YASAMCP_ARCHIVE" ]; then
    [ -f "$YASAMCP_ARCHIVE" ] || die "--yasamcp 指定的文件不存在: $YASAMCP_ARCHIVE"
    src_archive="$YASAMCP_ARCHIVE"
    YASAMCP_RESOLVED_VERSION="(local-archive)"
  else
    # 解析最新版本(直接调用,非子 shell),下载对应平台制品。
    resolve_yasamcp_tag
    local asset="${YASAMCP_ASSET:-yasamcp-$PLATFORM.tar.gz}"
    local url="https://github.com/$YASAMCP_REPO/releases/download/$YASAMCP_RESOLVED_VERSION/$asset"
    src_archive="$STAGE/$(basename "$url")"   # 保留真实扩展名(.tar.gz)
    info "下载 yasamcp 二进制($YASAMCP_RESOLVED_VERSION): $url"
    download_to "$url" "$src_archive"
  fi

  local stage="$STAGE/yasamcp"
  extract_archive "$src_archive" "$stage"

  # 找到名为 yasamcp 的可执行文件，取它所在目录作为 onedir root
  local exe; exe="$(find "$stage" -maxdepth 3 -type f -name 'yasamcp' | head -1)"
  [ -n "$exe" ] || die "压缩包里找不到 yasamcp 可执行文件"
  local onedir_root; onedir_root="$(dirname "$exe")"

  # 安放二进制（整体移动，保留旁边的依赖目录），目录名用 yasamcp-cli 更清晰
  rm -rf "$BINARY_DIR"
  mv "$onedir_root" "$BINARY_DIR"
  chmod +x "$BINARY_DIR/yasamcp"
  info "yasamcp 二进制已安装: $BINARY_DIR/yasamcp"
}

# write_config：写入 <安装目录>/config.json
# yasamcp 的 BinaryManager 读这个文件，按 <根>/tools 再拼 <平台>/{yasa,...}，
# 因此 binary_path 只写到「tools 根目录（不含平台）」即可。
write_config() {
  cat > "$YASAMCP_HOME/config.json" <<JSON
{"binary_path": "$TOOLS_ROOT"}
JSON
  info "已写入配置: $YASAMCP_HOME/config.json (binary_path=$TOOLS_ROOT)"
}

# tools_installed: 四类 native 工具目录是否都已存在(用于判断是否跳过下载)
tools_installed() {
  [ -n "$TOOLS_PLATFORM_DIR" ] && [ -d "$TOOLS_PLATFORM_DIR" ] || return 1
  local t
  for t in yasa codegraph ripgrep scc; do
    [ -d "$TOOLS_PLATFORM_DIR/$t" ] || return 1
  done
  return 0
}

# yasamcp_installed: yasamcp 可执行文件是否已存在(用于判断是否跳过下载)
yasamcp_installed() { [ -n "$BINARY_DIR" ] && [ -x "$BINARY_DIR/yasamcp" ]; }

# validate：自检四类工具齐全、二进制可执行。
validate() {
  local tool
  for tool in yasa codegraph ripgrep scc; do
    [ -d "$TOOLS_PLATFORM_DIR/$tool" ] || die "校验失败: 缺少目录 $TOOLS_PLATFORM_DIR/$tool"
  done
  [ -x "$BINARY_DIR/yasamcp" ] || die "校验失败: yasamcp 可执行文件不存在: $BINARY_DIR/yasamcp"
  success "安装自检通过"
}

# run_version_check：确认 yasamcp --version 能跑通，再继续设置环境变量。
# 顺手把 YASA_MCP_BIN_DIR 导出到本进程，保证 --version 触发加载时也能找到 native 工具。
run_version_check() {
  export YASA_MCP_BIN_DIR="$TOOLS_ROOT"
  local out
  if out="$("$BINARY_DIR/yasamcp" --version 2>&1)"; then
    success "yasamcp --version 可运行"
    info "$out"
  else
    warn "$out"
    die "yasamcp --version 执行失败，请检查二进制完整性"
  fi
}

# add_to_path：写入 shell rc。幂等（标记已存在则跳过）。
# 写入两项：把 yasamcp-cli 加入 PATH 让 yasamcp 命令可用，
# 以及导出 YASA_MCP_BIN_DIR 让 init 不传 -b 也能找到 native 工具。
add_to_path() {
  [ "$SKIP_PATH" = "1" ] && { info "跳过 PATH/环境变量修改(--skip-path)"; return; }

  local marker="# yasamcp installer"
  local rc=""
  case "${SHELL:-}" in
    *zsh)  rc="$HOME/.zshrc"  ;;
    *bash) rc="$HOME/.bashrc" ;;
    *)     rc="$HOME/.zshrc"  ;;
  esac
  touch "$rc"

  if grep -q "$marker" "$rc" 2>/dev/null; then
    info "环境变量配置已存在($rc)，跳过"
  else
    {
      echo ""
      echo "$marker"
      echo "export YASA_MCP_BIN_DIR=\"$TOOLS_ROOT\""
      echo "export PATH=\"\$PATH:$BINARY_DIR\""
    } >> "$rc"
    info "已写入 $rc:"
    info "  export YASA_MCP_BIN_DIR=$TOOLS_ROOT"
    info "  export PATH=\$PATH:$BINARY_DIR"
    warn "请执行 source $rc 或重开终端使其生效"
  fi
}

# ============================================================================
# 主流程
# ============================================================================
main() {
  parse_args "$@"

  # 前置检查：解压需要 unzip，下载需要 curl 或 wget 之一
  require_cmd unzip
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 \
    || die "需要 curl 或 wget 来下载文件"

  # 检测平台，后续所有路径围绕它
  PLATFORM="$(detect_platform)"
  info "检测到平台: $PLATFORM"
  info "安装目录: $YASAMCP_HOME"

  # 临时工作目录，脚本退出自动清理
  STAGE="$(mktemp -d)"
  trap 'rm -rf "$STAGE"' EXIT

  # 派生关键绝对路径（YASAMCP_HOME 可能含 ~，统一归一化为绝对路径）
  mkdir -p "$YASAMCP_HOME"
  local home_abs; home_abs="$(cd "$YASAMCP_HOME" && pwd)"
  TOOLS_ROOT="$home_abs/tools"            # native 工具根（不含平台）
  BINARY_DIR="$home_abs/yasamcp-cli"      # yasamcp 二进制目录（在它上面就是 PATH）
  TOOLS_PLATFORM_DIR="$TOOLS_ROOT/$PLATFORM"
  mkdir -p "$TOOLS_ROOT"

  # ── 步骤 1：native 工具(已安装且未指定本地包 -> 跳过下载) ──────────────
  if tools_installed && [ -z "$TOOLS_ARCHIVE" ]; then
    info "native 工具已安装,跳过下载: $TOOLS_PLATFORM_DIR"
  else
    local tools_archive="$TOOLS_ARCHIVE"
    if [ -z "$tools_archive" ]; then
      local turl; turl="$(tools_url_for "$PLATFORM")"
      tools_archive="$STAGE/tools.zip"
      info "下载 native 工具: $turl"
      download_to "$turl" "$tools_archive"
    else
      [ -f "$tools_archive" ] || die "--tools 指定的文件不存在: $tools_archive"
    fi
    extract_tools "$tools_archive"
  fi

  # ── 步骤 2：yasamcp 二进制(已安装且未指定本地包 -> 跳过下载) ───────────
  if yasamcp_installed && [ -z "$YASAMCP_ARCHIVE" ]; then
    info "yasamcp 二进制已安装,跳过下载: $BINARY_DIR/yasamcp"
  else
    install_yasamcp
  fi

  # ── 步骤 3：写 config.json ───────────────────────────────────────────
  write_config

  # ── 步骤 4：自检 ─────────────────────────────────────────────────────
  validate

  # ── 步骤 5：确认 --version 可运行，再设置环境变量 ────────────────────
  run_version_check

  # ── 步骤 6：设置 PATH 与 YASA_MCP_BIN_DIR ────────────────────────────
  add_to_path

  # ── 完成 ────────────────────────────────────────────────────────────
  success "yasamcp 安装完成！"
  echo "  - native 工具: $TOOLS_PLATFORM_DIR/{yasa,codegraph,ripgrep,scc}"
  echo "  - 二进制:      $BINARY_DIR/yasamcp  (命令: yasamcp)"
  echo "  - 配置:        $YASAMCP_HOME/config.json"
  echo "  - 环境变量:    YASA_MCP_BIN_DIR=$TOOLS_ROOT  (PATH+=$BINARY_DIR)"
  echo "  现在可运行: yasamcp init <你的项目目录>"
}

main "$@"
