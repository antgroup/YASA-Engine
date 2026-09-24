"""CLI 参数解析工具。"""

from __future__ import annotations

import json


def parse_multi_args(value: tuple[str, ...]) -> str | list[str]:
    """多值参数归一化：单值返回 str，多值返回 list，零值返回空字符串。

    供所有支持多参数的 CLI 工具统一使用，避免各子命令重复实现
    ``list(x) if x else ""`` 这类样板。
    """
    return list(value) if len(value) > 1 else (value[0] if value else "")


def normalize_detail(ctx, param, value):
    """click 回调：归一化 --detail 取值，支持 summary / full / true / false。

    - true  → full（含源码）
    - false → summary（仅元信息）
    返回 service 层认的 ``summary`` 或 ``full``。
    """
    v = (value or "summary").strip().lower()
    if v in ("full", "true"):
        return "full"
    if v in ("summary", "false"):
        return "summary"
    import click
    raise click.BadParameter("--detail 仅支持 summary / full / true(=full) / false(=summary)")


def normalize_multivalue(value):
    """把部分 MCP 客户端(如 Codex)序列化成 JSON 字符串的 list 参数还原成 list。

    这些客户端传 list 形参数时会把整个数组 JSON 序列化,如
    ``"name": "[\"HttpUtil\", \"CmdObject\", \"SinkUtil\"]"``,使底层把整串当成单个
    类名/关键字查询而返回空。仅当 value 是首尾为 ``[]`` 的字符串时 ``json.loads``;
    其余形态(list / 普通字符串 / None 等)原样返回。
    """
    if isinstance(value, str) and value[:1] == "[" and value[-1:] == "]":
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value
