import difflib
from pathlib import Path

from yasa_mcp.config import global_config
from yasa_mcp.util import function_signature_util


class ParamsValidator:

    @staticmethod
    def _validate_string(query: str, candidate: str, fuzzy_match: bool) -> bool:

        # 去掉所有空白字符（比如全类名有空格/格式不一）
        query = ''.join(query.split())
        candidate = ''.join(candidate.split())

        if not fuzzy_match:
            return query == candidate
        else:
            if query in candidate:
                return True
            if difflib.SequenceMatcher(None, query, candidate).ratio() < 0.8:
                return False
            return True

    @staticmethod
    def _validate_fqn(query_fqn: str, candidate_fqn: str, fuzzy_match: bool) -> bool:

        # 去掉所有空白字符（比如全类名有空格/格式不一）
        query_fqn = ''.join(query_fqn.split())
        candidate_fqn = ''.join(candidate_fqn.split())

        if not fuzzy_match:
            return query_fqn == candidate_fqn
        else:
            # 对于全类名，模糊匹配的策略是endwith
            if query_fqn and candidate_fqn.endswith(query_fqn):
                return True
            return False

    @staticmethod
    def _validate_signature(query_signature: str, candidate_signature: str, fuzzy_match: bool) -> bool:
        # 1. 规范化签名
        query_signature_norm = function_signature_util.normalize_signature(query_signature)
        candidate_signature_norm = function_signature_util.normalize_signature(candidate_signature)
        
        # 2. 移除空格后比较
        # 注意：这里需要同时保留原始字符串的处理，因为 normalize 可能在某些非标准输入下表现不佳
        # 或者用户输入本身就不是标准签名（比如 "getRuleList"）
        query_signature_clean = ''.join(query_signature_norm.split()) or ''.join(query_signature.split())
        candidate_signature_clean = ''.join(candidate_signature_norm.split())

        if not fuzzy_match:
            return query_signature_clean == candidate_signature_clean
        else:
            # 模糊匹配策略：
            # 1. 包含匹配 (Query in Candidate)
            if query_signature_clean and query_signature_clean in candidate_signature_clean:
                return True
            
            # 2. 尝试匹配纯方法名 (针对 "getRuleList" 这种情况)
            # normalize_signature 会把 "getRuleList" 变成 "getRuleList()"，这对无参方法是对的，
            # 但如果我想查任意参数的同名方法，这个行为就不对了。
            # 所以这里直接用原始 query 去匹配 candidate 的开头
            if '(' not in query_signature:
                 # 提取 candidate 的方法名
                 if candidate_signature_clean.startswith(query_signature.strip() + "("):
                     return True

            # 3. 保底策略：高相似度匹配
            return difflib.SequenceMatcher(None, query_signature_clean, candidate_signature_clean).ratio() > 0.9

    @staticmethod
    def _validate_file_path(query_file_path: Path, candidate_file_path: Path, fuzzy_match: bool) -> bool:
        # 如果 query 为空或者是当前目录，视为匹配所有
        if str(query_file_path) == "." or query_file_path.name == "":
            return True

        if not fuzzy_match:
            return query_file_path == candidate_file_path

        query_parts = query_file_path.parts
        candidate_parts = candidate_file_path.parts

        # 任意一个为空，无法匹配
        if not query_parts or not candidate_parts:
            return False

        # 如果 query 比 candidate 长，不可能是后缀
        if len(query_parts) > len(candidate_parts):
            return False

        # 模糊匹配策略：后缀匹配 + 拼写容错
        # 取 candidate 的末尾部分与 query 进行比较
        candidate_suffix = candidate_parts[-len(query_parts):]

        for q, c in zip(query_parts, candidate_suffix):
            if q == c:
                continue
            # 允许一定的拼写差异
            if difflib.SequenceMatcher(None, q, c).ratio() < 0.8:
                return False
        
        return True

    @staticmethod
    def _validate_line(query_line: int, candidate_line: int, fuzzy_match: bool):
        if query_line == 0:
            return True  # 如果 query_line 为0，认为是有效的

        if not fuzzy_match:
            return query_line == candidate_line
        else:
            if abs(query_line - candidate_line) > 3:
                return False
            return True

    @staticmethod
    def validate_params(*validators) -> bool:
        """
        所有 validator 必须都为 True 才返回 True，任何一个为 False 就返回 False。
        用法: ParamsValidator.validate_params(,cond1, cond2, cond3, ...)
        """
        return all(validators) if validators else False

    @staticmethod
    def validate(fuzzy_match: bool, **conditions) -> bool:
        """
        统一验证入口，一次性检查所有条件
        只有当所有提供的条件都满足时才返回True

        参数:
        fuzzy_match: 是否使用模糊匹配
        conditions: 包含验证条件的字典
            - string: (query, candidate)
            - fqn: (query_fqn, candidate_fqn)
            - signature: (query_sig, candidate_sig)
            - file_path: (query_path, candidate_path)
            - line: (query_line, candidate_line)

        返回: 所有条件满足返回True，任何条件失败返回False
        """
        # 如果没有提供任何条件，视为验证失败
        if not conditions:
            return False

        # 动态处理各种验证类型
        validators = {
            'string': ParamsValidator._validate_string,
            'fqn': ParamsValidator._validate_fqn,
            'signature': ParamsValidator._validate_signature,
            'file_path': ParamsValidator._validate_file_path,
            'line': ParamsValidator._validate_line
        }

        for condition_type, (query, candidate) in conditions.items():
            if validator := validators.get(condition_type):
                # 关键修复：
                # 只有当 query 有值（非 None, 非空字符串, 非0等）时才进行校验
                # 如果 query 为空，说明用户不关心这个条件的限制，应该视为“通过”而不是“跳过”或“失败”
                # 例如：用户只查 function_fqn，但没有提供 file_path，那么 file_path 的校验应该默认通过
                if query:
                    if not validator(query, candidate, fuzzy_match):
                        return False
            else:
                from yasa_mcp.core import exceptions
                raise exceptions.InvalidParameterError(f"Invalid condition type: {condition_type}")

        return True
