"""上下文管理器 - 管理多个项目的分析上下文，支持并发访问"""

import threading
from typing import Optional
from pathlib import Path
from yasa_mcp.core.context import YasaMcpContext


class ContextManager:
    """线程安全的上下文管理器
    
    支持多个项目同时分析，每个项目有独立的上下文。
    使用线程本地存储或字典映射来管理上下文。
    """
    
    def __init__(self):
        # 使用字典存储项目路径到上下文的映射
        # 键：project_path，值：YasaMcpContext
        self._contexts: dict[Path, YasaMcpContext] = {}
        self._last_accessed_project_path: Optional[Path] = None
        self._lock = threading.RLock()  # 可重入锁
    
    def set_context(self, project_path: Path, context: YasaMcpContext) -> None:
        """设置项目的上下文"""
        with self._lock:
            self._contexts[project_path] = context
            self._last_accessed_project_path = project_path
    
    def get_context(self, project_path: Optional[Path] = None) -> Optional[YasaMcpContext]:
        """获取项目的上下文
        
        Args:
            project_path: 项目路径。
                如果指定了路径，则返回对应的上下文，并将其标记为最近使用的上下文。
                如果为 None，则返回最近一次使用的上下文。若无最近使用记录，则尝试返回第一个可用的上下文。
        
        Returns:
            YasaMcpContext 或 None
        """
        with self._lock:
            if project_path:
                context = self._contexts.get(project_path)
                if context:
                    self._last_accessed_project_path = project_path
                return context
            
            # project_path is None
            if self._last_accessed_project_path and self._last_accessed_project_path in self._contexts:
                return self._contexts[self._last_accessed_project_path]
            
            # Fallback: return first available if exists (backward compatibility)
            if self._contexts:
                first_path = next(iter(self._contexts))
                self._last_accessed_project_path = first_path
                return self._contexts[first_path]
                
            return None
    
    def remove_context(self, project_path: Path) -> None:
        """移除项目的上下文"""
        with self._lock:
            self._contexts.pop(project_path, None)
            if self._last_accessed_project_path == project_path:
                self._last_accessed_project_path = None
    
    def has_context(self, project_path: Path) -> bool:
        """检查是否存在上下文"""
        with self._lock:
            if project_path:
                return project_path in self._contexts
            return len(self._contexts) > 0
    
    def list_projects(self) -> list[Path]:
        """列出所有已加载的项目路径"""
        with self._lock:
            return list(self._contexts.keys())


# 全局单例（线程安全）
_context_manager = ContextManager()


def get_context_manager() -> ContextManager:
    """获取全局上下文管理器实例"""
    return _context_manager


def get_project_context(project_path: str | None = None) -> YasaMcpContext:
    """获取项目上下文（支持多项目）。

    project_path 显式指定时：
    - 命中已缓存的 context 直接返回；
    - 未命中则从项目 .yasa 缓存加载并注册进 manager；
      缓存 DB 不存在时抛 ToolError 提示先通过 yasamcp init 生成分析结果。
    project_path 为空时取唯一/最近已加载的项目。
    """
    from yasa_mcp.core.exceptions import ToolError

    context_manager = get_context_manager()

    if project_path:
        project_path_obj = Path(project_path).resolve()
        context = context_manager.get_context(project_path_obj)
        if context is not None:
            return context
        from yasa_mcp.core.project_cache_manager import ProjectCacheManager
        pcm = ProjectCacheManager(project_path_obj)
        pcm.validate_or_abort()
        pcm.load_context()
        context = context_manager.get_context(project_path_obj)
        if context is None:
            raise ToolError(f"项目 {project_path_obj} 上下文加载失败，请先通过 yasamcp init 生成分析结果后再调用查询工具")
        return context

    projects = context_manager.list_projects()
    if not projects:
        raise ToolError("未找到已初始化的项目，请先通过 yasamcp init <项目路径> 生成分析结果后再调用查询工具")

    context = context_manager.get_context()
    if context is None:
        raise ToolError("项目上下文未正确初始化，请重新通过 yasamcp init <项目路径> 生成分析结果")
    return context
