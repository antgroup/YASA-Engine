"""Fully Qualified Name (FQN) construction utilities.

Builds FQNs from AST nodes for Python and Java languages.
"""

from pathlib import Path

from ast_grep_py import SgNode


def build_python_fqn(
    func_node: SgNode,
    file_path: str,
    project_path: str | None = None,
) -> str:
    """Build Python FQN from file path + parent class/function chain.

    Format: module.path.ClassName.method_name

    Args:
        func_node: The function/class SgNode
        file_path: Absolute file path
        project_path: Project root for relative module path calculation

    Returns:
        Fully qualified name string
    """
    prefix = _build_module_prefix(file_path, project_path)
    parent_chain = _build_parent_chain_python(func_node)

    # Get the node's own name
    name = _get_node_name(func_node)

    parts = [prefix] + parent_chain + [name]
    return ".".join(p for p in parts if p)


def build_java_fqn(
    node: SgNode,
    package_name: str,
) -> str:
    """Build Java FQN from package + class chain + method name.

    Format: com.package.ClassName.methodName

    Args:
        node: The method/class SgNode
        package_name: Package declaration string

    Returns:
        Fully qualified name string
    """
    parent_chain = _build_parent_chain_java(node)
    name = _get_node_name(node)

    parts = [package_name] + parent_chain + [name]
    return ".".join(p for p in parts if p)


def build_javascript_fqn(
    node: SgNode,
    file_path: str,
    project_path: str | None = None,
) -> str:
    """构建 JavaScript/TypeScript 的 UQL 风格 FQN。

    格式：relative.path.FileName.ClassOrInterface.methodName。
    顶层函数使用 relative.path.FileName.functionName，对齐阶段 1 记录的
    JavaScript 缓存分析 FQN 约定。
    """
    prefix = _build_javascript_module_prefix(file_path, project_path)
    parent_chain = _build_parent_chain_javascript(node)
    name = _get_javascript_node_name(node)
    if parent_chain and parent_chain[-1] == name:
        name = ""

    parts = [prefix] + parent_chain + [name]
    return ".".join(p for p in parts if p)


def find_java_package(root: SgNode) -> str:
    """Extract package name from Java source file root node.

    Args:
        root: The root SgNode of a parsed Java file

    Returns:
        Package name string, or empty string if not found
    """
    # Search for scoped_identifier inside package_declaration (e.g. "com.example.main")
    matches = root.find_all(
        config={"rule": {"kind": "scoped_identifier", "inside": {"kind": "package_declaration"}}}
    )
    for m in matches:
        return m.text()

    # Fallback: single identifier (e.g. "package main;")
    matches = root.find_all(
        config={"rule": {"kind": "identifier", "inside": {"kind": "package_declaration"}}}
    )
    for m in matches:
        return m.text()

    return ""


def _build_module_prefix(file_path: str, project_path: str | None) -> str:
    """Build Python module prefix from file path relative to project root."""
    if project_path:
        try:
            rel = Path(file_path).relative_to(project_path)
            module_parts = list(rel.with_suffix("").parts)
            return ".".join(module_parts)
        except ValueError:
            pass
    return Path(file_path).stem


def _build_javascript_module_prefix(file_path: str, project_path: str | None) -> str:
    """根据项目相对路径构建 JS/TS 模块前缀。"""
    path = Path(file_path)
    if project_path:
        try:
            path = path.relative_to(project_path)
        except ValueError:
            pass
    suffixes = (".js", ".ts")
    if path.suffix in suffixes:
        path = path.with_suffix("")
    return ".".join(path.parts)


def _build_parent_chain_python(node: SgNode) -> list[str]:
    """Walk up the AST to collect enclosing class/function names (Python)."""
    chain: list[str] = []
    cur = node.parent()
    while cur:
        kind = cur.kind()
        if kind in ("class_definition", "function_definition"):
            name = _get_child_identifier(cur)
            if name:
                chain.append(name)
        cur = cur.parent()
    chain.reverse()
    return chain


def _build_parent_chain_java(node: SgNode) -> list[str]:
    """Walk up the AST to collect enclosing class/interface/enum names (Java)."""
    chain: list[str] = []
    cur = node.parent()
    while cur:
        kind = cur.kind()
        if kind in ("class_declaration", "interface_declaration", "enum_declaration"):
            name = _get_child_identifier(cur)
            if name:
                chain.append(name)
        cur = cur.parent()
    chain.reverse()
    return chain


def _build_parent_chain_javascript(node: SgNode) -> list[str]:
    """向上收集 JS/TS 外层 class/interface/类字段名。"""
    chain: list[str] = []
    cur = node.parent()
    while cur:
        kind = cur.kind()
        name = ""
        if kind in ("class", "class_declaration", "interface_declaration"):
            name = _get_javascript_class_name(cur)
        elif kind == "field_definition":
            name = _get_child_identifier_any(cur)
        if name and name not in chain:
            chain.append(name)
        cur = cur.parent()
    chain.reverse()
    return chain


def _get_child_identifier(node: SgNode) -> str:
    """Get the first child identifier text from a node."""
    for child in node.children():
        if child.kind() == "identifier":
            return child.text()
    return ""


def _get_child_identifier_any(node: SgNode) -> str:
    """获取 JS/TS 节点的第一个标识符子节点。"""
    for child in node.children():
        if child.kind() in ("identifier", "type_identifier", "property_identifier", "private_property_identifier"):
            return child.text()
    return ""


def _assignment_left_name(node: SgNode) -> str:
    """从 assignment_expression 左侧提取导出或赋值名称。"""
    for child in node.children():
        kind = child.kind()
        if kind in ("identifier", "property_identifier"):
            return child.text()
        if kind == "member_expression":
            names = [
                grand.text()
                for grand in child.children()
                if grand.kind() in ("identifier", "property_identifier")
            ]
            if names:
                return names[-1]
    return ""


def _get_javascript_class_name(node: SgNode) -> str:
    """获取具名 class、匿名导出 class 或类字段 class 的名称。"""
    name = _get_child_identifier_any(node)
    if name:
        return name
    parent = node.parent()
    if parent and parent.kind() == "assignment_expression":
        return _assignment_left_name(parent)
    if parent and parent.kind() == "field_definition":
        return _get_child_identifier_any(parent)
    return ""


def _get_node_name(node: SgNode) -> str:
    """Extract the name identifier from a function/class node."""
    kind = node.kind()

    # For decorated_definition, dig into the inner function_definition
    if kind == "decorated_definition":
        for child in node.children():
            if child.kind() in ("function_definition", "class_definition"):
                return _get_child_identifier(child)

    return _get_child_identifier(node)


def _get_javascript_node_name(node: SgNode) -> str:
    """获取 JS/TS 定义名称，支持变量绑定和 CommonJS 赋值。"""
    kind = node.kind()
    if kind in ("class", "class_declaration", "interface_declaration"):
        return _get_javascript_class_name(node)
    if kind in ("method_definition", "function_declaration"):
        return _get_child_identifier_any(node)
    if kind in ("arrow_function", "function_expression"):
        direct_name = _get_child_identifier_any(node)
        if direct_name:
            return direct_name
        parent = node.parent()
        if parent and parent.kind() == "variable_declarator":
            return _get_child_identifier_any(parent)
        if parent and parent.kind() == "assignment_expression":
            return _assignment_left_name(parent)
    return _get_child_identifier_any(node)
