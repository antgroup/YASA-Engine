"""CLI 参数与 MCP 参数映射：把 test_cases 的 arguments 转成 yasamcp 调用参数。"""

from __future__ import annotations

from pathlib import Path


def multi_values(args: dict, key: str) -> list[str]:
    """把单值或列表参数统一展开为 list[str]（CLI 多值参数需要展开）。"""
    v = args.get(key)
    if v is None:
        return []
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v]
    return [str(v)]


def multi_opts(flag: str, args: dict, key: str) -> list[str]:
    """把单值或列表参数展开为 [flag, val, flag, val, ...] 的 CLI 选项序列。"""
    v = args.get(key)
    if v is None or v == "":
        return []
    if isinstance(v, (list, tuple)):
        result: list[str] = []
        for item in v:
            result += [flag, str(item)]
        return result
    return [flag, str(v)]


class CliArgBuilder:
    """把工具名 + arguments 转成 yasamcp CLI 子命令参数列表。

    参数映射与旧版 test_cli_tools.py 的 _build 函数完全保持一致。
    """

    @staticmethod
    def build(tool: str, args: dict, project: Path, bin_dir: Path) -> list[str]:
        if tool == "init_project":
            return ["init", str(args.get("project_path", project)), "-b", str(bin_dir)]

        post = ["-p", str(project), "-j"]

        if tool == "get_class_by_name":
            sub = ["class"] + multi_values(args, "name") + multi_opts("--fqn", args, "class_fqn")
            if args.get("use_regex"):
                sub.append("--use-regex")
            if args.get("include_methods"):
                sub.append("--include-methods")
            sub += ["--max-results", str(args.get("max_results", 10))]
            return sub + post

        if tool == "get_function_by_name":
            sub = ["func"] + multi_opts("--name", args, "name") + multi_opts("--fqn", args, "function_fqn")
            if args.get("use_regex"):
                sub.append("--use-regex")
            sub += ["--max-results", str(args.get("max_results", 10))]
            return sub + post

        if tool == "get_function_by_file":
            sub = ["func"] + multi_opts("--file-path", args, "file_path")
            if args.get("use_regex"):
                sub.append("--use-regex")
            sub += ["--detail", str(args.get("detail_level", "summary"))]
            sub += ["--max-results", str(args.get("max_results", 0))]
            return sub + post

        if tool == "get_function_by_code":
            sub = ["func", "--code", str(args.get("code_snippet", ""))]
            if args.get("use_regex"):
                sub.append("--use-regex")
            sub += ["--max-results", str(args.get("max_results", 10))]
            return sub + post

        if tool == "get_file_by_keyword":
            sub = ["keywords"] + multi_values(args, "keyword")
            if args.get("use_regex"):
                sub.append("--use-regex")
            sub += ["--detail", str(args.get("detail_level", "summary"))]
            sub += ["--max-results", str(args.get("max_results", 10))]
            return sub + post

        if tool == "get_function_by_call":
            sub = ["callees", str(args.get("function_call", ""))]
            if args.get("file_path"):
                sub += ["--file-path", str(args["file_path"])]
            if args.get("line", 0):
                sub += ["--line", str(args["line"])]
            sub += ["--max-results", str(args.get("max_results", 10))]
            return sub + post

        if tool == "get_reference_by_function":
            sub = ["callers", str(args.get("name", ""))]
            if args.get("function_fqn"):
                sub += ["--fqn", str(args["function_fqn"])]
            if args.get("file_path"):
                sub += ["--file-path", str(args["file_path"])]
            if args.get("line", 0):
                sub += ["--line", str(args["line"])]
            if args.get("use_regex"):
                sub.append("--use-regex")
            sub += ["--max-results", str(args.get("max_results", 10))]
            return sub + post

        if tool == "get_call_graph":
            sub = ["callgraph", str(args.get("name", ""))]
            if args.get("function_fqn"):
                sub += ["--fqn", str(args["function_fqn"])]
            if args.get("file_path"):
                sub += ["--file-path", str(args["file_path"])]
            if args.get("line", 0):
                sub += ["--line", str(args["line"])]
            sub += ["--depth", str(args.get("depth", 3))]
            if args.get("use_regex"):
                sub.append("--use-regex")
            sub += ["--detail", str(args.get("detail_level", "summary"))]
            sub += ["--maxcallees", str(args.get("max_callees_per_node", 3))]
            flag = "--exclude" if args.get("exclude_undefined_function_call", True) else "--no-exclude"
            sub.append(flag)
            return sub + post

        if tool == "search_symbol":
            sub = ["search"] + multi_values(args, "search")
            if args.get("kind"):
                sub += ["-k", str(args["kind"])]
            if args.get("detail_level"):
                sub += ["--detail", str(args["detail_level"])]
            sub += ["--max-results", str(args.get("max_results", 10))]
            return sub + post

        if tool == "get_api_by_name":
            sub = ["api"] + multi_values(args, "api_name")
            if args.get("use_regex"):
                sub.append("--use-regex")
            sub += ["--max-results", str(args.get("max_results", 0))]
            return sub + post

        raise ValueError(f"未知工具: {tool}")


# MCP 工具名映射
TOOL_MAP: dict[str, str] = {
    "get_class_by_name": "get_class_by_name",
    "get_function_by_name": "get_function",
    "get_function_by_file": "get_function",
    "get_function_by_code": "get_function",
    "get_file_by_keyword": "get_file_by_keyword",
    "get_function_by_call": "get_function_by_call",
    "get_reference_by_function": "get_reference_by_function",
    "get_call_graph": "get_call_graph",
    "search_symbol": "search_symbol",
    "get_api_by_name": "get_api_by_name",
}


class McpArgBuilder:
    """把 test_cases 参数映射为 MCP 工具参数（对齐 CLI 默认值）。"""

    @staticmethod
    def normalize(tool: str, args: dict, project_path: Path) -> dict:
        kwargs = dict(args)
        kwargs["project_path"] = str(project_path.resolve())
        if tool == "get_function_by_code":
            kwargs["code"] = kwargs.pop("code_snippet", kwargs.get("code", ""))
        if tool == "get_function_by_file":
            kwargs.setdefault("max_results", 0)
        return kwargs
