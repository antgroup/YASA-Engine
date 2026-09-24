"""yasa-mcp CLI 薄壳层。

查询类子命令经 bin.tools_service 直连 service 层，不重复查询逻辑、不 import
MCP SDK;只有 `server` 子命令才延迟导入 yasa_mcp.server。
支持多值输入的参数（如 search、class、func、keywords）可一次传入多个候选值，
列表内按 OR 语义命中任一即返回。
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any

import click

from yasa_mcp import __version__

_BUILD_DATE = "20260920"  # @BUILD_DATE@
_GIT_COMMIT = "74403a8"  # @GIT_COMMIT@
_BUILD_INFO = f"{__version__} (build {_BUILD_DATE}, commit {_GIT_COMMIT})"

from yasa_mcp.config import global_config, log_config
from yasa_mcp.util.path_util import ensure_path
from yasa_mcp.bin.formatter import print_result

logger = logging.getLogger("yasa_mcp.bin")


def _print_version(ctx: click.Context, param: click.Parameter, value: bool) -> None:
    if not value or ctx.resilient_parsing:
        return
    if ctx.invoked_subcommand is not None:
        return
    click.echo()
    click.echo("=============  Yet Another Static Analyzer MCP (YASA-MCP)  =============")
    click.echo(f"Version   : {_BUILD_INFO}")
    click.echo("=======================================================================")
    click.echo()
    ctx.exit()


def _setup_global_config() -> None:
    """设置全局日志配置，并为查询进程加载持久化 binary_path + runtime 单例。

    查询进程只读固定路径、不解析、不校验、不覆盖（resolver 重路径只在
    init / server -b 中调用）。
    """
    global_config.log_path = ensure_path(Path.home() / ".yasamcp" / "logs")
    log_config.setup_logger()
    from yasa_mcp.core.binary_manager import BinaryManager
    BinaryManager.load_from_persisted()


async def _call_tool(tool_name: str, arguments: dict[str, Any]) -> Any:
    # 查询工具直连 service,不经 server.py / fastmcp,避免一次 ~0.5s 的 MCP SDK 导入
    from yasa_mcp.bin import tools_service
    return await tools_service.dispatch(tool_name, arguments)


def run_tool(ctx: click.Context, tool_name: str, arguments: dict[str, Any], json_output: bool = False) -> None:
    """执行一个工具并打印结果。

    分 3 阶段计时（写入 ~/.yasamcp/logs 当日日志）：
      load = fastload/context 加载
      tool = mcp.call_tool（含 _get_context + service）
      fmt  = print_result 序列化
    """
    t_start = time.perf_counter()

    load_project(ctx, arguments.get("project_path"))

    t0 = time.perf_counter()
    result = asyncio.run(_call_tool(tool_name, arguments))
    t1 = time.perf_counter()
    print_result(result, json_output=json_output)
    t2 = time.perf_counter()

    logger.info(
        f"[TIMING] tool={tool_name} "
        f"load={(t0 - t_start) * 1000:.1f}ms "
        f"tool={(t1 - t0) * 1000:.1f}ms "
        f"fmt={(t2 - t1) * 1000:.1f}ms "
        f"sum={(t2 - t_start) * 1000:.1f}ms"
    )


def load_project(ctx: click.Context, project_path: str | None) -> None:
    """加载项目缓存上下文；不存在则报错提示先执行 init。

    binary_path 不在此处解析：查询进程的 runtime 已在 group 回调里建好，
    这里只做缓存 DB 存在检测 + fastload。
    """
    if not project_path:
        return
    resolved = Path(project_path).resolve()
    if not resolved.exists():
        click.echo(f"Error: 项目路径不存在: {project_path}", err=True)
        raise click.Abort()
    from yasa_mcp.core.project_cache_manager import ProjectCacheManager
    pcm = ProjectCacheManager(resolved)
    ctx.obj["pcm"] = pcm
    try:
        pcm.validate_or_abort()
        pcm.load_context()
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        raise click.Abort()


from yasa_mcp.bin.param_utils import parse_multi_args, normalize_detail


class OrderedCommandGroup(click.Group):
    """自定义命令顺序，避免 Click 默认字母序。"""
    COMMAND_ORDER = [
        "init", "status", "search", "class", "func", "keywords",
        "api", "callers", "callees", "callgraph", "server",
    ]

    def list_commands(self, ctx):
        ordered = [name for name in self.COMMAND_ORDER if name in self.commands]
        rest = [name for name in self.commands if name not in self.COMMAND_ORDER]
        return ordered + rest


@click.group(context_settings={"help_option_names": ["-h", "--help"]}, cls=OrderedCommandGroup)
@click.option("-v", "--version", is_flag=True, callback=_print_version, expose_value=False, is_eager=True, help="显示版本信息并退出")
@click.pass_context
def cli(ctx: click.Context) -> None:
    """yasamcp CLI 基于静态分析引擎 yasa 的仓库结构化查询工具"""
    ctx.ensure_object(dict)
    _setup_global_config()



# ---------------------------------------------------------------------------
# init
# ---------------------------------------------------------------------------


@cli.command()
@click.argument("project_path", type=click.Path(dir_okay=True, resolve_path=True))
@click.option("-b", "--bin", "bin", type=click.Path(dir_okay=True, resolve_path=True), default=None, envvar="YASA_MCP_BIN_DIR", help="native binary 目录；未指定时用 ~/.yasamcp 或上次 init 持久化的路径")
@click.option("--save", "save_cg_dump", is_flag=True, default=False, help="保留 yasa 原始调用图中间数据（yasacg 目录），默认导入后删除以节省空间")
@click.option("--no-progress", is_flag=True, default=False, help="禁用进度条（CI/日志场景）")
@click.pass_context
def init(ctx: click.Context, project_path: str, bin: str, save_cg_dump: bool, no_progress: bool) -> None:
    """初始化项目分析缓存，对代码工程做静态分析预处理并加速后续查询，支持自动增量更新。"""
    from yasa_mcp.core.binary_manager import BinaryManager
    from yasa_mcp.service.init_service import init_project
    from yasa_mcp.bin.progress import InitProgressPrinter

    project = Path(project_path).resolve()
    printer = InitProgressPrinter(enabled=False if no_progress else None)
    printer.start()
    printer.on_stage("checking_binary")
    # init 进程：resolve+validate+persist+init_runtime（唯一进入 binary_manager 重路径的地方）
    try:
        BinaryManager.configure(bin or None)
    except Exception as e:
        click.echo(f"Error: {e}", err=True)
        raise click.Abort()
    try:
        result = init_project(
            project_path=project,
            save_cg_dump=save_cg_dump,
            on_stage=printer.on_stage,
            on_done=printer.on_done,
        )
    except Exception as e:
        printer.stop()
        click.echo(f"Error: {e}", err=True)
        raise click.Abort()
    printer.stop()
    click.echo(result)


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


@cli.command()
@click.option("-p", "--project", "project", required=True, type=click.Path(dir_okay=True, resolve_path=True), envvar="YASA_MCP_PROJECT", help="分析好的仓库路径（必填）；缓存落 <project>/.yasa/。也可设置环境变量 YASA_MCP_PROJECT 后省略填写")
@click.pass_context
def status(ctx: click.Context, project: str) -> None:
    """判断指定项目分析缓存的状态。

    返回 JSON：合法状态 state=分析已完成、valid=true；
    非法状态 state 为 分析数据不完整/分析已过期/无分析结果 之一，valid=false 并附 advice。
    """
    import json as _json
    from yasa_mcp.core.project_cache_manager import ProjectCacheManager

    resolved = Path(project).resolve()
    if not resolved.exists():
        click.echo(_json.dumps({"state": "无分析结果", "valid": False,
                                "detail": "项目路径不存在",
                                "advice": "请通过 yasamcp init 生成分析结果"},
                               ensure_ascii=False))
        raise click.Abort()
    pcm = ProjectCacheManager(resolved)
    result = pcm.validate_cache()
    out: dict = {"state": result.state.value, "valid": result.is_valid}
    if not result.is_valid:
        out["detail"] = result.detail
        out["advice"] = result.advice
    click.echo(_json.dumps(out, ensure_ascii=False))


# ---------------------------------------------------------------------------
# search
# ---------------------------------------------------------------------------


@cli.command()
@click.argument("query", nargs=-1, required=True)
@click.option("-k", "--kind", default="", help="结果类型过滤：function/class/interface/file；留空返回所有命中符号")
@click.option("--detail", "detail_level", default="summary", callback=normalize_detail, help="详细程度：summary 仅元信息 / full 含源码；也可用 true(=full) / false(=summary)")
@click.option("--offset", type=int, default=0, help="分页偏移量")
@click.option("--max-results", type=int, default=0, help="最多返回结果数，0 表示不限制")
@click.option("-j", "--json", "json_output", is_flag=True, default=False, help="以 JSON 格式输出结果")
@click.option("-p", "--project", "project", required=True, type=click.Path(dir_okay=True, resolve_path=True), envvar="YASA_MCP_PROJECT", help="分析好的仓库路径（必填）；缓存落 <project>/.yasa/。也可设置环境变量 YASA_MCP_PROJECT 后省略填写")
@click.pass_context
def search(ctx: click.Context, project: str, query: tuple[str, ...], kind: str, detail_level: str, offset: int, max_results: int, json_output: bool) -> None:
    """统一符号搜索，根据一个或多个搜索词返回仓库中所有匹配的符号。"""
    args = {"project_path": project, "search": parse_multi_args(query), "kind": kind, "detail_level": detail_level, "offset": offset, "max_results": max_results}
    run_tool(ctx, "search_symbol", args, json_output=json_output)


# ---------------------------------------------------------------------------
# class
# ---------------------------------------------------------------------------


@cli.command(name="class")
@click.argument("name", nargs=-1, required=True)
@click.option("--fqn", multiple=True, help="类全限定名；可传入多个候选，补充 name 查找范围")
@click.option("--use-regex", is_flag=True, default=False, help="是否将 name/class_fqn 按正则表达式匹配")
@click.option("--include-methods", is_flag=True, default=False, help="是否返回类下方法列表")
@click.option("--offset", type=int, default=0, help="分页偏移量")
@click.option("--max-results", type=int, default=10, help="最多返回结果数，0 表示不限制")
@click.option("-j", "--json", "json_output", is_flag=True, default=False, help="以 JSON 格式输出结果")
@click.option("-p", "--project", "project", required=True, type=click.Path(dir_okay=True, resolve_path=True), envvar="YASA_MCP_PROJECT", help="分析好的仓库路径（必填）；缓存落 <project>/.yasa/。也可设置环境变量 YASA_MCP_PROJECT 后省略填写")
@click.pass_context
def query_class(ctx: click.Context, project: str, name: tuple[str, ...], fqn: tuple[str, ...], use_regex: bool, include_methods: bool, offset: int, max_results: int, json_output: bool) -> None:
    """按类名或类全限定名查询类定义，可选返回类方法列表，支持传入多个类名返回所有在当前仓库可找到的类实现。"""
    args = {"project_path": project, "name": parse_multi_args(name), "class_fqn": parse_multi_args(fqn), "use_regex": use_regex, "include_methods": include_methods, "offset": offset, "max_results": max_results}
    run_tool(ctx, "get_class_by_name", args, json_output=json_output)


# ---------------------------------------------------------------------------
# func / function
# ---------------------------------------------------------------------------


@cli.command(name="func")
@click.option("--name", multiple=True, help="函数短名、函数名关键字或正则；可传入多个候选，走按名查询路由")
@click.option("--fqn", multiple=True, help="函数全限定名；可传入多个候选，补充 name 查找范围，走按名查询路由")
@click.option("--file-path", multiple=True, help="项目相对路径；可传入多个文件，走按文件查询路由，传 . 表示全部文件")
@click.option("--code", default="", help="代码片段；传入走按代码片段定位函数路由")
@click.option("--use-regex", is_flag=True, default=False, help="是否将 name/file_path/code 按正则表达式匹配")
@click.option("--detail", "detail_level", default="summary", callback=normalize_detail, help="详细程度：summary 摘要 / full 完整函数体；也可用 true(=full) / false(=summary)")
@click.option("--offset", type=int, default=0, help="分页偏移量")
@click.option("--max-results", type=int, default=10, help="最多返回结果数，0 表示不限制")
@click.option("-j", "--json", "json_output", is_flag=True, default=False, help="以 JSON 格式输出结果")
@click.option("-p", "--project", "project", required=True, type=click.Path(dir_okay=True, resolve_path=True), envvar="YASA_MCP_PROJECT", help="分析好的仓库路径（必填）；缓存落 <project>/.yasa/。也可设置环境变量 YASA_MCP_PROJECT 后省略填写")
@click.pass_context
def func(ctx: click.Context, project: str, name: tuple[str, ...], fqn: tuple[str, ...], file_path: tuple[str, ...], code: str, use_regex: bool, detail_level: str, offset: int, max_results: int, json_output: bool) -> None:
    """查询函数定义，按入参类型互斥路由：传 --name 按函数名查（可配合 --fqn 收敛），传 --file-path 按文件查并返回这些文件中的全部函数，传 --code 按代码片段定位函数。"""
    args = {
        "project_path": project,
        "name": parse_multi_args(name),
        "function_fqn": parse_multi_args(fqn),
        "file_path": parse_multi_args(file_path),
        "code": code,
        "use_regex": use_regex,
        "detail_level": detail_level,
        "offset": offset,
        "max_results": max_results,
    }
    run_tool(ctx, "get_function", args, json_output=json_output)




# ---------------------------------------------------------------------------
# keywords
# ---------------------------------------------------------------------------


@cli.command()
@click.argument("keyword", nargs=-1, required=True)
@click.option("--use-regex", is_flag=True, default=False, help="是否使用正则匹配")
@click.option("--detail", "detail_level", default="summary", callback=normalize_detail, help="详细程度：summary 匹配片段上下文 / full 完整文件内容；也可用 true(=full) / false(=summary)")
@click.option("--offset", type=int, default=0, help="分页偏移量")
@click.option("--max-results", type=int, default=10, help="最多返回的文件数量，0 表示不限制")
@click.option("-j", "--json", "json_output", is_flag=True, default=False, help="以 JSON 格式输出结果")
@click.option("-p", "--project", "project", required=True, type=click.Path(dir_okay=True, resolve_path=True), envvar="YASA_MCP_PROJECT", help="分析好的仓库路径（必填）；缓存落 <project>/.yasa/。也可设置环境变量 YASA_MCP_PROJECT 后省略填写")
@click.pass_context
def keywords(ctx: click.Context, project: str, keyword: tuple[str, ...], use_regex: bool, detail_level: str, offset: int, max_results: int, json_output: bool) -> None:
    """根据关键字搜索文件内容，返回所有命中任一关键字的文件。"""
    args = {"project_path": project, "keyword": parse_multi_args(keyword), "use_regex": use_regex, "detail_level": detail_level, "offset": offset, "max_results": max_results}
    run_tool(ctx, "get_file_by_keyword", args, json_output=json_output)


# ---------------------------------------------------------------------------
# callees
# ---------------------------------------------------------------------------


@cli.command()
@click.argument("api_name", nargs=-1, required=True)
@click.option("--use-regex", is_flag=True, default=False, help="是否将 api_name 按正则表达式匹配")
@click.option("--max-results", type=int, default=0, help="最多返回结果数，0 表示不限制")
@click.option("-j", "--json", "json_output", is_flag=True, default=False, help="以 JSON 格式输出结果")
@click.option("-p", "--project", "project", required=True, type=click.Path(dir_okay=True, resolve_path=True), envvar="YASA_MCP_PROJECT", help="分析好的仓库路径（必填）；缓存落 <project>/.yasa/。也可设置环境变量 YASA_MCP_PROJECT 后省略填写")
@click.pass_context
def api(ctx: click.Context, project: str, api_name: tuple[str, ...], use_regex: bool, max_results: int, json_output: bool) -> None:
    """根据接口名返回接口实现，支持 HTTP 路径、MRPC 服务名、全限定类名+方法、短类名+方法。"""
    args = {"project_path": project, "api_name": parse_multi_args(api_name), "use_regex": use_regex, "max_results": max_results}
    run_tool(ctx, "get_api_by_name", args, json_output=json_output)


# ---------------------------------------------------------------------------
# server — 启动 MCP 进程
# ---------------------------------------------------------------------------


@cli.command()
@click.argument("name")
@click.option("--fqn", default="", help="函数全限定名，非空时优先精确匹配")
@click.option("--file-path", default="", help="调用点所在文件路径，使用相对路径")
@click.option("--line", type=int, default=0, help="调用点行号")
@click.option("--use-regex", is_flag=True, default=False, help="是否使用正则匹配")
@click.option("--offset", type=int, default=0, help="分页偏移量")
@click.option("--max-results", type=int, default=10, help="最大返回结果数，0 表示不限制")
@click.option("-j", "--json", "json_output", is_flag=True, default=False, help="以 JSON 格式输出结果")
@click.option("-p", "--project", "project", required=True, type=click.Path(dir_okay=True, resolve_path=True), envvar="YASA_MCP_PROJECT", help="分析好的仓库路径（必填）；缓存落 <project>/.yasa/。也可设置环境变量 YASA_MCP_PROJECT 后省略填写")
@click.pass_context
def callers(ctx: click.Context, project: str, name: str, fqn: str, file_path: str, line: int, use_regex: bool, offset: int, max_results: int, json_output: bool) -> None:
    """获取函数被调用的位置，即查找谁在什么文件、什么行调用了指定函数。"""
    args = {"project_path": project, "name": name, "function_fqn": fqn, "file_path": file_path, "line": line, "use_regex": use_regex, "offset": offset, "max_results": max_results}
    run_tool(ctx, "get_reference_by_function", args, json_output=json_output)


# ---------------------------------------------------------------------------
# callgraph
# ---------------------------------------------------------------------------


@cli.command()
@click.argument("function_call")
@click.option("--file-path", default="", help="调用点所在文件路径，使用相对路径")
@click.option("--line", type=int, default=0, help="调用点行号")
@click.option("--max-results", type=int, default=10, help="最大返回结果数，0 表示不限制")
@click.option("-j", "--json", "json_output", is_flag=True, default=False, help="以 JSON 格式输出结果")
@click.option("-p", "--project", "project", required=True, type=click.Path(dir_okay=True, resolve_path=True), envvar="YASA_MCP_PROJECT", help="分析好的仓库路径（必填）；缓存落 <project>/.yasa/。也可设置环境变量 YASA_MCP_PROJECT 后省略填写")
@click.pass_context
def callees(ctx: click.Context, project: str, function_call: str, file_path: str, line: int, max_results: int, json_output: bool) -> None:
    """根据调用点信息获取被调用函数的定义，即给定函数调用代码，找到被调用函数的实现。"""
    args = {"project_path": project, "function_call": function_call, "file_path": file_path, "line": line, "max_results": max_results}
    run_tool(ctx, "get_function_by_call", args, json_output=json_output)


# ---------------------------------------------------------------------------
# callers
# ---------------------------------------------------------------------------


@cli.command()
@click.argument("name")
@click.option("--fqn", default="", help="函数全限定名，非空时优先精确匹配")
@click.option("--file-path", default="", help="文件路径，使用相对路径")
@click.option("--line", type=int, default=0, help="行号")
@click.option("--depth", type=int, default=3, help="调用链展开深度，默认 3")
@click.option("--use-regex", is_flag=True, default=False, help="是否使用正则匹配")
@click.option("--detail", "detail_level", default="summary", callback=normalize_detail, help="详细程度：summary / full / true(=full) / false(=summary)")
@click.option("--maxcallees", "max_callees_per_node", type=int, default=3, help="每个节点最多返回的被调用函数数量，0 或负数不限制")
@click.option("--exclude/--no-exclude", "exclude_undefined_function_call", default=True, help="是否排除无定义的函数调用（外部函数、二三方包等），默认排除")
@click.option("-j", "--json", "json_output", is_flag=True, default=False, help="以 JSON 格式输出结果")
@click.option("-p", "--project", "project", required=True, type=click.Path(dir_okay=True, resolve_path=True), envvar="YASA_MCP_PROJECT", help="分析好的仓库路径（必填）；缓存落 <project>/.yasa/。也可设置环境变量 YASA_MCP_PROJECT 后省略填写")
@click.pass_context
def callgraph(ctx: click.Context, project: str, name: str, fqn: str, file_path: str, line: int, depth: int, use_regex: bool, detail_level: str, max_callees_per_node: int, exclude_undefined_function_call: bool, json_output: bool) -> None:
    """获取函数的调用图，返回指定函数的调用关系链路，可控制展开深度和每个节点的被调用函数数量。"""
    args = {"project_path": project, "name": name, "function_fqn": fqn, "file_path": file_path, "line": line, "depth": depth, "use_regex": use_regex, "detail_level": detail_level, "max_callees_per_node": max_callees_per_node, "exclude_undefined_function_call": exclude_undefined_function_call}
    run_tool(ctx, "get_call_graph", args, json_output=json_output)



# ---------------------------------------------------------------------------
# api
# ---------------------------------------------------------------------------


@cli.command()
@click.option("-t", "--transport", type=click.Choice(["stdio", "sse", "streamable-http"]), default="stdio", envvar="YASA_MCP_TRANSPORT", help="传输协议：stdio 供 CC/Codex 直接 spawn，sse/streamable-http 常驻多客户端")
@click.option("-b", "--bin", "bin_dir", type=click.Path(dir_okay=True, resolve_path=True), envvar="YASA_MCP_BIN_DIR", help="native binary 目录，包含 codegraph/yasa 等可执行文件")
@click.option("--host", default="0.0.0.0", envvar="YASA_MCP_HOST", help="监听地址，用于 sse/streamable-http")
@click.option("--port", type=int, default=8000, envvar="YASA_MCP_PORT", help="监听端口，用于 sse/streamable-http")
@click.pass_context
def server(ctx: click.Context, transport: str, bin_dir: str, host: str, port: int) -> None:
    """启动 MCP server 常驻进程，供 CC/Codex 等 MCP 客户端通过 stdio 或 HTTP 连接调用。"""
    from yasa_mcp.server import mcp
    from yasa_mcp.core.binary_manager import BinaryManager
    # server -b 覆盖时走 resolver（重路径：resolve+validate+persist+init_runtime），
    # 否则读持久化建 runtime（轻路径，与查询进程一致）。
    if bin_dir:
        BinaryManager.configure(bin_dir)
    else:
        BinaryManager.load_from_persisted()
    if transport == "stdio":
        mcp.run(transport="stdio")
    elif transport == "streamable-http":
        mcp.run(transport="streamable-http", host=host, port=port)
    elif transport == "sse":
        mcp.run(transport="sse", host=host, port=port)

def main() -> None:
    """console script 入口：无子命令或 `server` = 启 MCP；其他 = 一次性查询。"""
    cli(standalone_mode=True)


if __name__ == "__main__":
    main()
