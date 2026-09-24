import os
import logging
import pickle
from enum import Enum

from pathlib import Path

from yasa_mcp.config import global_config
from yasa_mcp.core.enums import Language, CallgraphAlgorithm, Mode
from yasa_mcp.core import exceptions
from yasa_mcp.core.models import ToolProtocol
from yasa_mcp.tools.yasa import yasa_module
from yasa_mcp.tools.yasa.yasa_bin_layout import YasaBinaryLayout
from yasa_mcp.util import command_util, log_util, json_util
from yasa_mcp.util.timer_util import Timer, timed

logger = logging.getLogger(__name__)


class YasaTool(ToolProtocol):

    def __init__(self, yasa_layout: YasaBinaryLayout):
        self.yasa_layout = yasa_layout
        # 普通查询不需要 native binary，廉价存在检测即可；真正调用时损坏会在执行处报错。
        self.initialized = command_util.binary_exists(self.yasa_layout.yasa_bin)

    def check_available(self) -> bool:
        """Check if Yasa CLI is available."""
        return command_util.check_binary_available(self.yasa_layout.yasa_bin)

    @timed(logger, "Yasa", "dump_callgraph")
    def dump_callgraph(
        self,
        project_path: Path,
        language: Language,
        yasa_report_dir: Path,
        algorithm: CallgraphAlgorithm,
        mode: Mode,
        *,
        return_graph: bool = True,
    ) -> yasa_module.CallGraph | None:
        """
        执行 yasa，仅生成 callgraph。

        :arguments:
            project_path: 项目路径
            language: 语言类型
            yasa_report_dir: yasa报告目录, callgraph.json会生成到该文件夹
            algorithm: callgraph算法
            mode: 模式
        """

        log_util.info(f"dump callgraph with yasa, project_path: {project_path}, language: {language}, "
                      f"yasa_report_dir: {yasa_report_dir}, algorithm: {algorithm}, mode: {mode}", logger=logger)
        args = [
            "--sourcePath", project_path,
            "--language", language.value,
            "--dumpAllCG",
            "--report", yasa_report_dir,
            "--intermediate-dir", yasa_report_dir,
            "--workerCount", "4"  # 限制并发量为1
        ]

        # 仅增量模式追加 --incremental true，全量模式按 yasa 默认行为执行
        if mode == Mode.INCREMENTAL:
            args.extend(["--incremental", "true"])

        if algorithm == CallgraphAlgorithm.CHA:
            if language not in [Language.JAVA, Language.GO]:
                raise exceptions.LanguageNotSupportedError(f"language {language} not support CHA callgraph algorithm")
            args.append("--cgAlgo")
            args.append(algorithm.value)

        if language in [Language.PYTHON, Language.GO]:
            args.append("--uastSDKPath")
            args.append(self.yasa_layout.get_uast_bin(language))


        # yasa 引擎按运行时 CWD 查找 node_modules（解析 JS/TS 依赖），
        # 必须将 CWD 设为 yasa 二进制所在目录，否则 JS callgraph dump 会因依赖缺失中断。
        result = command_util.run_binary(
            self.yasa_layout.yasa_bin,
            args,
            global_config.prepare_timeout,
            cwd=self.yasa_layout.yasa_bin.parent,
        )

        if result.returncode != 0 and result.stderr != "":
            message = f"prepare callgraph failed : {result.stderr}"
            log_util.error(message, logger=logger)
            # raise exceptions.ToolError(message)

        callgraph_path = yasa_report_dir / "callgraph.json"
        if not return_graph:
            return None
        return self.parse_callgraph_report(callgraph_path, project_path)

    @timed(logger, "Yasa", "parse_callgraph_report")
    def parse_callgraph_report(self, callgraph_path: Path, project_path: Path) -> yasa_module.CallGraph:
        """解析callgraph report"""
        if not callgraph_path.exists() or callgraph_path.stat().st_size == 0:
            log_util.warning(f"callgraph file {callgraph_path} is empty or not exists, return empty callgraph",
                             logger=logger)
            return yasa_module.CallGraph(nodes={}, edges={})

        callgraph_pkl = callgraph_path.with_suffix('.json.pkl')
        if callgraph_pkl.exists():
            try:
                with open(callgraph_pkl, 'rb') as f:
                    log_util.info(f"Loading callgraph from cache: {callgraph_pkl}", logger=logger)
                    return pickle.load(f)
            except Exception as e:
                log_util.warning(f"Failed to load pickle cache :{e}", logger=logger)

        callgraph_json = json_util.load_json_from_file(callgraph_path)
        if not callgraph_json:
            return yasa_module.CallGraph(nodes={}, edges={})

        # 统一处理路径为相对路径
        callgraph = yasa_module.CallGraph.model_validate(callgraph_json,
                                                         context={"project_path": project_path})

        # 将解析好的对象保存为 Pickle 缓存
        try:
            with open(callgraph_pkl, 'wb') as f:
                pickle.dump(callgraph, f, protocol=pickle.HIGHEST_PROTOCOL)
                log_util.info(f"Saved callgraph cache to: {callgraph_pkl}", logger=logger)
        except Exception as e:
            log_util.warning(f"Failed to save pickle cache: {e}", logger=logger)

        return callgraph
