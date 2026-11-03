"""
CallGraph DuckDB 查询层：将原先内存遍历改为 SQL + 必要时的少量 Python 校验（与 ParamsValidator 语义一致）。

UQL 表（`function_defs` / `class_defs`）与 CallGraph 表（`cg_nodes` 等）位于同一个
`project_analysis.db`，因此所有查询统一通过 `CallgraphDB.query` 完成，无需额外的
`AnalysisRepository` 实例。
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from yasa_mcp.core.enums import Language
from yasa_mcp.repository.callgraph_db import CallgraphDB
from yasa_mcp.repository.fqn_match import segment_boundary_regex
from yasa_mcp.service import models
from yasa_mcp.util.params_validator_util import ParamsValidator
from yasa_mcp.util.timer_util import timed

logger = logging.getLogger(__name__)


def _like_param(value: str) -> str:
    if "%" in value:
        return value
    return f"%{value}%"


def _segment_suffix_regex(value: str) -> str:
    """构造按 dotted 段边界匹配 FQN 后缀的正则。"""
    return rf"(^|\.){re.escape(value)}$"




@dataclass(frozen=True)
class FunctionNodeQueryPlan:
    strategy: str
    fields: tuple[str, ...]


@dataclass(frozen=True)
class FunctionNodeQueryContext:
    language: Language
    name: str = ""
    function_fqn: str = ""
    file_path: str = ""
    line: int = 0
    use_regex: bool = False
    need_definition: bool = False


_FUNCTION_NODE_QUERY_PLAN: tuple[FunctionNodeQueryPlan, ...] = (
    FunctionNodeQueryPlan("file_line", ("file_path", "line")),
    FunctionNodeQueryPlan("file_name_fqn", ("file_path", "name", "function_fqn")),
    FunctionNodeQueryPlan("file_fqn", ("file_path", "function_fqn")),
    FunctionNodeQueryPlan("name_fqn", ("name", "function_fqn")),
    FunctionNodeQueryPlan("function_fqn", ("function_fqn",)),
    FunctionNodeQueryPlan("name", ("name",)),
)


def normalize_callgraph_full_name(raw: str | None) -> str:
    """只归一化 callgraph 写入库时的 FQN 路径分隔符。

    历史 callgraph 节点会混用 path-style 和 dotted-style 名称，例如
    `/src/service/foo.Foo.bar` 和 `src.service.foo.Foo.bar`。数据库写入
    时会把 `cg_nodes.full_name` 统一保存为 dotted 形式。

    注意：这是写入侧归一化工具，reference 查询入参不调用它；查询入参只
    清理空白后直接与库里的 `func_name` / `full_name` 匹配。
    """
    if not raw:
        return ""
    normalized = raw.strip().replace("\\", "/").lstrip("/").replace("/", ".")
    while ".." in normalized:
        normalized = normalized.replace("..", ".")
    return normalized.strip(".")


class CallgraphSqlAccessor:
    """基于 CallgraphDB 的查询封装（cg_* 与 function_defs 同库）。"""

    def __init__(
        self,
        cg: CallgraphDB,
        project_path: Path,
    ):
        self._cg = cg
        self._project_path = project_path

    def _q(self, sql: str, params: list | None = None) -> list[dict]:
        return self._cg.query(sql, params or [])

    def _build_function_node_query_attempts(
        self, ctx: FunctionNodeQueryContext
    ) -> list[FunctionNodeQueryPlan]:
        # 这里先只判断“字段是否可用于本次查询”，不直接拼 SQL。
        # 这样 root 定位的降级顺序由 _FUNCTION_NODE_QUERY_PLAN 统一控制，
        # 后续新增 class_fqn、sourcefile_prefix 等字段时，也只需要扩展字段可用性和计划表。
        available = {
            "file_path": bool(ctx.file_path),
            # line 单独存在没有定位意义；必须和 file_path 一起出现，才表示“某文件的某个定义行”。
            "line": ctx.line > 0 and bool(ctx.file_path),
            "name": bool(ctx.name),
            "function_fqn": bool(ctx.function_fqn),
        }
        # 按计划表顺序过滤可执行 attempt：字段都可用才保留。
        # 例如四个字段都有时，会得到 file_line -> file_name_fqn -> file_fqn -> name_fqn -> fqn -> name。
        return [
            spec
            for spec in _FUNCTION_NODE_QUERY_PLAN
            if all(available[field] for field in spec.fields)
        ]

    def _append_function_node_field_condition(
        self,
        field: str,
        active_fields: tuple[str, ...],
        ctx: FunctionNodeQueryContext,
        conditions: list[str],
        params: list[Any],
    ) -> None:
        if field == "file_path":
            # file_path 来自用户输入，可能是相对路径，也可能带平台分隔符。
            # cg_nodes.func_def_sourcefile 保存的是 posix 风格路径；先统一路径格式，再同时支持精确匹配和尾缀匹配。
            fp = Path(ctx.file_path).as_posix()
            conditions.append("(func_def_sourcefile = ? OR regexp_matches(func_def_sourcefile, ?))")
            params.extend([fp, rf"(^|/){re.escape(fp)}$"])
            return

        if field == "line":
            # line 只在 file_path 可用时才会进入 attempt。用户可能传入函数体内部任意行，
            # 不能把它收窄成 func_def_start_line 精确匹配；BETWEEN 是闭区间，能直接表达
            # “输入行号落在函数定义 start/end 范围内”的 root 定位语义。
            # start/end 任一缺失时无法构成可靠范围，直接跳过该候选，避免退化成
            # start_line <= line 后误命中同文件中所有更早开始的函数。
            conditions.append(
                "(func_def_start_line IS NOT NULL AND "
                "func_def_end_line IS NOT NULL AND "
                "? BETWEEN func_def_start_line AND func_def_end_line)"
            )
            params.append(int(ctx.line))
            return

        if field == "name":
            # name 对应 cg_nodes.func_name；use_regex=True 时保留原有正则语义，否则使用短名精确匹配。
            if ctx.use_regex:
                conditions.append("regexp_matches(func_name, ?)")
                params.append(ctx.name)
            else:
                conditions.append("func_name = ?")
                params.append(ctx.name)
            return

        if field == "function_fqn":
            # function_fqn 对应 cg_nodes.full_name。full_name 在 JS 场景可能存在 path-style/dotted-style 差异，
            # 因此同时做完整精确匹配和 dotted 段边界尾缀匹配。
            fqn_conditions = ["full_name = ?", "regexp_matches(full_name, ?)"]
            fqn_params: list[Any] = [ctx.function_fqn, _segment_suffix_regex(ctx.function_fqn)]

            if "name" not in active_fields:
                # 只有 FQN、没有 name 时，额外从 FQN 最后一段推导 func_name，减少同尾缀误召。
                last_segment = ctx.function_fqn.rsplit(".", 1)[-1]
                if last_segment:
                    conditions.append("func_name = ?")
                    params.append(last_segment)

            conditions.append("(" + " OR ".join(fqn_conditions) + ")")
            params.extend(fqn_params)
            return

        raise ValueError(f"Unsupported function node query field: {field}")

    def _build_function_node_where(
        self, spec: FunctionNodeQueryPlan, ctx: FunctionNodeQueryContext
    ) -> tuple[str, list[Any]]:
        # 每次 attempt 都从 language 开始，避免跨语言项目中把同名函数混在一起。
        conditions: list[str] = ["language = ?"]
        params: list[Any] = [ctx.language.value]

        # 只拼接本 attempt 声明的字段条件；不要把 ctx 里其他非空字段偷偷带进来，
        # 否则降级链会退化成“一次性全字段 AND”，召回能力会明显下降。
        for field in spec.fields:
            self._append_function_node_field_condition(field, spec.fields, ctx, conditions, params)

        if ctx.need_definition:
            # get_call_graph root 必须是真实函数定义：排除 external 和只有占位信息的节点。
            # get_reference_by_function 不打开该开关，避免影响引用查询对 external/placeholder 的召回。
            conditions.extend([
                "is_external = FALSE",
                "func_def_sourcefile IS NOT NULL",
                "func_def_start_line IS NOT NULL",
                "func_def_end_line IS NOT NULL",
            ])

        return " AND ".join(conditions), params

    def _query_function_nodes_id(
        self, spec: FunctionNodeQueryPlan, ctx: FunctionNodeQueryContext
    ) -> list[dict]:
        # spec.strategy 只用于日志/测试识别降级层级；真正的 SQL 条件由 spec.fields 构造。
        where, params = self._build_function_node_where(spec, ctx)
        return self._q(
            f"""
            SELECT node_id, full_name, func_name, is_external,
                   func_def_sourcefile, func_def_start_line, func_def_start_col,
                   func_def_end_line, func_def_end_col
            FROM cg_nodes
            WHERE {where}
            ORDER BY
                CASE WHEN func_def_sourcefile IS NULL THEN 1 ELSE 0 END,
                func_def_sourcefile,
                func_def_start_line,
                node_id
            """,
            params,
        )

    @timed(logger, "callgraph_query", "query_function_node_ids")
    def query_function_node_ids(
        self,
        language: Language,
        name: str = "",
        function_fqn: str = "",
        file_path: str = "",
        line: int = 0,
        use_regex: bool = False,
        need_definition: bool = False,
    ) -> list[dict]:
        # 对外入口先把原始入参规整成不可变查询上下文，后续所有降级 attempt 都消费同一份 ctx。
        ctx = FunctionNodeQueryContext(
            language=language,
            name=name.strip(),
            function_fqn=function_fqn.strip(),
            file_path=file_path.strip(),
            line=line,
            use_regex=use_regex,
            need_definition=need_definition,
        )

        # 按计划顺序逐级尝试。只要某一级命中，就立即返回，避免更宽松的查询把 root 候选放大。
        for spec in self._build_function_node_query_attempts(ctx):
            rows = self._query_function_nodes_id(spec, ctx)
            if rows:
                return rows
        return []

    @timed(logger, "callgraph_query", "find_user_defined_functions")
    def find_user_defined_functions(
        self,
        language: Language,
        name: str = "",
        function_fqn: str = "",
        function_signature: str = "",
        file_path: str = "",
        line: int = 0,
        use_regex: bool = False,
    ) -> list[models.FunctionDef]:
        lang = language.value
        rows = self._search_function_defs_rows(
            lang, name, function_fqn, function_signature, use_regex
        )
        out: list[models.FunctionDef] = []
        q_fp = Path(file_path) if file_path else Path(".")

        # 当 function_fqn 非空时，使用 ParamsValidator 做精确二次过滤
        effective_fqn = function_fqn if function_fqn else name

        for fd in rows:
            if function_fqn:
                # contains 语义：function_fqn 用模糊匹配（endswith），支持「短类名+函数」
                # 匹配完整 FQCN；signature/file/line 仍按各自语义校验。
                if not ParamsValidator.validate(
                    fuzzy_match=True,
                    fqn=(function_fqn, fd["function_fqn"]),
                ):
                    continue
                if function_signature and not ParamsValidator.validate(
                    fuzzy_match=True,
                    signature=(function_signature, fd["function_signature"]),
                ):
                    continue
                if not ParamsValidator.validate(
                    fuzzy_match=False,
                    file_path=(q_fp, Path(fd["file_path"])),
                    line=(line, int(fd["start_line"])),
                ):
                    continue
            node_row = self._find_internal_node_for_function_def(fd, lang)
            if not node_row:
                continue
            out.append(
                models.FunctionDef(
                    node_id=node_row["node_id"],
                    function_fqn=fd["function_fqn"],
                    function_signature=fd["function_signature"],
                    location=models.Location(
                        file_path=Path(fd["file_path"]),
                        start_line=int(fd["start_line"]),
                        start_column=int(fd["start_column"]),
                        end_line=int(fd["end_line"]),
                        end_column=int(fd["end_column"]),
                    ),
                )
            )
        return out

    def _search_function_defs_rows(
        self,
        lang: str,
        name: str,
        function_fqn: str,
        function_signature: str,
        use_regex: bool,
    ) -> list[dict]:
        """拉取 function_defs 候选行。function_fqn 非空时优先精确匹配，否则按 name 匹配。"""
        conditions: list[str] = ["language = ?"]
        params: list[Any] = [lang]

        if function_fqn:
            # 段边界匹配：支持「短类名+函数」按 . 段边界命中完整 FQCN，
            # 排除段被截断的误命中（如 A.foo 不命中 A.fooBar）。
            conditions.append("regexp_matches(function_fqn, ?)")
            params.append(segment_boundary_regex(function_fqn))
        elif name:
            if use_regex:
                conditions.append("(regexp_matches(function_fqn, ?) OR regexp_matches(short_name, ?))")
                params.extend([name, name])
            else:
                conditions.append("(regexp_matches(function_fqn, ?) OR short_name = ?)")
                params.extend([segment_boundary_regex(name), name])

        if function_signature:
            sig_prefix = function_signature.split("(")[0].strip()
            conditions.append("function_signature LIKE ?")
            params.append(_like_param(sig_prefix) if sig_prefix else _like_param(function_signature))

        where = " AND ".join(conditions)
        sql = f"SELECT function_fqn, function_signature, file_path, start_line, start_column, end_line, end_column FROM function_defs WHERE {where}"
        return self._q(sql, params)

    def _find_internal_node_for_function_def(self, fd: dict, lang: str) -> dict | None:
        # 条件顺序：先 file + 行/列（可走 idx_cg_nodes_func_def_file 与 func_def_start_line），再 language / is_external
        rows = self._q(
            """
            SELECT node_id, full_name, is_external, func_def_sourcefile, func_def_start_line,
                   func_def_start_col, func_def_end_line, func_def_end_col, func_name
            FROM cg_nodes
            WHERE func_def_sourcefile = ?
              AND func_def_start_line = ?
              AND func_def_start_col = ?
              AND language = ?
              AND is_external = FALSE
            """,
            [
                fd["file_path"],
                int(fd["start_line"]),
                int(fd["start_column"]),
                lang,
            ],
        )
        return rows[0] if rows else None

    @timed(logger, "callgraph_query", "find_external_functions")
    def find_external_functions(
        self,
        language: Language,
        function_fqn: str,
        fuzzy_match: bool,
    ) -> list[models.FunctionDef]:
        if not function_fqn:
            return []

        lang = language.value
        # 模糊：fqn 语义为 endswith，且支持用户自带 % 通配符（对齐 duckdb_repo）
        if fuzzy_match and "%" not in function_fqn:
            pat = f"%{_escape_like_literal(''.join(function_fqn.split()))}"
            rows = self._q(
                """
                SELECT node_id, full_name FROM cg_nodes
                WHERE language = ? AND is_external = TRUE
                  AND REPLACE(full_name, ' ', '') LIKE ? ESCAPE '\\'
                """,
                [lang, pat],
            )
        elif fuzzy_match:
            rows = self._q(
                """
                SELECT node_id, full_name FROM cg_nodes
                WHERE language = ? AND is_external = TRUE AND full_name LIKE ?
                """,
                [lang, function_fqn],
            )
        else:
            rows = self._q(
                """
                SELECT node_id, full_name FROM cg_nodes
                WHERE language = ? AND is_external = TRUE AND full_name = ?
                """,
                [lang, function_fqn],
            )

        out: list[models.FunctionDef] = []
        for r in rows:
            fn = r["full_name"]
            if not ParamsValidator.validate(
                fuzzy_match=fuzzy_match,
                fqn=(function_fqn, fn),
            ):
                continue
            fd = self.build_function_def_from_node_row(language, r["node_id"])
            if fd:
                out.append(fd)
        return out

    @timed(logger, "callgraph_query", "build_function_def_from_node_id")
    def build_function_def_from_node_id(
        self, language: Language, node_id: str
    ) -> models.FunctionDef | None:
        rows = self._q(
            """
            SELECT node_id, full_name, is_external, func_name,
                   func_def_sourcefile, func_def_start_line, func_def_start_col,
                   func_def_end_line, func_def_end_col
            FROM cg_nodes
            WHERE language = ? AND node_id = ?
            """,
            [language.value, node_id],
        )
        if not rows:
            return None
        r = rows[0]
        if r.get("is_external"):
            return self._function_def_from_joined_row(language, r, None, None)

        if r.get("func_def_sourcefile") is None:
            return None

        uql_fqn: str | None = None
        uql_sig: str | None = None
        urows = self._q(
            """
            SELECT function_fqn, function_signature FROM function_defs
            WHERE file_path = ? AND start_line = ? AND start_column = ? AND language = ?
            """,
            [
                r["func_def_sourcefile"],
                int(r["func_def_start_line"] or 0),
                int(r["func_def_start_col"] or 0),
                language.value,
            ],
        )
        if urows:
            uql_fqn = urows[0]["function_fqn"]
            uql_sig = urows[0]["function_signature"]

        return self._function_def_from_joined_row(language, r, uql_fqn, uql_sig)

    def build_function_def_from_node_row(
        self, language: Language, node_id: str
    ) -> models.FunctionDef | None:
        return self.build_function_def_from_node_id(language, node_id)

    def build_function_def_from_cg_node_id(
        self, language: Language, node_id: str
    ) -> models.FunctionDef | None:
        return self.build_function_defs_from_cg_node_ids(language, [node_id]).get(node_id)

    @timed(logger, "callgraph_query", "build_function_defs_from_cg_node_ids")
    def build_function_defs_from_cg_node_ids(
        self, language: Language, node_ids: list[str]
    ) -> dict[str, models.FunctionDef]:
        ids = list(dict.fromkeys(node_ids))
        if not ids:
            return {}

        placeholders = ", ".join(["?" for _ in ids])
        rows = self._q(
            f"""
            SELECT node_id, full_name, is_external, func_name,
                   func_def_sourcefile, func_def_start_line, func_def_start_col,
                   func_def_end_line, func_def_end_col
            FROM cg_nodes
            WHERE language = ? AND node_id IN ({placeholders})
            """,
            [language.value, *ids],
        )

        out: dict[str, models.FunctionDef] = {}
        for r in rows:
            if r.get("func_def_sourcefile") is None:
                out[r["node_id"]] = models.FunctionDef(
                    node_id=r["node_id"],
                    function_fqn=r["full_name"],
                    function_signature="",
                    location=models.Location.default(),
                )
                continue

            out[r["node_id"]] = models.FunctionDef(
                node_id=r["node_id"],
                function_fqn=r["full_name"],
                function_signature="",
                location=models.Location(
                    file_path=Path(r["func_def_sourcefile"]),
                    start_line=int(r["func_def_start_line"] or 0),
                    start_column=int(r["func_def_start_col"] or 0),
                    end_line=int(r["func_def_end_line"] or 0),
                    end_column=int(r["func_def_end_col"] or 0),
                ),
            )
        return out

    def _function_def_from_joined_row(
        self,
        language: Language,
        row: dict,
        uql_fqn: str | None,
        uql_sig: str | None,
    ) -> models.FunctionDef | None:
        _ = language
        if row.get("is_external"):
            return models.FunctionDef(
                node_id=row["node_id"],
                function_fqn=row["full_name"],
                function_signature=row["full_name"].strip().split(".")[-1] + "()",
                location=models.Location.default(),
            )
        if row.get("func_def_sourcefile") is None:
            return None
        loc = models.Location(
            file_path=Path(row["func_def_sourcefile"]),
            start_line=int(row["func_def_start_line"] or 0),
            start_column=int(row["func_def_start_col"] or 0),
            end_line=int(row["func_def_end_line"] or 0),
            end_column=int(row["func_def_end_col"] or 0),
        )
        if uql_fqn:
            return models.FunctionDef(
                node_id=row["node_id"],
                function_fqn=uql_fqn,
                function_signature=uql_sig or "",
                location=loc,
            )
        fn = row["full_name"]
        return models.FunctionDef(
            node_id=row["node_id"],
            function_fqn=fn,
            function_signature=fn.strip().split(".")[-1] + "()",
            location=loc,
        )

    @timed(logger, "callgraph_query", "get_incoming_edges")
    def get_incoming_edges(
        self, language: Language, target_node_id: str,
        limit: int = 0, offset: int = 0,
    ) -> list[dict]:
        sql = """
            SELECT e.id, e.source_node_id, e.target_node_id, e.call_site_id,
                   cs.call_site_sourcefile, cs.call_site_start_line, cs.call_site_start_col,
                   cs.call_site_end_line, cs.call_site_end_col
            FROM cg_edges e
            INNER JOIN cg_call_sites cs
              ON e.call_site_id = cs.call_site_id AND e.language = cs.language
            WHERE e.language = ? AND e.target_node_id = ? AND e.call_site_id IS NOT NULL
        """
        params: list = [language.value, target_node_id]
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        if offset > 0:
            sql += " OFFSET ?"
            params.append(offset)
        return self._q(sql, params)

    @timed(logger, "callgraph_query", "get_incoming_edges_for_targets")
    def get_incoming_edges_for_targets(
        self,
        language: Language,
        target_node_ids: list[str],
        limit: int = 0,
        offset: int = 0,
    ) -> list[dict]:
        if not target_node_ids:
            return []
        ids = list(dict.fromkeys(target_node_ids))
        placeholders = ", ".join(["?" for _ in ids])
        sql = f"""
            SELECT e.id, e.source_node_id, e.target_node_id, e.call_site_id,
                   cs.call_site_sourcefile, cs.call_site_start_line, cs.call_site_start_col,
                   cs.call_site_end_line, cs.call_site_end_col
            FROM cg_edges e
            INNER JOIN cg_call_sites cs
              ON e.call_site_id = cs.call_site_id AND e.language = cs.language
            WHERE e.language = ? AND e.target_node_id IN ({placeholders})
              AND e.call_site_id IS NOT NULL
            ORDER BY cs.call_site_sourcefile, cs.call_site_start_line, cs.call_site_start_col,
                     e.source_node_id, e.target_node_id
        """
        params: list[Any] = [language.value, *ids]
        if limit > 0:
            sql += " LIMIT ?"
            params.append(limit)
        if offset > 0:
            sql += " OFFSET ?"
            params.append(offset)
        return self._q(sql, params)

    @timed(logger, "callgraph_query", "get_outgoing_edges")
    def get_outgoing_edges(self, language: Language, source_node_id: str) -> list[dict]:
        return self.get_outgoing_edges_for_sources(language, [source_node_id])

    @timed(logger, "callgraph_query", "get_outgoing_edges_for_sources")
    def get_outgoing_edges_for_sources(
        self, language: Language, source_node_ids: list[str]
    ) -> list[dict]:
        ids = list(dict.fromkeys(source_node_ids))
        if not ids:
            return []
        placeholders = ", ".join(["?" for _ in ids])
        return self._q(
            f"""
            SELECT e.id, e.source_node_id, e.target_node_id, e.call_site_id,
                   cs.call_site_sourcefile, cs.call_site_start_line, cs.call_site_start_col,
                   cs.call_site_end_line, cs.call_site_end_col
            FROM cg_edges e
            INNER JOIN cg_call_sites cs
              ON e.call_site_id = cs.call_site_id AND e.language = cs.language
            WHERE e.language = ? AND e.source_node_id IN ({placeholders})
              AND e.call_site_id IS NOT NULL
            ORDER BY e.source_node_id, cs.call_site_start_line, cs.call_site_start_col, e.target_node_id
            """,
            [language.value, *ids],
        )

    @timed(logger, "callgraph_query", "recursive_outgoing_call_tree_edges")
    def recursive_outgoing_call_tree_edges(
        self,
        language: Language,
        root_node_id: str,
        max_depth: int,
    ) -> list[dict]:
        """
        使用 DuckDB `WITH RECURSIVE` 自根节点展开带调用点的出边，路径上 `list_contains` 做环剪枝。

        与 `get_outgoing_edges` 一致仅保留 `call_site_id IS NOT NULL` 的边。
        `max_depth` 语义对齐 CallGraphTraversor 的旧版 DFS：仅当 `ct.depth < max_depth` 时继续向下递归。

        说明：环上的边在 SQL 中被直接丢弃，不会产生 `has_cycle=True` 的 Callee（与应用层 DFS 略有差异）。
        """
        lang = language.value
        sql = """
WITH RECURSIVE call_tree AS (
    SELECT
        e.source_node_id,
        e.target_node_id,
        e.id AS edge_id,
        cs.call_site_sourcefile,
        cs.call_site_start_line,
        cs.call_site_start_col,
        cs.call_site_end_line,
        cs.call_site_end_col,
        1 AS depth,
        LIST_VALUE(e.source_node_id) AS path_nodes,
        e.language AS lang
    FROM cg_edges e
    INNER JOIN cg_call_sites cs
      ON e.call_site_id = cs.call_site_id AND e.language = cs.language
    WHERE e.language = ? AND e.source_node_id = ? AND e.call_site_id IS NOT NULL
      AND NOT list_contains(LIST_VALUE(e.source_node_id), e.target_node_id)

    UNION ALL

    SELECT
        e.source_node_id,
        e.target_node_id,
        e.id,
        cs.call_site_sourcefile,
        cs.call_site_start_line,
        cs.call_site_start_col,
        cs.call_site_end_line,
        cs.call_site_end_col,
        ct.depth + 1,
        list_concat(ct.path_nodes, LIST_VALUE(ct.target_node_id)),
        e.language
    FROM call_tree ct
    INNER JOIN cg_edges e
      ON e.source_node_id = ct.target_node_id AND e.language = ct.lang
    INNER JOIN cg_call_sites cs
      ON e.call_site_id = cs.call_site_id AND e.language = cs.language
    WHERE e.call_site_id IS NOT NULL
      AND ct.depth < ?
      AND NOT list_contains(
          list_concat(ct.path_nodes, LIST_VALUE(ct.target_node_id)),
          e.target_node_id
      )
)
SELECT
    source_node_id,
    target_node_id,
    edge_id,
    call_site_sourcefile,
    call_site_start_line,
    call_site_start_col,
    call_site_end_line,
    call_site_end_col,
    depth
FROM call_tree
ORDER BY depth, call_site_start_line, call_site_start_col
"""
        return self._q(sql, [lang, root_node_id, max_depth])

    @timed(logger, "callgraph_query", "iter_edges_with_callsites")
    def iter_edges_with_callsites(self, language: Language) -> list[dict]:
        """get_function_by_call：一次性拉取带调用点的边（避免逐边遍历整张图）。"""
        return self._q(
            """
            SELECT e.source_node_id, e.target_node_id,
                   cs.call_site_sourcefile, cs.call_site_start_line, cs.call_site_start_col,
                   cs.call_site_end_line, cs.call_site_end_col
            FROM cg_edges e
            INNER JOIN cg_call_sites cs
              ON e.call_site_id = cs.call_site_id AND e.language = cs.language
            WHERE e.language = ? AND e.call_site_id IS NOT NULL
            """,
            [language.value],
        )

    def get_edges_by_callsite_range(
        self,
        language: Language,
        file_path: Path | str,
        start_line: int,
        end_line: int,
    ) -> list[dict]:
        """get_function_by_call: 按调用点文件和行号范围查询调用边。

        注意：逐点查路径，不再打 @timed，避免 N 次点查产生海量噪音日志。
        批量调用请改用 ``batch_get_edges_by_callsite_ranges``。
        """
        return self._q(
            """
            SELECT e.source_node_id, e.target_node_id,
                   cs.call_site_sourcefile, cs.call_site_start_line, cs.call_site_start_col,
                   cs.call_site_end_line, cs.call_site_end_col
            FROM cg_edges e
            INNER JOIN cg_call_sites cs
              ON e.call_site_id = cs.call_site_id AND e.language = cs.language
            WHERE e.language = ? AND e.call_site_id IS NOT NULL
              AND cs.call_site_sourcefile = ?
              AND cs.call_site_start_line BETWEEN ? AND ?
            ORDER BY cs.call_site_start_line, cs.call_site_start_col
            """,
            [language.value, Path(file_path).as_posix(), start_line, end_line],
        )

    @timed(logger, "callgraph_query", "batch_get_edges_by_callsite_ranges")
    def batch_get_edges_by_callsite_ranges(
        self,
        language: Language,
        callsites: list[tuple[str, int, int]],
    ) -> list[dict]:
        """get_function_by_call: 一批 (file, start_line, end_line) 调用点范围批量查调用边。

        - ``callsites`` 元素为 ``(rel_path, start_line, end_line)``，语义与
          ``get_edges_by_callsite_range`` 完全一致：``cs.call_site_start_line BETWEEN
          start_line AND end_line``（只看起始行）。
        - 一次 SQL 用行值 ``(call_site_sourcefile, call_site_start_line) IN (...)``
          替代 N 次逐点点查；返回字段与逐点查一致。
        - 空输入返回 []，不发起查询。
        """
        if not callsites:
            return []

        lang = language.value
        # 行值 IN：每个调用点贡献 (file, start_line) 两个占位符，范围 end_line 用
        # BETWEEN ? AND ? 由同行的 start/end 控制。这里用 (file, start_line) 行值
        # 命中起行，再在每条候选的 (start_line, end_line) 区间内做 OR。
        # 实现上展开为 ((file1, s1) OR ... ) AND start_line BETWEEN end 不好统一，
        # 因此采用逐候选 OR 子句拼接，每候选三项占位符：file, start, end。
        clauses: list[str] = []
        params: list = [lang]
        for rel_path, start_line, end_line in callsites:
            clauses.append(
                "(cs.call_site_sourcefile = ? AND cs.call_site_start_line BETWEEN ? AND ?)"
            )
            params.extend([Path(rel_path).as_posix(), start_line, end_line])

        where_or = " OR ".join(clauses)
        return self._q(
            f"""
            SELECT e.source_node_id, e.target_node_id,
                   cs.call_site_sourcefile, cs.call_site_start_line, cs.call_site_start_col,
                   cs.call_site_end_line, cs.call_site_end_col
            FROM cg_edges e
            INNER JOIN cg_call_sites cs
              ON e.call_site_id = cs.call_site_id AND e.language = cs.language
            WHERE e.language = ? AND e.call_site_id IS NOT NULL
              AND ({where_or})
            ORDER BY cs.call_site_sourcefile, cs.call_site_start_line, cs.call_site_start_col
            """,
            params,
        )

    @timed(logger, "callgraph_query", "batch_get_remote_calls_by_callsites")
    def batch_get_remote_calls_by_callsites(
        self,
        language: Language,
        callsites: list[tuple[str, int]],
    ) -> list[dict]:
        """按候选调用点批量查询 remote_calls，匹配完全由 DuckDB 完成。"""
        if not callsites:
            return []

        unique_callsites = list(
            dict.fromkeys(
                (Path(file_path).as_posix().lstrip("/"), line)
                for file_path, line in callsites
            )
        )
        values = ", ".join("(?, ?)" for _ in unique_callsites)
        params: list = [
            value
            for file_path, line in unique_callsites
            for value in (file_path, line)
        ]
        params.append(language.value)
        return self._q(
            f"""
            WITH candidate_callsites(sourcefile, line) AS (
                VALUES {values}
            )
            SELECT rc.call_site_sourcefile, rc.call_site_start_line,
                   rc.call_site_end_line, rc.caller_name, rc.callee_name,
                   rc.framework, rc.protocol, rc.remote_interface_fqn,
                   rc.remote_method_name, rc.remote_repo_url, rc.remote_repo_file
            FROM candidate_callsites candidate
            INNER JOIN remote_calls rc
              ON rc.call_site_sourcefile = candidate.sourcefile
             AND candidate.line BETWEEN rc.call_site_start_line
                                    AND rc.call_site_end_line
            WHERE rc.language = ?
              AND rc.remote_repo_url IS NOT NULL
            ORDER BY rc.call_site_sourcefile,
                     rc.call_site_start_line,
                     rc.call_site_end_line
            """,
            params,
        )

    @timed(logger, "callgraph_query", "batch_build_function_defs")
    def batch_build_function_defs(
        self, language: Language, node_ids: set[str]
    ) -> dict[str, models.FunctionDef | None]:
        """批量版 build_function_def_from_node_id：单次 LEFT JOIN 替代 N 次逐条查询。"""
        if not node_ids:
            return {}
        ids = list(node_ids)
        placeholders = ", ".join(["?" for _ in ids])
        rows = self._q(
            f"""
            SELECT n.node_id, n.full_name, n.is_external, n.func_name,
                   n.func_def_sourcefile, n.func_def_start_line, n.func_def_start_col,
                   n.func_def_end_line, n.func_def_end_col,
                   fd.function_fqn, fd.function_signature
            FROM cg_nodes n
            LEFT JOIN function_defs fd
              ON n.func_def_sourcefile = fd.file_path
             AND n.func_def_start_line = fd.start_line
             AND n.func_def_start_col = fd.start_column
             AND n.language = fd.language
            WHERE n.language = ? AND n.node_id IN ({placeholders})
            """,
            [language.value, *ids],
        )
        result: dict[str, models.FunctionDef | None] = {}
        for r in rows:
            nid = r["node_id"]
            if nid in result:
                continue
            if r.get("is_external"):
                result[nid] = self._function_def_from_joined_row(language, r, None, None)
            elif r.get("func_def_sourcefile") is None:
                result[nid] = None
            else:
                result[nid] = self._function_def_from_joined_row(
                    language, r, r.get("function_fqn"), r.get("function_signature")
                )
        return result

    def callsite_row_to_location(self, row: dict) -> models.Location:
        return models.Location(
            file_path=Path(row["call_site_sourcefile"]),
            start_line=int(row["call_site_start_line"]),
            start_column=int(row["call_site_start_col"] or 0),
            end_line=int(row["call_site_end_line"] or row["call_site_start_line"]),
            end_column=int(row["call_site_end_col"] or 0),
        )

    @timed(logger, "callgraph_query", "iter_edges_with_callsites_filtered")
    def iter_edges_with_callsites_filtered(
        self, language: Language, rel_files: set[str] | None
    ) -> list[dict]:
        """在 ripgrep 预筛文件集合上限制 call_site_sourcefile，减少返回行数。
        
        - rel_files=None: ripgrep 不可用 rel_files=set() (空集合): ripgrep 正常但无匹配，直接返回空列表
        - rel_files=非空集合: 按文件过滤
        """
        lang = language.value
        if rel_files is None or not rel_files:
            return []
        files = list(rel_files)
        placeholders = ", ".join(["?" for _ in files])
        return self._q(
            f"""
            SELECT e.source_node_id, e.target_node_id,
                   cs.call_site_sourcefile, cs.call_site_start_line, cs.call_site_start_col,
                   cs.call_site_end_line, cs.call_site_end_col
            FROM cg_edges e
            INNER JOIN cg_call_sites cs
              ON e.call_site_id = cs.call_site_id AND e.language = cs.language
            WHERE e.language = ? AND e.call_site_id IS NOT NULL
              AND cs.call_site_sourcefile IN ({placeholders})
            """,
            [lang, *files],
        )
