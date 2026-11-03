__version__ = "1.2.0"

# 当二进制包更新时，需要更新这个版本号
# 同时，所有代码库的缓存也会更新
__binary_version__ = "1.0.0"


def main() -> None:
    """Main entry point: CLI → server → service."""
    from yasa_mcp.bin.yasa_client import main as cli_main
    cli_main()


# Optionally expose other important items at package level
__all__ = ["main", "server", "__version__", "__binary_version__"]
