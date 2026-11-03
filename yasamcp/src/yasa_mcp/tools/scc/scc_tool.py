import json
import logging
from pathlib import Path

from yasa_mcp.core.enums import Language
from yasa_mcp.core.models import ToolProtocol
from yasa_mcp.tools.scc.scc_bin_layout import SccBinaryLayout
from yasa_mcp.util import command_util
from yasa_mcp.util.timer_util import timed

logger = logging.getLogger(__name__)

# scc 检测时忽略的目录名
_EXCLUDE_DIRS = [
    ".git", ".DS_Store", "__pycache__", ".idea", ".vscode",
    "node_modules", "target", "build", "dist",
    "venv", ".venv", ".yasa_info", ".codegraph",".yasa_scenario"
]

# scc 检测时忽略的文件扩展名
_EXCLUDE_EXTENSIONS = ["*.pyc", "*.pyo", "*.pyd", "*.log", "*.tmp", "*.bak"]

# scc 语言名 → yasa-mcp 内部 Language 名称的归一化映射。
# scc 会把 TypeScript / TypeScript Typings 单列，但 yasa 引擎以 --language javascript
# 同时解析 js/ts，故统一归并到 javascript，避免 TS 文件被丢弃导致语言识别不全
# （尤其是纯 TS 项目会完全识别不出来）。
_SCC_LANGUAGE_NORMALIZE: dict[str, str] = {
    "typescript": "javascript",
    "typescript typings": "javascript",
}


class SccTool(ToolProtocol):
    def __init__(self, scc_layout: SccBinaryLayout):
        self.scc_layout = scc_layout
        self.initialized = command_util.binary_exists(self.scc_layout.scc_bin)

    def check_available(self) -> bool:
        return command_util.check_binary_available(self.scc_layout.scc_bin)

    @timed(logger, "SCC", "detect_languages")
    def detect_languages(self, project_path: Path) -> list[Language]:
        """使用 scc 检测项目的编程语言，按文件数降序返回。"""
        try:
            # -c: 跳过代码复杂度计算，减少文件解析开销
            # --no-cocomo: 跳过 COCOMO 工作量估算，我们只需要语言和文件数
            # --format json: JSON 格式输出，便于解析
            # --exclude-dir: 排除干扰目录
            # --not-match: 排除干扰扩展名文件
            args = [
                "-c", "--no-cocomo", "--format", "json",
                "--exclude-dir", ",".join(_EXCLUDE_DIRS),
                "--not-match", ",".join(_EXCLUDE_EXTENSIONS),
                str(project_path),
            ]
            result = command_util.run_binary(
                self.scc_layout.scc_bin,
                args,
                timeout=10,
            )
        except Exception:
            return []

        if result.returncode != 0 or not result.stdout.strip():
            return []

        try:
            stats = json.loads(result.stdout)
        except json.JSONDecodeError:
            return []

        # 先按归一化后的语言名累加文件数（TypeScript / TypeScript Typings 归并到 javascript）。
        # 同名归并后 count 累加而非覆盖，保证后续频率排序准确。
        normalized_counts: dict[str, int] = {}
        for entry in stats:
            raw_name = entry.get("Name", "")
            name = _SCC_LANGUAGE_NORMALIZE.get(raw_name.lower(), raw_name)
            normalized_counts[name] = normalized_counts.get(name, 0) + entry.get("Count", 0)

        # 按累加后的文件数降序，依次解析为内部 Language（无法识别的语言名跳过）。
        languages: list[Language] = []
        for name, _count in sorted(normalized_counts.items(), key=lambda kv: kv[1], reverse=True):
            lang = Language.try_parse(name)
            if lang is not None and lang not in languages:
                languages.append(lang)

        return languages
