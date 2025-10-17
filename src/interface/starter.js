const fs = require('fs-extra')
const pathMod = require('path')
const _ = require('lodash')
const { Command } = require('commander')
const Config = require('../config')
const Parsing = require('../engine/parser/parsing')
const Stat = require('../util/statistics')
const logger = require('../util/logger')(__filename)
const FileUtil = require('../util/file-util')
const { ErrorCode, Errors } = require('../util/error-code')
const FrameworkUtil = require('../util/framework-util')
const { handleException } = require('../engine/analyzer/common/exception-handler')
const OutputStrategyAutoRegister = require('../engine/analyzer/common/output-strategy-auto-register')

/**
 * the main entry point of the usual scan
 * @param dir
 * @param args
 * @param printf
 * @param isSync
 */
async function execute(dir, args = [], printf, isSync) {
  const analyzer = await initAnalyzer(dir, args, printf)
  if (analyzer) {
    const processingDir = Config.maindir
    let isSuccess = false
    if (!isSync) {
      isSuccess = await executeAnalyzerAsync(analyzer, processingDir)
    } else {
      isSuccess = executeAnalyzer(analyzer, processingDir)
    }
    if (isSuccess) {
      return outputAnalyzerResult(analyzer, printf)
    }
  }
}

/**
 * output all the findings of all registered checker
 * @param analyzer
 * @param printf
 */
function outputAnalyzerResult(analyzer, printf) {
  if (!printf || typeof printf !== 'function') {
    printf = logger.info.bind(logger)
  }
  let allFindings = null
  const { resultManager } = analyzer.getCheckerManager()
  if (resultManager && Config.reportDir) {
    const outputStrategyAutoRegister = new OutputStrategyAutoRegister()
    outputStrategyAutoRegister.autoRegisterAllStrategies()
    allFindings = resultManager.getFindings()
    logger.info('\n=================  outputFindings  =======================')
    for (const outputStrategyId in allFindings) {
      const strategy = outputStrategyAutoRegister.getStrategy(outputStrategyId)
      if (strategy && typeof strategy.outputFindings === 'function') {
        strategy.outputFindings(resultManager, strategy.getOutputFilePath(), Config, printf)
      }
    }
    logger.info('\n================  outputFindings done  ===================')
  }
  logger.info('analyze done')
  return allFindings
}

/**
 *
 * @param dir
 * @param args
 * @param printf
 */
async function initAnalyzer(dir, args = [], printf) {
  let sourcePath
  if (dir) {
    sourcePath = dir
  }

  // load the basic configuration from e.g. 'config.json'
  loadConfig(Config.configFilePath)
  const program = new Command()
  let reportPath = ''
  // 定义命令行选项
  program
    .option('--sourcePath <dir>', '指定源代码目录（支持文件或目录）', (d) => {
      try {
        if (!fs.existsSync(d)) {
          handleException(null, `Error !! no such file or directory: ${d}`, `Error !! no such file or directory: ${d}`)
          process.exit(1)
        }
        const stats = fs.statSync(d)
        if (stats.isFile()) {
          Config.single = true
        }
        sourcePath = d
      } catch (err) {
        handleException(
          err,
          'ERROR: an error occurred while reading source path',
          'ERROR: an error occurred while reading source path'
        )
        process.exit(1)
      }
    })
    .option('--language <lang>', '指定语言（支持: javascript/typescript/golang/python/java）', (lang) => {
      const supported = ['javascript', 'typescript', 'js', 'ts', 'go', 'golang', 'python', 'java']
      if (!supported.includes(lang)) {
        logger.info('Unknown language!! Only support javascript/typescript/golang/python/java')
        process.exit(0)
      }
      if (['typescript', 'ts', 'js', 'javascript'].includes(lang)) {
        lang = 'javascript'
      }
      if (['golang', 'go'].includes(lang)) {
        lang = 'golang'
      }
      Config.language = lang
    })
    .option('--analyzer <analyzer>', '指定框架', (f) => {
      Config.analyzer = f
    })
    .option('--report <dir>', '指定报告输出目录或文件', (rdir) => {
      reportPath = rdir
    })
    .option('--ruleConfigFile <file>', '指定规则配置文件', (file) => {
      const ruleConfigFile = pathMod.isAbsolute(file) ? file : pathMod.resolve(pathMod.join(process.cwd(), file))
      Config.ruleConfigFile = ruleConfigFile
      logger.info('Rule config file: ', ruleConfigFile)
    })
    .option('--entrypointMode <mode>', '指定入口点模式（BOTH/SELF_COLLECT/ONLY_CUSTOM）', (mode) => {
      const validModes = ['BOTH', 'SELF_COLLECT', 'ONLY_CUSTOM']
      if (!validModes.includes(mode)) {
        handleException(
          null,
          'EntrypointMode must be BOTH/SELF_COLLECT/ONLY_CUSTOM',
          'EntrypointMode must be BOTH/SELF_COLLECT/ONLY_CUSTOM'
        )
      } else {
        Config.entryPointMode = mode
      }
      logger.info('EntrypointMode set: ', mode)
    })
    .option('--checkerIds <list>', '指定检查器id列表（逗号分隔）', (list) => {
      const checkerIds = list.split(',')
      Config.checkerIds = _.assign(Config.checkerIds, checkerIds)
      logger.info('Specific checkerIds:', checkerIds)
    })
    .option('--checkerPackIds <list>', '指定检查器组id列表（逗号分隔）', (list) => {
      const checkerPackIds = list.split(',')
      Config.checkerPackIds = _.assign(Config.checkerPackIds, checkerPackIds)
      logger.info('Specific checkerPackIds:', checkerPackIds)
    })
    .option('--dumpAST', 'dump单文件AST', () => {
      Config.dumpAST = true
    })
    .option('--dumpAllAST', 'dump整个项目AST', () => {
      Config.dumpAllAST = true
    })
    .option('--uastSDKPath <dir>', 'UAST二进制文件路径', (uastDir) => {
      Config.uastSDKPath = pathMod.isAbsolute(uastDir) ? uastDir : pathMod.resolve(pathMod.join(process.cwd(), uastDir))
    })
    .option('--dumpCG', '输出函数调用图', () => {
      Config.dumpCG = true
      if (!Config.checkerIds) Config.checkerIds = []
      Config.checkerIds = Array.isArray(Config.checkerIds) ? Config.checkerIds : [Config.checkerIds]
      Config.checkerIds.push('callgraph')
    })
    .option('--dumpAllCG', '输出完整调用图输出', () => {
      Config.dumpAllCG = true
      if (!Config.checkerIds) Config.checkerIds = []
      Config.checkerIds = Array.isArray(Config.checkerIds) ? Config.checkerIds : [Config.checkerIds]
      Config.checkerIds.push('callgraph')
    })
    .option('--source <locations>', '指定source位置（QL专用）', (locations) => {
      if (!Config.FlowConfig) {
        Config.FlowConfig = {}
      }
      if (!Config.FlowConfig.source) {
        Config.FlowConfig.source = []
        Config.FlowConfig.sourcefiles = {}
      }

      const sourceLocs = locations.split(',')
      for (const sourceLoc of sourceLocs) {
        Config.FlowConfig.source.push(sourceLoc)
        const sourcefile = sourceLoc.split(':')[0]
        Config.FlowConfig.sourcefiles[sourcefile] = 0
      }
    })
    .option('--sink <locations>', '指定sink位置（QL专用）', (locations) => {
      if (!Config.FlowConfig) {
        Config.FlowConfig = {}
      }
      if (!Config.FlowConfig.sink) {
        Config.FlowConfig.sink = []
        Config.FlowConfig.sinkfiles = {}
      }

      const sinkLocs = locations.split(',')
      for (const sinkLoc of sinkLocs) {
        Config.FlowConfig.sink.push(sinkLoc)
        const sinkFile = sinkLoc.split(':')[0]
        Config.FlowConfig.sinkfiles[sinkFile] = 0
      }
    })
    .option('--single', '单文件模式', () => {
      Config.single = true
    })
    .option('--prefixPath <path>', '指定临时前缀位置（QL专用）', (prefixPath) => {
      Config.prefixPath = prefixPath
    })
    .option('--configFilePath <configFilePath>', '指定config配置文件路径（JSON格式）', (configFilePath) => {
      loadConfig(configFilePath)
    })
  // 处理非选项参数（如直接传入的目录）
  program.arguments('[paths...]').action((paths) => {
    if (paths.length > 0) {
      for (const path of paths) {
        try {
          if (fs.existsSync(path)) {
            const stats = fs.statSync(path)
            if (stats.isFile()) {
              Config.single = true
            }
            sourcePath = path
          }
        } catch (err) {
          handleException(
            err,
            'ERROR: an error occurred while reading path',
            'ERROR: an error occurred while reading path'
          )
          process.exit(1)
        }
      }
    }
  })

  // 处理未知选项
  program.allowUnknownOption(true)
  program.allowExcessArguments()

  // 处理帮助信息
  program.on('--help', () => {
    printHelp()
  })

  program.version('0.2.3-inner')

  // 解析命令行参数
  program.parse(args, { from: 'user' })

  Stat.parsingTime = 0

  // 解析分析目标
  if (sourcePath) {
    try {
      let maindir
      if (pathMod.isAbsolute(sourcePath)) {
        maindir = sourcePath
      } else {
        maindir = pathMod.resolve(pathMod.join(process.cwd(), sourcePath))
      }
      if (!maindir.endsWith('/') && !Config.single) {
        maindir += '/'
      }
      // record the main directory
      logger.info(`source path: ${maindir}`)
      Config.maindir = maindir
      Config.maindirPrefix = maindir.substring(0, maindir.lastIndexOf('/'))
    } catch (e) {
      logger.info(e)
      logger.info(`directory = [${dir}]`)
      return
    }
  }
  if (Config.maindir && Config.maindir !== '') {
    if (Config.single) {
      const lang = detectFileLanguage(Config.maindir)
      if (lang) {
        Config.language = lang
      } else {
        logger.info(
          'Unknown command or unknown language!! Note the command using -- , and language support javascript/typescript/golang/python/java.'
        )
        process.exit(0)
      }
    }
  } else {
    handleException(
      null,
      'There is no source path specified to analyze',
      'There is no source path specified to analyze'
    )
    process.exit(0)
  }

  if (reportPath && reportPath !== '') {
    const reportPathAbs = pathMod.isAbsolute(reportPath)
      ? reportPath
      : pathMod.resolve(pathMod.join(process.cwd(), reportPath))
    if (Config.dumpAST) {
      Config.ASTFileOutput = reportPathAbs
      const parentDir = pathMod.dirname(reportPathAbs)
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true })
      }
      if (!fs.existsSync(reportPathAbs)) {
        fs.writeFileSync(reportPathAbs, '')
      } else {
        const stats = fs.statSync(reportPathAbs)
        if (!stats.isFile()) {
          fs.rmSync(reportPathAbs, { recursive: true, force: true })
          fs.writeFileSync(reportPathAbs, '')
        }
      }
      logger.info('Report File:', Config.ASTFileOutput)
    } else {
      Config.reportDir = reportPathAbs
      if (!fs.existsSync(reportPathAbs)) {
        fs.mkdirSync(reportPathAbs, { recursive: true })
      } else {
        const stats = fs.statSync(reportPathAbs)
        if (!stats.isDirectory()) {
          fs.unlinkSync(reportPathAbs)
          fs.mkdirSync(reportPathAbs, { recursive: true })
        }
      }
      logger.info('Report directory:', Config.reportDir)
    }
  }

  // dump AST
  if (Config.dumpAST) {
    if (!Config.single) {
      Errors.ParseError('Only support dump AST for single file, but given a dir')
      process.exit(0)
    }
    // read and parse the source file(s)
    const apps = loadSource(Config.maindir)
    // logger.info("apps: " + JSON.stringify(apps));
    if (apps.length === 0) {
      const ecode = ErrorCode.no_valid_source_file
      handleException(null, `ERROR: ${ErrorCode.toString(ecode)}`, `ERROR: ${ErrorCode.toString(ecode)}`)
      process.exitCode = ecode
      return
    }
    if (Config.ASTFileOutput) {
      dumpAST(apps, fs.writeFileSync)
    } else {
      dumpAST(apps, logger.info.bind(logger))
    }
    process.exit(0)
  }

  // dump all AST
  if (Config.dumpAllAST) {
    try {
      await Parsing.parseDirectory(Config.maindir, Config)
      console.log('parseDirectory UAST success!')
      process.exit(0)
    } catch (e) {
      handleException(e, 'Error occurred in dumpAllAST!!!!', `Error occurred in dumpAllAST!!!!${e}`)
      process.exit(1)
    }
  }

  // prepare the output and report directories
  cleanReportDir(Config.reportDir)

  const JavaScriptAnalyzer = require('../engine/analyzer/javascript/common/js-analyzer')
  const EggAnalyzer = require('../engine/analyzer/javascript/egg/egg-analyzer')

  const JavaAnalyzer = require('../engine/analyzer/java/common/java-analyzer')
  const SpringAnalyzer = require('../engine/analyzer/java/spring/spring-analyzer')

  const GoAnalyzer = require('../engine/analyzer/golang/common/go-analyzer')

  const PythonAnalyzer = require('../engine/analyzer/python/common/python-analyzer')

  const analyzerEnum = {
    EggAnalyzer,
    JavaScriptAnalyzer,
    JavaAnalyzer,
    GoAnalyzer,
    SpringAnalyzer,
    PythonAnalyzer,
  }
  const analyzerLanguage = {
    EggAnalyzer: 'javascript',
    JavaScriptAnalyzer: 'javascript',
    JavaAnalyzer: 'java',
    SpringAnalyzer: 'java',
    GoAnalyzer: 'golang',
    PythonAnalyzer: 'python',
  }

  let Analyzer
  if (Config.analyzer && Config.analyzer !== '') {
    Analyzer = analyzerEnum[Config.analyzer]
    Config.language = analyzerLanguage[Config.analyzer]
    if (!Analyzer || Analyzer === '') {
      handleException(
        null,
        'analyzer set failed,now YASA supported EggAnalyzer|JavaScriptAnalyzer|JavaAnalyzer|SpringAnalyzer|GoAnalyzer|PythonAnalyzer',
        'analyzer set failed,now YASA supported EggAnalyzer|JavaScriptAnalyzer|JavaAnalyzer|SpringAnalyzer|GoAnalyzer|PythonAnalyzer'
      )
      return
    }
  } else {
    if (!Config.language || Config.language === '') {
      handleException(null, 'language or analyzer must be set', 'language or analyzer must be set')
      return
    }
    let f = FrameworkUtil.detectAnalyzer(Config.language, Config.maindir)
    if (!f || f === '') {
      logger.info('analyzer detect failed, use default language analyzer')
      switch (Config.language) {
        case 'golang':
          f = 'GoAnalyzer'
          break
        case 'javascript':
          f = 'JavaScriptAnalyzer'
          break
        case 'java':
          f = 'JavaAnalyzer'
          break
        case 'python':
          f = 'PythonAnalyzer'
          break
        default:
          handleException(null, 'default analyzer set failed', 'default analyzer set failed')
          return
      }
    }
    Config.analyzer = f
    Analyzer = analyzerEnum[Config.analyzer]
  }
  logger.info(`Analyze Language: ${Config.language}`)
  logger.info(`Analyze Analyer: ${Config.analyzer}`)
  return new Analyzer(Config)
}

/**
 *
 * @param analyzer
 * @param processingDir
 */
async function executeAnalyzerAsync(analyzer, processingDir) {
  try {
    if (Config.single) {
      const source = fs.readFileSync(processingDir, 'utf8')
      if (!analyzer.analyzeSingleFile(source, processingDir)) {
        return false
      }
    } else if (!(await analyzer.analyzeProjectAsync(processingDir))) {
      return false
    }
    return true
  } catch (e) {
    handleException(e, 'Error occurred in executeAnalyzerAsync!!!!', 'Error occurred in executeAnalyzerAsync!!!!')
  }
  return false
}

/**
 *
 * @param analyzer
 * @param processingDir
 */
function executeAnalyzer(analyzer, processingDir) {
  try {
    if (Config.single) {
      const source = fs.readFileSync(processingDir, 'utf8')
      if (!analyzer.analyzeSingleFile(source, processingDir)) {
        return false
      }
    } else if (!analyzer.analyzeProject(processingDir)) {
      return false
    }
    return true
  } catch (e) {
    handleException(e, 'Error in executeAnalyzerAsync occurred!!!!', 'Error in executeAnalyzerAsync occurred!!!!')
  }
  return false
}

// 递归函数，用于删除对象及其子对象中的 'parent' 属性
/**
 *
 * @param obj
 */
function removeParentProperty(obj) {
  if (typeof obj !== 'object' || obj === null) {
    return obj
  }

  // 删除当前对象的 'parent' 属性
  delete obj.parent

  // 递归遍历子对象
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      obj[key] = removeParentProperty(obj[key])
    }
  }

  return obj
}
/**
 *
 * @param absdirs
 * @returns {Array}
 */
function loadSource(absdirs) {
  if (!Config.language) {
    logger.info('please set language first')
    process.exit(1)
  }
  let fext = ['.sol']
  const dirFilter = []
  switch (Config.language) {
    case 'golang':
      fext = ['go']
      dirFilter.push('vendor')
      break
    case 'javascript':
    case 'js':
    case 'typescript':
    case 'ts':
      fext = ['js', 'ts', 'cjs', 'mjs']
      dirFilter.push('node_modules')
      break
    case 'java':
      fext = ['java']
      break
    case 'python':
      fext = ['py']
      break
  }

  const res = []
  if (absdirs && !Array.isArray(absdirs)) {
    absdirs = [absdirs]
  }
  for (const dir of absdirs) {
    const srcTxts = FileUtil.loadAllFileText(dir, fext, dirFilter)
    for (const txt of srcTxts) {
      // txt: { file: ..., content: ... }
      res.push(txt)
    }
  }
  return res
}

/**
 * load the configuration file from the disk
 * @param configfile
 */
function loadConfig(configfile) {
  let file = configfile || 'config.json'
  if (!pathMod.isAbsolute(file)) file = `${process.cwd()}/${file}`
  if (file) {
    try {
      if (!fs.existsSync(file)) return
      const cf = FileUtil.loadJSONfile(file)
      if (cf) {
        for (const x in cf) {
          Config[x] = cf[x]
        }
      }
    } catch (e) {
      handleException(
        e,
        `ERROR: loading the configuration file failed: ${configfile}`,
        `ERROR: loading the configuration file failed: ${configfile}`
      )
    }
  }
}

/**
 * clean or create the directory for report for external usage
 * @param odir target directory
 */
function cleanReportDir(odir) {
  // handle the trigger output directory
  if (odir) {
    try {
      if (!fs.existsSync(odir))
        // create the output directory
        fs.mkdirSync(odir)
      else {
        // clean up the output directory
        const files = fs.readdirSync(odir)
        for (let i = 0; i < files.length; i++) {
          const fname = files[i]
          if (fname.startsWith('findings')) {
            const filePath = `${odir}/${fname}`
            if (fs.statSync(filePath).isFile()) fs.unlinkSync(filePath)
          } else if (fname === 'html') {
            const sub_path = `${odir}/${fname}`
            cleanReportDir(sub_path)
          }
        }
      }
    } catch (e) {
      handleException(
        e,
        'ERROR: an error occurred while cleanReportDir.',
        'ERROR: an error occurred while cleanReportDir.'
      )
      process.exitCode = ErrorCode.fail_to_generate_report
    }
  }
}

//* *****************************  Command-line hints**********************************

/**
 * command line help information
 */
function printHelp() {
  logger.info('Usage example: ./yasa-sdk [option1 options2 ...] source_path')
}

/**
 *
 * @param apps
 * @param printf
 */
function dumpAST(apps, printf) {
  for (const app of apps) {
    if (!Config.ASTFileOutput) {
      printf('dump file AST:', app.file)
    }
    Config.sourcefile = app.file
    const ast = Parsing.parseCodeRaw(app.file, app.content, Config)
    // golang较为特殊，它是返回的是promise，单独处理
    if (Config.language !== 'golang') {
      const parseResult = JSON.stringify(ast)
      if (Config.ASTFileOutput) {
        printf(Config.ASTFileOutput, parseResult)
      } else {
        printf(parseResult)
      }
    } else if (!Config.ASTFileOutput) {
      printf('Report File: ./uast.json')
    }
  }
}

/**
 *
 * @param findings
 */
function filtrateFindings(findings) {
  if (findings && Array.isArray(findings)) {
    return findings.filter((element) => {
      const trace = element?.trace
      if (trace && Array.isArray(trace)) {
        for (const t of trace) {
          if (!t.str?.toString().includes('SOURCE:') && !t.affectedNodeName) {
            return false
          }
        }
        return true
      }
      return false
    })
  }
  return null
}

/**
 *
 * @param filename
 */
function detectFileLanguage(filename) {
  const ext = filename.split('.').pop().toLowerCase()
  switch (ext) {
    case 'ts':
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'go':
      return 'golang'
    case 'java':
      return 'java'
    case 'py':
      return 'python'
    default:
      return null
  }
}

module.exports = {
  execute,
  initAnalyzer,
}
