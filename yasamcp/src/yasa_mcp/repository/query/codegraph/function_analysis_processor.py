"""函数输入分类，以及函数、文件查询的请求级编排。"""

from __future__ import annotations

from pathlib import Path

from yasa_mcp.repository.query.codegraph.codegraph_analysis_processor import CodeGraphAnalysisProcessor
from yasa_mcp.repository.query.codegraph.query_models import (
    ClassifiedFunctionInput,
    CodeGraphQueryRepository,
    ConditionField,
    ConditionOperator,
    FunctionInputKind,
    FunctionRecord,
    PreparedNodeQuery,
    PreparedNodeQueryBuilder,
    QueryCondition,
    QueryConditionGroup,
    QueryTemplate,
)
from yasa_mcp.util.codegraph_param_util import CodeGraphParamUtil
from yasa_mcp.util.selector_util import normalize_selector


class FunctionInputClassifier:
    """结合类型段命名与包前缀识别 FQCN，保守地把不确定输入归入 suffix。"""

    @staticmethod
    def classify(value: str, use_regex: bool = False) -> ClassifiedFunctionInput:
        source = (value or "").strip()
        if not source:
            return ClassifiedFunctionInput(FunctionInputKind.EMPTY)
        if use_regex:
            return ClassifiedFunctionInput(
                FunctionInputKind.REGEX_FQCN,
                regex_candidate=CodeGraphParamUtil.adapt_fqn_regex(source),
            )
        normalized_parts = [part for part in source.replace("::", ".").split(".") if part]
        if len(normalized_parts) < 2:
            return ClassifiedFunctionInput(FunctionInputKind.EMPTY)

        has_package_prefix = len(normalized_parts) >= 4
        # 四段及以上才能证明至少存在包前缀、owner 和 member；分隔符及 owner 大小写
        # 不改变该边界。少于四段只能证明 owner/member 后缀，不能尝试 FQN exact。
        if not has_package_prefix:
            suffix_regex = CodeGraphParamUtil.build_method_fqn_suffix_regex(source)
            return ClassifiedFunctionInput(
                FunctionInputKind.OWNER_MEMBER_SUFFIX,
                regex_candidate=suffix_regex,
            )

        candidates = tuple(CodeGraphParamUtil.build_method_fqn_candidates(source))
        kind = (
            FunctionInputKind.FULL_STORED_FQCN
            if "::" in source
            else FunctionInputKind.FULL_DOTTED_FQCN
        )
        return ClassifiedFunctionInput(kind, exact_candidates=candidates)


class FunctionAnalysisProcessor(CodeGraphAnalysisProcessor):
    """分类先于降级：完整 FQCN 走索引，短/tail FQCN 直接走边界 suffix。"""

    def __init__(
        self,
        repository: CodeGraphQueryRepository,
        project_path: Path | str = ".",
        name: str | list[str] | tuple[str, ...] = "",
        function_fqn: str | list[str] | tuple[str, ...] = "",
        use_regex: bool = False,
    ):
        super().__init__(repository)
        self.project_path = Path(project_path)
        self.names = normalize_selector(name)
        self.function_fqns = normalize_selector(function_fqn)
        self.name = self.names[0] if len(self.names) == 1 else ""
        self.function_fqn = self.function_fqns[0] if len(self.function_fqns) == 1 else ""
        self.use_regex = use_regex
        self.file_path = "."
        self.file_paths: tuple[str, ...] = ()
        self.classified_input = FunctionInputClassifier.classify(self.function_fqn, use_regex)
        self._multi_selector = not isinstance(name, str) or not isinstance(function_fqn, str) or len(self.names) > 1 or len(self.function_fqns) > 1

    @staticmethod
    def _condition(field: ConditionField, operator: ConditionOperator, value: str) -> QueryCondition:
        return QueryCondition(field, operator, value)

    def _build_function_queries(self) -> tuple[PreparedNodeQuery, ...]:
        """把分类结果展开为不会跨查询族的确定性降级链。

        显式 regex FQCN 依次尝试 ``name regex + FQCN regex``、仅 FQCN regex、仅 name
        regex，且绝不混入 exact。完整 stored/dotted FQCN 优先使用索引友好的组合 exact，
        再放宽为仅 FQCN exact；所有可靠 FQCN 候选失败后，才允许按显式 name exact。
        ``OWNER_MEMBER_SUFFIX`` 无法证明包前缀完整，因此只能先执行带 ``.``/``::`` 段边界
        的 suffix regex，再按显式 name 或末段 member exact 降级，禁止构造 FQCN exact。
        查询执行器遇到首个非空结果即停止，所以这里的追加顺序就是对外可观察的降级顺序。
        """
        if self._multi_selector:
            return self._build_multi_function_queries()

        classified = self.classified_input
        name_eq = self._condition(ConditionField.NAME, ConditionOperator.EQ, self.name)
        name_regex = self._condition(ConditionField.NAME, ConditionOperator.REGEX, self.name)
        queries: list[PreparedNodeQuery] = []
        if classified.kind is FunctionInputKind.REGEX_FQCN:
            fqn = self._condition(
                ConditionField.QUALIFIED_NAME, ConditionOperator.REGEX, classified.regex_candidate
            )
            if self.name:
                # 第一优先级：name 与 FQCN 都按显式正则约束，先缩小跨 owner 的同名函数集合。
                queries.append(PreparedNodeQueryBuilder.build("function_name_fqn_regex", QueryTemplate.FUNCTION_SEARCH, (name_regex, fqn)))
            # 第二优先级：组合条件无结果时信任调用方的 FQCN 正则，允许 short name 不一致。
            queries.append(PreparedNodeQueryBuilder.build("function_fqn_regex", QueryTemplate.FUNCTION_SEARCH, (fqn,)))
            if self.name:
                # 最后降级：FQCN 正则无结果时仅按 name 正则返回候选，不混入任何 exact 条件。
                queries.append(PreparedNodeQueryBuilder.build("function_name_regex", QueryTemplate.FUNCTION_SEARCH, (name_regex,)))
            return tuple(queries)
        if classified.kind is FunctionInputKind.OWNER_MEMBER_SUFFIX:
            # util 已把每个名称段转义并加入 ``.``/``::`` 边界，processor 不再拼接 SQL 正则。
            suffix = self._condition(
                ConditionField.QUALIFIED_NAME,
                ConditionOperator.REGEX,
                classified.regex_candidate,
            )
            conditions = (name_eq, suffix) if self.name else (suffix,)
            # 第一优先级：仅查询完整 owner/member 段后缀；显式 name 存在时再叠加等值约束。
            queries.append(
                PreparedNodeQueryBuilder.build(
                    "function_fqn_suffix", QueryTemplate.FUNCTION_SEARCH, conditions
                )
            )
            # suffix 无结果后只允许按显式 name 或输入末段 member 降级，绝不补做 exact。
            fallback_name = self.name or self.function_fqn.replace("::", ".").rsplit(".", 1)[-1]
            if fallback_name:
                # 最后降级：仅使用显式或派生 member 短名等值，避免不完整 owner 被伪装成 exact FQCN。
                queries.append(
                    PreparedNodeQueryBuilder.build(
                        "function_name_exact",
                        QueryTemplate.FUNCTION_SEARCH,
                        (self._condition(ConditionField.NAME, ConditionOperator.EQ, fallback_name),),
                    )
                )
            return tuple(queries)
        for candidate in classified.exact_candidates:
            fqn = self._condition(ConditionField.QUALIFIED_NAME, ConditionOperator.EQ, candidate)
            if self.name:
                # 第一优先级：短名与确定性 FQCN 候选同时等值，精确率最高并保持索引友好。
                queries.append(PreparedNodeQueryBuilder.build("function_name_fqn_exact", QueryTemplate.FUNCTION_SEARCH, (name_eq, fqn)))
            # 第二优先级：忽略可能不一致的显式短名，仅按完整 FQCN 候选等值查询。
            queries.append(PreparedNodeQueryBuilder.build("function_fqn_exact", QueryTemplate.FUNCTION_SEARCH, (fqn,)))
        if self.name:
            operator = ConditionOperator.REGEX if self.use_regex else ConditionOperator.EQ
            # 最后降级：完整 FQCN 候选均失败后才按短名搜索；操作符与调用方模式保持一致。
            queries.append(PreparedNodeQueryBuilder.build("function_name_regex" if self.use_regex else "function_name_exact", QueryTemplate.FUNCTION_SEARCH, (self._condition(ConditionField.NAME, operator, self.name),)))
        return tuple(queries)

    def _build_multi_function_queries(self) -> tuple[PreparedNodeQuery, ...]:
        """Compile list selectors into one OR query per controlled fallback stage."""

        if self.use_regex:
            conditions: list[QueryCondition] = []
            for value in self.names:
                conditions.append(self._condition(ConditionField.NAME, ConditionOperator.REGEX, value))
            for value in self.function_fqns:
                adapted = CodeGraphParamUtil.adapt_fqn_regex(value)
                if adapted:
                    conditions.append(self._condition(ConditionField.QUALIFIED_NAME, ConditionOperator.REGEX, adapted))
            if not conditions:
                return ()
            return (
                PreparedNodeQueryBuilder.build(
                    "function_multi_regex",
                    QueryTemplate.FUNCTION_SEARCH,
                    (QueryConditionGroup(tuple(conditions), "OR"),),
                ),
            )

        exact_conditions: list[QueryCondition] = [
            self._condition(ConditionField.NAME, ConditionOperator.EQ, value)
            for value in self.names
        ]
        suffix_conditions: list[QueryCondition] = []
        for value in self.function_fqns:
            for candidate in FunctionInputClassifier.classify(value).exact_candidates:
                exact_conditions.append(
                    self._condition(ConditionField.QUALIFIED_NAME, ConditionOperator.EQ, candidate)
                )
            classified = FunctionInputClassifier.classify(value)
            if classified.kind is FunctionInputKind.OWNER_MEMBER_SUFFIX:
                suffix_conditions.append(
                    self._condition(
                        ConditionField.QUALIFIED_NAME,
                        ConditionOperator.REGEX,
                        classified.regex_candidate,
                    )
                )
            elif classified.kind is FunctionInputKind.EMPTY and value:
                exact_conditions.append(self._condition(ConditionField.NAME, ConditionOperator.EQ, value))

        queries: list[PreparedNodeQuery] = []
        if exact_conditions:
            queries.append(
                PreparedNodeQueryBuilder.build(
                    "function_multi_exact",
                    QueryTemplate.FUNCTION_SEARCH,
                    (QueryConditionGroup(tuple(exact_conditions), "OR"),),
                )
            )
        if suffix_conditions:
            queries.append(
                PreparedNodeQueryBuilder.build(
                    "function_multi_suffix",
                    QueryTemplate.FUNCTION_SEARCH,
                    (QueryConditionGroup(tuple(suffix_conditions), "OR"),),
                )
            )
        return tuple(queries)

    def search(self, limit: int = 0, offset: int = 0) -> list[FunctionRecord]:
        return self._run_prepared_queries(self._build_function_queries(), self.repository.execute_function_query, limit, offset)

    @classmethod
    def for_file(cls, repository: CodeGraphQueryRepository, project_path: Path | str, file_path: str, use_regex: bool = False) -> "FunctionAnalysisProcessor":
        processor = cls(repository, project_path=project_path, use_regex=use_regex)
        processor.file_path = CodeGraphParamUtil.normalize_file_path(Path(project_path), file_path)
        return processor

    def search_file(self, limit: int = 0, offset: int = 0) -> list[FunctionRecord]:
        if self.file_path == ".":
            strategy, conditions = "functions_all", ()
        elif self.use_regex:
            strategy = "functions_by_file_regex"
            conditions = (self._condition(ConditionField.FILE_PATH, ConditionOperator.REGEX, self.file_path),)
        else:
            strategy = "functions_by_file_exact"
            conditions = (self._condition(ConditionField.FILE_PATH, ConditionOperator.EQ, self.file_path),)
        query = PreparedNodeQueryBuilder.build(strategy, QueryTemplate.FUNCTIONS_BY_FILE, conditions)
        return self._run_prepared_queries((query,), self.repository.execute_function_query, limit, offset)

    @classmethod
    def for_files(cls, repository: CodeGraphQueryRepository, project_path: Path | str, file_paths: list[str]) -> "FunctionAnalysisProcessor":
        processor = cls(repository, project_path=project_path)
        processor.file_paths = tuple(CodeGraphParamUtil.normalize_file_path(Path(project_path), path) for path in file_paths)
        return processor

    def search_files(self, limit: int = 0, offset: int = 0) -> list[FunctionRecord]:
        """Query all requested files in one prepared SQL statement."""

        if not self.file_paths:
            return self.for_file(self.repository, self.project_path, ".", self.use_regex).search_file(limit, offset)
        if self.use_regex:
            conditions = tuple(
                self._condition(ConditionField.FILE_PATH, ConditionOperator.REGEX, path)
                for path in self.file_paths
            )
        else:
            conditions = tuple(
                self._condition(ConditionField.FILE_PATH, ConditionOperator.EQ, path)
                for path in self.file_paths
            )
        query = PreparedNodeQueryBuilder.build(
            "functions_by_files_regex" if self.use_regex else "functions_by_files_exact",
            QueryTemplate.FUNCTIONS_BY_FILE,
            (QueryConditionGroup(conditions, "OR"),),
        )
        return self.repository.execute_function_query(query, limit, offset)
