from functools import cached_property
from pathlib import Path

from pydantic import BaseModel

from yasa_mcp.core.enums import Language, Tool
from yasa_mcp.util.path_util import ensure_path

# 分析结果子目录名（存放 DuckDB、project_config、fingerprint_cache）
ANALYSIS_RESULTS_DIR = "yasamcp"
# 不同工具分析结果共用的 DuckDB 文件名
PROJECT_ANALYSIS_DB_FILENAME = "yasa.db"
# 项目配置与指纹缓存文件名
PROJECT_CONFIG_FILENAME = "project_config.json"
FINGERPRINT_CACHE_FILENAME = "fingerprint_cache.json"
CONFIG_FILENAME = "config.json"
CODEGRAPH_DB_FILENAME = "codegraph.db"

class ToolCacheLayout(BaseModel):
    """工具缓存布局基类

    - root_path: 工具的根目录（例如某个工具子目录）
    """
    root_path: Path

    def get_language_dir(self, language: Language) -> Path:
        """当前语言的缓存目录: <tool_root>/<language>"""
        return ensure_path(self.root_path / language.value)


class YasaCacheLayout(ToolCacheLayout):
    """Yasa 缓存布局

    结构:
        <project_cache>/yasacg/     <-- root_path
            └── <language>/         <-- language_dir
                └── callgraph.json

    说明：CallGraph 表与其它分析结果写入同一 DuckDB：``<project_cache>/yasamcp/yasa.db``。
    init 导入 duckdb 后默认删除本目录，save_cg_dump=True 时保留。
    """

    def get_callgraph_report(self, language: Language) -> Path:
        return self.get_language_dir(language) / "callgraph.json"

    def get_ast_cache(self, language: Language) -> Path:
        """返回 Yasa UAST 缓存目录。"""
        return self.get_language_dir(language) / "astcache"

    def get_callgraph_duckdb_path(self) -> Path:
        """获取与其它工具共用的 DuckDB 路径（内含 cg_* 与 function_defs / class_defs）。"""
        return ensure_path(self.root_path.parent / ANALYSIS_RESULTS_DIR) / PROJECT_ANALYSIS_DB_FILENAME


class CodeGraphCacheLayout(ToolCacheLayout):
    """CodeGraph consumer 数据库缓存布局。

    结构::

        <project_cache>/yasamcp/.codegraph/  # root_path
        └── codegraph.db                              # consumer 数据库

    增量同步时同级使用 ``.codegraph.staging`` 和 ``.codegraph.backup``
    作为临时目录；业务访问统一通过本布局对象。
    """

    def get_dir_path(self) -> Path:
        return self.root_path

    def get_db_path(self) -> Path:
        return self.root_path / CODEGRAPH_DB_FILENAME

    def get_staging_dir_path(self) -> Path:
        return self.root_path.with_name(f"{self.root_path.name}.staging")

    def get_backup_dir_path(self) -> Path:
        return self.root_path.with_name(f"{self.root_path.name}.backup")

    def is_cache_exists(self) -> bool:
        path = self.get_db_path()
        return path.is_file() and path.stat().st_size > 0


class CacheLayout(BaseModel):
    """按语言划分的缓存布局

    - root_path: 全局缓存根目录 (不含语言)
    """
    root_path: Path

    @cached_property
    def yasa_cache(self) -> YasaCacheLayout:
        # root_path 指向 <project_cache>/yasacg（yasa 原始 CG dump，init 后默认删除）
        return YasaCacheLayout(
            root_path=self.root_path / "yasacg"
        )

    @cached_property
    def codegraph_cache(self) -> CodeGraphCacheLayout:
        return CodeGraphCacheLayout(root_path=self.root_path / ANALYSIS_RESULTS_DIR / ".codegraph")

    def is_full_cache_exists(self) -> bool:
        return (
            self.is_cache_exists()
            and self.codegraph_cache.is_cache_exists()
            and self.get_project_config_json().exists()
        )

    def get_cache_build_lock_path(self) -> Path:
        return ensure_path(self.root_path / ANALYSIS_RESULTS_DIR) / ".cache_build.lock"

    def get_shared_analysis_duckdb_path(self) -> Path:
        """不同工具分析结果写入同一个 DuckDB 文件（位于 ``<project_cache>/yasamcp/``）。

        与 ``YasaCacheLayout.get_callgraph_duckdb_path()`` 在 ``root_path == <project_cache>``
        语义下等价；业务代码宜优先用本方法或注入本 ``CacheLayout`` 的 analysis_duckdb_path，
        避免各工具各缓存一份 Path。
        """
        return ensure_path(self.root_path / ANALYSIS_RESULTS_DIR) / PROJECT_ANALYSIS_DB_FILENAME

    def get_tool_cache(self, tool: Tool) -> ToolCacheLayout:
        """获取指定工具的缓存布局"""
        if tool == Tool.YASA:
            return self.yasa_cache
        elif tool == Tool.CODEGRAPH:
            return self.codegraph_cache
        else:
            raise ValueError(f"Unknown tool: {tool}")

    def is_cache_exists(self) -> bool:
        """判断缓存是否存在（通过检查共享 DuckDB 文件）。"""
        return (self.root_path / ANALYSIS_RESULTS_DIR / PROJECT_ANALYSIS_DB_FILENAME).exists()

    def get_project_config_json(self) -> Path:
        """获取项目配置文件路径（位于 yasamcp/ 下）"""
        return self.root_path / ANALYSIS_RESULTS_DIR / PROJECT_CONFIG_FILENAME

    def get_fingerprint_cache_json(self) -> Path:
        """获取文件指纹缓存路径（位于 yasamcp/ 下）"""
        return self.root_path / ANALYSIS_RESULTS_DIR / FINGERPRINT_CACHE_FILENAME

    def get_binary_path_json(self) -> Path:
        """获取 init 时记录的 binary 目录路径文件（位于 yasamcp/ 下）"""
        return self.root_path / ANALYSIS_RESULTS_DIR / CONFIG_FILENAME
