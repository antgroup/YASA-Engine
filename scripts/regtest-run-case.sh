#!/usr/bin/env bash
# 回归用例标准执行脚本（源码形式 tsx + src/main.ts），参数从用例 .config 读取，不自行改参数。
# 用法: ENGINE_DIR=<engine path> scripts/regtest-run-case.sh <case-name> <report-dir> [testcase-root]
#   ENGINE_DIR 默认为本脚本所在仓库根（ours）。
# 严格串行：同一 engine 目录禁止并行；调用方负责不并行起任务。
set -uo pipefail

CASE="${1:?case name required}"
REPORT="${2:?report dir required}"
ROOT="${3:-/Users/ariel/code/yasa-reformat/test/yasa2-bench/testcase/python}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE_DIR="${ENGINE_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
cd "$ENGINE_DIR"

CASE_DIR="$ROOT/$CASE"
# mpc_server 目录内部 case 名是 mcp_server，特例处理
if [[ "$CASE" == "mpc_server" ]]; then
  CFG_NAME="mcp_server"
  SOURCE_PATH="$CASE_DIR/mcp_server"
else
  CFG_NAME="$CASE"
  SOURCE_PATH="$CASE_DIR/$CASE"
fi

CONFIG_FILE="$CASE_DIR/$CFG_NAME.config"
[[ -f "$CONFIG_FILE" ]] || { echo "missing $CONFIG_FILE" >&2; exit 2; }

CHECKER_PACKS=$(python -c "import json;d=json.load(open('$CONFIG_FILE'));print(','.join(d['checkerPackIds']))")
ANALYZER=$(python -c "import json;d=json.load(open('$CONFIG_FILE'));print(d.get('analyzer',''))")
LANGUAGE=$(python -c "import json;d=json.load(open('$CONFIG_FILE'));print(d.get('language',''))")
RULE_CONFIG_REL=$(python -c "import json;d=json.load(open('$CONFIG_FILE'));print(d.get('ruleConfigFile',''))")
RULE_CONFIG="$CASE_DIR/${RULE_CONFIG_REL#./}"

NODE_OPTS=$(python -c "import json;d=json.load(open('$CONFIG_FILE'));print(d.get('nodeOptions',''))")
[[ -n "$NODE_OPTS" ]] && export NODE_OPTIONS="$NODE_OPTS"

[[ -d "$SOURCE_PATH" ]] || { echo "missing sourcePath $SOURCE_PATH" >&2; exit 2; }

rm -rf "$REPORT"; mkdir -p "$REPORT"

ARGS=(--sourcePath "$SOURCE_PATH" --checkerPackIds "$CHECKER_PACKS" --language "$LANGUAGE" --ruleConfigFile "$RULE_CONFIG" --report "$REPORT")
[[ -n "$ANALYZER" ]] && ARGS+=(--analyzer "$ANALYZER")

# 留痕：完整命令写进 report/cmd.log
{
  echo "# ENGINE_DIR=$ENGINE_DIR"
  echo "# HEAD=$(git rev-parse --short HEAD 2>/dev/null)"
  echo "# NODE_OPTIONS=${NODE_OPTIONS:-}"
  echo "node ./node_modules/tsx/dist/cli.mjs ./src/main.ts \\"
  for a in "${ARGS[@]}"; do echo "  $a \\"; done
  echo
} > "$REPORT/cmd.log"

echo "[regtest] ENGINE=$ENGINE_DIR CASE=$CASE REPORT=$REPORT"
/usr/bin/time -l node ./node_modules/tsx/dist/cli.mjs ./src/main.ts "${ARGS[@]}" 1>/dev/null 2>"$REPORT/time.log"
echo "[regtest] exit=$?"