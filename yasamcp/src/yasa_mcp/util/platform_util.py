import platform

from yasa_mcp.core import exceptions


def detect_platform():
    # 判断当前的平台
    system = platform.system()
    machine = platform.machine()

    platform_map = {
        ("Darwin", "arm64"): "darwin-aarch64",
        ("Darwin", "aarch64"): "darwin-aarch64",
        ("Darwin", "x86_64"): "darwin-x86-64",
        ("Linux", "x86_64"): "linux-x86-64",
        ("Windows", "AMD64"): "windows-x86-64",
    }

    platform_path = platform_map.get((system, machine))
    if not platform_path:
        raise exceptions.PlatformNotSupportedError(f"不支持的平台: {system}/{machine}")

    return platform_path


if __name__ == '__main__':
    print(detect_platform())