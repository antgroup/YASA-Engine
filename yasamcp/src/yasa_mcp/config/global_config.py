import os
from pathlib import Path
from yasa_mcp.core.enums import Language

# 超时时间，默认是30s
run_timeout = 30
# 预处理时间，默认是3600s（1小时），因为有些项目可能很大，预处理可能需要较长时间
prepare_timeout = 3600

# 缓存文件夹
cache_path = Path("./cache")

# 日志文件夹
log_path = Path.home() / ".yasamcp" / "logs"

# 二进制文件夹：默认 ~/.yasamcp，平台子目录(darwin-aarch64 等)由 BinaryLayout.from_root 自动追加。
# init/server -b 覆盖时由 binary_manager 持久化到 ~/.yasamcp/config.json。
binary_path = Path.home() / ".yasamcp"

support_languages = [
    Language.JAVA,
    Language.PYTHON,
    Language.JAVASCRIPT,
    Language.GO,
    Language.PHP,
]

_cpu_count = os.cpu_count() or 4

# 快线程池（code_search_service 等轻量 DuckDB 索引查询，IO-bound，周转快）
# 推荐 3x CPU 核心数，上限 32 防止 DuckDB 连接过多
fast_pool_size = min(32, _cpu_count * 4)

# 慢线程池（callgraph_service 等图遍历 + 大量文件 IO，混合型，占用时间长）
# 推荐 1x CPU 核心数，上限 16 防止磁盘 IO 饱和
slow_pool_size = min(16, _cpu_count*2)

# Service 对外接口慢请求入参日志阈值，<=0 表示关闭入参追加，仅保留耗时日志
service_slow_request_log_threshold_ms = 3_000
