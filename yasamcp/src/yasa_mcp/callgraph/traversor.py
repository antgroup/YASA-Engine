from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter
from typing import Dict, List, Set

from yasa_mcp.core.enums import Language
from yasa_mcp.repository.callgraph_query import CallgraphSqlAccessor
from yasa_mcp.service import models
from yasa_mcp.util import file_util, log_util


logger = logging.getLogger(__name__)


@dataclass
class CurrentNode:
    """BFS 当前层待展开节点状态。

    node_id 是当前要从 cg_edges 查询 outgoing edges 的 callgraph node；
    children 指向输出树中当前节点的 callee 列表，因此 append children 就是在挂载结果树；
    path_node_ids 只记录 root 到当前节点路径上的 node id，用于 path-aware cycle 判断；
    depth 中 root 为 0，root 的直接 callee 为 1。
    """

    node_id: str
    children: list[models.Callee]
    path_node_ids: frozenset[str]
    depth: int


class CallGraphTraversor:
    """基于 cg_edges/cg_call_sites 构建可切换遍历模式的被调函数树。"""

    def __init__(
        self,
        accessor: CallgraphSqlAccessor,
        language: Language,
        project_path: Path | None,
        detail_level: str,
        max_depth: int,
        max_callees_per_node: int,
        exclude_undefined_function_call: bool,
    ):
        self.accessor = accessor
        self.language = language
        self.project_path = project_path
        self.detail_level = detail_level
        self.max_depth = max_depth
        self.max_callees_per_node = max_callees_per_node if max_callees_per_node > 0 else 0
        self.exclude_undefined_function_call = exclude_undefined_function_call

    def build(self, root_node_id: str, mode: str = "bfs") -> List[models.Callee]:
        if mode == "python_dfs":
            return self.build_python_dfs(root_node_id)
        if mode == "sql_recursive":
            return self.build_sql_recursive(root_node_id)
        return self.build_bfs(root_node_id)

    def build_bfs(self, root_node_id: str) -> List[models.Callee]:
        """使用 BFS 按层展开被调函数树。

        depth <= 0 表示不限制深度；第一层不受 max_callees_per_node 限制，
        从第二层开始才对每个节点应用该上限。
        """
        top_callees: List[models.Callee] = []
        current_level = [
            CurrentNode(
                node_id=root_node_id,
                children=top_callees,
                path_node_ids=frozenset({root_node_id}),
                depth=0,
            )
        ]

        while current_level:
            level_started_at = perf_counter()
            level_depth = current_level[0].depth
            traversed_children = 0

            # current_level 表示同一个 BFS depth 下所有需要展开的 current 节点。
            # 每一轮只查询这一层的 outgoing edges，因此 traversal 是按广度优先推进，
            # 而不是对某个节点一路递归到底。
            current_ids = [current.node_id for current in current_level]

            # BFS 的性能收益来自“按层批量查边”：当前层所有 current node 共用一次 SQL，
            # 避免 DFS 那种每访问一个 node 就查一次 outgoing edges 的 N+1 查询模式。
            edges = self.accessor.get_outgoing_edges_for_sources(self.language, current_ids)
            children_by_current = self._group_edges_by_current(edges)

            # 当前层所有 target 的函数定义也一次性构建，后续处理每条 edge 时只做 dict lookup。
            # 这样既保持输出构造逻辑简单，也避免逐 edge 构建 FunctionDef 的重复 IO/查询成本。
            target_ids = {edge["target_node_id"] for edge in edges}
            node_defs = self.accessor.build_function_defs_from_cg_node_ids(self.language, list(target_ids))

            next_level: list[CurrentNode] = []
            for current in current_level:
                # children 是当前 current node 的 outgoing edges；它们会被转换成 Callee，
                # append 到 current.children 指向的真实输出树 list 中。
                children = children_by_current.get(current.node_id, [])
                child_depth = current.depth + 1
                limit = self._callee_limit_for_depth(child_depth)
                added = 0

                for edge in children:
                    if limit and added >= limit:
                        break
                    
                    # 获取child的实现构建callee
                    child_id = edge["target_node_id"]
                    function_def = node_defs.get(child_id)
                    # 判断是否存在递归环路
                    has_cycle = child_id in current.path_node_ids
                    child = self._build_callee(edge, function_def, has_cycle=has_cycle)
                    if child is None:
                        continue

                    # current.children 指向输出树中当前节点的 callees list；这里 append
                    # 不是临时缓存，而是在把本条 callgraph edge 挂载到最终返回结构上。
                    current.children.append(child)
                    added += 1
                    traversed_children += 1

                    if self._can_expand_child(has_cycle=has_cycle, child_depth=child_depth):
                        # 为每个 child 创建独立的不可变 path_node_ids，避免兄弟分支共享可变 set
                        # 造成路径污染；membership 使用 frozenset 可把 cycle 判断优化到近似 O(1)。
                        next_level.append(
                            CurrentNode(
                                node_id=child_id,
                                children=child.callees,
                                path_node_ids=current.path_node_ids | {child_id},
                                depth=child_depth,
                            )
                        )

            elapsed_ms = (perf_counter() - level_started_at) * 1000
            depth_limit = "unlimited" if self.max_depth <= 0 else str(self.max_depth)
            children_limit = "unlimited" if limit <= 0 else str(limit)
            log_util.info(
                f"callgraph bfs depth={level_depth}, depth_limit={depth_limit}, "
                f"edges={len(edges)}, children={traversed_children}, children_limit={children_limit}"
                f"elapsed={elapsed_ms:.1f}ms",
                logger=logger,
            )
            current_level = next_level

        return top_callees

    def _callee_limit_for_depth(self, child_depth: int) -> int:
        """返回当前 child 深度应使用的 callee 限制。"""
        # root 的直接 callee 处于第 1 层。按接口语义，第一层需要尽量完整召回，
        # 不应用 max_callees_per_node；从第 2 层开始才使用该上限控制展开规模。
        if child_depth == 1:
            return 0
        return self.max_callees_per_node

    def _can_expand_child(self, *, has_cycle: bool, child_depth: int) -> bool:
        """判断 child 是否应进入下一层 BFS。"""
        # 成环 child 仍会被输出，并带 has_cycle=True；但不能继续放入下一层，
        # 否则 callgraph 中的环会导致无限展开。
        if has_cycle:
            return False
        # max_depth <= 0 表示不限制深度；否则 child_depth 必须小于 max_depth，
        # 因为达到最大深度的 child 只负责输出，不再继续展开它的 children。
        return self.max_depth <= 0 or child_depth < self.max_depth

    def _group_edges_by_current(self, edges: list[dict]) -> Dict[str, list[dict]]:
        """按 source_node_id 分组当前层出边，并按调用点位置稳定排序。"""
        children_by_current: Dict[str, list[dict]] = {}
        for edge in edges:
            children_by_current.setdefault(edge["source_node_id"], []).append(edge)

        # repository 层通常已经按调用点排序；这里再做一次本地稳定排序，
        # 让 traversor 的输出顺序不依赖 SQL 未来是否调整 ORDER BY。
        for children in children_by_current.values():
            children.sort(
                key=lambda edge: (
                    int(edge["call_site_start_line"] or 0),
                    int(edge["call_site_start_col"] or 0),
                    edge["target_node_id"],
                )
            )
        return children_by_current

    def build_python_dfs(self, root_node_id: str) -> List[models.Callee]:
        """使用旧版应用层 DFS 语义构建被调函数树。"""
        return self._build_python_dfs_node(
            current_node_id=root_node_id,
            depth=0,
            visited_nodes=set(),
            subtree_cache={},
        )

    def build_sql_recursive(self, root_node_id: str) -> List[models.Callee]:
        """基于递归 SQL 展开的边集合构建被调函数树。"""
        rows = self.accessor.recursive_outgoing_call_tree_edges(
            self.language, root_node_id, self.max_depth
        )
        return self._build_from_recursive_sql_rows(root_node_id, rows)

    def _build_python_dfs_node(
        self,
        current_node_id: str,
        depth: int,
        visited_nodes: Set[str],
        subtree_cache: Dict[tuple[str, int], List[models.Callee]],
    ) -> List[models.Callee]:
        if current_node_id in visited_nodes or (self.max_depth > 0 and depth >= self.max_depth):
            return []

        remaining_depth = self.max_depth - depth if self.max_depth > 0 else -1
        cache_key = (current_node_id, remaining_depth)
        if cache_key in subtree_cache:
            return subtree_cache[cache_key]

        visited_nodes.add(current_node_id)
        callees: List[models.Callee] = []
        edges = self.accessor.get_outgoing_edges(self.language, current_node_id)
        node_defs = self.accessor.build_function_defs_from_cg_node_ids(
            self.language, list({edge["target_node_id"] for edge in edges})
        )

        for edge in edges:
            if self.max_callees_per_node and len(callees) >= self.max_callees_per_node:
                break
            callee_id = edge["target_node_id"]
            has_cycle = callee_id in visited_nodes
            sub_callees: List[models.Callee] = []
            if not has_cycle:
                sub_callees = self._build_python_dfs_node(
                    current_node_id=callee_id,
                    depth=depth + 1,
                    visited_nodes=visited_nodes,
                    subtree_cache=subtree_cache,
                )
            callee = self._build_callee(edge, node_defs.get(callee_id), has_cycle=has_cycle)
            if callee is None:
                continue
            callee.callees = sub_callees
            callees.append(callee)

        visited_nodes.remove(current_node_id)
        subtree_cache[cache_key] = callees
        return callees

    def _build_from_recursive_sql_rows(
        self, root_node_id: str, rows: list[dict]
    ) -> List[models.Callee]:
        children_index: Dict[str, list[dict]] = {}
        for row in rows:
            children_index.setdefault(row["source_node_id"], []).append(row)
        for children in children_index.values():
            children.sort(
                key=lambda row: (
                    int(row["call_site_start_line"] or 0),
                    int(row["call_site_start_col"] or 0),
                )
            )

        node_defs = self.accessor.build_function_defs_from_cg_node_ids(
            self.language, list({row["target_node_id"] for row in rows})
        )
        subtree_cache: Dict[str, List[models.Callee]] = {}

        def build_for_parent(parent_id: str) -> List[models.Callee]:
            if parent_id in subtree_cache:
                return subtree_cache[parent_id]
            callees: List[models.Callee] = []
            for edge in children_index.get(parent_id, []):
                if self.max_callees_per_node and len(callees) >= self.max_callees_per_node:
                    break
                callee_id = edge["target_node_id"]
                callee = self._build_callee(edge, node_defs.get(callee_id), has_cycle=False)
                if callee is None:
                    continue
                callee.callees = build_for_parent(callee_id)
                callees.append(callee)
            subtree_cache[parent_id] = callees
            return callees

        return build_for_parent(root_node_id)

    def _build_callee(
        self,
        edge: dict,
        function_def: models.FunctionDef | None,
        has_cycle: bool,
    ) -> models.Callee | None:
        if not function_def or not hasattr(function_def, "location"):
            return None
        if (
            self.exclude_undefined_function_call
            and function_def.location.file_path == Path("default")
        ):
            return None

        callsite_location = self.accessor.callsite_row_to_location(edge)
        callsite_content = file_util.get_file_content_by_location(
            self.project_path, callsite_location
        )
        callee_content = (
            file_util.get_file_content_by_location(self.project_path, function_def.location)
            if self.detail_level == "full" and function_def.location is not None
            else ""
        )
        return models.Callee(
            call_site=models.CallSite(
                file_path=callsite_location.file_path.as_posix(),
                line=callsite_location.start_line,
                content=callsite_content,
            ),
            function_fqn=function_def.function_fqn,
            function_signature=function_def.function_signature,
            location=function_def.location,
            content=callee_content,
            has_cycle=has_cycle,
            callees=[],
        )
