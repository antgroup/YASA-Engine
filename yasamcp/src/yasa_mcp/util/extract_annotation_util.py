import re
from pathlib import Path

from yasa_mcp.service.models import ParameterAnnotation
from yasa_mcp.util import file_util

_ANNOTATION_PATTERN = re.compile(r'@[a-zA-Z_][\w.]*')


def extract_annotations(
        project_path: Path,
        file_path: Path,
        start_line: int,
        content: str = "",
        preceding_lines: int = 3,
) -> tuple[list[str], list[ParameterAnnotation]]:
    """
    实时提取函数注解和参数注解。

    函数注解来源（合并去重）：
    1. start_line 起的开头行 — UQL 可能将注解行纳入函数范围，此时 start_line 本身就是注解行
    2. start_line 之前最多 preceding_lines 行 — 应对注解在函数范围之外的情况

    参数注解：从函数 content 的参数列表中正则提取。

    :param project_path: 项目根路径
    :param file_path: 文件相对路径
    :param start_line: 函数起始行号
    :param content: 函数内容（为空时跳过参数注解提取）
    :param preceding_lines: 往前读取的最大行数
    :return: (函数注解列表, 参数注解列表)
    """
    f_annos = extract_function_annotations(project_path, file_path, start_line, preceding_lines)
    p_annos = extract_parameter_annotations(content) if content else []
    return f_annos, p_annos


def extract_function_annotations(
        project_path: Path,
        file_path: Path,
        start_line: int,
        preceding_lines: int = 3,
) -> list[str]:
    """
    提取函数注解的完整文本（如 @Override、@Bean(initMethod = "init")）。

    扫描策略：
    1. 从 start_line 开始向下读，提取开头连续的注解行（UQL 可能将注解纳入函数范围）
    2. 从 start_line 向上读最多 preceding_lines 行（注解在函数范围之外的情况）
    遇到非注解非空行立即停止，防止读取到上一个函数的注解。
    """
    full_path = (project_path / file_path).resolve()
    lines = file_util.get_file_lines(full_path)
    if not lines:
        return []

    annotations = []

    # 1. 从 start_line 开始向下读，提取开头连续的注解行
    for offset in range(preceding_lines):
        line_idx = start_line - 1 + offset
        if line_idx >= len(lines):
            break
        line = _clean_line(lines[line_idx])
        if not line:
            continue
        if not line.startswith('@'):
            break
        annotations.append(line)

    # 2. 从 start_line 向上读最多 preceding_lines 行
    for offset in range(1, preceding_lines + 1):
        line_idx = start_line - 1 - offset
        if line_idx < 0:
            break
        if line_idx >= len(lines):
            continue
        line = _clean_line(lines[line_idx])
        if not line:
            continue
        if not line.startswith('@'):
            break
        if line not in annotations:
            annotations.append(line)

    return annotations


def _clean_line(line: str) -> str:
    """去除首尾空白和行内注释"""
    line = line.strip()
    if '//' in line:
        line = line.split('//')[0].strip()
    return line


def extract_parameter_annotations(content: str) -> list[ParameterAnnotation]:
    """从函数签名的参数列表中提取参数注解。"""
    if not content:
        return []

    open_paren = content.find('(')
    if open_paren == -1:
        return []

    sig_end = content.find('{')
    if sig_end == -1:
        sig_end = content.find(';')
    if sig_end == -1:
        sig_end = len(content)

    close_paren = -1
    depth = 0
    for i in range(open_paren, sig_end):
        if content[i] == '(':
            depth += 1
        elif content[i] == ')':
            depth -= 1
            if depth == 0:
                close_paren = i
                break

    if close_paren == -1:
        return []

    params_str = content[open_paren + 1:close_paren]
    params_list = _split_parameters(params_str)

    p_annos = []
    for param_str in params_list:
        if '//' in param_str:
            param_str = param_str.split('//')[0]
        param_name = _extract_parameter_name(param_str)
        anns = _ANNOTATION_PATTERN.findall(param_str)
        for ann in anns:
            p_annos.append(ParameterAnnotation(annotation=ann, parameter_name=param_name))

    return p_annos


def _split_parameters(signature_content: str) -> list[str]:
    """
    Split parameters string into individual parameter strings, handling nested brackets.
    e.g. "String s, List<String> l" -> ["String s", "List<String> l"]
    """
    params = []
    current = []
    depth_paren = 0
    depth_angle = 0
    depth_brace = 0

    for char in signature_content:
        if char == ',' and depth_paren == 0 and depth_angle == 0 and depth_brace == 0:
            params.append("".join(current).strip())
            current = []
        else:
            if char == '(': depth_paren += 1
            elif char == ')': depth_paren -= 1
            elif char == '<': depth_angle += 1
            elif char == '>': depth_angle -= 1
            elif char == '{': depth_brace += 1
            elif char == '}': depth_brace -= 1
            current.append(char)

    if current:
        params.append("".join(current).strip())
    return params


def _extract_parameter_name(param_str: str) -> str:
    """
    Best effort extraction of parameter name from a parameter definition string.
    Assumes Java-like syntax: "Type name" or "@Ann Type name" or "Type... name"
    """
    clean_str = re.sub(r'\[\s*\]', '', param_str)
    clean_str = re.sub(r'\.\.\.', '', clean_str)
    tokens = re.findall(r'\b[a-zA-Z_]\w*\b', clean_str)
    if not tokens:
        return ""
    return tokens[-1]
