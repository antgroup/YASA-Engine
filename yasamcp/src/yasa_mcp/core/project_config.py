"""完整项目缓存的提交凭据及其原子 JSON 持久化。"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import TypeAlias

import orjson

from yasa_mcp.core.enums import Language
from yasa_mcp.util import json_util

JSONScalar: TypeAlias = str | int | float | bool | None
JSONValue: TypeAlias = JSONScalar | list["JSONValue"] | dict[str, "JSONValue"]


@dataclass(frozen=True)
class ProjectConfig:
    """完整项目缓存的持久化提交凭据。"""

    project_path: Path
    project_hash: str
    version: str
    languages: list[Language] = field(default_factory=list)
    codegraph: dict[str, JSONValue] = field(default_factory=dict)

    @classmethod
    def read_project_config_json(cls, config_json_path: Path) -> ProjectConfig | None:
        """读取并做字段级校验；缺失或不兼容的旧配置视为不可加载。"""

        if not config_json_path.is_file():
            return None

        config_json = json_util.load_json_from_file(config_json_path)
        if not isinstance(config_json, dict):
            return None

        project_path_raw = config_json.get("project_path")
        project_hash = config_json.get("project_hash")
        version = config_json.get("version")
        languages_raw = config_json.get("languages") or []
        codegraph_raw = config_json.get("codegraph") or {}
        if not isinstance(project_path_raw, str):
            return None
        if not isinstance(project_hash, str) or not isinstance(version, str):
            return None
        if not isinstance(languages_raw, list) or not all(
            isinstance(language, str) for language in languages_raw
        ):
            return None
        if not isinstance(codegraph_raw, dict) or not all(
            isinstance(key, str) for key in codegraph_raw
        ):
            return None

        # 以下为安全注释COSEC：外部缓存只经 JSON 与显式字段转换，不反序列化任意对象。
        languages = [Language.from_string(language) for language in languages_raw]
        return cls(
            project_path=Path(project_path_raw),
            project_hash=project_hash,
            version=version,
            languages=languages,
            codegraph=dict(codegraph_raw),
        )

    def write_project_config_json(self, config_json_path: Path) -> None:
        """同目录 staging + replace，避免进程中断留下半写配置。"""

        payload: dict[str, JSONValue] = {
            "project_path": str(self.project_path),
            "project_hash": self.project_hash,
            "version": self.version,
            "languages": [language.value for language in self.languages],
            "codegraph": self.codegraph,
        }
        config_json_path.parent.mkdir(parents=True, exist_ok=True)
        fd, staging_name = tempfile.mkstemp(
            prefix=f".{config_json_path.name}.",
            suffix=".tmp",
            dir=config_json_path.parent,
        )
        staging_path = Path(staging_name)
        try:
            # 以下为安全注释COSEC：staging 固定在目标同目录，避免跨目录发布或覆盖非目标路径。
            with os.fdopen(fd, "wb") as staging_file:
                staging_file.write(orjson.dumps(payload))
                staging_file.flush()
                os.fsync(staging_file.fileno())
            # 同一目录内原子替换；只有完整 payload 落盘后才发布新的缓存提交凭据。
            os.replace(staging_path, config_json_path)
        except BaseException:
            staging_path.unlink(missing_ok=True)
            raise
