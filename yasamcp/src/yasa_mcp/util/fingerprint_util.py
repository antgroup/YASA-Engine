import hashlib
import logging
import os
from pathlib import Path
from typing import Dict, Optional, Set, Tuple
from yasa_mcp.util.path_util import validate_path
from yasa_mcp.util import json_util, log_util

logger = logging.getLogger(__name__)


class FolderFingerprint:
    """
    计算文件夹指纹的工具类，用于检测文件夹内容是否发生变更。
    """

    # 默认忽略的文件/目录名
    DEFAULT_IGNORE_NAMES = {
        ".git",
        ".DS_Store",
        "__pycache__",
        ".idea",
        ".vscode",
        "node_modules",
        "target",
        "build",
        "dist",
        "venv",
        ".venv",
        ".yasa_info",
        ".codegraph",
        ".yasa_scenario",
        ".yasa"
    }

    # 默认忽略的文件扩展名
    DEFAULT_IGNORE_EXTENSIONS = {
        ".pyc",
        ".pyo",
        ".pyd",
        ".log",
        ".tmp",
        ".bak"
    }

    @classmethod
    def calculate(cls, root_path: Path, ignore_names: Set[str] = None, ignore_extensions: Set[str] = None,
                  fast_mode: bool = False) -> str:
        """
        计算文件夹的指纹哈希。

        指纹由以下因素决定：
        1. 文件及其相对路径
        2. 文件内容 (fast_mode=False) 或 内容采样 (fast_mode=True, 读取文件头尾各 4KB + size)

        注意：
        - 默认使用 fast_mode=False (完整内容哈希)，结果最精确。
        - fast_mode=True 使用内容采样（头尾各 4KB + 文件大小），速度更快且不受 git clone/pull 更新 mtime 的影响。
          对于绝大多数源码文件，采样哈希足以检测内容变更。

        如果文件名改变、文件内容改变、文件被添加或删除，指纹都会改变。

        :param root_path: 根目录路径
        :param ignore_names: 要忽略的文件或目录名集合（可选）
        :param ignore_extensions: 要忽略的文件扩展名集合（可选，需包含点号，如 ".pyc"）
        :param fast_mode: 快速模式。
                          False (默认): 读取完整文件内容计算哈希，最精确。
                          True: 采样文件头尾各 4KB + 文件大小计算哈希，速度快且不依赖 mtime。
        :return: 指纹哈希字符串 (MD5 hex)
        """

        root = validate_path(root_path)

        if not root.is_dir():
            # 如果是单文件，直接算文件哈希
            if fast_mode:
                return cls._sampled_file_hash(root)
            return cls._file_hash(root)

        ignore_names = ignore_names or cls.DEFAULT_IGNORE_NAMES
        ignore_extensions = ignore_extensions or cls.DEFAULT_IGNORE_EXTENSIONS

        files_data = cls._walk_and_hash(root, ignore_names, ignore_extensions, fast_mode)
        return cls._compute_overall_hash(files_data)

    @classmethod
    def calculate_incremental(
            cls,
            root_path: Path,
            cache_path: Path,
            ignore_names: Set[str] = None,
            ignore_extensions: Set[str] = None,
            diff_out: Optional[list] = None,
    ) -> str:
        """
        增量计算文件夹的指纹哈希。

        原理：
        1. 从 cache_path 加载上次保存的每文件缓存 (size, sampled_hash, content_hash)
        2. 遍历目录，对每个文件：
           - 计算采样哈希（文件头尾各 4KB + 文件大小），开销极小
           - 如果 size + sampled_hash 与缓存一致 → 直接复用缓存中的 content_hash，无需读取完整文件
           - 如果不一致或是新文件 → 重新计算完整 content_hash
        3. 用所有 (rel_path, content_hash) 计算整体指纹
        4. 将更新后的每文件缓存保存到 cache_path

        优势：
        - 首次运行等同于全量 calculate()，结果完全一致
        - 后续运行只对少量变化文件做完整 I/O，大幅提速
        - 不依赖 mtime，git clone/pull 后缓存依然有效
        - 最终指纹值与全量 calculate() 完全一致（基于相同的 content_hash）

        :param root_path: 根目录路径
        :param cache_path: 每文件哈希缓存的 JSON 文件路径
        :param ignore_names: 要忽略的文件或目录名集合（可选）
        :param ignore_extensions: 要忽略的文件扩展名集合（可选）
        :param diff_out: 可选列表；传入时，函数会把"旧缓存(对应上次 project_hash) →
                          当前快照"的每文件差异 append 进去，元素为
                          (kind, rel_path, old_hash, new_hash)，kind ∈ {added, removed, changed}。
                          供调用方在整体 hash 不一致时定位变动文件。
        :return: 指纹哈希字符串 (MD5 hex)
        """
        root = validate_path(root_path)

        if not root.is_dir():
            return cls._file_hash(root)

        ignore_names = ignore_names or cls.DEFAULT_IGNORE_NAMES
        ignore_extensions = ignore_extensions or cls.DEFAULT_IGNORE_EXTENSIONS

        # 1. 加载缓存
        file_cache = cls._load_file_cache(cache_path)

        # 2. 遍历目录，增量计算哈希
        files_data = []
        new_file_cache: Dict[str, Dict] = {}
        rehashed_count = 0
        reused_count = 0

        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in ignore_names]

            for filename in filenames:
                if filename in ignore_names:
                    continue

                _, ext = os.path.splitext(filename)
                if ext in ignore_extensions:
                    continue

                file_path = Path(dirpath) / filename
                rel_path = file_path.relative_to(root).as_posix()

                try:
                    current_size = file_path.stat().st_size
                    # 计算采样哈希（仅读取头尾各 4KB，开销极小）
                    current_sampled_hash = cls._sampled_file_hash(file_path)

                    # 检查缓存是否命中：size + sampled_hash 匹配则复用
                    cached_entry = file_cache.get(rel_path)
                    if (cached_entry is not None
                            and cached_entry.get("size") == current_size
                            and cached_entry.get("sampled_hash") == current_sampled_hash):
                        # 缓存命中：采样哈希未变，复用 content_hash
                        content_hash = cached_entry["hash"]
                        reused_count += 1
                    else:
                        # 缓存未命中：需要重新计算完整内容哈希
                        content_hash = cls._file_hash(file_path)
                        rehashed_count += 1

                    files_data.append((rel_path, content_hash))
                    new_file_cache[rel_path] = {
                        "size": current_size,
                        "sampled_hash": current_sampled_hash,
                        "hash": content_hash,
                    }
                except OSError:
                    continue

        logger.debug(
            f"增量指纹统计: reused={reused_count}, rehashed={rehashed_count}, "
            f"total={reused_count + rehashed_count}, cache_path={cache_path}"
        )

        # 3. 计算整体指纹
        overall_hash = cls._compute_overall_hash(files_data)

        # 4. 保存更新后的缓存
        cls._save_file_cache(cache_path, new_file_cache)

        # 5. 可选：收集与旧缓存的每文件差异。旧缓存 (file_cache) 对应上次写入的
        #    project_hash，new_file_cache 对应当前仓库快照，二者差异即"上次 → 现在"
        #    的变动文件。仅当调用方传入 diff_out 时才计算，避免无谓开销。
        if diff_out is not None:
            diff_out.extend(cls.compute_cache_diff(file_cache, new_file_cache))

        return overall_hash

    @classmethod
    def _walk_and_hash(
            cls,
            root: Path,
            ignore_names: Set[str],
            ignore_extensions: Set[str],
            fast_mode: bool,
    ) -> list[Tuple[str, str]]:
        """遍历目录并计算每个文件的哈希，返回 (rel_path, hash) 列表"""
        files_data = []

        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in ignore_names]

            for filename in filenames:
                if filename in ignore_names:
                    continue

                _, ext = os.path.splitext(filename)
                if ext in ignore_extensions:
                    continue

                file_path = Path(dirpath) / filename
                rel_path = file_path.relative_to(root).as_posix()

                try:
                    if fast_mode:
                        file_hash = cls._sampled_file_hash(file_path)
                    else:
                        file_hash = cls._file_hash(file_path)
                    files_data.append((rel_path, file_hash))
                except OSError:
                    continue

        return files_data

    @staticmethod
    def _compute_overall_hash(files_data: list[Tuple[str, str]]) -> str:
        """根据 (rel_path, hash) 列表计算整体指纹"""
        files_data.sort(key=lambda x: x[0])
        overall_hash = hashlib.md5()
        for rel_path, f_hash in files_data:
            overall_hash.update(rel_path.encode("utf-8"))
            overall_hash.update(f_hash.encode("utf-8"))
        return overall_hash.hexdigest()

    @staticmethod
    def compute_cache_diff(
            old_cache: Dict[str, Dict],
            new_cache: Dict[str, Dict],
    ) -> list[Tuple[str, str, Optional[str], Optional[str]]]:
        """对比两份每文件指纹缓存，返回变动文件列表。

        用于在整体 project_hash 不一致时定位具体变动文件。返回元素为
        ``(kind, rel_path, old_hash, new_hash)``：

        - ``added``   : 新增文件（old 无 / new 有），old_hash=None
        - ``removed`` : 删除文件（old 有 / new 无），new_hash=None
        - ``changed`` : 内容变化文件（hash 不同）

        各段按 rel_path 升序稳定排列。
        """
        old_cache = old_cache or {}
        new_cache = new_cache or {}
        old_keys = set(old_cache)
        new_keys = set(new_cache)

        def _h(entry):
            return entry.get("hash") if isinstance(entry, dict) else None

        diffs: list[Tuple[str, str, Optional[str], Optional[str]]] = []
        for k in sorted(new_keys - old_keys):
            diffs.append(("added", k, None, _h(new_cache[k])))
        for k in sorted(old_keys - new_keys):
            diffs.append(("removed", k, _h(old_cache[k]), None))
        for k in sorted(new_keys & old_keys):
            old_h, new_h = _h(old_cache[k]), _h(new_cache[k])
            if old_h != new_h:
                diffs.append(("changed", k, old_h, new_h))
        return diffs

    @staticmethod
    def _load_file_cache(cache_path: Path) -> Dict[str, Dict]:
        """从 JSON 文件加载每文件哈希缓存"""
        if cache_path is None or not cache_path.exists():
            return {}
        try:
            result = json_util.load_json_from_file(cache_path)
            return result if isinstance(result, dict) else {}
        except Exception as e:
            log_util.warning(f"加载指纹缓存失败，将全量重算: path={cache_path}, error={e}", logger=logger)
            return {}

    @staticmethod
    def _save_file_cache(cache_path: Path, file_cache: Dict[str, Dict]) -> None:
        """将每文件哈希缓存保存到 JSON 文件"""
        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            json_util.write_json_to_file(cache_path, file_cache)
        except Exception as e:
            log_util.warning(f"保存指纹缓存失败: path={cache_path}, error={e}", logger=logger)

    @staticmethod
    def _sampled_file_hash(file_path: Path, sample_size: int = 4096) -> str:
        """
        采样模式：读取文件头尾各 sample_size 字节 + 文件大小计算哈希。

        不依赖 mtime，适合 git clone/pull 后 mtime 发生变化的场景。
        对于小于 2*sample_size 的文件，等同于读取完整内容。

        :param file_path: 文件路径
        :param sample_size: 头尾各采样的字节数，默认 4096 (4KB)
        :return: 哈希字符串 (MD5 hex)
        """
        stat = file_path.stat()
        file_size = stat.st_size
        hasher = hashlib.md5()
        # 混入文件大小
        hasher.update(f"{file_size}:".encode("utf-8"))

        with open(file_path, "rb") as f:
            # 读取头部
            head = f.read(sample_size)
            hasher.update(head)

            # 读取尾部（仅当文件足够大时才有独立尾部）
            if file_size > sample_size * 2:
                f.seek(-sample_size, 2)  # 从文件末尾向前偏移
                tail = f.read(sample_size)
                hasher.update(tail)
            elif file_size > sample_size:
                # 文件大小介于 sample_size 和 2*sample_size 之间，读取剩余部分
                remaining = f.read()
                hasher.update(remaining)
            # 文件 <= sample_size 时，head 已经包含全部内容

        return hasher.hexdigest()

    @staticmethod
    def _file_hash(file_path: Path, chunk_size: int = 8192) -> str:
        """计算单个文件的 MD5 哈希（读取完整内容）"""
        hasher = hashlib.md5()
        with open(file_path, "rb") as f:
            while chunk := f.read(chunk_size):
                hasher.update(chunk)
        return hasher.hexdigest()
