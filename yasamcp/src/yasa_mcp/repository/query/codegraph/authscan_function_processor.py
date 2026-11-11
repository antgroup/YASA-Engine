"""AuthScan 路由与接口查询均为空后的 CodeGraph 函数兜底。"""

from __future__ import annotations

import re

from yasa_mcp.repository.query.codegraph.codegraph_analysis_processor import (
    CodeGraphAnalysisProcessor,
)
from yasa_mcp.repository.query.codegraph.function_analysis_processor import (
    FunctionAnalysisProcessor,
)
from yasa_mcp.repository.query.codegraph.query_models import (
    CodeGraphQueryRepository,
    ConditionField,
    ConditionOperator,
    FunctionRecord,
    PreparedNodeQuery,
    PreparedNodeQueryBuilder,
    QueryCondition,
    QueryTemplate,
)
from yasa_mcp.util.codegraph_param_util import CodeGraphParamUtil


class AuthScanFunctionProcessor(CodeGraphAnalysisProcessor):
    """把旧 function_defs 的五类查询限制为受控 function_search 条件。"""

    def __init__(self, repository: CodeGraphQueryRepository, language: str):
        super().__init__(repository)
        self.language = language.strip().lower()

    @staticmethod
    def _condition(
        field: ConditionField, operator: ConditionOperator, value: str
    ) -> QueryCondition:
        return QueryCondition(field, operator, value)

    @staticmethod
    def _classify(api_name: str) -> tuple[str, str, str] | None:
        source = (api_name or "").strip()
        if not source or "/" in source:
            return None
        parts = [part for part in source.replace("::", ".").split(".") if part]
        if not parts:
            return None
        if len(parts) == 1:
            return ("short_class", parts[0], "") if parts[0][:1].isupper() else None
        if len(parts) == 2:
            if parts[0][:1].isupper() and parts[1][:1].islower():
                return "short_method", parts[0], parts[1]
            return None
        if parts[-1][:1].isupper():
            return "fqcn_class", ".".join(parts), ""
        if parts[-1][:1].islower():
            return "fqcn_method", ".".join(parts[:-1]), parts[-1]
        return None

    def _query(
        self, strategy: str, fqn_operator: ConditionOperator, fqn_value: str
    ) -> PreparedNodeQuery:
        return PreparedNodeQueryBuilder.build(
            strategy,
            QueryTemplate.FUNCTION_SEARCH,
            (
                self._condition(
                    ConditionField.LANGUAGE, ConditionOperator.EQ, self.language
                ),
                self._condition(
                    ConditionField.QUALIFIED_NAME, fqn_operator, fqn_value
                ),
            ),
        )

    def _build_queries(
        self, api_name: str, use_regex: bool
    ) -> tuple[PreparedNodeQuery, ...]:
        source = (api_name or "").strip()
        if not source or not self.language:
            return ()
        if use_regex:
            return (
                self._query(
                    "authscan_function_regex",
                    ConditionOperator.REGEX,
                    CodeGraphParamUtil.adapt_fqn_regex(source),
                ),
            )

        classified = self._classify(source)
        if classified is None:
            return ()
        kind, owner, method_name = classified
        if kind == "fqcn_method":
            dotted_fqn = f"{owner}.{method_name}"
            exact_candidates = CodeGraphParamUtil.build_method_fqn_candidates(dotted_fqn)
            queries = [
                self._query(
                    "authscan_function_fqcn_exact", ConditionOperator.EQ, candidate
                )
                for candidate in exact_candidates
            ]
            suffix = CodeGraphParamUtil.build_method_fqn_suffix_regex(dotted_fqn)
            if suffix:
                queries.append(
                    self._query(
                        "authscan_function_fqcn_suffix",
                        ConditionOperator.REGEX,
                        suffix,
                    )
                )
            return tuple(queries)
        escaped_owner = re.escape(owner)
        if kind == "short_method":
            pattern = rf"(?:^|\.|::){escaped_owner}::{re.escape(method_name)}$"
        elif kind == "fqcn_class":
            candidates = CodeGraphParamUtil.build_class_fqn_candidates(owner)
            if not candidates:
                return ()
            pattern = rf"^{re.escape(candidates[0])}::[^:]+$"
        else:
            pattern = rf"(?:^|\.|::){escaped_owner}::[^:]+$"
        return (
            self._query(
                f"authscan_function_{kind}", ConditionOperator.REGEX, pattern
            ),
        )

    def search(
        self,
        api_name: str,
        use_regex: bool = False,
        limit: int = 0,
        project_path: str = ".",
    ) -> list[FunctionRecord]:
        """class-only 保留专用 owner 查询，具体函数委托统一 processor。"""
        source = (api_name or "").strip()
        if use_regex:
            return FunctionAnalysisProcessor(
                self.repository,
                project_path=project_path,
                function_fqn=source,
                use_regex=True,
            ).search(limit=limit, offset=0)

        classified = self._classify(source)
        if classified is None:
            return []
        kind, _, method_name = classified
        if kind in {"fqcn_method", "short_method"}:
            return FunctionAnalysisProcessor(
                self.repository,
                project_path=project_path,
                name=method_name,
                function_fqn=source,
            ).search(limit=limit, offset=0)

        return self._run_prepared_queries(
            self._build_queries(source, False),
            self.repository.execute_function_query,
            limit,
            0,
        )
