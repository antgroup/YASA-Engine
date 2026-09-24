from __future__ import annotations

import re
from pathlib import Path

from yasa_mcp.util.location_util import resolve_project_relative_path


class CodeGraphParamUtil:
    """将代码检索公开参数适配为 CodeGraph 存储格式。"""

    @staticmethod
    def build_class_fqn_candidates(value: str) -> list[str]:
        """按命名约定把点分类型名确定性地转换为 CodeGraph FQN。

        CodeGraph 只保留包内的点，类型及嵌套类型之间使用 ``::``。点分输入本身不携带
        边界元数据，因此以首个大写段作为类型起点；全小写输入无法证明边界时，保守地把
        最末段当作类型。该规则只产生一个候选，避免猜测多个边界导致错误 exact 命中。
        """
        source = (value or "").strip()
        if not source:
            return []
        if "::" in source:
            return [source]
        parts = [part for part in source.split(".") if part]
        if len(parts) <= 1:
            return [source]
        type_index = next(
            (index for index, part in enumerate(parts) if part[:1].isupper()),
            len(parts) - 1,
        )
        package = ".".join(parts[:type_index])
        type_path = "::".join(parts[type_index:])
        return [f"{package}::{type_path}" if package else type_path]

    @staticmethod
    def build_method_fqn_candidates(value: str) -> list[str]:
        """按同一类型边界约定生成唯一方法 FQN 候选。

        最末段固定视为函数名，前面的 owner 部分使用 class 的同一规则：首个大写段及其
        后续段均为类型或内部类；owner 全小写时，倒数第二段（即 owner 最末段）作为类型。
        已有 ``::`` 的存储格式原样保留。返回列表是为了保持 processor 契约，但确定性
        转换最多只返回一个元素。
        """
        source = (value or "").strip()
        if not source:
            return []
        if "::" in source:
            return [source]
        parts = [part for part in source.split(".") if part]
        if len(parts) <= 1:
            return [source]
        class_candidate = CodeGraphParamUtil.build_class_fqn_candidates(".".join(parts[:-1]))[0]
        return [f"{class_candidate}::{parts[-1]}"]

    @staticmethod
    def build_method_fqn_suffix_regex(value: str) -> str:
        """把不完整 owner/member 输入编译为 CodeGraph 限定名后缀正则。

        调用方可能传入 ``User.run``、``foo.User.run``，也可能混用 ``.`` 与 ``::``。
        CodeGraph 的包段保留点，而类型、内部类型和成员边界使用 ``::``；因此 member 前的
        最终 owner 段必须由 ``::`` 连接，之前的 owner 段才兼容 ``.`` 或 ``::``。所有名称
        段均以 ``re.escape`` 作字面量匹配。

        repository 使用 ``re.search``，所以前边界只需声明字符串起点、点或 ``::``，无需
        拼接 ``.*``。末尾 ``$`` 保证 member 是最终段：``User.run`` 可以命中
        ``pkg::User::run``，但不能命中 ``pkg::NotUser::run`` 或 ``pkg::User::run::nested``。
        少于 owner/member 两段时返回空串，由 processor 决定不生成该查询条件。
        """
        source = (value or "").strip()
        if not source:
            return ""
        parts = [part for part in re.split(r"::|\.", source) if part]
        if len(parts) < 2:
            return ""
        separator = r"(?:\.|::)"
        owner = separator.join(re.escape(part) for part in parts[:-1])
        member = re.escape(parts[-1])
        return rf"(?:^|\.|::){owner}::{member}$"

    @staticmethod
    def normalize_file_path(project_path: Path, file_path: str) -> str:
        """把公开文件参数规范为 CodeGraph DB 使用的 POSIX 路径。

        空串和 ``.`` 保留为全项目查询标记。项目内绝对路径转为相对项目根目录的路径，
        项目外绝对路径无法安全相对化时保持绝对形式；相对路径只统一为 POSIX 分隔符，
        不调用 ``resolve``，避免把调用进程工作目录意外引入查询语义。
        """
        value = (file_path or "").strip()
        if not value or value == ".":
            return "."
        path = Path(value)
        if path.is_absolute():
            relative = resolve_project_relative_path(project_path, value)
            return relative.as_posix() if relative is not None else path.resolve().as_posix()
        return path.as_posix()

    @staticmethod
    def adapt_fqn_regex(pattern: str) -> str:
        """把调用方的点分 FQN 正则适配为 CodeGraph 存储分隔符。

        包名中的点继续作为点保留，首个类型或通配模式段开始改用 ``::``，使 Java 风格
        ``com\\.foo\\..*Controller\\.run`` 可匹配 CodeGraph 限定名。调用方已提供 ``::``
        时认为其明确了解存储格式并原样返回；此方法只适配分隔符，不扩大或转义正则语义。
        """
        value = (pattern or "").strip()
        if not value or "::" in value:
            return value
        # CodeGraph 保留包名中的点，只把类型及其成员边界存成 ``::``。
        separator = r"\." if r"\." in value else "."
        parts = value.split(separator)
        if len(parts) < 2:
            return value
        class_index = next(
            (
                index
                for index, part in enumerate(parts)
                if part and (part[0].isupper() or "*" in part or "[" in part or "(" in part)
            ),
            len(parts) - 1,
        )
        package = ".".join(parts[:class_index])
        type_and_member = "::".join(parts[class_index:])
        return f"{package}::{type_and_member}" if package else type_and_member

    @staticmethod
    def build_method_signature(name: str, signature: str | None, return_type: str | None = None) -> str:
        """把 CodeGraph 的拆分字段还原为旧接口使用的可读函数签名。

        CodeGraph 各语言 extractor 可能返回仅参数列表、包含返回类型但缺方法名，或已经完整
        的签名。该方法先压缩无意义空白；已有方法名时原样复用语义，仅参数列表时插入 name
        并优先使用签名自身前缀、其次使用独立 return_type。无法识别括号结构时仍保留原始
        文本，并以 return_type/name 做最小补全，避免 mapper 因单个异常签名丢失函数记录。
        """
        method_name = (name or "").strip()
        sig = " ".join((signature or "").strip().split())
        ret = " ".join((return_type or "").strip().split())
        if not sig:
            return f"{method_name}()" if method_name else ""
        if not method_name:
            return sig
        # 已含方法名的签名直接复用，避免 mapper 重复插入方法名。
        if re.search(rf"(^|\s){re.escape(method_name)}\s*\(", sig):
            return sig
        open_idx = sig.find("(")
        close_idx = sig.rfind(")")
        if open_idx >= 0 and close_idx > open_idx:
            prefix = sig[:open_idx].strip()
            params = sig[open_idx + 1:close_idx].strip()
            suffix = sig[close_idx + 1:].strip()
            return_prefix = prefix or ret
            if return_prefix:
                built = f"{return_prefix} {method_name}({params})"
            else:
                built = f"{method_name}({params})"
            if suffix:
                built = f"{built} {suffix}"
            return built
        if ret:
            return f"{ret} {method_name}({sig})"
        return f"{method_name}({sig})"

    @staticmethod
    def build_search_symbol_match(value: str) -> str:
        """将用户输入转换为与 CodeGraph 一致的 FTS5 前缀查询。

        与 codegraph ``searchNodesFTS`` 的预处理保持一致：

        - ``::`` 替换为空格（Rust/C++/Ruby 限定符分隔符）；单独的 ``:`` 被删除。
        - ``' " * ( ) ^`` 等 FTS5 特殊字符直接删除（非替换为空格）。
        - ``.`` 保留在 token 内，不做拆分。codegraph FTS5 分词器会将其视为 token
          的一部分，形成短语前缀查询，例如 ``com.alipay.UserService`` 整体作为一个
          前缀 token。

        每个剩余 token 包装为 ``"token"*`` 前缀匹配，多个 token 之间用 ``OR`` 连接。
        """
        normalized = re.sub(r"::", " ", value or "")
        normalized = re.sub(r"['\"*()^:]", "", normalized)
        tokens = [
            token
            for token in normalized.split()
            if token and token.upper() not in {"AND", "OR", "NOT", "NEAR"}
        ]
        return " OR ".join(f'"{token}"*' for token in tokens)


    # ── search_symbol 语义分组与多信号重排 ──

    # 公开 kind → 一组 CodeGraph 节点 kind 的映射。
    SEARCH_SYMBOL_NODE_KINDS = {
        "class": {"class", "struct", "interface", "trait", "protocol", "enum"},
        "function": {"function", "method"},
        "interface": {"interface"},
        "file": {"file"},
    }

    # kind 优先级加分（与 codegraph kindBonus 一致），function/method 高于 import/field。
    KIND_BONUS_MAP = {
        "function": 10,
        "method": 10,
        "interface": 9,
        "class": 8,
        "trait": 9,
        "protocol": 9,
        "route": 9,
        "component": 8,
        "type_alias": 6,
        "struct": 6,
        "union": 6,
        "enum": 5,
        "module": 4,
        "namespace": 4,
        "property": 3,
        "field": 3,
        "constant": 3,
        "enum_member": 3,
        "variable": 2,
        "import": 1,
        "export": 1,
        "parameter": 0,
        "file": 0,
    }

    @staticmethod
    def kind_bonus(kind: str) -> int:
        """节点类型优先级加分。"""
        return CodeGraphParamUtil.KIND_BONUS_MAP.get(kind, 0)

    @staticmethod
    def name_match_bonus(
        node_name: str, query: str, *, node_kind: str = "", requested_kind: str = ""
    ) -> int:
        """节点裸名与搜索串的匹配加分。

        import 节点的 name 是完整导入路径（非短名），长查询会产生虚假精确匹配。
        除非用户显式指定 ``kind=import``，否则 import 节点不参与名称加分，
        使其在 ``kind_bonus`` 已经最低的基础上自然沉到结果末尾。

        其余 kind（class / interface / method / function / file 等）的加分规则
        与 codegraph nameMatchBonus 一致：
        精确匹配 +80，多词 token 精确匹配 +60，前缀匹配按长度比 10~40 递减，
        子词全覆盖 +15，包含 +10。

        对于 FQN 查询（如 ``com.foo.Bar`` 或 ``com::foo::Bar``），只取最后一段
        与节点短名比较，避免完整 FQN 与短名永不会命中导致 bonus 恒为 0。
        """
        # import 节点除非用户显式请求 kind=import，否则不给予名称加分
        if node_kind == "import" and requested_kind != "import":
            return 0

        name_lower = node_name.lower()
        raw_query = (query or "").strip()

        # 取查询串最后一段作为短名比较基准
        # "::" 和 "." 都是限定符分隔符，空格是多词查询分隔符
        short_query = re.split(r"[\s.]+", raw_query.replace("::", " "))[-1] if raw_query else ""
        short_lower = short_query.lower()

        # 完整查询（去空格）用于 substring 和前缀分支
        query_lower = raw_query.replace(" ", "").lower()
        query_tokens = [t.lower() for t in raw_query.split() if len(t) >= 2]
        raw_terms = re.sub(r"([a-z])([A-Z])", r"\1 \2", raw_query)
        raw_terms = [t.lower() for t in re.split(r"[\s_.\-]+", raw_terms) if len(t) >= 2]

        # 精确匹配：短名 == 查询最后一段，或短名 == 完整查询（短查询场景）
        if name_lower == short_lower or name_lower == query_lower:
            return 80
        # 多词 token 精确匹配
        if len(query_tokens) > 1 and name_lower in query_tokens:
            return 60
        # 前缀匹配：短名以查询最后一段开头
        if short_lower and name_lower.startswith(short_lower):
            ratio = len(short_lower) / len(name_lower) if name_lower else 0
            return round(10 + 30 * ratio)
        # 子词全覆盖
        if len(raw_terms) > 1 and all(t in name_lower for t in raw_terms):
            return 15
        # 包含
        if query_lower and query_lower in name_lower:
            return 10
        if short_lower and short_lower in name_lower:
            return 10
        return 0