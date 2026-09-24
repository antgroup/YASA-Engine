"""binary_path 解析/读取，封装在 BinaryManager 类中。

约定大于配置：binary 默认根目录 ``~/.yasamcp``，平台子目录由
:class:`BinaryLayout` 自动追加。只有 init 进程（及 server -b 覆盖）才进入
``configure`` 做 resolve+validate+persist；普通查询/server 默认进程
只调 ``load_from_persisted`` 读固定路径，绝不进入解析/校验/持久化。

校验的工具集合复用 ``Tool`` 枚举 + ``BinaryLayout`` 字段，增删工具无需改这里。
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from yasa_mcp.config import global_config
from yasa_mcp.core.enums import Tool
from yasa_mcp.core.exceptions import FileNotFoundError
from yasa_mcp.core.runtime import init_runtime
from yasa_mcp.layout.binary_layout import BinaryLayout

logger = logging.getLogger(__name__)


class BinaryManager:
    """进程级 binary_path 解析器。

    重路径（resolve+validate+persist+init_runtime）只在 init / server -b 调用；
    轻路径（读持久化建 runtime）供查询进程启动回调使用。
    """

    # 持久化目录与文件（与日志/默认 binary 共用 ~/.yasamcp）
    PERSIST_ROOT = Path.home() / ".yasamcp"
    PERSIST_FILE = PERSIST_ROOT / "config.json"

    # 默认 binary 根目录（不含平台子目录），与 global_config.binary_path 一致
    DEFAULT_BINARY_ROOT = PERSIST_ROOT

    # init / server -b 覆盖时的优先级环境变量
    ENV_OVERRIDE = "YASA_MCP_BIN_DIR"

    # ── 轻路径（查询进程）─────────────────────────────────────────────

    @classmethod
    def read_persisted_path(cls) -> Path:
        """读取持久化的 binary_path，供查询/普通进程启动时使用。

        无校验、无优先级解析、无写入。读不到回退默认 ``~/.yasamcp``。
        查询进程启动链里没有任何 binary 解析/校验逻辑，只一次 file read。
        """
        try:
            if cls.PERSIST_FILE.exists():
                data = json.loads(cls.PERSIST_FILE.read_text("utf-8"))
                return Path(data["binary_path"])
        except Exception:
            logger.debug("读取持久化 binary_path 失败,回退默认: %s", cls.PERSIST_FILE, exc_info=True)
        return cls.DEFAULT_BINARY_ROOT

    @classmethod
    def load_from_persisted(cls) -> Path:
        """【轻】查询/普通进程启动回调：读持久化 binary_path 并建 runtime 单例。

        不调 validate、不调 resolve 优先级、不写持久化。
        供 ``cli`` group 回调与 ``server`` 默认（无 -b）入口使用。
        """
        resolved = cls.read_persisted_path()
        global_config.binary_path = resolved
        init_runtime(resolved)
        return resolved

    # ── 重路径（init 进程）─────────────────────────────────────────────

    @classmethod
    def configure(cls, override: Path | str | None = None) -> Path:
        """【重】init / server -b 覆盖时调用：resolve → validate → persist → init_runtime。

        只在 init 进程（及 server 显式 -b）调用；普通查询进程启动不进入此方法。
        流程：
          1. 按「-b > YASA_MCP_BIN_DIR > ~/.yasamcp」选一个候选路径；
          2. validate 严格校验 native binary，缺失直接抛 FileNotFoundError；
          3. 校验通过后持久化到 ~/.yasamcp/config.json，供后续查询进程读；
          4. global_config.binary_path = 解析值；init_runtime 建单例（路径变更则重建）。
        """
        resolved = cls.resolve_override(override)
        cls.validate(resolved)
        cls.persist(resolved)
        global_config.binary_path = resolved
        init_runtime(resolved)
        logger.info("configure: resolved=%s, persisted, runtime ready", resolved)
        return resolved

    @classmethod
    def resolve_override(cls, override: Path | str | None) -> Path:
        """解析 override 优先级：显式 -b > 环境变量 > 默认 ~/.yasamcp。

        不读持久化文件：init 总是按「-b > env > 默认」选一个候选路径，
        再交给 ``validate`` 严格校验；校验不过直接报错，不回退别处。
        持久化值只供查询进程（轻路径）读，init 不复用。
        """
        if override:
            return Path(override).expanduser().resolve()
        env_val = os.environ.get(cls.ENV_OVERRIDE)
        if env_val:
            return Path(env_val).expanduser().resolve()
        return cls.DEFAULT_BINARY_ROOT

    @classmethod
    def validate(cls, binary_path: Path) -> None:
        """【重】校验 binary 根目录下 native binary 都存在，缺失抛 FileNotFoundError。

        供 ``configure`` 在持久化前调用，绝不给查询进程使用——查询进程
        默认信任持久化值，不再校验（runtime.get_tool 按需创建工具实例时做
        存在检测并抛 InvalidToolError，已足够）。

        工具集合来自 ``Tool`` 枚举 + ``BinaryLayout`` 字段，增删工具无需改这里。
        """
        layout = cls._layout_or_raise(binary_path)
        missing = cls._missing_from_layout(layout)
        if missing:
            raise FileNotFoundError(
                f"缺少 native binary 工具: {', '.join(missing)}，请检查 binary 目录: {binary_path}"
            )

    @classmethod
    def persist(cls, binary_path: Path) -> None:
        """【重】持久化 binary_path 到 ~/.yasamcp/config.json，供后续查询进程读取。幂等。"""
        cls.PERSIST_ROOT.mkdir(parents=True, exist_ok=True)
        cls.PERSIST_FILE.write_text(
            json.dumps({"binary_path": str(binary_path)}),
            encoding="utf-8",
        )

    # ── 工具集合复用 Tool 枚举 ───────────────────────────────────────

    @staticmethod
    def _iter_layout_tools(layout: BinaryLayout):
        """遍历 BinaryLayout 中所有 native tool 属性，复用 Tool 枚举值做 getattr。

        新增/删除工具只需维护 Tool 枚举与 BinaryLayout 字段，这里自动跟随。
        """
        for tool in Tool:
            layout_obj = getattr(layout, tool.value, None)
            if layout_obj is None:
                continue
            yield tool, layout_obj

    @classmethod
    def _missing_from_layout(cls, layout: BinaryLayout) -> list[str]:
        """对已构造的 layout 遍历，返回缺失 root_path 的工具名列表。"""
        missing = []
        for tool, layout_obj in cls._iter_layout_tools(layout):
            if not layout_obj.root_path.exists():
                missing.append(tool.value)
        return missing

    @classmethod
    def missing_binaries(cls, binary_path: Path) -> list[str]:
        """返回 binary_path 下缺失的工具名列表（不抛异常，供诊断）。"""
        try:
            layout = BinaryLayout.from_root(binary_path)
        except Exception:
            return [t.value for t in Tool]
        return cls._missing_from_layout(layout)

    @staticmethod
    def _layout_or_raise(binary_path: Path) -> BinaryLayout:
        try:
            return BinaryLayout.from_root(binary_path)
        except Exception as error:
            raise FileNotFoundError(f"Binary 目录无效: {binary_path} ({error})") from error
