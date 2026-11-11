"""CodeGraph 查询分类、受控条件与 repository 执行契约。"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Protocol, TypeAlias, TypedDict
from weakref import ReferenceType, ref

NodeValue: TypeAlias = str | int | float | None
QueryValues: TypeAlias = tuple[NodeValue, ...]
NodeRecord: TypeAlias = dict[str, NodeValue]
FunctionRecord: TypeAlias = dict[str, str | int]
ClassRecord: TypeAlias = dict[str, str | int]
MethodRecord: TypeAlias = dict[str, str | int]


class InterfaceQueryKind(str, Enum):
    """AuthScan 接口输入的四种封闭查询形态，与四条固定 SQL 一一对应。"""

    FQCN_METHOD = "fqcn_method"
    SHORT_NAME_METHOD = "short_name_method"
    FQCN_ALL_METHODS = "fqcn_all_methods"
    SHORT_NAME_ALL_METHODS = "short_name_all_methods"


@dataclass(frozen=True)
class InterfaceQuerySpec:
    """Repository 执行固定模板所需的静态规格。"""

    template: str
    includes_method: bool


class InterfaceQueryKind(str, Enum):
    """AuthScan 接口输入的四种封闭查询形态，与四条固定 SQL 一一对应。"""

    FQCN_METHOD = "fqcn_method"
    SHORT_NAME_METHOD = "short_name_method"
    FQCN_ALL_METHODS = "fqcn_all_methods"
    SHORT_NAME_ALL_METHODS = "short_name_all_methods"


@dataclass(frozen=True)
class InterfaceQuerySpec:
    """Repository 执行固定模板所需的静态规格。"""

    template: str
    includes_method: bool


class InterfaceImplementationRecord(TypedDict):
    interface_id: str
    interface_name: str
    interface_fqn: str
    implementation_class_id: str
    implementation_class_name: str
    implementation_class_fqn: str
    implementation_method_id: str
    function_fqn: str
    function_signature: str
    short_name: str
    language: str
    file_path: str
    start_line: int
    start_column: int
    end_line: int
    end_column: int
    implements_metadata: str
    implements_provenance: str
    implementation_class_file_path: str
    implementation_class_start_line: int
    implementation_class_start_column: int
    implementation_class_end_line: int
    implementation_class_end_column: int
    implementation_class_language: str


# 语义分组集中在 query 层，避免 mapper 与 repository 各自维护不一致的多语言 kind。
FUNCTION_NODE_KINDS = ("function", "method")
CLASS_LIKE_NODE_KINDS = ("class", "struct", "interface", "trait", "protocol", "enum")


class QueryTemplate(Enum):
    """模板按 projection、基础范围和排序语义划分，而不是按每种条件复制 SQL。"""

    CLASS_SEARCH = "class_search"
    FUNCTION_SEARCH = "function_search"
    FUNCTIONS_BY_FILE = "functions_by_file"
    METHODS_BY_OWNER = "methods_by_owner"
    ENCLOSING_FUNCTION = "enclosing_function"
    SEARCH_SYMBOL = "search_symbol_nodes"


class ConditionField(Enum):
    NAME = "name"
    QUALIFIED_NAME = "qualified_name"
    LANGUAGE = "language"
    FILE_PATH = "file_path"
    START_LINE = "start_line"
    END_LINE = "end_line"


class ConditionOperator(Enum):
    EQ = "eq"
    LIKE = "like"
    NOT_LIKE = "not_like"
    REGEX = "regex"
    LTE = "lte"
    GTE = "gte"
    ALWAYS = "always"


class FunctionInputKind(Enum):
    """函数限定名的查询族；每一项都描述最终条件，而不是字符串外观。

    ``EMPTY`` 表示没有可用限定名，例如 ``""``、空白串；若另有
    ``name="run"``，只生成 ``name = ?`` 的 ``function_search``，否则不查询。

    ``FULL_STORED_FQCN`` 表示已有可靠包前缀的存储格式，例如
    ``com.foo::User::run``、``org.demo::user::save``；候选保持 ``::`` 格式，先在
    ``function_search`` 中执行 ``qualified_name = ?``，全部 exact 候选为空后才按
    name 降级。类型名是否大写不参与判断。

    ``FULL_DOTTED_FQCN`` 表示有可靠包前缀的点分格式，例如
    ``com.foo.User.run``、``org.demo.user.save``；分类器生成有限的
    ``com.foo::User::run`` 等 exact 候选，查询模板和降级顺序与 stored FQCN 相同。

    ``OWNER_MEMBER_SUFFIX`` 统一表示无法证明包前缀完整、但明确含 owner/member
    边界的输入，例如 ``User.run``、``user::run``、``foo.User.run``、
    ``foo::user::save``。它生成带前段边界 ``(^|\\.|::)``、owner 段分隔
    ``(\\.|::)`` 和最终 ``class::member$`` 约束的正则，先在 ``function_search``
    中执行 ``REGEXP``；无结果才按显式 name 或末段 member 做 ``name = ?``
    fallback，绝不执行 FQCN exact。

    ``REGEX_FQCN`` 仅由显式 ``use_regex=True`` 产生，例如
    ``com\\.foo\\..*Controller\\.run``、``org\\.demo\\..*\\.save``；候选先适配
    数据库存储分隔符，再使用 ``function_search`` 的 ``REGEXP`` 查询族。若显式
    name 非空，降级顺序为 name regex + FQCN regex、FQCN regex、name regex；
    若 name 为空则只执行 FQCN regex。该族不会混入任何 exact 条件。
    """

    EMPTY = "empty"
    FULL_STORED_FQCN = "full_stored_fqcn"
    FULL_DOTTED_FQCN = "full_dotted_fqcn"
    OWNER_MEMBER_SUFFIX = "owner_member_suffix"
    REGEX_FQCN = "regex_fqcn"


@dataclass(frozen=True)
class QueryCondition:
    field: ConditionField
    operator: ConditionOperator
    value: NodeValue = None


@dataclass(frozen=True)
class QueryConditionGroup:
    """A bounded boolean group used for selector lists.

    The group operator and fields are created only by the query builder.  Values still
    travel through SQLite bindings; this type merely lets a processor express
    ``field_a = ? OR field_b = ?`` without interpolating user input.
    """

    conditions: tuple[QueryCondition | "QueryConditionGroup", ...]
    operator: str = "OR"


@dataclass(frozen=True)
class PreparedNodeQuery:
    """传给 repository 的最终查询；认证标记证明条件来自白名单编译器。"""

    strategy: str
    template: QueryTemplate
    kinds: tuple[str, ...]
    conditions_sql: str
    condition_params: QueryValues


class QueryConditionCompiler:
    """只编译白名单原子条件，所有值继续通过 SQLite 参数绑定。"""

    _OPERATORS = {
        ConditionOperator.EQ: "= ?",
        ConditionOperator.LIKE: "LIKE ?",
        ConditionOperator.NOT_LIKE: "NOT LIKE ?",
        ConditionOperator.REGEX: "REGEXP(?, {field})",
        ConditionOperator.LTE: "<= ?",
        ConditionOperator.GTE: ">= ?",
    }

    @classmethod
    def compile(
        cls,
        conditions: tuple[QueryCondition | QueryConditionGroup, ...],
    ) -> tuple[str, QueryValues]:
        if not conditions:
            return "1 = 1", ()

        def compile_one(
            condition: QueryCondition | QueryConditionGroup,
        ) -> tuple[str, QueryValues]:
            if isinstance(condition, QueryConditionGroup):
                if condition.operator not in {"AND", "OR"} or not condition.conditions:
                    raise ValueError("不支持的查询条件组")
                child_sql: list[str] = []
                child_params: list[NodeValue] = []
                for child in condition.conditions:
                    sql, params = compile_one(child)
                    child_sql.append(sql)
                    child_params.extend(params)
                return (
                    "(" + f" {condition.operator} ".join(child_sql) + ")",
                    tuple(child_params),
                )
            if not isinstance(condition, QueryCondition):
                raise ValueError("查询条件必须是 QueryCondition 或 QueryConditionGroup")
            if condition.operator is ConditionOperator.ALWAYS:
                return "1 = 1", ()
            expression = cls._OPERATORS.get(condition.operator)
            if expression is None:
                raise ValueError(f"不支持的查询操作符: {condition.operator}")
            field = condition.field.value
            if condition.operator is ConditionOperator.REGEX:
                return expression.format(field=field), (condition.value,)
            return f"{field} {expression}", (condition.value,)

        fragments: list[str] = []
        params: list[NodeValue] = []
        for condition in conditions:
            sql, child_params = compile_one(condition)
            fragments.append(sql)
            params.extend(child_params)
        return " AND ".join(fragments), tuple(params)


class PreparedNodeQueryBuilder:
    """构造 repository 边界对象，并校验模板对应的固定 kind 语义。"""

    # 准备记录只存在于 builder 私有注册表，调用者无法通过复制字段伪造认证状态。
    _PREPARED: dict[int, ReferenceType[PreparedNodeQuery]] = {}
    _KINDS = {
        QueryTemplate.CLASS_SEARCH: CLASS_LIKE_NODE_KINDS,
        QueryTemplate.FUNCTION_SEARCH: FUNCTION_NODE_KINDS,
        QueryTemplate.FUNCTIONS_BY_FILE: FUNCTION_NODE_KINDS,
        # owner prefix 不能证明自由 function 是类型成员，因此该模板只允许 method。
        QueryTemplate.METHODS_BY_OWNER: ("method",),
        QueryTemplate.ENCLOSING_FUNCTION: FUNCTION_NODE_KINDS,
        # FTS 节点查询在 service 层做语义 kind 过滤，因此这里不携带固定 kind。
        QueryTemplate.SEARCH_SYMBOL: (),
    }

    @classmethod
    def build(
        cls,
        strategy: str,
        template: QueryTemplate,
        conditions: tuple[QueryCondition | QueryConditionGroup, ...] = (),
    ) -> PreparedNodeQuery:
        conditions_sql, params = QueryConditionCompiler.compile(conditions)
        query = PreparedNodeQuery(
            strategy,
            template,
            cls._KINDS[template],
            conditions_sql,
            params,
        )
        query_id = id(query)
        cls._PREPARED[query_id] = ref(
            query, lambda _reference, prepared_id=query_id: cls._PREPARED.pop(prepared_id, None)
        )
        return query

    @classmethod
    def build_search_symbol(cls, match_query: str) -> PreparedNodeQuery:
        """构造 FTS 查询对象；查询文本仍作为绑定参数传入 repository。"""
        if not match_query:
            raise ValueError("search_symbol FTS 查询不能为空")
        query = PreparedNodeQuery(
            "search_symbol",
            QueryTemplate.SEARCH_SYMBOL,
            (),
            "nodes_fts MATCH ?",
            (match_query,),
        )
        query_id = id(query)
        cls._PREPARED[query_id] = ref(
            query, lambda _reference, prepared_id=query_id: cls._PREPARED.pop(prepared_id, None)
        )
        return query

    @classmethod
    def verify(cls, query: PreparedNodeQuery) -> None:
        """Repository 执行前验证来源与固定 kind，拒绝手工伪造条件 SQL。"""
        prepared_reference = cls._PREPARED.get(id(query))
        if prepared_reference is None or prepared_reference() is not query:
            raise ValueError("PreparedNodeQuery 必须由 PreparedNodeQueryBuilder 构造")
        if query.kinds != cls._KINDS.get(query.template):
            raise ValueError("PreparedNodeQuery 的模板与 kind 范围不匹配")


class CodeGraphQueryRepository(Protocol):
    """Processor 只能提交编译完成的查询，repository 不接触分类与条件决策。"""

    def execute_class_query(
        self, query: PreparedNodeQuery, limit: int = 0, offset: int = 0
    ) -> list[ClassRecord]: ...

    def execute_function_query(
        self, query: PreparedNodeQuery, limit: int = 0, offset: int = 0
    ) -> list[FunctionRecord]: ...

    def find_interface_implementations(
        self,
        *,
        query_kind: InterfaceQueryKind,
        interface_name: str,
        method_name: str | None,
        language: str,
    ) -> list[InterfaceImplementationRecord]: ...

    def get_methods_by_owner_fqn(self, class_fqn: str) -> list[MethodRecord]: ...


@dataclass(frozen=True)
class ClassifiedFunctionInput:
    kind: FunctionInputKind
    exact_candidates: tuple[str, ...] = ()
    suffix_candidates: tuple[str, ...] = ()
    regex_candidate: str = ""
