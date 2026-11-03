import logging
from pathlib import Path
from typing import Any, List, Optional
import orjson
from yasa_mcp.util import log_util

logger = logging.getLogger(__name__)


def load_json_from_file(file_path: Path, encoding_candidates: Optional[List[str]] = None) -> Any:
    """
    从文件加载 JSON，尝试多种编码。
    
    策略:
    1. 用二进制模式 ('rb') 读取文件。
    2. 直接尝试 orjson.loads(content) (最快，假设是 UTF-8)。
    3. 如果失败，尝试使用候选编码 (默认: ['gb18030', 'latin-1']) 解码后再解析。
    
    :param file_path: JSON 文件路径。
    :param encoding_candidates: 如果默认 UTF-8 失败，尝试使用的编码列表。
    :return: 解析后的 JSON 对象 (dict/list)。
    """
    if not file_path.exists():
        return None

    if encoding_candidates is None:
        encoding_candidates = ['gb18030', 'latin-1']

    with open(file_path, 'rb') as f:
        content = f.read()

    # 尝试的编码列表：None 表示直接解析 bytes (UTF-8，由 orjson 隐含支持)
    try_encodings = [None] + encoding_candidates

    parsed_json = None
    last_exception = None

    for encoding in try_encodings:
        try:
            if encoding is None:
                # 直接解析二进制 (最快，隐含 UTF-8)
                parsed_json = orjson.loads(content)
            else:
                log_util.warning(f"Failed to parse {file_path} as UTF-8, trying {encoding}", logger=logger)
                parsed_json = orjson.loads(content.decode(encoding))

            return parsed_json

        except Exception as e:
            last_exception = e
            continue

    log_util.error(f"Failed to parse {file_path} with encodings {try_encodings}: {last_exception}", logger=logger)
    return parsed_json


def write_json_to_file(file_path: Path, data: Any, indent: bool = False) -> None:
    """
    将数据写入 JSON 文件。

    :param file_path: JSON 文件路径。
    :param data: 要写入的数据。
    :param indent: 是否格式化输出 (缩进)。
    """
    option = orjson.OPT_INDENT_2 if indent else 0
    with open(file_path, 'wb') as f:
        f.write(orjson.dumps(data, option=option))
