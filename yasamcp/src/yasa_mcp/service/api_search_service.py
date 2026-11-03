"""API 搜索服务：根据 api_name 反查接口实现函数。

从 authscan_service.py 提取，封装为 APISearchService 类。
多参数逻辑不再通过 __wrapped__ 解包递归，而是在类内直接循环单参数核心。
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

from yasa_mcp.core.cache_status import CacheStatusMask
from yasa_mcp.core.context import YasaMcpContext
from yasa_mcp.service.models import (
    Location,
    RouterDef,
)
from yasa_mcp.util import file_util
from yasa_mcp.util import log_util
from yasa_mcp.util.timer_util import timed
from yasa_mcp.util.selector_util import normalize_selector
from yasa_mcp.service.repository_service import (
    get_codegraph_repository,
)
from yasa_mcp.repository.query.codegraph.authscan_function_processor import (
    AuthScanFunctionProcessor,
)
from yasa_mcp.repository.query.codegraph.interface_implementation_processor import (
    InterfaceImplementationProcessor,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ApiQueryByNameContext:
    """``get_api_by_name`` 一次调用的预备上下文。

    通过 ``_validate_api_query`` 构造；构造成功即代表所有前置校验都已通过：
      - ``main_lang`` 非空
      - ``project_path`` 非空
      - ``use_regex=True`` 时 ``api_name`` 已被 ``re.compile`` 校验为合法正则
    """
    main_lang: str                  # 项目主语言（"java" / "python" / ...）
    project_path: Path              # 项目根目录绝对路径
    probes: list[tuple[str, str]]   # 探针列表，由 _build_probes 推导


class APISearchService:
    """根据 api_name 反查接口实现函数的搜索服务。

    多参数入口直接在类内循环调用 ``_get_api_by_name_single``（单参数核心），
    合并去重后返回，不依赖 ``__wrapped__`` 解包递归。
    """

    @staticmethod
    def get_api_by_name(
        context: YasaMcpContext,
        api_name: str | list[str],
        use_regex: bool = False,
        max_results: int = 10,
        max_output_tokens: int = 0,
    ) -> list[RouterDef]:
        """根据接口 api_name 反查其实现函数（支持 Java / Python）。

        支持 4 种 ``api_name`` 形态：

        1. HTTP route path：``/order/query``
        2. MRPC / OpenAPI 服务名：``alipay.smartcampus.user.query``
        3. 全限定类名+方法：``com.foo.UserServiceImpl.query``
        4. 短类名+方法：``UserService.query``、``FileController.upload``

        可填写一个搜索词，也可一次提供多个候选词，命中任一候选即返回。
        空值返回项目内所有可定位实现的接口。
        """
        # 单字符串直接走单参数核心，沿用调用方的 max_results。
        if isinstance(api_name, str):
            return APISearchService._get_api_by_name_single(
                context, api_name=api_name, use_regex=use_regex,
                max_results=max_results, max_output_tokens=max_output_tokens,
            )

        # 列表/多候选：逐个走单参数核心（不限量），合并去重后再统一截断。
        names = normalize_selector(api_name)
        if not names:
            # 空 list 保留"列出全部可定位实现接口"的既有语义，等价于空字符串单参数。
            return APISearchService._get_api_by_name_single(
                context, api_name="", use_regex=use_regex,
                max_results=max_results, max_output_tokens=max_output_tokens,
            )

        merged: list[RouterDef] = []
        seen: set[tuple[object, ...]] = set()
        for value in names:
            for item in APISearchService._get_api_by_name_single(
                context, api_name=value, use_regex=use_regex,
                max_results=0, max_output_tokens=0,
            ):
                key = (item.api_name, item.full_name, item.filepath, item.location.to_string())
                if key in seen:
                    continue
                seen.add(key)
                merged.append(item)
        return merged[:max_results] if max_results > 0 else merged

    @staticmethod
    @timed(logger, "api_search_service", "get_api_by_name_single")
    def _get_api_by_name_single(
        context: YasaMcpContext,
        api_name: str,
        use_regex: bool = False,
        max_results: int = 10,
        max_output_tokens: int = 0,
    ) -> list[RouterDef]:
        """单参数核心：CodeGraph 接口实现 → 函数兜底 两级查询。"""
        query_ctx = APISearchService._validate_api_query(context, api_name, use_regex)
        if query_ctx is None:
            return []

        results: list[RouterDef] = []

        if api_name:
            # 第一优先级：把输入解释为接口方法，返回并补全实现方法的 CodeGraph 定位。
            results = APISearchService.query_iface_implement_db(
                context,
                query_ctx,
                api_name,
                use_regex=use_regex,
                max_results=max_results,
            )
            if results:
                log_util.info(
                    f"get_api_by_name 接口实现查询命中: api_name={api_name!r}, "
                    f"results={len(results)}",
                    logger=logger,
                )

            # 最后降级：接口未命中时，把非 HTTP path 输入解释为普通函数。
            if not results and "/" not in api_name:
                results = APISearchService._fallback_get_function_by_name(
                    context=context,
                    query_ctx=query_ctx,
                    api_name=api_name,
                    use_regex=use_regex,
                    max_results=max_results,
                )
                if results:
                    log_util.info(
                        f"get_api_by_name 普通函数查询命中: api_name={api_name!r}, "
                        f"results={len(results)}",
                        logger=logger,
                    )

        log_util.info(
            f"get_api_by_name 完成: results={len(results)}",
            logger=logger,
        )
        return results

    @staticmethod
    def _validate_api_query(
        context: YasaMcpContext | None,
        api_name: str,
        use_regex: bool,
    ) -> ApiQueryByNameContext | None:
        """统一收敛 ``get_api_by_name`` 的前置校验与查询路径选择。

        任一前置失败：内部记好日志、返回 None；主流程据此直接 ``return []``。
        校验顺序：
            1. context 非空且 REPO 缓存就绪 —— 项目尚未 init_project 不能查
            2. 项目主语言可识别 —— 仅查询主语言路由表
            3. ``use_regex=True`` 时 ``re.compile(api_name)`` 必须合法
               —— 下游不再重复 try
        """
        # 1) repo 就绪
        if context is None or not context.is_cache_ready(CacheStatusMask.REPO):
            logger.error(
                "get_api_by_name: repo 未就绪，cache_status=%s",
                context.cache_status if context else "None",
            )
            return None

        # 2) 项目主语言
        main_lang = context.get_project_main_language()
        if not main_lang:
            log_util.error("get_api_by_name: 未识别项目主语言", logger=logger)
            return None

        # 3) use_regex=True 时 api_name 必须是合法 regex；非法直接返回 None
        if use_regex and api_name:
            try:
                re.compile(api_name)
            except re.error as e:
                log_util.warning(
                    f"get_api_by_name: 非法正则 api_name={api_name!r}, error={e}",
                    logger=logger,
                )
                return None

        return ApiQueryByNameContext(
            main_lang=main_lang,
            project_path=context.project_path,
            probes=APISearchService._build_probes(api_name),
        )

    @staticmethod
    def _build_probes(api_name: str) -> list[tuple[str, str]]:
        """根据 api_name 形态决定探针列表。每个探针 = (field, mode)。

        - 空 / 含 ``/`` → HTTP URL，仅探 api_url
        - 短类名+方法（仅 1 个 ``.`` 且首字母大写）→ interface_fqn / handler / def_scope suffix
        - 其他点分形态（FQCN / MRPC / OpenAPI）→ api_url / interface_fqn / handler / def_scope exact
        """
        if not api_name or "/" in api_name:
            return [("api_url", "exact")]
        if api_name.count(".") == 1 and api_name[:1].isupper():
            return [
                ("interface_fqn", "suffix"),
                ("handler", "suffix"),
                ("def_scope", "suffix"),
            ]
        return [
            ("api_url", "exact"),
            ("interface_fqn", "exact"),
            ("handler", "exact"),
            ("def_scope", "exact"),
        ]

    @staticmethod
    def _build_router_def(
        api_name: str,
        framework: str,
        full_name: str,
        signature: str,
        def_file_path: str,
        start_line,
        end_line,
        project_path,
    ) -> RouterDef | None:
        """构造 RouterDef：def_file 缺失或行号缺失时返回 None。"""
        if not def_file_path or start_line is None or end_line is None:
            return None
        location = Location(
            file_path=Path(def_file_path),
            start_line=int(start_line),
            start_column=0,
            end_line=int(end_line),
            end_column=0,
        )
        content = ""
        if project_path is not None:
            try:
                content = file_util.get_file_content_by_location(project_path, location)
            except Exception as e:
                log_util.warning(
                    f"读取实现源码失败: file={def_file_path}, "
                    f"start={start_line}, end={end_line}, error={e}",
                    logger=logger,
                )
        return RouterDef(
            api_name=api_name,
            framework=framework,
            full_name=full_name,
            signature=signature,
            filepath=def_file_path,
            location=location,
            content=content,
        )

    _IFACE_INPUT_KIND = ("fqcn_method", "fqcn_class", "short_method", "short_class")

    @staticmethod
    def _classify_iface_input(api_name: str) -> str | None:
        """根据 api_name 形态判断走 interface_implement 表的哪种查询。

        返回值 ∈ {"fqcn_method", "fqcn_class", "short_method", "short_class", None}。
        None 表示形态不匹配（含 ``/`` 的 HTTP path、纯方法名、首字母小写的类等），
        调用方据此跳过接口分支。
        """
        if not api_name or "/" in api_name:
            return None
        if "." in api_name:
            last = api_name.rsplit(".", 1)[-1]
            if not last:
                return None
            if api_name.count(".") == 1:
                if api_name[:1].isupper() and last[:1].islower():
                    return "short_method"
                return None
            if last[:1].isupper():
                return "fqcn_class"
            if last[:1].islower():
                return "fqcn_method"
            return None
        if api_name[:1].isupper():
            return "short_class"
        return None

    _IFACE_LOCATION_REGEX = re.compile(r"^(.+):(\d+):(\d+):(\d+):(\d+)$")

    @staticmethod
    def _parse_iface_location(loc_str: str) -> tuple[str, int, int] | None:
        """解析 ``path:sl:sc:el:ec`` 串，返回 (file_path, start_line, end_line)。"""
        if not loc_str:
            return None
        m = APISearchService._IFACE_LOCATION_REGEX.match(loc_str)
        if not m:
            return None
        try:
            return m.group(1), int(m.group(2)), int(m.group(4))
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _iface_row_to_router_def(row: dict, project_path) -> RouterDef | None:
        """把 interface_implement 行转 RouterDef。"""
        loc_str = row.get("function_impl_location") or ""
        parsed = APISearchService._parse_iface_location(loc_str)
        if parsed is None:
            return None
        file_path, start_line, end_line = parsed
        return APISearchService._build_router_def(
            api_name="",
            framework="",
            full_name=row.get("function_impl_fqcn") or "",
            signature=row.get("function_signature") or "",
            def_file_path=file_path,
            start_line=start_line,
            end_line=end_line,
            project_path=project_path,
        )

    @staticmethod
    def query_iface_implement_db(
        context: YasaMcpContext,
        query_ctx: ApiQueryByNameContext,
        api_name: str,
        use_regex: bool,
        max_results: int,
    ) -> list[RouterDef]:
        """优先把输入解析为接口实现方法 ``RouterDef``。

        显式 regex 不进入接口 SQL，而是返回空结果，让调用链继续执行受控的 CodeGraph
        function 查询。Repository 仅从已发布的 consumer DB 获取。

        结果按 full name、signature、filepath 去重，再应用 ``max_results``。
        """
        if use_regex:
            return []

        repository = get_codegraph_repository(context)
        if repository is None:
            return []
        try:
            resolution = InterfaceImplementationProcessor(
                repository, query_ctx.main_lang
            ).resolve(api_name)
        except Exception as exc:
            log_util.warning(
                f"CodeGraph 接口实现查询失败: api_name={api_name!r}, error={exc}",
                logger=logger,
            )
            return []

        results: list[RouterDef] = []
        seen: set[tuple[str, str, str]] = set()
        for row in resolution.records:
            rd = APISearchService._build_router_def(
                api_name="",
                framework="",
                full_name=row["function_fqn"],
                signature=row["function_signature"],
                def_file_path=row["file_path"],
                start_line=row["start_line"],
                end_line=row["end_line"],
                project_path=query_ctx.project_path,
            )
            if rd is None:
                continue
            key = (rd.full_name, rd.signature, str(rd.filepath))
            if key in seen:
                continue
            seen.add(key)
            results.append(rd)
        log_util.info(
            f"query_iface_implement_db: status={resolution.status.value}, results={len(results)}",
            logger=logger,
        )
        return results[:max_results] if max_results > 0 else results

    @staticmethod
    def _fallback_get_function_by_name(
        context: YasaMcpContext,
        query_ctx: ApiQueryByNameContext,
        api_name: str,
        use_regex: bool,
        max_results: int,
    ) -> list[RouterDef]:
        """接口实现未命中时，查询 class-only 或具体普通函数。

        ``AuthScanFunctionProcessor`` 保留 class-only owner 查询；具体函数与显式正则由其
        委托 ``FunctionAnalysisProcessor``。映射完成后应用结果上限。
        """
        if not context:
            return []
        repository = get_codegraph_repository(context)
        if repository is None:
            return []

        try:
            rows = AuthScanFunctionProcessor(
                repository, query_ctx.main_lang
            ).search(
                api_name,
                use_regex=use_regex,
                limit=0,
                project_path=query_ctx.project_path,
            )
        except Exception as exc:
            log_util.warning(
                f"CodeGraph 函数兜底失败: api_name={api_name!r}, error={exc}",
                logger=logger,
            )
            return []

        results: list[RouterDef] = []
        seen: set[tuple[str, str, str]] = set()
        for row in rows:
            rd = APISearchService._build_router_def(
                api_name="",
                framework="",
                full_name=row.get("function_fqn") or "",
                signature=row.get("function_signature") or "",
                def_file_path=row.get("file_path") or "",
                start_line=row.get("start_line"),
                end_line=row.get("end_line"),
                project_path=query_ctx.project_path,
            )
            if rd is None:
                continue
            key = (rd.full_name, rd.signature, str(rd.filepath))
            if key in seen:
                continue
            seen.add(key)
            results.append(rd)
        return results[:max_results] if max_results > 0 else results
