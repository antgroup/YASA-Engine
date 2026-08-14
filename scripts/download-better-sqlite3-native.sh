#!/bin/bash

set -euo pipefail

readonly VERSION="11.10.0"
readonly ABI="108"
readonly OUTPUT_DIR="${1:-native/better-sqlite3}"
readonly LINUX_GLIBC_MAJOR="2"
readonly LINUX_GLIBC_MINOR="17"

fail() {
  printf '错误: %s\n' "$1" >&2
  exit 1
}

verify_sha256() {
  local file="$1"
  local expected="$2"
  local actual

  actual="$(shasum -a 256 "$file" | cut -d ' ' -f 1)"
  [ "$actual" = "$expected" ] || fail "${file} 的 SHA256 校验失败"
}

verify_linux_compatibility() {
  local file="$1"
  local incompatible_versions

  if ! LC_ALL=C strings "$file" | grep -F "node_register_module_v${ABI}" > /dev/null; then
    fail "${file} 不是 Node ABI ${ABI} 的 native addon"
  fi

  incompatible_versions="$({ LC_ALL=C strings "$file" | sed -n 's/.*GLIBC_\([0-9][0-9.]*\).*/\1/p'; } | awk -F. \
    -v max_major="$LINUX_GLIBC_MAJOR" -v max_minor="$LINUX_GLIBC_MINOR" \
    '$1 > max_major || ($1 == max_major && $2 > max_minor)' | sort -u)"
  [ -z "$incompatible_versions" ] || \
    fail "${file} 依赖高于 GLIBC_${LINUX_GLIBC_MAJOR}.${LINUX_GLIBC_MINOR} 的符号: ${incompatible_versions}"
}

prepare_linux_platform() {
  local binary_sha256="$1"
  local destination="${OUTPUT_DIR}/linux-x64/better_sqlite3.node"

  [ -f "$destination" ] || \
    fail "缺少兼容 GLIBC_${LINUX_GLIBC_MAJOR}.${LINUX_GLIBC_MINOR} 的已提交制品 ${destination}"

  # 以下为安全注释COSEC：固定哈希并校验 ABI/glibc 基线，防止错误或篡改的 native addon 进入发布包。
  verify_sha256 "$destination" "$binary_sha256"
  verify_linux_compatibility "$destination"
  printf '复用已提交兼容制品 %s\n' "$destination"
}

download_platform() {
  local platform="$1"
  local archive_sha256="$2"
  local binary_sha256="$3"
  local archive
  local url
  local destination
  local temp_dir

  archive="better-sqlite3-v${VERSION}-node-v${ABI}-${platform}.tar.gz"
  url="https://github.com/WiseLibs/better-sqlite3/releases/download/v${VERSION}/${archive}"
  destination="${OUTPUT_DIR}/${platform}/better_sqlite3.node"
  temp_dir="$(mktemp -d)"

  mkdir -p "$(dirname "$destination")"
  if [ -f "$destination" ]; then
    verify_sha256 "$destination" "$binary_sha256"
    printf '复用已提交制品 %s\n' "$destination"
    return
  fi

  curl --fail --location --retry 3 --connect-timeout 20 --output "${temp_dir}/${archive}" "$url"
  verify_sha256 "${temp_dir}/${archive}" "$archive_sha256"
  tar -xzf "${temp_dir}/${archive}" -C "$temp_dir"
  [ -f "${temp_dir}/build/Release/better_sqlite3.node" ] || fail "${archive} 缺少 native addon"
  install -m 755 "${temp_dir}/build/Release/better_sqlite3.node" "$destination"
  verify_sha256 "$destination" "$binary_sha256"
  rm -rf "$temp_dir"
  printf '已准备 %s\n' "$destination"
}

prepare_linux_platform "aa44403445f4ff23a128d9df993e178fb673f8dcb4f4efd58e623fedf4b26aff"
download_platform "darwin-x64" "4972e047d44fbda3839014815aee104cb6efb30b399dcca2b7d32abb1af4eafa" "0be28f9a03b5a1ded9279904cec90a3fb216a7a79e6d81bd4d8224fbecc3c46e"
download_platform "darwin-arm64" "31bf763ca042a7c0fa9d77715a85200d836ef511c9c8494651a59b21a18e671e" "c514fcc0a69ee99df610d8ba5b6632dabe21d6ceb5432dff83d6ed319b6453af"
