"""集成测试共享配置：路径解析、工具白名单、用例发现。

所有路径从环境变量或仓库相对路径推导，不硬编码绝对路径。
"""

from __future__ import annotations

import json
import os
import platform as pf
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class IntegrationCase:
    """单条集成测试用例。"""

    lang: str
    app: str
    tool: str
    case: str
    arguments: dict
    project_path: Path
    input_file: Path
    expected_file: Path
    root: str = ""

    @property
    def id(self) -> str:
        return f"{self.lang}/{self.app}/{self.tool}/{self.case}"


class IntegrationConfig:
    """集成测试配置：集中管理路径、环境变量、工具白名单、用例发现。"""

    PLATFORM_MAP = {
        "darwin": {"arm64": "darwin-aarch64", "x86_64": "darwin-x86-64"},
        "linux": {"x86_64": "linux-x86-64", "aarch64": "linux-aarch64"},
    }

    EXPOSED_TOOLS = frozenset({
        "init_project", "get_class_by_name", "get_function_by_name",
        "get_function_by_file", "get_function_by_code", "get_file_by_keyword",
        "get_function_by_call", "get_reference_by_function", "get_call_graph",
        "search_symbol", "get_api_by_name",
    })

    def __init__(self) -> None:
        here = Path(__file__).resolve().parent
        self.dataset_dir: Path = here.parent.parent / "dataset"
        self.repo_root: Path = here.parent.parent.parent

        # 用例根：xast=对外开源用例(基于 ant-application-security-testing-benchmark)。
        # project_path 统一按 dataset/{lang}/{app} 解析。
        self.cases_roots: list[tuple[str, Path]] = [
            ("xast", here.parent / "test_cases"),
        ]
        selected = os.environ.get("YASA_CASE_ROOTS", "xast")
        self.enabled_roots: set[str] = set()
        for token in selected.split(","):
            token = token.strip()
            if token:
                self.enabled_roots.add(token)

        self.yasamcp_binary: Path = Path(
            os.environ.get("YASAMCP_BINARY", str(self.repo_root / "dist" / "yasamcp" / "yasamcp"))
        )

        system = pf.system().lower()
        arch = pf.machine()
        default_platform = self.PLATFORM_MAP.get(system, {}).get(arch, f"{system}-{arch}")
        default_bin_dir = Path.home() / ".yasamcp" / default_platform
        self.bin_dir: Path = Path(os.environ.get("YASA_BIN_DIR", str(default_bin_dir)))

        self.update_snapshots: bool = os.environ.get("UPDATE_SNAPSHOTS", "0") == "1"

    # ── 用例发现 ──────────────────────────────────────────────────────────

    def discover_cases(self) -> list[IntegrationCase]:
        """扫描启用的用例根(client/xast)，返回白名单内、项目存在的用例。

        project_path 统一按 dataset/{lang}/{app} 解析；两根一致。
        缺失 dataset 的根自动跳过(不报错)，适配外部用户缺内部仓库或未 clone xast 的场景。
        """
        cases: list[IntegrationCase] = []
        for root_name, root_dir in self.cases_roots:
            if root_name not in self.enabled_roots:
                continue
            if not root_dir.exists():
                continue
            for lang_dir in sorted(root_dir.iterdir()):
                if not lang_dir.is_dir():
                    continue
                for app_dir in sorted(lang_dir.iterdir()):
                    if not app_dir.is_dir():
                        continue
                    project_path = self.dataset_dir / lang_dir.name / app_dir.name
                    if not project_path.exists():
                        continue  # dataset 缺失则跳过整个 app
                    for tool_dir in sorted(app_dir.iterdir()):
                        if not tool_dir.is_dir():
                            continue
                        tool = tool_dir.name
                        if tool not in self.EXPOSED_TOOLS:
                            continue
                        for input_file in sorted(tool_dir.glob("*_input.json")):
                            stem = input_file.name.replace("_input.json", "")
                            if stem.startswith("rpc_"):
                                continue
                            data = self.read_json(input_file)
                            if data is None:
                                continue
                            cases.append(IntegrationCase(
                                lang=lang_dir.name,
                                app=app_dir.name,
                                tool=tool,
                                case=stem,
                                arguments=data.get("arguments", {}),
                                project_path=project_path,
                                input_file=input_file,
                                expected_file=input_file.parent / f"{stem}.expected.json",
                                root=root_name,
                            ))
        return cases

    @staticmethod
    def read_json(path: Path) -> dict | None:
        try:
            return json.loads(path.read_text("utf-8"))
        except Exception:
            return None
