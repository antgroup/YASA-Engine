"""AuthScan route 未命中后，将接口输入解析为 CodeGraph 实现方法查询。

本 processor 位于 cached AuthScan routes 与普通 CodeGraph function fallback 之间。它只负责
识别四种封闭的接口输入、规范化接口 FQCN、执行一次固定 SQL，并把 LEFT JOIN 的查询行归纳
为内部 resolution 状态；不访问 UQL、不拼接 SQL，也不向公开响应暴露诊断状态。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum

from yasa_mcp.repository.query.codegraph.query_models import (
    CodeGraphQueryRepository,
    InterfaceImplementationRecord,
    InterfaceQueryKind,
)
from yasa_mcp.repository.dao.codegraph import CodeGraphNodeRow
from yasa_mcp.util import log_util
from yasa_mcp.util.codegraph_param_util import CodeGraphParamUtil

logger = logging.getLogger(__name__)


class InterfaceResolutionStatus(str, Enum):
    """一次接口实现解析的内部结果，不属于 MCP 公开响应。"""

    # 恰好找到一个带源码位置的实现方法。
    METHOD_RESOLVED = "method_resolved"
    # 多实现类、多个同名短接口或 overload 导致多个可定位实现方法。
    MULTIPLE_METHODS_RESOLVED = "multiple_methods_resolved"
    # 接口和 implements 实现类存在，但 LEFT JOIN 未关联到目标实现方法。
    IMPLEMENTATION_METHOD_NOT_FOUND = "implementation_method_not_found"
    # 输入不可分类，或接口节点/implements edge 没有命中。
    INTERFACE_IMPLEMENTATION_NOT_FOUND = "interface_implementation_not_found"


@dataclass(frozen=True)
class InterfaceResolution:
    status: InterfaceResolutionStatus
    records: tuple[InterfaceImplementationRecord, ...] = ()


@dataclass(frozen=True)
class ClassifiedInterfaceInput:
    """分类后的接口输入。

    ``method_name`` 仅在 ``FQCN_METHOD`` / ``SHORT_NAME_METHOD`` 中有值；
    ``*_ALL_METHODS`` 对应 interface-only 输入，因此该字段为 ``None``。
    """

    query_kind: InterfaceQueryKind
    interface_name: str
    method_name: str | None = None


class InterfaceImplementationProcessor:
    """将接口输入映射到固定方案 C SQL，并产生可解释的内部解析状态。"""

    _FQCN_QUERY_KINDS = {
        InterfaceQueryKind.FQCN_METHOD,
        InterfaceQueryKind.FQCN_ALL_METHODS,
    }

    def __init__(self, repository: CodeGraphQueryRepository, language: str):
        self.repository = repository
        self.language = language.strip().lower()

    @staticmethod
    def classify(api_name: str) -> ClassifiedInterfaceInput | None:
        """把 api_name 分类为四种接口查询形态，不访问数据库。

        判定规则：

        - ``com.foo.UserService.query``：三段及以上且末段小写开头，分类为
          ``FQCN_METHOD``；owner 是接口全限定名，末段是方法名。
        - ``UserService.query``：两段、owner 大写开头且末段小写开头，分类为
          ``SHORT_NAME_METHOD``。
        - ``com.foo.UserService``：三段及以上且末段大写开头，分类为
          ``FQCN_ALL_METHODS``，查询该接口实现类的方法候选。
        - ``UserService``：单段且大写开头，分类为 ``SHORT_NAME_ALL_METHODS``。
        - 空串、HTTP path、纯小写单段或无法证明为短接口方法的两段输入返回 ``None``。

        CodeGraph 存储格式中的 ``::`` 在分类阶段临时转成 ``.`` 以统一分段。这里不猜测
        多个包/类型边界；显式 regex 已由 service 跳过本 processor，进入受控 function
        fallback。
        """
        source = (api_name or "").strip()
        if not source or "/" in source:
            return None

        normalized = source.replace("::", ".")
        parts = [part for part in normalized.split(".") if part]
        if not parts:
            return None

        # 单段输入只有大写开头时才能证明它是接口短名。
        if len(parts) == 1:
            if not parts[0][:1].isupper():
                return None
            return ClassifiedInterfaceInput(
                InterfaceQueryKind.SHORT_NAME_ALL_METHODS, parts[0]
            )

        # 末段大写开头表示输入止于接口类型；三段及以上才视为可靠 FQCN。
        if parts[-1][:1].isupper():
            query_kind = (
                InterfaceQueryKind.FQCN_ALL_METHODS
                if len(parts) >= 3
                else InterfaceQueryKind.SHORT_NAME_ALL_METHODS
            )
            return ClassifiedInterfaceInput(query_kind, ".".join(parts))

        owner = ".".join(parts[:-1])
        method_name = parts[-1]
        is_fqcn = len(parts) >= 3
        # 两段方法输入必须由大写开头的接口短名作为 owner，避免把普通点分 token 误分类。
        if not is_fqcn and not owner[:1].isupper():
            return None
        query_kind = (
            InterfaceQueryKind.FQCN_METHOD
            if is_fqcn
            else InterfaceQueryKind.SHORT_NAME_METHOD
        )
        return ClassifiedInterfaceInput(query_kind, owner, method_name)

    @staticmethod
    def _deduplicate(
        rows: list[InterfaceImplementationRecord],
    ) -> tuple[InterfaceImplementationRecord, ...]:
        """按接口、实现类、实现方法三元组去重并保留 SQL 的稳定顺序。

        短接口名可能命中多个接口，多实现类和 overload 也可能产生多行；三元组既不会把
        不同实现错误合并，也能消除重复 edge 或重复查询行。
        """
        records: list[InterfaceImplementationRecord] = []
        seen: set[tuple[str, str, str]] = set()
        for row in rows:
            key = (
                row["interface_id"],
                row["implementation_class_id"],
                row["implementation_method_id"],
            )
            if key in seen:
                continue
            seen.add(key)
            records.append(row)
        return tuple(records)

    @classmethod
    def _normalize_interface_name(
        cls, classified: ClassifiedInterfaceInput
    ) -> str:
        """把 FQCN 确定性转换为 CodeGraph 格式；短名保持原样。

        ``build_class_fqn_candidates`` 最多返回一个候选，因此这里只取唯一结果，不构造
        candidates 集合，也不提供虚假的多候选重试控制流。
        """
        if classified.query_kind not in cls._FQCN_QUERY_KINDS:
            return classified.interface_name
        candidates = CodeGraphParamUtil.build_class_fqn_candidates(
            classified.interface_name
        )
        return candidates[0] if candidates else ""

    def resolve(self, api_name: str) -> InterfaceResolution:
        """分类并执行一次接口实现查询，再把结果归纳为内部状态。

        流程固定为：分类 -> FQCN 规范化 -> 单次 repository 查询 -> 过滤 LEFT JOIN 产生的
        空 method 行 -> 三元组去重 -> 状态判定。all-methods 查询出现多个方法是正常候选，
        不随机选择；没有可定位 method 但存在实现类关系行时记录为方法未找到。
        """
        classified = self.classify(api_name)
        if classified is None or not self.language:
            return InterfaceResolution(
                InterfaceResolutionStatus.INTERFACE_IMPLEMENTATION_NOT_FOUND
            )

        interface_name = self._normalize_interface_name(classified)
        if not interface_name:
            return InterfaceResolution(
                InterfaceResolutionStatus.INTERFACE_IMPLEMENTATION_NOT_FOUND
            )

        rows = self.repository.find_interface_implementations(
            query_kind=classified.query_kind,
            interface_name=interface_name,
            method_name=classified.method_name,
            language=self.language,
        )
        records = self._deduplicate(
            [row for row in rows if row["implementation_method_id"]]
        )

        if len(records) == 1:
            status = InterfaceResolutionStatus.METHOD_RESOLVED
        elif records:
            status = InterfaceResolutionStatus.MULTIPLE_METHODS_RESOLVED
        elif rows:
            status = InterfaceResolutionStatus.IMPLEMENTATION_METHOD_NOT_FOUND
        else:
            status = InterfaceResolutionStatus.INTERFACE_IMPLEMENTATION_NOT_FOUND

        log_util.info(
            "CodeGraph interface resolution "
            f"query_kind={classified.query_kind.value}, interface={interface_name!r}, "
            f"method={classified.method_name!r}, results={len(records)}, status={status.value}",
            logger=logger,
        )
        return InterfaceResolution(status, records)

    @classmethod
    def expand_implementations(
        cls,
        repository: CodeGraphQueryRepository,
        interface_rows: set[CodeGraphNodeRow],
    ) -> tuple[set[CodeGraphNodeRow], set[CodeGraphNodeRow]]:
        """批量展开接口类和接口函数的实现，返回 (实现类集合, 实现函数集合)。

        入参 ``interface_rows`` 包含接口类节点和接口函数节点（method/function 且
        owner FQN 是接口节点 FQN）。不改变 ``resolve`` 已有功能，仅在其上做批量编排：

        - 接口类节点：调用 ``resolve`` 以 FQN 和短名分别尝试，沿 ``implements`` 边
          召回实现类，每个实现类只取一次（按节点 id 去重）。
        - 接口函数节点：同理 ``resolve``，但只收集实现方法行（按节点 id 去重）。

        返回两类结果分离：接口类 → 实现类，接口函数 → 实现函数。调用方按需合并。
        """
        implementation_classes: set[CodeGraphNodeRow] = set()
        implementation_methods: set[CodeGraphNodeRow] = set()
        seen_class_ids: set[str] = set()
        seen_method_ids: set[str] = set()

        # 确定性遍历：interface_rows 是 set，迭代顺序随 PYTHONHASHSEED 变化。
        # 同一接口可能存在多个 CodeGraph 节点（如 queryByScene 接口方法有两个 id），
        # resolve 对同 FQN 行返回相同的实现记录，seen_*_ids 去重会"保留首个"。
        # 不排序则首个行随进程变化，展开行继承的 score 也随之变化，
        # 导致实现行在 max_results 截断边界处被挤进/挤出（8/9 抖动）。
        # 按 abs(score) 降序取最优接口匹配行的 score，使展开实现行稳定且靠前。
        ordered_rows = sorted(
            interface_rows,
            key=lambda r: (-abs(r.score or 0.0), r.qualified_name or r.name or "", r.id or ""),
        )
        for interface_row in ordered_rows:
            interface_name = interface_row.qualified_name or interface_row.name
            language = interface_row.language
            if not interface_name or not language:
                continue

            is_method_node = interface_row.kind in ("method", "function")
            processor = cls(repository, language)
            resolution = processor.resolve(interface_name)
            if not resolution.records and interface_row.name and interface_row.name != interface_name:
                resolution = processor.resolve(interface_row.name)

            for record in resolution.records:
                if is_method_node:
                    if not record["implementation_method_id"]:
                        continue
                    method_id = str(record["implementation_method_id"])
                    if method_id in seen_method_ids:
                        continue
                    seen_method_ids.add(method_id)
                    implementation_methods.add(CodeGraphNodeRow(
                        id=method_id,
                        kind="method",
                        name=str(record["short_name"]),
                        qualified_name=str(record["function_fqn"]),
                        signature=str(record["function_signature"]),
                        return_type=None,
                        file_path=str(record["file_path"]),
                        language=str(record["language"]),
                        start_line=int(record["start_line"]),
                        start_column=int(record["start_column"]),
                        end_line=int(record["end_line"]),
                        end_column=int(record["end_column"]),
                        score=interface_row.score,
                    ))
                else:
                    class_id = str(record["implementation_class_id"])
                    if class_id in seen_class_ids:
                        continue
                    seen_class_ids.add(class_id)
                    implementation_classes.add(CodeGraphNodeRow(
                        id=class_id,
                        kind="class",
                        name=str(record["implementation_class_name"]),
                        qualified_name=str(record["implementation_class_fqn"]),
                        signature=None,
                        return_type=None,
                        file_path=str(record.get("implementation_class_file_path") or ""),
                        language=str(record.get("implementation_class_language") or record["language"]),
                        start_line=int(record.get("implementation_class_start_line") or 0),
                        start_column=int(record.get("implementation_class_start_column") or 0),
                        end_line=int(record.get("implementation_class_end_line") or 0),
                        end_column=int(record.get("implementation_class_end_column") or 0),
                        score=interface_row.score,
                    ))

        return implementation_classes, implementation_methods
