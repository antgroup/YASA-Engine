---
name: yasa-mcp-opensrc-regression
description: 从零端到端跑通 yasamcp 对外开源版回归——准备 xast benchmark 靶场、生成分析缓存、CLI 与 MCP 两通道全量回归 100% 验证
allowed-tools: Bash, Read, Glob, Grep
---

# yasamcp 开源回归测试 Skill

当需要验证 yasamcp 对外开源版本回归是否 100% 通过时使用此 skill：准备 xast benchmark 数据集 → 生成分析缓存 → CLI 与 MCP 两通道全量回归。

## 适用范围

仅对外开源回归。用例来自仓库内已提交的 `tests/integration/test_cases`（基于 ant-application-security-testing-benchmark 的 5 个 sast 模块：sast-java/sast-go/sast-js/sast-php/sast-python3）。靶场数据集 `tests/dataset` 已被 `.gitignore`，不进 git；首次运行由 `prepare_dataset.py` 自动 clone xast 仓库并 cp 到 `dataset/{lang}/{module}`。

## 环境变量

| 变量 | 含义 | 默认 |
|---|---|---|
| `YASAMCP_BINARY` | yasamcp 二进制路径 | `dist/yasamcp/yasamcp` |
| `YASA_BIN_DIR` | native 工具"根目录"，其下 `<platform>/<tool>`（codegraph/yasa/ripgrep/scc） | `~/.yasamcp` |
| `YASA_CASE_ROOTS` | 用例根（开源版仅 `xast` 一根） | `xast` |
| `YASA_AUTO_FETCH` | xast 自动拉取开关；离线/CI 设 `0` 关闭，缺失用例按 skip | `1`（开） |

Python 用装好 pytest 的 venv 的解释器执行。本机示例：

```bash
PY=python3                            # 或 venv 内装好 pytest 的解释器
BIN=~/yasa_mcp_bin                     # native 工具根目录
YASAMCP=dist/yasamcp/yasamcp
```

## 缓存布局判定

每个项目缓存就绪的标志（缺失就报"请执行 init"）：

```text
<project>/.yasa/yasamcp/.codegraph/codegraph.db   存在且非空
<project>/.yasa/yasamcp/yasa.db                   存在且非空
```

手动补缓存（通常不需要：CLI harness 首次遇到某项目会自动 init）：

```bash
$YASAMCP init <project_path> -b $BIN
```

## 一、从零全链路（首次冒烟，推荐）

完整复现：删 dataset → clone xast 并 cp → CLI 自动 init + 跑全部用例 → MCP 跑全部用例。

```bash
# 0) 清空靶场（tests/dataset 已在 .gitignore 内，安全）
$PY - <<'PY'
import shutil, pathlib
d = pathlib.Path("tests/dataset")
if d.exists(): shutil.rmtree(d, ignore_errors=True)
print("dataset 已清空")
PY

# 1) 准备 xast 靶场：clone xast + cp 5 个 sast 模块到 dataset/{lang}/
$PY tests/integration/yasamcp_client_integration/prepare_dataset.py
# 期望末行：完成：dataset 就绪。
# clone 走 SSH，失败自动回退 https；两者都失败会提示把公钥加入 GitHub 账号(ssh -T git@github.com 验证)后重试。

# 2) CLI 通道：首次运行会对每个项目自动 init 生成缓存，再跑全部用例
YASA_CASE_ROOTS=xast YASAMCP_BINARY=$YASAMCP YASA_BIN_DIR=$BIN \
  $PY -m pytest tests/integration/yasamcp_client_integration/test_cli_tools.py -q -p no:cacheprovider
# 期望：256 passed（首次含 5 个 app 冷 init + 用例，约 2~3 分钟；缓存已就绪后约 2 分钟内）

# 3) MCP 通道：复用上一步生成的缓存，启动 server 跑全部用例
YASA_CASE_ROOTS=xast YASAMCP_BINARY=$YASAMCP YASA_BIN_DIR=$BIN \
  $PY tests/integration/yasamcp_client_integration/test_mcp_server.py
# 期望：测试完成: 251 passed, 0 failed, 0 skipped（数秒；冷 fastload 19~36ms，热请求均值约 22ms）
```

成功标准：CLI 全 passed、MCP `0 failed 0 skipped`，两通道用例覆盖一致（CLI 多出的 5 条为各 app 的 `init_project` setup 用例，MCP 不跑 init）。

## 二、增量回归（dataset 与缓存都已就绪）

```bash
# CLI
YASA_CASE_ROOTS=xast YASAMCP_BINARY=$YASAMCP YASA_BIN_DIR=$BIN \
  $PY -m pytest tests/integration/yasamcp_client_integration/test_cli_tools.py -q -p no:cacheprovider

# MCP
YASA_CASE_ROOTS=xast YASAMCP_BINARY=$YASAMCP YASA_BIN_DIR=$BIN \
  $PY tests/integration/yasamcp_client_integration/test_mcp_server.py
```

只跑某接口/某语言时给 CLI 传 pytest `-k`：

```bash
... $PY -m pytest tests/integration/yasamcp_client_integration/test_cli_tools.py -k 'get_class_by_name' -q
... $PY -m pytest tests/integration/yasamcp_client_integration/test_cli_tools.py -k 'java' -q
```

## 三、生成 / 更新 expected 基线

expected 为空或与实际不一致时，用 `UPDATE_SNAPSHOTS=1` 重新落盘（务必先 `git diff` 复核再提交）：

```bash
YASA_CASE_ROOTS=xast YASAMCP_BINARY=$YASAMCP YASA_BIN_DIR=$BIN UPDATE_SNAPSHOTS=1 \
  $PY -m pytest tests/integration/yasamcp_client_integration/test_cli_tools.py -q -p no:cacheprovider
```

新 case 落盘规则见 `build-regression-cases` skill。expected 一律要求非空；空结果需换更通用的真实符号重写，禁止放宽非空规则、禁止给 case 加 skip。

## 四、用例与目录约定

```text
tests/integration/test_cases/<lang>/<module>/<tool>/<case>_input.json
tests/integration/test_cases/<lang>/<module>/<tool>/<case>.expected.json
tests/dataset/<lang>/<module>/                 # 靶场源码（gitignore，prepare_dataset 生成）
tests/dataset/xast/ant-application-security-testing-benchmark-main   # xast clone 缓存（gitignore）
```

- 每个查询工具 ≥5 条；6 个多入参工具各含 ≥1 条多值用例。
- expected 一律非空；不在用例目录里写任何内部/绝对路径，全用 dataset/{lang}/{module} 解析。

## 五、常见失败排查

| 现象 | 原因 / 处理 |
|---|---|
| CLI exit≠0 / "无法解析 JSON" | 多半缓存未生成：确保先让 CLI 跑过（会自动 init），或手动 `yasamcp init <project> -b $BIN` |
| MCP 报"请执行 init" | 该项目无缓存：先用 CLI 跑一遍（自动 init）或手动 init 后再跑 MCP（MCP 不做 init） |
| `prepare_dataset.py` clone 失败 | 按报错里的两个 URL 明细处理：SSH publickey denied → 把本机公钥加入 GitHub 账号、`ssh -T git@github.com` 验证后重试；https 也不通 → 检查网络/代理能否访问 github.com |
| 个别 case 实际为空但 expected 非空 | xast module 改动导致符号变化：换真实符号重写 input/expected，不要删 case、不要 skip |
| 启动极慢 / 单次 >1s | 确认跑的是打包二进制（`dist/yasamcp/yasamcp`），非源码 python -m；二进制定位工具/加载缓存应在毫秒级 |

## 性能基线（mac arm64 参考）

- CLI 256 用例：约 140s（含 5 app 冷 init）/ 缓存就绪后约 100s。
- MCP 251 用例：约 7s。
- MCP 热请求均值 ~22ms，<100ms 占 97%；任一工具单次明显 >1s 多半是冷 fastload 或异常，看日志 `~/.yasamcp/logs/<date>.log`。
