"""CodeGraph SQLite 的只读 PreparedNodeQuery repository。"""

from __future__ import annotations

import logging
import re
import sqlite3
import threading
from pathlib import Path

from yasa_mcp.repository.dao.codegraph import (
    CodeGraphInterfaceImplementationRow,
    CodeGraphNodeRow,
)
from yasa_mcp.repository.query.codegraph.query_models import (
    ClassRecord,
    ConditionField,
    ConditionOperator,
    FunctionRecord,
    InterfaceImplementationRecord,
    InterfaceQueryKind,
    InterfaceQuerySpec,
    MethodRecord,
    NodeRecord,
    PreparedNodeQuery,
    PreparedNodeQueryBuilder,
    QueryCondition,
    QueryTemplate,
)
from yasa_mcp.util import log_util
from yasa_mcp.util.timer_util import timed

logger = logging.getLogger(__name__)
MAPPER_DIR = Path(__file__).parent / "mapper" / "codegraph"
_INTERFACE_QUERY_SPECS = {
    InterfaceQueryKind.FQCN_METHOD: InterfaceQuerySpec(
        "interface_implement_by_fqcn", True
    ),
    InterfaceQueryKind.SHORT_NAME_METHOD: InterfaceQuerySpec(
        "interface_implement_by_short_name", True
    ),
    InterfaceQueryKind.FQCN_ALL_METHODS: InterfaceQuerySpec(
        "interface_only_implement_by_fqcn", False
    ),
    InterfaceQueryKind.SHORT_NAME_ALL_METHODS: InterfaceQuerySpec(
        "interface_only_implement_by_short_name", False
    ),
}
_INTERFACE_TEMPLATES = {spec.template for spec in _INTERFACE_QUERY_SPECS.values()}
_IMPORT_TEMPLATES = {"import_nodes_by_file", "import_nodes_by_file_suffix"}


class CodeGraphAnalysisRepository:
    """只替换已验证模板中的唯一占位符并执行，不解释用户输入或选择查询策略。"""

    # 运行时从 mapper 目录扫描 SQL 文件；新增 mapper 无需修改此类。
    _MAPPER_FILES: tuple[str, ...] = ()

    def __init__(self, db_path: str | Path):
        self._db_path = Path(db_path)
        self._local = threading.local()
        self._MAPPER_FILES = tuple(
            path.name for path in sorted(MAPPER_DIR.glob("*.sql")) if path.is_file()
        )
        self._statements = self._load_statements()

    def _load_statements(self) -> dict[str, str]:
        """加载 mapper 目录下配置的全部 SQL 语句。"""
        statements: dict[str, str] = {}
        for mapper in self._MAPPER_FILES:
            name: str | None = None
            lines: list[str] = []
            for line in (MAPPER_DIR / mapper).read_text(encoding="utf-8").splitlines():
                match = re.match(r"\s*--\s*name:\s*([a-z_]+)\s*$", line)
                if match:
                    if name:
                        statements[name] = "\n".join(lines).strip()
                    name, lines = match.group(1), []
                elif name:
                    lines.append(line)
            if name:
                statements[name] = "\n".join(lines).strip()
        return statements

    def _get_connection(self) -> sqlite3.Connection:
        connection = getattr(self._local, "connection", None)
        if not isinstance(connection, sqlite3.Connection):
            connection = sqlite3.connect(f"file:{self._db_path}?mode=ro", uri=True)
            connection.row_factory = sqlite3.Row
            connection.create_function("REGEXP", 2, self._regexp)
            self._local.connection = connection
        return connection

    @staticmethod
    def _regexp(pattern: str | None, value: str | None) -> int:
        try:
            return int(bool(pattern and value is not None and re.search(pattern, value)))
        except re.error:
            return 0

    def execute_query(self, query: PreparedNodeQuery, limit: int = 0, offset: int = 0) -> list[NodeRecord]:
        # Repository 是信任边界：即使调用方能实例化 dataclass，也不能注入自写 conditions_sql。
        PreparedNodeQueryBuilder.verify(query)
        template = self._statements[query.template.value]
        sql = template.replace("{conditions}", query.conditions_sql)
        params: list[str | int | None] = [*query.kinds, *query.condition_params]
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        elif offset > 0:
            sql += " LIMIT -1"
        if offset > 0:
            sql += " OFFSET ?"
            params.append(offset)
        try:
            rows = self._get_connection().execute(sql, params).fetchall()
            return [{key: row[key] for key in row.keys()} for row in rows]
        except sqlite3.Error as exc:
            log_util.error(f"CodeGraph 查询失败: strategy={query.strategy}, error={exc}", logger=logger)
            raise

    def execute_class_query(self, query: PreparedNodeQuery, limit: int = 0, offset: int = 0) -> list[ClassRecord]:
        if query.template is not QueryTemplate.CLASS_SEARCH:
            raise ValueError("class query 必须使用 class_search 模板")
        return [CodeGraphNodeRow.from_mapping(row).to_class_dict() for row in self.execute_query(query, limit, offset)]

    def execute_function_query(self, query: PreparedNodeQuery, limit: int = 0, offset: int = 0) -> list[FunctionRecord]:
        if query.template is QueryTemplate.CLASS_SEARCH:
            raise ValueError("function query 不能使用 class_search 模板")
        return [CodeGraphNodeRow.from_mapping(row).to_function_dict() for row in self.execute_query(query, limit, offset)]

    @timed(logger, "codegraph_repository", "search_symbol_nodes")
    def search_symbol_nodes(
        self,
        match_query: str,
        *,
        limit: int = 0,
        offset: int = 0,
    ) -> list[CodeGraphNodeRow]:
        """查询 FTS 并映射为 CodeGraphNodeRow，service 不接触 sqlite.Row。 

        kind 筛选属于 service 语义层。CodeGraph 会持续增加节点类型，FTS SQL 不限制
        kind 才不会把未来新增的有效命中静默过滤掉。
        """

        if not match_query:
            return []
        try:
            query = PreparedNodeQueryBuilder.build_search_symbol(match_query)
            rows = self.execute_query(query, limit=limit, offset=offset)
            return [CodeGraphNodeRow.from_mapping(row) for row in rows]
        except sqlite3.Error as exc:
            log_util.error(
                f"CodeGraph search_symbol 查询失败: match={match_query!r}, error={exc}",
                logger=logger,
            )
            raise

    @timed(logger, "codegraph_repository", "find_interface_implementations")
    def find_interface_implementations(
        self,
        *,
        query_kind: InterfaceQueryKind,
        interface_name: str,
        method_name: str | None,
        language: str,
    ) -> list[InterfaceImplementationRecord]:
        """执行与接口输入形态一一对应的固定 SQL。

        ``query_kind`` 同时表达两个维度：接口名是全限定名还是短名，以及输入是指定
        method 还是查询接口全部实现方法。每种组合都映射到一个白名单模板，避免两个 bool
        在调用处产生歧义，也不允许调用方动态拼接模板名。

        method 模板需要五个绑定参数；all-methods 模板不消费 ``method_name``，即使调用方
        提供该字段也会忽略，只绑定模板实际需要的四个参数。这里只负责模板执行和 DTO
        转换，不重新分类输入，也不把 SQLite 异常伪装成未命中。
        """
        spec = _INTERFACE_QUERY_SPECS[query_kind]
        method_params = (method_name,) if spec.includes_method else ()
        params = method_params + (language, language, language, interface_name)
        template = spec.template
        try:
            rows = self._get_connection().execute(
                self._statements[template], params
            ).fetchall()
        except sqlite3.Error as exc:
            log_util.error(
                f"CodeGraph 接口实现查询失败: template={template}, error={exc}",
                logger=logger,
            )
            raise
        return [
            CodeGraphInterfaceImplementationRow.from_mapping(
                {key: row[key] for key in row.keys()}
            ).to_record()
            for row in rows
        ]

    def get_methods_by_owner_fqn(self, class_fqn: str) -> list[MethodRecord]:
        # owner prefix 要求至少一个成员段，nested prefix 排除嵌套类型内的方法。
        query = PreparedNodeQueryBuilder.build(
            "methods_by_owner_fqn",
            QueryTemplate.METHODS_BY_OWNER,
            (
                QueryCondition(ConditionField.QUALIFIED_NAME, ConditionOperator.LIKE, f"{class_fqn}::%"),
                QueryCondition(ConditionField.QUALIFIED_NAME, ConditionOperator.NOT_LIKE, f"{class_fqn}::%::%"),
            ),
        )
        rows = self.execute_function_query(query)
        return [{"short_name": row["short_name"], "function_signature": row["function_signature"], "start_line": row["start_line"]} for row in rows]

    @timed(logger, "codegraph_repository", "find_import_nodes_by_file")
    def find_import_nodes_by_file(
        self,
        file_path: str,
        *,
        fuzzy_match: bool = True,
        limit: int = 0,
    ) -> list[NodeRecord]:
        """从 CodeGraph ``nodes`` 表查询指定文件的全部 import 节点。

        ``fuzzy_match`` 只扩展为路径后缀匹配，不查询或聚合 ``edges``。因此本方法
        返回的是 CodeGraph 直接记录的导入事实，而不是二次推导的依赖关系。
        """

        normalized_path = file_path.replace("\\", "/").lstrip("/")
        if not normalized_path:
            return []

        if fuzzy_match:
            # 以下为安全注释COSEC：LIKE 中的通配符同样来自调用参数，必须先转义，
            # 再通过占位符绑定，防止输入改变既定的“路径后缀”查询语义。
            escaped_path = (
                normalized_path.replace("\\", "\\\\")
                .replace("%", "\\%")
                .replace("_", "\\_")
            )
            sql = self._statements["import_nodes_by_file_suffix"]
            params: list[str | int] = [
                normalized_path,
                f"%/{escaped_path}",
                limit if limit > 0 else -1,
            ]
        else:
            sql = self._statements["import_nodes_by_file"]
            params = [normalized_path, limit if limit > 0 else -1]

        try:
            rows = self._get_connection().execute(sql, params).fetchall()
        except sqlite3.Error as exc:
            log_util.error(
                "CodeGraph import 节点查询失败: "
                f"file_path={normalized_path!r}, fuzzy_match={fuzzy_match}, error={exc}",
                logger=logger,
            )
            raise
        return [{key: row[key] for key in row.keys()} for row in rows]

    def close(self) -> None:
        connection = getattr(self._local, "connection", None)
        if isinstance(connection, sqlite3.Connection):
            connection.close()
            self._local.connection = None
