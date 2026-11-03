import logging
import threading
from pathlib import Path
from typing import Callable, Generic, TypeVar

from pydantic import BaseModel, Field, PrivateAttr

from yasa_mcp.config import global_config
from yasa_mcp.core.cache_status import CacheStatusMask
from yasa_mcp.core.enums import Language, Tool
from yasa_mcp.core.exceptions import InvalidToolError
from yasa_mcp.core.models import ToolProtocol, ToolContext
from yasa_mcp.core.runtime import YasaMcpRuntime, get_runtime
# from yasa_mcp.tools.antql.antql_tool import AntQLTool
from typing import Any

from yasa_mcp.util import log_util
from yasa_mcp.util.log_util import Task
from yasa_mcp.util.timer_util import timed

logger = logging.getLogger(__name__)

T = TypeVar("T")


class YasaMcpContext(BaseModel):
    """所有任务流转的上下文"""

    # 工具上下文
    tools_context: dict[Tool, Any] = Field(default_factory=dict)
    project_path: Path | None = None
    languages: list[Language] = Field(default_factory=list)
    cache_status: CacheStatusMask = CacheStatusMask.NONE
    _cache_lock: threading.Lock = PrivateAttr(default_factory=threading.Lock)

    def get_tool(self, name: Tool) -> ToolProtocol:
        """获取指定工具，经 runtime 单例按需懒加载。"""
        return get_runtime().get_tool(name)

    def get_tool_context(self, name: Tool) -> ToolContext:
        """获取指定工具的上下文"""
        tool_context = self.tools_context.get(name)
        if tool_context is None:
            raise InvalidToolError(f"ToolContext: '{name.value}' not found in tools_context registry.")
        return tool_context

    def set_tool_context(self, name: Tool, tool_context: ToolContext):
        """设置指定工具的上下文"""
        self.tools_context[name] = tool_context

    def get_or_create_cached(self, key: str, factory: Callable[[], T | None]) -> T | None:
        """
        线程安全的懒加载：双重检查锁定，同一 key 只会执行一次 factory。

        factory 返回 None 时不缓存，下次调用仍会重试。
        """
        val = self.__dict__.get(key)
        if val is not None:
            return val
        with self._cache_lock:
            val = self.__dict__.get(key)
            if val is not None:
                return val
            val = factory()
            if val is not None:
                self.__dict__[key] = val
            return val

    def update_cache_status(self, flag: CacheStatusMask):
        """追加缓存就绪标志位（OR 操作）。"""
        self.cache_status = CacheStatusMask(self.cache_status | flag)

    def reset_cache_status(self, flag: CacheStatusMask):
        """重置缓存状态到指定级别（直接赋值）。"""
        self.cache_status = flag

    def get_cache_status(self) -> CacheStatusMask:
        """返回当前缓存就绪状态。"""
        return self.cache_status

    def is_cache_ready(self, required: CacheStatusMask = CacheStatusMask.ALL) -> bool:
        """判断当前缓存状态是否满足给定级别（所有必需位均已置位）。"""
        return (self.cache_status & required) == required

    def set_project_path(self, project_path: Path):
        self.project_path = project_path

    def set_task(self, task: Task):
        """设置当前任务"""
        log_util.set_current_task(task)

    def set_default_task(self):
        log_util.set_current_task(Task(task_id="default", project_path=self.project_path))

    def get_project_languages(self) -> list:
        """返回当前项目涉及的语言列表；为空时返回默认支持语言。"""
        return list(self.languages or global_config.support_languages)
    
    def get_main_languages(self) -> Language:
        """返回当前项目涉及主语言；为空时返回默认支持语言。"""
        languages = self.get_project_languages()
        return languages[0] if languages else Language.JAVA

    def get_project_main_language(self) -> str:
        """返回项目主语言（第一个语言的字符串值），供实时分析路由使用。"""
        languages = self.get_project_languages()
        lang = languages[0] if languages else Language.JAVA
        return lang.value if hasattr(lang, "value") else str(lang)

    def set_project_languages(self, languages: list[Language]):
        self.languages = list(languages)
