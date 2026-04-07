const { PythonTaintAbstractChecker } = require('./python-taint-abstract-checker')
const Config = require('../../../config')
const { markTaintSource } = require('../common-kit/source-util')
const AstUtil = require('../../../util/ast-util')

// fclos.qid 匹配规则
const ARGPARSE_QID_PATTERN = /\.argparse\.ArgumentParser\(.*\)\.(parse_args|parse_known_args)$/
const OPTPARSE_QID_PATTERN = /\.optparse\.OptionParser\(.*\)\.(parse_args|parse_known_args)$/
const INPUT_QID_PATTERN = /\.(input|raw_input)$/
const GETOPT_QID_PATTERN = /\.getopt\.(getopt|gnu_getopt)$/
const OS_GETENV_QID_PATTERN = /\.os\.getenv$/
const OS_ENVIRON_GET_QID_PATTERN = /\.os\.environ\.get$/
const SYS_STDIN_QID_PATTERN = /\.sys\.stdin\.(read|readline|readlines)$/

// 文件 I/O source：open() / io.open() / codecs.open() 返回文件句柄，携带本地文件内容
const FILE_OPEN_QID_PATTERN = /\.(open|io\.open|codecs\.open)$/
// pathlib 文件读取
const PATHLIB_READ_QID_PATTERN = /\.Path.*\.(read_text|read_bytes|read)$/

const SCRIPT_SOURCE_QID_PATTERNS = [
  ARGPARSE_QID_PATTERN,
  OPTPARSE_QID_PATTERN,
  INPUT_QID_PATTERN,
  GETOPT_QID_PATTERN,
  OS_GETENV_QID_PATTERN,
  OS_ENVIRON_GET_QID_PATTERN,
  SYS_STDIN_QID_PATTERN,
  FILE_OPEN_QID_PATTERN,
  PATHLIB_READ_QID_PATTERN,
]

/**
 * Python 脚本污点追踪 checker
 * Source: argparse.parse_args(), sys.argv, input(), os.environ, getopt, open() 等
 * Entrypoint: 文件级入口（脚本从文件头开始执行）
 */
class ScriptTaintChecker extends PythonTaintAbstractChecker {
  constructor(resultManager: any) {
    super(resultManager, 'taint_flow_python_script_input')
  }

  triggerAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any): void {
    this.addSourceTagForcheckerRuleConfigContent('PYTHON_INPUT', this.checkerRuleConfigContent)
    if (Config.entryPointMode === 'ONLY_CUSTOM') return
    const fullCallGraphFileEntryPoint = require('../../common/full-callgraph-file-entrypoint')
    const fullFileEntrypoint = fullCallGraphFileEntryPoint.getAllFileEntryPointsUsingFileManager(analyzer)
    analyzer.entryPoints.push(...fullFileEntrypoint)
  }

  triggerAtFunctionCallAfter(analyzer: any, scope: any, node: any, state: any, info: any): void {
    super.triggerAtFunctionCallAfter(analyzer, scope, node, state, info)
    const { fclos, ret } = info
    if (Config.entryPointMode === 'ONLY_CUSTOM' || !fclos || !ret) return

    const { qid } = fclos
    if (typeof qid !== 'string') return

    for (const pattern of SCRIPT_SOURCE_QID_PATTERNS) {
      if (pattern.test(qid)) {
        markTaintSource(ret, { path: node, kind: 'PYTHON_INPUT' })
        return
      }
    }
  }

  triggerAtMemberAccess(analyzer: any, scope: any, node: any, state: any, info: any): void {
    if (Config.entryPointMode === 'ONLY_CUSTOM') return

    // sys.argv
    if (AstUtil.prettyPrintAST(node) === 'sys.argv') {
      markTaintSource(info.res, { path: node, kind: 'PYTHON_INPUT' })
    }

    // os.environ
    if (AstUtil.prettyPrintAST(node) === 'os.environ') {
      markTaintSource(info.res, { path: node, kind: 'PYTHON_INPUT' })
    }
  }
}

module.exports = ScriptTaintChecker
