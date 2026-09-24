"""
AnalysisRepository 抽象基类

提供 code_search_service 所需的数据查询能力。
当前默认实现为 DuckDB，预留 MySQL 等其他数据库的扩展接口。
"""
from abc import ABC, abstractmethod


class AnalysisRepository(ABC):
    """分析数据仓储抽象基类，定义 service 层所需的全部查询接口。"""

    # ── class_defs ──────────────────────────────────────────────

    @abstractmethod
    def search_class_defs(
        self, name: str = "", class_fqn: str = "", use_regex: bool = False,
        limit: int = 0, offset: int = 0,
    ) -> list[dict]:
        """
        按类名搜索类定义。

        :param name: 类名（短名或 FQN），支持精确匹配或正则匹配
        :param class_fqn: 类 FQN，非空时优先精确匹配
        :param use_regex: True 时对 name 使用正则匹配
        :param limit: 返回上限，0 表示不限制
        :param offset: 分页偏移量
        """
        ...

    @abstractmethod
    def get_methods_by_class_fqn(self, class_fqn: str) -> list[dict]:
        """获取指定类的直接方法列表（不含内部类方法）。"""
        ...

    # ── function_defs ───────────────────────────────────────────

    @abstractmethod
    def search_function_defs(
        self,
        name: str = "",
        function_fqn: str = "",
        function_signature: str = "",
        use_regex: bool = False,
        limit: int = 0,
        offset: int = 0,
    ) -> list[dict]:
        """
        按函数名搜索函数定义。

        :param name: 函数名（短名或 FQN），支持精确匹配或正则匹配
        :param function_fqn: 函数 FQN，非空时优先精确匹配
        :param function_signature: 函数签名过滤
        :param use_regex: True 时对 name 使用正则匹配
        :param limit: 返回上限，0 表示不限制
        :param offset: 分页偏移量
        """
        ...

    @abstractmethod
    def search_function_defs_by_name(
        self, short_name: str, fuzzy_match: bool = False,
    ) -> list[dict]:
        """
        按函数短名索引搜索（等价于旧的 _function_defs_by_name 索引查找）。
        """
        ...

    @abstractmethod
    def get_functions_by_file(
        self, file_path: str, fuzzy_match: bool = False,
        limit: int = 0, offset: int = 0,
    ) -> list[dict]:
        """
        获取指定文件中的所有函数定义，按 start_line 升序排列。
        """
        ...

    @abstractmethod
    def get_functions_for_files(self, file_paths: list[str]) -> dict[str, list[dict]]:
        """
        批量获取多个文件中的函数定义（用于 code_snippet 查找场景）。

        :return: { file_path: [func_dict, ...] }，每个文件内的函数按 start_line 升序
        """
        ...

    @abstractmethod
    def get_all_functions(self) -> list[dict]:
        """获取全部函数定义，按 file_path, start_line 升序排列。"""
        ...

    @abstractmethod
    def get_classes_by_file(self, file_path: str) -> list[dict]:
        """
        获取指定文件中的所有类定义，按 start_line 升序排列。

        :param file_path: 文件路径（相对于项目根目录），精确匹配
        :return: 列表，每个元素为 dict，包含
                 class_fqn, file_path, start_line, start_column, end_line, end_column
        """
        ...
    
    # ── lifecycle ────────────────────────────────────────────────

    @abstractmethod
    def close(self):
        """释放底层资源（连接、文件句柄等）。"""
        ...
