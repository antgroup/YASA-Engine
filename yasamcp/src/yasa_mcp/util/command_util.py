import signal
import subprocess
import os
import logging
from pathlib import Path
from typing import NamedTuple

from yasa_mcp.core import exceptions
from yasa_mcp.util import log_util

# 获取当前模块的日志记录器
logger = logging.getLogger(__name__)


def _kill_process_tree(process: subprocess.Popen, timeout: float = 5) -> None:
    """
    安全地终止进程及其整个子进程树。

    策略：
    1. 先尝试通过进程组 (PGID) 发送 SIGTERM，给进程优雅退出的机会
    2. 等待短暂时间后，如果仍未退出，发送 SIGKILL 强制终止整个进程组
    3. 最后调用 wait() 回收资源，防止僵尸进程

    这解决了 shell 脚本（如 uast_extractor.sh、run_rule.sh）内部启动的
    JVM/Node.js 子进程在父进程被 kill 后仍然残留的问题。
    """
    if process is None:
        return

    # 快速路径: 进程已正常退出（communicate() 成功后），无需任何清理
    if process.returncode is not None:
        return

    pid = process.pid

    try:
        pgid = os.getpgid(pid)
    except (OSError, ProcessLookupError):
        # 进程已退出
        try:
            process.wait(timeout=1)
        except Exception:
            pass
        return

    # Step 1: 优雅终止 — 向整个进程组发送 SIGTERM
    try:
        os.killpg(pgid, signal.SIGTERM)
    except (OSError, ProcessLookupError):
        pass

    # Step 2: 等待进程退出
    try:
        process.wait(timeout=timeout)
        return  # 进程已正常退出
    except subprocess.TimeoutExpired:
        pass

    # Step 3: 强制终止 — 向整个进程组发送 SIGKILL
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        pass

    # Step 4: 最终回收，防止僵尸进程
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
       log_util.error(f"进程 {pid} 在 SIGKILL 后仍未退出", logger=logger)
    except Exception:
        pass


def binary_exists(binary_path: Path) -> bool:
    """廉价存在检测：仅判断二进制文件是否存在，不 spawn 子进程。

    供普通工具加载缓存上下文时使用——查询路径不会调用 native binary，无需
    在每次进程启动时都跑 `--version`（5 个二进制累加约数秒）。工具真正被
    调用时若二进制损坏，会在执行处失败并报错。init 流程另有文件存在校验。
    """
    try:
        return binary_path is not None and Path(binary_path).exists()
    except Exception:
        return False

def check_binary_available(binary_path: Path, timeout: int = 10) -> bool:
    """检查命令行是否可用, 使用version命令"""
    try:
        if os.path.exists(binary_path):
            os.chmod(binary_path, 0o755)
        result = subprocess.run([binary_path, "--version"], capture_output=True, text=True, timeout=timeout)
        if result.returncode != 0:
            message = f" 二进制：{binary_path} 不可用, 错误信息：{result.stderr.strip()}, {result.stdout.strip()}"
            log_util.error(message, logger=logger)
            return False
        message = f" 二进制：{binary_path} 可用, 版本：{result.stdout.strip()}"
        log_util.info(message, logger=logger)
        return True
    except FileNotFoundError:
        message = f" 二进制：{binary_path} 不存在"
        log_util.error(message, logger=logger)
        raise exceptions.FileNotFoundError(message)
    except subprocess.TimeoutExpired:
        message = f" 二进制：{binary_path} 超时"
        log_util.error(message, logger=logger)
        raise exceptions.ToolTimeoutError(message)


def run_binary(binary_path: Path, args: list, timeout: int, errors: str = None,
               cwd: Path | str | None = None,
               env: dict[str, str] | None = None,
               log_stdout: bool = True) -> subprocess.CompletedProcess:
    """
    执行外部二进制命令，获取 stdout/stderr 结果。

    使用 start_new_session=True 将子进程放入独立的进程组，
    确保超时或异常时能通过 os.killpg() 终止整个进程树
    （包括 shell 脚本内部启动的 JVM/Node.js 子进程）。

    :param cwd: 子进程工作目录。默认 None（继承当前进程 CWD），向下兼容旧调用方。
                yasa 引擎依赖运行时 CWD 下的 node_modules 解析 JS/TS 依赖，
                需显式传入 yasa 二进制所在目录，否则 JS callgraph dump 会因
                依赖缺失而中断。
    :param env: 子进程环境变量。仅显式传入时覆盖，避免调用方修改父进程环境。
    :param log_stdout: 是否记录 stdout；默认开启以保持现有调用方行为。
    """
    if not os.path.exists(binary_path):
        message = f"The binary path does not exist : {binary_path}"
        log_util.error(message, logger=logger)
        raise exceptions.FileNotFoundError(message)

    os.chmod(binary_path, 0o755)

    command = [str(binary_path)] + [str(arg) for arg in args]
    log_util.info(f"Run command: {' '.join(command)}", logger=logger)
    
    process = None
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors=errors,
            # 子进程工作目录；None 时继承当前进程 CWD（向下兼容旧调用方）
            cwd=str(cwd) if cwd is not None else None,
            env=env,
            # 关键: 创建独立进程组，使 os.killpg() 能终止整个进程树
            start_new_session=True,
        )
        stdout, stderr = process.communicate(timeout=timeout)

        # 兼容 subprocess.run 的返回结构
        result = subprocess.CompletedProcess(
            args=command,
            returncode=process.returncode,
            stdout=stdout,
            stderr=stderr
        )
        
        if log_stdout and result.stdout:
            # 限制日志长度，只记录前 10000 个字符
            log_content = result.stdout.strip()
            if len(log_content) > 10000:
                log_content = log_content[:10000] + "... (truncated)"
            log_util.info(repr(log_content), logger=logger)
        return result

    except subprocess.TimeoutExpired:
        message = f"Run command timed out : {' '.join(command)}"
        log_util.error(message, logger=logger)
        raise exceptions.ToolTimeoutError(message)

    except Exception as e:
        message = f"Failed to run binary: {type(e).__name__}"
        log_util.exception(message, logger=logger)
        raise exceptions.InvalidToolError(message)

    finally:
        # 无论正常返回、超时还是异常，都确保进程树被清理。
        # _kill_process_tree 内部会检查 process.returncode:
        #   - 正常退出 (returncode is not None): 直接跳过，零开销
        #   - 未退出 (超时/异常): SIGTERM → wait → SIGKILL → wait，彻底清理
        _kill_process_tree(process)
