"""准备 xast 回归靶场数据集。

xast 仓库 (ant-application-security-testing-benchmark) 提供静态分析 benchmark 模块。
本脚本只做一件事：

1. 检测 tests/dataset/{lang}/{module} 是否已存在；全部存在则直接返回（不拉取）。
2. 任一缺失时：浅克隆 xast 仓库到缓存目录，再把缺失模块 cp 到 dataset/{lang}/。
   幂等：已存在的应用不会被覆盖；已存在的缓存直接复用。

注意：本脚本与 tests/integration/test_cases（已提交、推送远程的用例目录）无关。
选择拷贝哪些模块完全由本文件写死的 XAST_MODULE_LANG 映射决定，不会扫描 test_cases。

可独立运行:
    python tests/integration/yasamcp_client_integration/prepare_dataset.py

也可被 conftest / 集成测试脚本 import 调用 ensure_datasets()。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import warnings
from pathlib import Path

# ── 常量（写死，不走环境变量）─────────────────────────────────────────
XAST_CACHE_DIR_NAME = "ant-application-security-testing-benchmark-main"
XAST_REPO_SSH = "git@github.com:alipay/ant-application-security-testing-benchmark.git"
XAST_REPO_HTTPS = "https://github.com/alipay/ant-application-security-testing-benchmark.git"

# 写死的 xast 模块 -> dataset 语言目录映射（与 test_cases 无关）
XAST_MODULE_LANG: dict[str, str] = {
    "sast-java": "java",
    "sast-go": "golang",
    "sast-js": "javascript",
    "sast-php": "php",
    "sast-python3": "python",
}

# 是否允许自动拉取；离线/CI 可用 YASA_AUTO_FETCH=0 关闭，缺失用例按 skip 处理
AUTO_FETCH = os.environ.get("YASA_AUTO_FETCH", "1").lower() not in ("0", "false", "no", "off")

# 路径：本文件位于 tests/integration/yasamcp_client_integration/
_HERE = Path(__file__).resolve().parent
DATASET_DIR: Path = _HERE.parent.parent / "dataset"
XAST_CACHE_DIR: Path = DATASET_DIR / "xast" / XAST_CACHE_DIR_NAME
CONFIG_CACHE_DIR: Path = DATASET_DIR / "xast" / XAST_CACHE_DIR_NAME


def ensure_xast_cache() -> None:
    """确保 xast 仓库缓存存在；已存在（含 sast-* 模块）则复用，否则浅克隆。

    SSH 地址失败时自动回退 https 地址；两者都失败则抛出可操作错误，
    提示用户配置 GitHub public key / 网络后重试。
    """
    if XAST_CACHE_DIR.exists() and any(XAST_CACHE_DIR.glob("sast-*")):
        return  # 已有解压/克隆数据，直接复用
    XAST_CACHE_DIR.parent.mkdir(parents=True, exist_ok=True)

    # 残留空目录或无 sast-* 的损坏/半成品克隆，清掉再重克隆
    if XAST_CACHE_DIR.exists() and XAST_CACHE_DIR.is_dir():
        shutil.rmtree(XAST_CACHE_DIR, ignore_errors=True)

    # 非交互拉取：SSH 走 BatchMode+连接超时快速失败，HTTPS 禁止凭据提示，避免挂起
    clone_env = {**os.environ, "GIT_SSH_COMMAND": "ssh -o BatchMode=yes -o ConnectTimeout=15", "GIT_TERMINAL_PROMPT": "0"}
    errors: list[str] = []
    for url in (XAST_REPO_SSH, XAST_REPO_HTTPS):
        try:
            print(f"  · git clone --depth 1 {url} -> {XAST_CACHE_DIR}")
            subprocess.run(
                ["git", "clone", "--depth", "1", url, str(XAST_CACHE_DIR)],
                check=True, capture_output=True, text=True, timeout=600, env=clone_env,
            )
            if any(XAST_CACHE_DIR.glob("sast-*")):
                return
            errors.append(f"{url}: 克隆完成但未包含 sast-* 模块（疑似损坏）")
            shutil.rmtree(XAST_CACHE_DIR, ignore_errors=True)
        except subprocess.CalledProcessError as e:
            errors.append(f"{url}: {(e.stderr or '').strip() or str(e)}")
        except Exception as e:
            errors.append(f"{url}: {e}")
    raise RuntimeError(
        "克隆 xast 仓库失败，请检查网络与凭据后重试：\n  - " + "\n  - ".join(errors)
        + "\n提示：若走 SSH 无法访问（Permission denied (publickey)），请把本机 SSH 公钥"
        "加入 GitHub 账号并用 `ssh -T git@github.com` 验证，或确认网络能访问 github.com。"
    )


def ensure_datasets(fetch: bool | None = None) -> None:
    """确保写死的 xast 模块都已 cp 到 dataset/{lang}/；缺失则拉取并拷贝。

    - 全部存在 → 直接返回，不拉取。
    - 任一缺失 → 复用或浅克隆 xast 缓存，再把缺失模块 cp 到 dataset。
    幂等：已存在的应用不会被覆盖。
    """
    missing: list[tuple[str, str]] = []
    for module, lang in XAST_MODULE_LANG.items():
        if not (DATASET_DIR / lang / module).exists():
            missing.append((module, lang))
    if not missing:
        return

    do_fetch = AUTO_FETCH if fetch is None else fetch
    if not do_fetch:
        warnings.warn(
            "YASA_AUTO_FETCH=0，缺失 dataset 应用将不自动拉取，相关用例会被跳过: "
            + ", ".join(f"{lang}/{module}" for module, lang in missing)
        )
        return

    ensure_xast_cache()
    for module, lang in missing:
        src = XAST_CACHE_DIR / module
        dst = DATASET_DIR / lang / module
        if not src.exists():
            warnings.warn(f"xast 缓存中不存在模块 {module}，跳过 {lang}/{module}")
            continue
        if dst.exists():
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src, dst)
        print(f"  · cp xast/{module} -> dataset/{lang}/{module}")


def main() -> None:
    print("准备 xast 回归靶场数据集 ...")
    ensure_datasets()
    ready = all((DATASET_DIR / lang / module).exists() for module, lang in XAST_MODULE_LANG.items())
    print("完成：dataset 就绪。" if ready else "仍有缺失，相关用例将跳过。")


if __name__ == "__main__":
    main()
