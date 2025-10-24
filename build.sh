#!/bin/bash

# 检测操作系统和架构
detect_platform() {
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  ARCH=$(uname -m)
  
  case "$OS" in
    linux)
      case "$ARCH" in
        x86_64) echo "linux-amd64" ;;
        *) echo "unsupported" ;;
      esac
      ;;
    darwin)
      case "$ARCH" in
        x86_64) echo "mac-amd64" ;;
        arm64) echo "mac-arm64" ;;
        *) echo "unsupported" ;;
      esac
      ;;
    *)
      echo "unsupported"
      ;;
  esac
}

# 检查当前目录是否为 YASA-Engine
check_directory() {
  if [ ! -f "package.json" ] || [ ! -d "deps" ]; then
    echo "[ERROR] This script must be run from the root directory of the YASA-Engine repository."
    echo "Please navigate to the YASA-Engine directory and try again."
    exit 1
  fi
}

# 下载二进制文件
download_binaries() {
  PLATFORM=$1
  RELEASE_URL="https://api.github.com/repos/antgroup/YASA-UAST/releases/latest"
  
  echo "[INFO] Fetching latest release info from GitHub..."
  TAG=$(curl -s $RELEASE_URL | grep "tag_name" | cut -d '"' -f 4)
  
  if [ -z "$TAG" ]; then
    echo "[ERROR] Failed to fetch release info. Please check your network."
    exit 1
  fi

  echo "[INFO] Latest version: $TAG"

  # 创建目标目录
  mkdir -p deps/uast4go deps/uast4py

  # 下载对应的二进制文件并放置到指定路径
  BINARIES=("uast4go-$PLATFORM" "uast4py-$PLATFORM")
  TARGET_PATHS=("deps/uast4go/uast4go" "deps/uast4py/uast4py")

  for i in "${!BINARIES[@]}"; do
    BINARY=${BINARIES[$i]}
    TARGET=${TARGET_PATHS[$i]}
    DOWNLOAD_URL="https://github.com/antgroup/YASA-UAST/releases/download/${TAG}/${BINARY}"
    echo "[INFO] Downloading $BINARY to $TARGET..."
    curl -L -o $TARGET $DOWNLOAD_URL
    chmod +x $TARGET
  done
}

# 主构建流程
main() {
  echo "[INFO] Starting YASA-Engine build process..."

  # 检查是否在正确的目录下
  check_directory

  # 检测平台
  PLATFORM=$(detect_platform)
  if [ "$PLATFORM" = "unsupported" ]; then
    echo "[ERROR] Unsupported platform: $(uname -s)-$(uname -m)"
    exit 1
  fi
  echo "[INFO] Detected platform: $PLATFORM"

  # 安装依赖
  echo "[INFO] Installing dependencies..."
  npm install || { echo "[ERROR] npm install failed"; exit 1; }

  # 下载二进制文件
  echo "[INFO] Downloading required binaries..."
  download_binaries "$PLATFORM"

  echo "[INFO] Build completed successfully."
}

main "$@"