from yasa_mcp.core.models import ToolProtocol
from yasa_mcp.tools.ripgrep.ripgrep_bin_layout import RipGrepBinaryLayout
from yasa_mcp.tools.ripgrep.ripgrep_module import FileLineResult
from yasa_mcp.util import command_util
from yasa_mcp.util.timer_util import timed
from pathlib import Path
import re

import logging

from yasa_mcp.core import exceptions

logger = logging.getLogger(__name__)


class RipgrepTool(ToolProtocol):
    def __init__(self, ripgrep_layout: RipGrepBinaryLayout):
        self.ripgrep_layout = ripgrep_layout
        self.initialized = command_util.binary_exists(self.ripgrep_layout.rg_bin)

    def check_available(self) -> bool:
        """Check if Ripgrep CLI is available."""
        return command_util.check_binary_available(self.ripgrep_layout.rg_bin)

    @timed(logger, "Ripgrep", "search_keyword")
    def search_keyword(self, project_path: Path, keyword: str, fuzzy_match: bool = False, timeout: int = 30) -> list[Path]:
        """执行ripgrep，获取包含关键词的文件列表（仅文件级）。"""
        ripgrep_args = [keyword, str(project_path), "-l", "-U"]
        
        if fuzzy_match:
            ripgrep_args.insert(0, "-i")
        else:
            ripgrep_args.insert(0, "-F")

        result = command_util.run_binary(self.ripgrep_layout.rg_bin, ripgrep_args, timeout)
        if result.returncode == 0:
            return [Path(x) for x in result.stdout.strip().split("\n") if x]
        if result.returncode == 1:
            return []
        else:
            raise exceptions.InvalidToolError(f"Ripgrep CLI configuration failed: {result.stderr}")

    @timed(logger, "Ripgrep", "search_regex_with_line")
    def search_regex_with_line(
        self, project_path: Path, pattern: str, timeout: int = 30
    ) -> list[FileLineResult]:
        """
        执行 ripgrep，使用正则模式搜索，返回命中的「文件路径 + 行号」列表。
        """
        # Remove -F for regex search, add --no-heading, -n (line number), -U (multiline/search binary?)
        # Add -H (--with-filename) to ensure file path is always printed even for single file search
        ripgrep_args = ["-n", "--no-heading", "-H", pattern, str(project_path), "-U"]
        result = command_util.run_binary(self.ripgrep_layout.rg_bin, ripgrep_args, timeout)

        if result.returncode == 1:
            # 1 表示没有匹配
            return []
        if result.returncode != 0:
            raise exceptions.InvalidToolError(f"Ripgrep CLI configuration failed: {result.stderr}")

        matches = []
        stdout = result.stdout.strip()
        if not stdout:
            return matches

        for line in stdout.split("\n"):
            if not line:
                continue
            # 期望格式：path:line:content
            parts = line.split(":", 2)
            if len(parts) < 3:
                continue

            file_path_str = parts[0]
            line_str = parts[1]
            content_str = parts[2]

            try:
                line_no = int(line_str)
            except ValueError:
                continue

            matches.append(FileLineResult(file_path=Path(file_path_str), line=line_no, content=content_str))

        return matches

    @timed(logger, "Ripgrep", "search_keyword_with_line")
    def search_keyword_with_line(
        self, project_path: Path, keyword: str, fuzzy_match: bool = False,
        use_regex: bool = False, timeout: int = 30,
        exclude_globs: list[str] | None = None,
        include_globs: list[str] | None = None,
    ) -> list[FileLineResult]:
        """
        执行 ripgrep，返回命中的「文件路径 + 行号」列表。

        默认使用 rg 的输出格式：`file:line:column:match_text`。
        """
        # -n: line number
        # --no-heading: group matches by file line (standard grep output)
        ripgrep_args = ["-n", "--no-heading", keyword, str(project_path), "-U"]

        if include_globs:
            for g in include_globs:
                ripgrep_args.extend(["--glob", g])
        if exclude_globs:
            for g in exclude_globs:
                ripgrep_args.extend(["--glob", f"!{g}"])

        if use_regex:
            pass  # ripgrep 默认就是正则模式
        elif fuzzy_match:
            ripgrep_args.insert(0, "-i")
        else:
            ripgrep_args.insert(0, "-F")

        # 使用 errors='replace' 忽略解码错误，防止二进制文件或非UTF8文件导致崩溃
        result = command_util.run_binary(self.ripgrep_layout.rg_bin, ripgrep_args, timeout, errors='replace')

        if result.returncode == 1:
            # 1 表示没有匹配
            return []
        if result.returncode != 0:
            raise exceptions.InvalidToolError(f"Ripgrep CLI configuration failed: {result.stderr}")

        matches = []
        stdout = result.stdout.strip()
        if not stdout:
            return matches

        for line in stdout.split("\n"):
            if not line:
                continue
            # 期望格式：path:line:column:content
            # 注意：rg 的输出可能是 file:line:match... 或 file:line:column:match...
            # 这里我们保守地解析前两部分，剩下的作为 content
            parts = line.split(":", 3)
            
            # 至少要有 path:line
            if len(parts) < 2:
                continue
            
            file_path_str = parts[0]
            line_str = parts[1]
            
            # 尝试解析行号
            try:
                line_no = int(line_str)
            except ValueError:
                # 可能是 windows 路径 C:\... 这种情况？
                # 但 rg 在 windows 下也会输出 C:\path:line... 
                # 这里简单处理，解析失败就跳过
                continue

            content = ""
            if len(parts) > 2:
                # 剩下的部分重新拼回去作为 content
                content = ":".join(parts[2:])

            matches.append(FileLineResult(file_path=Path(file_path_str), line=line_no, content=content))

        return matches

    @timed(logger, "Ripgrep", "search_keywords_with_line")
    def search_keywords_with_line(
        self,
        project_path: Path,
        keywords: list[str] | tuple[str, ...],
        *,
        use_regex: bool = False,
        timeout: int = 30,
    ) -> list[FileLineResult]:
        """Search a selector list in one ripgrep invocation.

        Literal selectors are escaped before composing the bounded alternation.  Regex
        selectors are validated independently by the service and then combined without
        adding any command-line options derived from user input.
        """

        values = tuple(value for value in keywords if value)
        if not values:
            return []
        pattern = "(?:" + "|".join(values if use_regex else re.escape(value) for value in values) + ")"
        return self.search_keyword_with_line(
            project_path,
            pattern,
            use_regex=True,
            timeout=timeout,
        )
