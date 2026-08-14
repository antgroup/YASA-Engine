#!/bin/bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")" && pwd)
LOGGER_FILE="$ROOT_DIR/src/util/logger.ts"
PACKAGE_FILE="$ROOT_DIR/package.json"
STARTER_FILE="$ROOT_DIR/src/interface/starter.ts"
SNAPSHOT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/engine-client-build.XXXXXX")
LOGGER_SNAPSHOT="$SNAPSHOT_DIR/logger.ts"
PACKAGE_SNAPSHOT="$SNAPSHOT_DIR/package.json"
STARTER_SNAPSHOT="$SNAPSHOT_DIR/starter.ts"

cp "$LOGGER_FILE" "$LOGGER_SNAPSHOT"
cp "$PACKAGE_FILE" "$PACKAGE_SNAPSHOT"
cp "$STARTER_FILE" "$STARTER_SNAPSHOT"

restore_snapshots() {
  local exit_code=$?
  set +e
  cp "$LOGGER_SNAPSHOT" "$LOGGER_FILE"
  cp "$PACKAGE_SNAPSHOT" "$PACKAGE_FILE"
  cp "$STARTER_SNAPSHOT" "$STARTER_FILE"
  rm -rf "$SNAPSHOT_DIR"
  exit "$exit_code"
}

trap restore_snapshots EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

python3 - "$LOGGER_FILE" "$PACKAGE_FILE" "$STARTER_FILE" <<'PY'
import re
import sys
from pathlib import Path

logger_path = Path(sys.argv[1])
package_path = Path(sys.argv[2])
starter_path = Path(sys.argv[3])

logger = logger_path.read_text()
logger_pattern = re.compile(r"(default:\s*\{\s*appenders:\s*)\[[^\]]*\](\s*,\s*level:)")
logger_matches = list(logger_pattern.finditer(logger))
if len(logger_matches) != 1:
    raise SystemExit(f"logger default appenders match count is {len(logger_matches)}, expected 1")
logger = logger_pattern.sub(r"\1['infoFilter', 'errFilter']\2", logger, count=1)
if "default: { appenders: ['infoFilter', 'errFilter']," not in logger:
    raise SystemExit("logger default appenders replacement was not verifiable")
logger_path.write_text(logger)

package = package_path.read_text()
for field in ("main", "bin"):
    pattern = re.compile(rf'(^\s*"{field}"\s*:\s*)"[^"]*"(\s*,?\s*$)', re.MULTILINE)
    matches = list(pattern.finditer(package))
    if len(matches) != 1:
        raise SystemExit(f'package {field} match count is {len(matches)}, expected 1')
    package = pattern.sub(rf'\1"./dist/client.js"\2', package, count=1)
    if not re.search(rf'^\s*"{field}"\s*:\s*"\./dist/client\.js"', package, re.MULTILINE):
        raise SystemExit(f"package {field} replacement was not verifiable")
package_path.write_text(package)

starter = starter_path.read_text()
starter_target = "/snapshot/yasa/dist/main.js"
starter_replacement = "/snapshot/yasa/dist/client.js"
starter_matches = starter.count(starter_target)
if starter_matches != 1:
    raise SystemExit(f"starter main.js match count is {starter_matches}, expected 1")
starter = starter.replace(starter_target, starter_replacement, 1)
if starter.count(starter_replacement) != 1 or starter_target in starter:
    raise SystemExit("starter main.js replacement was not verifiable")
starter_path.write_text(starter)
PY

cd "$ROOT_DIR"
bash ./build.sh
