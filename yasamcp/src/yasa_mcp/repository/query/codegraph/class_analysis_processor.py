"""类与类型定义查询的请求级降级编排。"""

from __future__ import annotations

from yasa_mcp.repository.query.codegraph.codegraph_analysis_processor import CodeGraphAnalysisProcessor
from yasa_mcp.repository.query.codegraph.query_models import (
    ClassRecord,
    CodeGraphQueryRepository,
    ConditionField,
    ConditionOperator,
    MethodRecord,
    PreparedNodeQuery,
    PreparedNodeQueryBuilder,
    QueryCondition,
    QueryConditionGroup,
    QueryTemplate,
)
from yasa_mcp.util.codegraph_param_util import CodeGraphParamUtil
from yasa_mcp.util.selector_util import normalize_selector


class ClassAnalysisProcessor(CodeGraphAnalysisProcessor):
    """类搜索保留真实的 exact 降级；短类名最后使用段边界 suffix 兼容。"""

    def __init__(
        self,
        repository: CodeGraphQueryRepository,
        name: str | list[str] | tuple[str, ...] = "",
        class_fqn: str | list[str] | tuple[str, ...] = "",
        use_regex: bool = False,
    ):
        super().__init__(repository)
        self.names = normalize_selector(name)
        self.class_fqns = normalize_selector(class_fqn)
        self.name = self.names[0] if len(self.names) == 1 else ""
        self.class_fqn = self.class_fqns[0] if len(self.class_fqns) == 1 else ""
        self.use_regex = use_regex
        self._multi_selector = not isinstance(name, str) or not isinstance(class_fqn, str) or len(self.names) > 1 or len(self.class_fqns) > 1

    @staticmethod
    def _condition(field: ConditionField, operator: ConditionOperator, value: str) -> QueryCondition:
        return QueryCondition(field, operator, value)

    def _build_class_queries(self) -> tuple[PreparedNodeQuery, ...]:
        """按可信度从高到低构造类查询降级链。

        显式正则与普通输入严格隔离：正则模式先尝试 ``name + FQN``，再尝试 FQN，最后
        才退化为 name，避免把正则文本放进等值条件。普通完整 FQN 先使用可命中索引的
        exact 条件；同时给出 name 时先组合过滤，再放宽为仅 FQN，之后才按 name 查询。
        只有不含任何分隔符的短类名才追加 ``%::Class`` 段边界 suffix，用于调用方把类名
        误放入 FQN 参数的兼容场景；完整限定名不会走 suffix，从而避免扩大结果集合。
        """
        if self._multi_selector:
            return self._build_multi_class_queries()

        source = self.class_fqn
        queries: list[PreparedNodeQuery] = []
        name_eq = self._condition(ConditionField.NAME, ConditionOperator.EQ, self.name)
        if self.use_regex:
            fqn_regex_value = CodeGraphParamUtil.adapt_fqn_regex(source)
            name_regex = self._condition(ConditionField.NAME, ConditionOperator.REGEX, self.name)
            if fqn_regex_value:
                fqn_regex = self._condition(ConditionField.QUALIFIED_NAME, ConditionOperator.REGEX, fqn_regex_value)
                if self.name:
                    # 第一优先级：同时约束短名和限定名，减少宽泛正则带来的同名类误匹配。
                    queries.append(PreparedNodeQueryBuilder.build("class_name_fqn_regex", QueryTemplate.CLASS_SEARCH, (name_regex, fqn_regex)))
                # 第二优先级：短名组合无结果或未提供短名时，仅保留调用方明确给出的 FQN 正则。
                queries.append(PreparedNodeQueryBuilder.build("class_fqn_regex", QueryTemplate.CLASS_SEARCH, (fqn_regex,)))
            if self.name:
                # 最后降级：FQN 正则没有命中时仅按短名正则搜索，保证旧接口仍可返回候选。
                queries.append(PreparedNodeQueryBuilder.build("class_name_regex", QueryTemplate.CLASS_SEARCH, (name_regex,)))
            return tuple(queries)
        for candidate in CodeGraphParamUtil.build_class_fqn_candidates(source):
            fqn = self._condition(ConditionField.QUALIFIED_NAME, ConditionOperator.EQ, candidate)
            if self.name:
                # 第一优先级：name 与确定性 FQN 候选同时等值，精确率最高且两列均可利用索引。
                queries.append(PreparedNodeQueryBuilder.build("class_name_fqn_exact", QueryTemplate.CLASS_SEARCH, (name_eq, fqn)))
            # 第二优先级：忽略可能过时的短名，仅按规范化后的 FQN 候选执行等值查询。
            queries.append(PreparedNodeQueryBuilder.build("class_fqn_exact", QueryTemplate.CLASS_SEARCH, (fqn,)))
        if self.name:
            # 第三优先级：所有 FQN 候选失败后按短名等值返回同名候选，不扩大到正则匹配。
            queries.append(PreparedNodeQueryBuilder.build("class_name_exact", QueryTemplate.CLASS_SEARCH, (name_eq,)))
        if source and "." not in source and "::" not in source:
            suffix = self._condition(ConditionField.QUALIFIED_NAME, ConditionOperator.LIKE, f"%::{source}")
            # 最后兼容：裸类名可能被放入 class_fqn，仅匹配 ``::Class`` 结尾以守住段边界。
            queries.append(PreparedNodeQueryBuilder.build("class_fqn_suffix", QueryTemplate.CLASS_SEARCH, (suffix,)))
        return tuple(queries)

    def _build_multi_class_queries(self) -> tuple[PreparedNodeQuery, ...]:
        """Compile all list selectors into one bounded OR query per fallback stage."""

        if self.use_regex:
            conditions: list[QueryCondition | QueryConditionGroup] = []
            regex_conditions: list[QueryCondition] = []
            for value in self.names:
                regex_conditions.append(self._condition(ConditionField.NAME, ConditionOperator.REGEX, value))
            for value in self.class_fqns:
                adapted = CodeGraphParamUtil.adapt_fqn_regex(value)
                if adapted:
                    regex_conditions.append(self._condition(ConditionField.QUALIFIED_NAME, ConditionOperator.REGEX, adapted))
            if regex_conditions:
                conditions.append(QueryConditionGroup(tuple(regex_conditions), "OR"))
            return (
                (PreparedNodeQueryBuilder.build("class_multi_regex", QueryTemplate.CLASS_SEARCH, tuple(conditions)),)
                if conditions
                else ()
            )

        exact_conditions: list[QueryCondition] = []
        for value in self.names:
            exact_conditions.append(self._condition(ConditionField.NAME, ConditionOperator.EQ, value))
        suffix_values: list[str] = []
        for value in self.class_fqns:
            candidates = CodeGraphParamUtil.build_class_fqn_candidates(value)
            for candidate in candidates:
                exact_conditions.append(self._condition(ConditionField.QUALIFIED_NAME, ConditionOperator.EQ, candidate))
            if "." not in value and "::" not in value:
                suffix_values.append(value)

        queries: list[PreparedNodeQuery] = []
        if exact_conditions:
            queries.append(
                PreparedNodeQueryBuilder.build(
                    "class_multi_exact",
                    QueryTemplate.CLASS_SEARCH,
                    (QueryConditionGroup(tuple(exact_conditions), "OR"),),
                )
            )
        if suffix_values:
            suffix_conditions = tuple(
                self._condition(ConditionField.QUALIFIED_NAME, ConditionOperator.LIKE, f"%::{value}")
                for value in suffix_values
            )
            queries.append(
                PreparedNodeQueryBuilder.build(
                    "class_multi_suffix",
                    QueryTemplate.CLASS_SEARCH,
                    (QueryConditionGroup(suffix_conditions, "OR"),),
                )
            )
        return tuple(queries)

    def search(self, limit: int = 0, offset: int = 0) -> list[ClassRecord]:
        return self._run_prepared_queries(self._build_class_queries(), self.repository.execute_class_query, limit, offset)

    def search_by_file(self, file_path: str) -> list[ClassRecord]:
        """按项目相对路径精确查询类型节点，供已有文本命中结果定位所属类型。"""
        normalized = file_path.strip()
        if not normalized:
            return []
        query = PreparedNodeQueryBuilder.build(
            "class_file_path_exact",
            QueryTemplate.CLASS_SEARCH,
            (
                self._condition(
                    ConditionField.FILE_PATH,
                    ConditionOperator.EQ,
                    normalized,
                ),
            ),
        )
        return self.repository.execute_class_query(query)

    def get_methods(self, class_fqn: str) -> list[MethodRecord]:
        return self.repository.get_methods_by_owner_fqn(class_fqn)
