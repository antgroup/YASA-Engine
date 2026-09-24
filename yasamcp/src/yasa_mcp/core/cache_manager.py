from __future__ import annotations

import hashlib
import logging
import shutil
from pathlib import Path
from threading import RLock
from typing import Dict

from yasa_mcp.config import global_config
from yasa_mcp.layout.cache_layout import CacheLayout
from yasa_mcp.util import log_util, json_util
from yasa_mcp.util.path_util import validate_path, ensure_path

logger = logging.getLogger(__name__)


class CacheManager:
    """
    缓存管理器

    统一管理全局 `cache/` 目录下不同项目的缓存布局，仅负责目录结构与 `CacheLayout` 创建。

    目录结构约定：

        <cache_root>/
            project_map.json          # 全局项目路径映射配置文件
            <project_key>/            # 由项目路径派生的稳定目录名
                antql/...
                yasa/...
                uql/...
    """

    def __init__(self, root_path: Path | None = None) -> None:
        # 使用全局配置中的 cache_path 作为默认根目录
        base = Path(root_path or global_config.cache_path)
        self.root_path: Path = validate_path(base)
        self.map_file = self.root_path / "project_map.json"

        # 内存中的缓存索引：project_path -> CacheLayout
        self._caches: Dict[Path, CacheLayout] = {}
        self._lock = RLock()

    # ------------------------------------------------------------------
    # 内部工具方法
    # ------------------------------------------------------------------
    def _load_project_map(self) -> dict[str, str]:
        """加载项目路径映射文件"""
        data = json_util.load_json_from_file(self.map_file)
        return data if data is not None else {}

    def _save_project_map(self, data: dict[str, str]) -> None:
        """保存项目路径映射文件"""
        try:
            json_util.write_json_to_file(self.map_file, data, indent=True)
        except Exception as e:
            log_util.warning(f"Failed to save project map to {self.map_file}: {e}", logger=logger)

    def _project_key(self, project_path: Path) -> str:
        """
        根据项目路径生成稳定的目录名。
        
        策略：
        1. 优先查阅 cache 根目录下的 project_map.json 映射文件。
           用户可以手动编辑该文件，将新路径指向旧的缓存 Key，从而实现缓存复用。
        2. 如果映射不存在，则基于路径生成默认 Key，并自动写入映射文件。
        """
        project_path = project_path.resolve()
        abs_path_str = str(project_path)
        
        # 1. 尝试从映射文件中获取
        # 注意：此处在 lock 保护下调用（由 get_or_create_cache 保证），或者是无锁的只读访问
        # 为了简单起见，这里每次都重新读写文件。对于初始化频率不高的场景是可以接受的。
        project_map = self._load_project_map()
        
        if abs_path_str in project_map:
            return project_map[abs_path_str]

        # 2. 生成默认 Key (name + path hash)
        name = project_path.name or "project"
        digest = hashlib.sha256(project_path.as_posix().encode()).hexdigest()[:8]
        new_key = f"{name}_{digest}"
        
        # 3. 自动记录到映射文件
        project_map[abs_path_str] = new_key
        self._save_project_map(project_map)
        
        return new_key

    def _project_root(self, project_path: Path) -> Path:
        """某个项目在 cache 下对应的根目录: <cache_root>/<project_key>"""
        return ensure_path(self.root_path / self._project_key(project_path))

    def _ensure_root(self) -> None:
        """确保全局 cache 根目录存在。"""
        ensure_path(self.root_path)

    # ------------------------------------------------------------------
    # 对外接口
    # ------------------------------------------------------------------

    def get_or_create_cache(
        self, project_path: Path, cache_dir: Path | None = None
    ) -> CacheLayout:
        """
        获取（如不存在则创建）指定项目的缓存布局。

        当 ``cache_dir`` 非空时，直接使用该目录作为缓存根（绕过 hash/project_map），
        用于 ``--project`` 模式（缓存落 ``<project>/.yasa/``）。
        """
        project_path = project_path.resolve()

        with self._lock:
            if project_path in self._caches:
                return self._caches[project_path]

            if cache_dir is not None:
                project_root = ensure_path(cache_dir)
            else:
                self._ensure_root()
                project_root = self._project_root(project_path)

            cache_layout = CacheLayout(root_path=project_root)

            self._caches[project_path] = cache_layout

            log_util.info(
                f"创建缓存布局: project={project_path}, path={project_root}",
                logger=logger,
            )
            return cache_layout

    def get_cache(self, project_path: Path) -> CacheLayout | None:
        """仅从内存中获取缓存布局，不会自动创建。"""
        project_path = project_path.resolve()
        with self._lock:
            return self._caches.get(project_path)

    def remove_project(self, project_path: Path) -> None:
        """从内存索引中移除某个项目（不删除磁盘上的缓存）。"""
        project_path = project_path.resolve()
        with self._lock:
            self._caches.pop(project_path, None)

    def list_projects(self) -> list[Path]:
        """列出当前已加载的项目路径（仅内存索引，不扫盘）。"""
        with self._lock:
            return list(self._caches.keys())


# 全局单例（线程安全）
_cache_manager: CacheManager | None = None
_project_cache_dir: Path | None = None


def set_project_cache_dir(cache_dir: Path | None) -> None:
    """设置 --project 模式下的缓存目录（<project>/.yasa）。None 表示恢复默认全局模式。"""
    global _project_cache_dir
    _project_cache_dir = Path(cache_dir) if cache_dir else None


def get_project_cache_dir() -> Path | None:
    return _project_cache_dir


def get_cache_manager(root_path: Path | None = None) -> CacheManager:
    """获取全局缓存管理器实例（可选地覆盖根目录）。"""
    global _cache_manager
    if _cache_manager is None:
        _cache_manager = CacheManager(root_path=root_path)
    return _cache_manager

def get_or_create_cache_for_project(project_path: Path) -> CacheLayout:
    """获取项目缓存布局，--project 模式下直接用 <project>/.yasa，否则走全局 cache_root。"""
    if _project_cache_dir is not None:
        project_cache = ensure_path(_project_cache_dir)
        return CacheLayout(root_path=project_cache)
    cache_manager = get_cache_manager(global_config.cache_path)
    return cache_manager.get_or_create_cache(
        project_path, cache_dir=_project_cache_dir
    )
