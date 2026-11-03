#!/usr/bin/env bash
# Build yasamcp CLI for macOS arm64 (PyInstaller onedir)
# 仅打包 Python 侧；native binary 由运行时 -b/--bin 指定
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$REPO_ROOT/dist"
BUILD_DIR="$REPO_ROOT/build"
TARGET_FILE="$REPO_ROOT/src/yasa_mcp/bin/yasa_client.py"
PYTHON="${PYTHON:-python3}"

echo "==> Building yasamcp for macOS arm64"
echo "    Repo: $REPO_ROOT"
echo "    Python: $PYTHON"

cd "$REPO_ROOT"

# --- 动态注入构建日期和 git commit ---
BUILD_DATE=$(date +%Y%m%d)
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
echo "    Build date: $BUILD_DATE"
echo "    Git commit: $GIT_COMMIT"

# 备份源文件
cp "$TARGET_FILE" "$TARGET_FILE.bak"

# 临时替换引号内的 _BUILD_DATE 和 _GIT_COMMIT 值
"$PYTHON" <<PYEOF
import pathlib, re
p = pathlib.Path("$TARGET_FILE")
s = p.read_text("utf-8")
s = re.sub(r'_BUILD_DATE = "[^"]*"', f'_BUILD_DATE = "$BUILD_DATE"', s)
s = re.sub(r'_GIT_COMMIT = "[^"]*"', f'_GIT_COMMIT = "$GIT_COMMIT"', s)
p.write_text(s, "utf-8")
PYEOF
echo "    Injected build info into $TARGET_FILE"

# 清理旧产物
rm -rf "$DIST_DIR/yasamcp" 2>/dev/null || true

# 运行 PyInstaller
"$PYTHON" -m PyInstaller script/yasa-mcp.spec \
    --distpath "$DIST_DIR" \
    --workpath "$BUILD_DIR" \
    --clean \
    --noconfirm

# 恢复源文件
mv "$TARGET_FILE.bak" "$TARGET_FILE"
echo "    Restored source"

echo ""
echo "==> Build complete!"
echo "    Output: $DIST_DIR/yasamcp/yasamcp"
