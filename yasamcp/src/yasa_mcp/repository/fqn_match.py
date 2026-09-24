"""
fqcn / 函数 FQN 的**段边界匹配**工具。

背景：早期为支持「短类名+函数」「短类名」查询，多处 SQL 用了 DuckDB 原生
``contains(fqn, ?)``（纯字符子串包含）。但纯子串不识别 ``.`` 段边界，会误命中
（如 ``main.Main`` 命中 ``main.MainApp``）。

本模块提供统一的段边界正则构造：命中当且仅当输入作为**完整段序列**出现在 fqn 中
（前缀 / 后缀 / 中间 / 完整均可），且两端落在 ``.`` 段边界，不会匹配被截断的段。
"""

from __future__ import annotations

import re


def segment_boundary_regex(query: str) -> str:
    """把用户输入构造成"按 ``.`` 段边界匹配"的正则 pattern（供 DuckDB ``regexp_matches`` 使用）。

    命中规则：``query`` 作为完整段序列出现在候选 fqn 中，且其
    - 左端 = 字段开头 或 前面紧跟 ``.``
    - 右端 = 字段结尾 或 后面紧跟 ``.``

    因此覆盖四种合法场景（完整相等 / 后缀段 / 前缀段 / 中间段），并排除"段被截断"的误命中：
    ``main.Main`` 不命中 ``main.MainApp``；``Bar`` 不命中 ``FooBar``。

    ``re.escape`` 会转义 ``.`` / ``%`` / ``_`` 等元字符（``.`` 必须转义，否则正则里是任意字符）。

    :param query: 用户输入的 fqcn / 短类名 / 短类名+函数
    :return: 可直接作为 ``regexp_matches(fqn, ?)`` 参数的正则字符串
    """
    return r"(^|\.)" + re.escape(query) + r"(\.|$)"
