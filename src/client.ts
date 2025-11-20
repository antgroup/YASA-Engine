import type { ResponseObject, PrintFunction } from './engine/analyzer/common/common-types'

const readline = require('readline')
const { initAnalyzer } = require('./interface/starter')
const { ErrorCode } = require('./util/error-code')
const Config = require('./config')
const logger = require('./util/logger')(__filename)
const BasicRuleHandler = require('./checker/common/rules-basic-handler')
const OutputStrategyAutoRegister = require('./engine/analyzer/common/output-strategy-auto-register')
const { outputTotalErrors, clearTotalErrors } = require('./engine/analyzer/common/exception-handler')
const { execute } = require('./interface/starter')

/**
 *
 */
class IoSession {
  analyzer: any

  mng: any

  init: boolean

  /**
   *
   * @param analyzer
   */
  constructor(analyzer: any) {
    this.analyzer = analyzer
    this.mng = analyzer.checkerManager
    this.init = false
  }

  /**
   * 交互式命令行具体执行的逻辑，选择checker执行handleInput / handleOutput
   * @param message ： { command:"", arguments:[""]}
   */
  onMessage(message: string): ResponseObject | null {
    const response = {
      body: '',
    }
    try {
      const request = JSON.parse(message)
      let checkerName = ''
      switch (request.command) {
        case 'hasflow': {
          checkerName = 'antql_hasflow'
          break
        }
        case 'hasfunctioncall': {
          checkerName = 'antql_hasfunctioncall'
          break
        }
        case 'hasproperty': {
          checkerName = 'antql_hasproperty'
          break
        }
        case 'getsubclass': {
          checkerName = 'antql_getsubclass'
          break
        }
        case 'getbaseclass': {
          checkerName = 'antql_getbaseclass'
          break
        }
        case 'getdefinition': {
          checkerName = 'antql_getdefinition'
          break
        }
        case 'getfileast': {
          checkerName = 'get_file_ast'
          break
        }
        case 'getastsourcecode': {
          checkerName = 'get_ast_source_code'
          break
        }
        default: {
          /* empty */
        }
      }

      const checker = this.mng.registered_checkers[checkerName]
      // 每次模拟执行清空findings
      this.analyzer?.checkerManager?.resultManager?.clearFindings()
      clearTotalErrors()
      checker.handleInput(request.arguments)
      this.analyzer.startAnalyze()
      this.analyzer.symbolInterpret()
      this.analyzer.endAnalyze()
      checker.handleOutput()
      return outputAnalyzerResult(this.analyzer, checker)
    } catch (e) {
      logger.error(e)
    }
    // console.log(JSON.stringify(response))
    return null
  }

  /**
   * 注册stdio，监听用户输入
   */
  listen(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '>>> ',
    })
    rl.prompt()

    rl.on('line', (input: string) => {
      const message = input.trim()
      this.onMessage(message)
      rl.prompt()
    })

    rl.on('close', () => {
      logger.info('Exiting YASA...')
      rl.close()
      process.exit(0)
    })
  }
}

/**
 * client的主入口
 */
async function main(): Promise<void> {
  logger.info(`main file:${require.main?.filename || 'unknown'}`)
  try {
    const args = process.argv.slice(2)
    console.log(`arguments: ${args.join(' ')}`)
    if (!args.includes('--singleCommand')) {
      const analyzer = await initAnalyzer(null, args)
      await analyzer.preProcess(Config.maindir)
      const fullCallGraphFileEntryPoint = require('./checker/common/full-callgraph-file-entrypoint')
      fullCallGraphFileEntryPoint.makeFullCallGraph(analyzer)
      BasicRuleHandler.setPreprocessReady(true)
      console.log('Yasa initialization is complete')
      const ioSession = new IoSession(analyzer)
      ioSession.listen()
    } else {
      await execute(null, args)
    }
  } catch (e) {
    logger.error('Error', e)
    process.exitCode = ErrorCode.unknown_error
  }
}

/**
 * output all the findings of all registered checker
 * @param analyzer
 * @param checker
 * @param printf
 */
function outputAnalyzerResult(analyzer: any, checker: any, printf?: PrintFunction): null {
  if (!printf || typeof printf !== 'function') {
    printf = logger.info.bind(logger)
  }
  const allFindings = null
  const { resultManager } = analyzer.getCheckerManager()
  if (resultManager && Config.reportDir && checker.getStrategyId()) {
    const outputStrategyAutoRegister = new OutputStrategyAutoRegister()
    outputStrategyAutoRegister.autoRegisterAllStrategies()

    const { yasaSeparator } = require('./util/format-util')
    yasaSeparator('outputFindings')
    for (const outputStrategyId of checker.getStrategyId()) {
      const strategy = outputStrategyAutoRegister.getStrategy(outputStrategyId)
      if (strategy && typeof strategy.outputFindings === 'function') {
        strategy.outputFindings(resultManager, strategy.getOutputFilePath(), Config, printf)
      }
    }
    yasaSeparator('')
  }
  logger.info('analyze done')
  outputTotalErrors()
  return allFindings
}

if (require.main === module) {
  main()
}

module.exports = { IoSession }
