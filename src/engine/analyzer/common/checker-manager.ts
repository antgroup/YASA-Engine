const fs = require('fs')
const path = require('path')
const logger = require('../../../util/logger')(__filename)
const statistics: { numChecks: number; checkFiringTime: number } = require('../../../util/statistics')
const checkerKit = require('../../../checker/common/checker-kit')
const ResultManager = require('./result-manager')
const { getAbsolutePath, loadJSONfile, isPkgEnv } = require('../../../util/file-util')
const { handleException } = require('./exception-handler')
const { yasaLog } = require('../../../util/format-util')
const Config = require('../../../config')
const {
  getCurrentExecutorResultBuffer,
} = require('./entrypoint/entrypoint-executor') as typeof import('./entrypoint/entrypoint-executor')
import type { LocalResultBuffer } from './local-result-buffer'
import { ResultManagerProxy } from './result-manager-proxy'

interface DataflowCallHooksModule {
  onFunctionCallBefore: (analyzer: unknown, scope: unknown, node: unknown, state: unknown, info: unknown) => void
  onFunctionCallAfter: (analyzer: unknown, scope: unknown, node: unknown, state: unknown, info: unknown) => void
  onNewExprAfter: (analyzer: unknown, scope: unknown, node: unknown, state: unknown, info: unknown) => void
}

let dataflowCallHooks: DataflowCallHooksModule | null = null

function loadDataflowCallHooks(): DataflowCallHooksModule {
  if (!dataflowCallHooks) {
    dataflowCallHooks = require('./dataflow-call-hooks') as DataflowCallHooksModule
  }
  return dataflowCallHooks
}

/**
 * checker 路径解析：按入口环境分流，避免 src/dist 双重加载导致 module-scope 状态分裂
 *
 * 分流策略：
 * - pkg 打包模式（/snapshot/...）：dist/ 是唯一可执行产物，优先 dist/.js
 * - 非 pkg 开发模式（tsx / ts-node / node dist/main.js）：从主入口反推项目根，并与主入口加载路径保持一致
 *   - 主入口在 dist/ 下（node dist/main.js）→ 优先 dist/.js
 *   - 主入口在 src/ 下（tsx src/main.ts）→ 优先 src/.ts
 *
 * 不一致会导致同一逻辑 module 出现两份实例（src .ts 与 dist .js），module-scope
 * 变量（如 rules-basic-handler 的 preprocessReady）分裂，taint source mark 失效。
 * @param checkerPath
 */
function resolveProjectRootFromMainFile(mainFile: string | undefined, isPkg: boolean): string {
  if (typeof mainFile !== 'string') {
    return process.cwd()
  }
  const srcIdx = mainFile.indexOf(`${path.sep}src${path.sep}`)
  if (srcIdx > 0) {
    return mainFile.slice(0, srcIdx)
  }
  const distIdx = mainFile.indexOf(`${path.sep}dist${path.sep}`)
  if (distIdx > 0) {
    return mainFile.slice(0, distIdx)
  }
  if (isPkg) {
    // pkg 二进制路径没有 src/dist 标记时，只能从主文件目录兜底回退。
    return path.resolve(path.dirname(mainFile), '..')
  }
  const moduleRoot = path.resolve(__dirname, '../../../..')
  if (fs.existsSync(path.join(moduleRoot, 'resource/checker/checker-config.json'))) {
    return moduleRoot
  }
  return process.cwd()
}

function resolveCheckerPath(checkerPath: string): string {
  if (path.isAbsolute(checkerPath)) {
    return checkerPath
  }
  const mainFile = require.main?.filename || process.execPath
  const isPkg = isPkgEnv(mainFile)
  const projectRoot = resolveProjectRootFromMainFile(mainFile, isPkg)

  const distJsPath = path.join(projectRoot, 'dist', checkerPath.replace(/\.ts$/, '.js'))
  const srcTsPath = path.join(projectRoot, 'src', checkerPath)

  if (isPkg) {
    // 打包分发：dist 唯一产物
    if (fs.existsSync(distJsPath)) return distJsPath
    if (fs.existsSync(srcTsPath)) return srcTsPath
  } else {
    // 开发模式：跟随主入口加载方式，避免 src/dist 双重实例
    const mainFromDist = typeof mainFile === 'string' && mainFile.includes(`${path.sep}dist${path.sep}`)
    if (mainFromDist) {
      if (fs.existsSync(distJsPath)) return distJsPath
      if (fs.existsSync(srcTsPath)) return srcTsPath
    } else {
      // tsx / ts-node：主入口走 src/.ts，checker 也走 src/.ts 保持单实例
      if (fs.existsSync(srcTsPath)) return srcTsPath
      if (fs.existsSync(distJsPath)) return distJsPath
    }
  }

  // 兜底：直接返回项目根目录下的路径
  return path.join(projectRoot, checkerPath)
}

/**
 * Security checking rules
 */
class CheckerManager {
  static resolveCheckerPath: (checkerPath: string) => string

  static resolveProjectRootFromMainFile: (mainFile: string | undefined, isPkg: boolean) => string

  options: any

  checkerIds: any

  checkerPackIds: any

  Rules: any

  kit: any

  resultManager: any

  // executor 路由代理：在 executor ALS scope 内将 findings 路由到 LocalResultBuffer
  resultManagerProxy: ResultManagerProxy | undefined

  checkpoints: any

  registered_checkers: any

  /**
   *
   * @param _options
   * @param checkerIds
   * @param checkerPackIds
   * @param printers
   * @param Rules
   * @param resultManager
   */
  constructor(_options: any, checkerIds: any, checkerPackIds: any, printers: any, Rules: any, resultManager: any) {
    this.options = _options
    this.checkerIds = checkerIds
    this.checkerPackIds = checkerPackIds
    this.Rules = Rules

    // checkpoint of checker will be registered here
    this.checkpoints = {
      check_at_start_analyze: [], // 开始分析前
      check_at_end_analyze: [], // 分析完成后
      check_at_compile_unit: [], // 每个文件分析前
      check_at_end_compileunit: [], // 每个文件分析后
      check_at_binary_operation: [], // 二元表达式开始分析前
      check_at_pre_declaration: [], // 每个变量定义之前
      check_at_funccall_syntax: [], // 函数调用时，分析目标对象前
      check_at_function_call_before: [], // 函数调用时，分析出目标函数后，实际模拟执行这个函数前
      check_at_function_call_after: [], // 函数调用时，分析出目标函数后，际模拟执行这个函数后
      check_at_new_expr: [], // new操作时，分析new目标对象前
      check_at_new_object: [], // new操作时，分析new目标对象后，模拟执行new操作前
      check_at_new_expr_after: [], // new操作整体分析完后
      check_at_ifcondition: [], // if语句开始分析前
      check_at_assignment: [], // 赋值操作前
      check_at_end_block: [], // 每一个语句块分析后
      check_at_function_definition: [], // 分析完函数定义语句后
      check_at_variable_declaration: [], // 分析完变量定义语句后
      check_at_identifier: [], // 分析完identifier后
      check_at_member_access: [], // 分析完MemberAccess后
      check_at_end_of_node: [], // 分析完每一个ast node后
      check_at_symbol_execute_of_entrypoint_before: [], // 在模拟执行一个entrypoint前
      check_at_symbol_execute_of_entrypoint_after: [], // 在模拟执行一个entrypoint后
    }

    this.registered_checkers = {}

    if (!this.options) return
    const { yasaSeparator } = require('../../../util/format-util')
    try {
      this.kit = checkerKit
      this.resultManager = resultManager || new ResultManager()
      // 路由代理：checker 持有 proxy，在 executor scope 内写入 LocalResultBuffer
      this.resultManagerProxy = new ResultManagerProxy(this.resultManager)
      const resultManagerProxy = this.resultManagerProxy

      const targetCheckerIds: any[] = []
      const targetCheckerPaths: any[] = []
      const targetCheckerDescs: any[] = []
      const loadCheckerNames: any[] = []
      const checkerConfigMap = this.loadCheckerConfigAsMap()
      if (this.checkerIds) {
        for (const checkerId of this.checkerIds) {
          if (checkerConfigMap.has(checkerId) && !targetCheckerIds.includes(checkerId)) {
            targetCheckerIds.push(checkerId)
            targetCheckerDescs.push(checkerConfigMap.get(checkerId).description)
            targetCheckerPaths.push(checkerConfigMap.get(checkerId).checkerPath)
          }
        }
      }
      if (this.checkerPackIds) {
        const checkerPackConfigMap = this.loadCheckerPackConfigAsMap()
        for (const checkerPackId of this.checkerPackIds) {
          if (Array.isArray(checkerPackConfigMap.get(checkerPackId)?.checkerIds)) {
            for (const checkerId of checkerPackConfigMap.get(checkerPackId).checkerIds) {
              if (checkerConfigMap.has(checkerId) && !targetCheckerIds.includes(checkerId)) {
                targetCheckerIds.push(checkerId)
                targetCheckerDescs.push(checkerConfigMap.get(checkerId).description)
                targetCheckerPaths.push(checkerConfigMap.get(checkerId).checkerPath)
              }
            }
          }
        }
      }
      for (let i = 0; i < targetCheckerPaths.length; i++) {
        const checkerId = targetCheckerIds[i]
        let targetCheckerPath = targetCheckerPaths[i]
        targetCheckerPath = resolveCheckerPath(targetCheckerPath)
        yasaLog(`Loading checker: ${checkerId} from ${targetCheckerPath}`, 'init')
        const targetCheckerDesc = targetCheckerDescs[i]
        const checkerNames = this.registerAllCheckers(this, targetCheckerPath, targetCheckerDesc, resultManagerProxy)
        if (checkerNames) {
          if (Array.isArray(checkerNames)) {
            loadCheckerNames.push(...checkerNames)
          } else {
            loadCheckerNames.push(checkerNames)
          }
        }
      }
      // 0 个 checker 加载成功时抛出异常，无法继续分析
      if (loadCheckerNames.length === 0) {
        throw new Error('No checker loaded successfully, cannot proceed with analysis')
      }
      const checkerCount = loadCheckerNames.length
      yasaLog(`Successfully loaded ${checkerCount} checker(s): [${loadCheckerNames.join(', ')}]`, 'init')
    } catch (e) {
      handleException(e, 'Error occurred in CheckerManager_ctor', 'Error occurred in CheckerManager_ctor')
    }
  }

  /**
   *
   */
  getResultManager() {
    return this.resultManager
  }

  /**
   * 返回当前 executor ALS scope 的 LocalResultBuffer。
   * 未走 EntryPointExecutor 时 scope 不命中返回 undefined，
   * caller 须 fallback 到 getResultManager() 原路径。
   */
  getResultBufferForCurrentExecutor(): LocalResultBuffer | undefined {
    return getCurrentExecutorResultBuffer()
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtStartOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()
    const { check_at_start_analyze } = this.checkpoints
    for (const i in check_at_start_analyze) {
      if (this.isCheckOn(check_at_start_analyze[i].getCheckerId())) {
        try {
          check_at_start_analyze[i].triggerAtStartOfAnalyze(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].getCheckerId()}.triggerAtStartOfAnalyze! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].getCheckerId()}.triggerAtStartOfAnalyze! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }
    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   * check at the end of analyzer processing
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtEndOfAnalyze(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()

    const { check_at_end_analyze } = this.checkpoints
    for (const i in check_at_end_analyze) {
      if (this.isCheckOn(check_at_end_analyze[i].getCheckerId())) {
        try {
          check_at_end_analyze[i].triggerAtEndOfAnalyze(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_end_analyze[i].getCheckerId()}.triggerAtEndOfAnalyze! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_end_analyze[i].getCheckerId()}.triggerAtEndOfAnalyze! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }

    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   * check "CompileUnit" statement
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtCompileUnit(analyzer: any, scope: any, node: any, state: any, info: any) {
    let interruptFlag: boolean = false
    const start_time: number = new Date().getTime()
    const { check_at_compile_unit } = this.checkpoints
    for (const i in check_at_compile_unit) {
      if (this.isCheckOn(check_at_compile_unit[i].getCheckerId())) {
        try {
          interruptFlag =
            interruptFlag || check_at_compile_unit[i].triggerAtCompileUnit(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_compile_unit[i].getCheckerId()}.triggerAtCompileUnit! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_compile_unit[i].getCheckerId()}.triggerAtCompileUnit! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }
    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
    return interruptFlag
  }

  /**
   * check at the end of compile unit processing
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtEndOfCompileUnit(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()
    const { check_at_end_compileunit } = this.checkpoints
    for (const i in check_at_end_compileunit) {
      if (this.isCheckOn(check_at_end_compileunit[i].getCheckerId())) {
        try {
          check_at_end_compileunit[i].triggerAtEndOfCompileUnit(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_end_compileunit[i].getCheckerId()}.triggerAtEndOfCompileUnit! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_end_compileunit[i].getCheckerId()}.triggerAtEndOfCompileUnit! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }
    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   * check at binary operation
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtBinaryOperation(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()
    const { check_at_binary_operation } = this.checkpoints
    for (const i in check_at_binary_operation) {
      if (this.isCheckOn(check_at_binary_operation[i].getCheckerId())) {
        try {
          check_at_binary_operation[i].triggerAtBinaryOperation(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_binary_operation[i].getCheckerId()}.checkAtBinaryOperation! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_binary_operation[i].getCheckerId()}.checkAtBinaryOperation! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }
    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtPreDeclaration(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()

    const { check_at_pre_declaration } = this.checkpoints
    for (const i in check_at_pre_declaration) {
      if (this.isCheckOn(check_at_pre_declaration[i].getCheckerId())) {
        try {
          check_at_pre_declaration[i].triggerAtPreDeclaration(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_pre_declaration[i].getCheckerId()}.triggerAtPreDeclaration! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_pre_declaration[i].getCheckerId()}.triggerAtPreDeclaration! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }
    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   * examine the AST node at call sites
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtFuncCallSyntax(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()

    const { check_at_funccall_syntax } = this.checkpoints
    for (const i in check_at_funccall_syntax) {
      if (this.isCheckOn(check_at_funccall_syntax[i].getCheckerId())) {
        try {
          check_at_funccall_syntax[i].triggerAtFuncCallSyntax(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_funccall_syntax[i].getCheckerId()}.triggerAtFuncCallSyntax! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_funccall_syntax[i].getCheckerId()}.triggerAtFuncCallSyntax! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }

    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   * check point at function call
   *
   * @param analyzer
   * @param node
   * @param scope
   * @param state
   * @param info
   */
  checkAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { fclos } = info
    if (!fclos) return
    if (fclos.vtype === 'union' && Array.isArray(fclos.value)) {
      fclos.value.forEach((fClos: any) => {
        info.fclos = fClos
        this.checkAtFunctionCallBefore(analyzer, scope, node, state, info)
      })
      return
    }

    const start_time: number = new Date().getTime()

    this.observeFunctionCallBefore(analyzer, scope, node, state, info)

    const { check_at_function_call_before } = this.checkpoints
    for (const i in check_at_function_call_before) {
      if (this.isCheckOn(check_at_function_call_before[i].getCheckerId())) {
        try {
          check_at_function_call_before[i].triggerAtFunctionCallBefore(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_function_call_before[i].getCheckerId()}.triggerAtFunctionCallBefore! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_function_call_before[i].getCheckerId()}.triggerAtFunctionCallBefore! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }

    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   * check point at function call after
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtFunctionCallAfter(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()

    this.observeFunctionCallAfter(analyzer, scope, node, state, info)

    const { check_at_function_call_after } = this.checkpoints
    for (const i in check_at_function_call_after) {
      if (this.isCheckOn(check_at_function_call_after[i].getCheckerId())) {
        try {
          check_at_function_call_after[i].triggerAtFunctionCallAfter(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_function_call_after[i].getCheckerId()}.triggerAtFunctionCallAfter! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_function_call_after[i].getCheckerId()}.triggerAtFunctionCallAfter! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }

    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtNewExpr(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()

    const check_new_expr = this.checkpoints.check_at_new_expr
    for (const i in check_new_expr) {
      if (this.isCheckOn(check_new_expr[i].getCheckerId())) {
        try {
          check_new_expr[i].triggerAtNewExpr(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_new_expr[i].getCheckerId()}.triggerAtNewExpr! Stack detail has been logged in error log!`,
            `Error occured in:${check_new_expr[i].getCheckerId()}.triggerAtNewExpr! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }

    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   * check at new object build
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtNewObject(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()
    const { check_at_new_object } = this.checkpoints
    for (const i in check_at_new_object) {
      if (this.isCheckOn(check_at_new_object[i].getCheckerId())) {
        try {
          check_at_new_object[i].triggerAtNewObject(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_new_object[i].getCheckerId()}.triggerAtNewObject! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_new_object[i].getCheckerId()}.triggerAtNewObject! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }
    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtNewExprAfter(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()

    this.observeNewExprAfter(analyzer, scope, node, state, info)

    const check_new_expr_after = this.checkpoints.check_at_new_expr_after
    for (const i in check_new_expr_after) {
      if (this.isCheckOn(check_new_expr_after[i].getCheckerId())) {
        try {
          check_new_expr_after[i].triggerAtNewExprAfter(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_new_expr_after[i].getCheckerId()}.triggerAtNewExprAfter! Stack detail has been logged in error log!`,
            `Error occured in:${check_new_expr_after[i].getCheckerId()}.triggerAtNewExprAfter! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }

    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /** 分析生命周期观察点；仅 dataflow 显式模式加载采集逻辑。 */
  observeFunctionCallBefore(analyzer: unknown, scope: unknown, node: unknown, state: unknown, info: unknown): void {
    if (!Config.dataflowDb) return
    loadDataflowCallHooks().onFunctionCallBefore(analyzer, scope, node, state, info)
  }

  /** 分析生命周期观察点；仅 dataflow 显式模式加载采集逻辑。 */
  observeFunctionCallAfter(analyzer: unknown, scope: unknown, node: unknown, state: unknown, info: unknown): void {
    if (!Config.dataflowDb) return
    loadDataflowCallHooks().onFunctionCallAfter(analyzer, scope, node, state, info)
  }

  /** 分析生命周期观察点；仅 dataflow 显式模式加载采集逻辑。 */
  observeNewExprAfter(analyzer: unknown, scope: unknown, node: unknown, state: unknown, info: unknown): void {
    if (!Config.dataflowDb) return
    loadDataflowCallHooks().onNewExprAfter(analyzer, scope, node, state, info)
  }

  /**
   * check "if" statement
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtIfCondition(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()

    const { check_at_ifcondition } = this.checkpoints
    for (const i in check_at_ifcondition) {
      if (this.isCheckOn(check_at_ifcondition[i].getCheckerId())) {
        try {
          check_at_ifcondition[i].triggerAtIfCondition(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_ifcondition[i].getCheckerId()}.triggerAtIfCondition! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_ifcondition[i].getCheckerId()}.triggerAtIfCondition! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }

    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   * check point at assignment expression
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtAssignment(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { lscope, lvalue, rvalue } = info
    if (!lscope || !rvalue) return

    const start_time: number = new Date().getTime()

    const { check_at_assignment } = this.checkpoints
    for (const i in check_at_assignment) {
      if (this.isCheckOn(check_at_assignment[i].getCheckerId())) {
        try {
          check_at_assignment[i].triggerAtAssignment(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_assignment[i].getCheckerId()}.triggerAtAssignment! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_assignment[i].getCheckerId()}.triggerAtAssignment! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }

    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   * check at the end of the block
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtEndOfBlock(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()

    const { check_at_end_block } = this.checkpoints
    for (const i in check_at_end_block) {
      if (this.isCheckOn(check_at_end_block[i].getCheckerId())) {
        try {
          check_at_end_block[i].triggerAtEndOfBlock(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_end_block[i].getCheckerId()}.triggerAtEndOfBlock! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_end_block[i].getCheckerId()}.triggerAtEndOfBlock! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }

    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtIdentifier(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()

    const { check_at_identifier } = this.checkpoints
    for (const i in check_at_identifier) {
      if (this.isCheckOn(check_at_identifier[i].getCheckerId())) {
        try {
          check_at_identifier[i].triggerAtIdentifier(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_identifier[i].getCheckerId()}.triggerAtIdentifier! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_identifier[i].getCheckerId()}.triggerAtIdentifier! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }

    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtMemberAccess(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()

    const { check_at_member_access } = this.checkpoints
    for (const i in check_at_member_access) {
      if (this.isCheckOn(check_at_member_access[i].getCheckerId())) {
        try {
          check_at_member_access[i].triggerAtMemberAccess(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_member_access[i].getCheckerId()}.triggerAtMemberAccess! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_member_access[i].getCheckerId()}.triggerAtMemberAccess! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }

    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   * check at the end of the block
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtFunctionDefinition(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()

    const { check_at_function_definition } = this.checkpoints
    for (const i in check_at_function_definition) {
      if (this.isCheckOn(check_at_function_definition[i].getCheckerId())) {
        try {
          check_at_function_definition[i].triggerAtFunctionDefinition(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_function_definition[i].getCheckerId()}.triggerAtFunctionDefinition! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_function_definition[i].getCheckerId()}.triggerAtFunctionDefinition! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }

    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtSymbolInterpretOfEntryPointBefore(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()

    const { check_at_symbol_execute_of_entrypoint_before } = this.checkpoints
    for (const i in check_at_symbol_execute_of_entrypoint_before) {
      if (this.isCheckOn(check_at_symbol_execute_of_entrypoint_before[i].getCheckerId())) {
        try {
          check_at_symbol_execute_of_entrypoint_before[i].triggerAtSymbolInterpretOfEntryPointBefore(
            analyzer,
            scope,
            node,
            state,
            info
          )
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_symbol_execute_of_entrypoint_before[i].getCheckerId()}.triggerAtSymbolInterpretOfEntryPointBefore! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_symbol_execute_of_entrypoint_before[i].getCheckerId()}.triggerAtSymbolInterpretOfEntryPointBefore! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }

    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtSymbolInterpretOfEntryPointAfter(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()

    const { check_at_symbol_execute_of_entrypoint_after } = this.checkpoints
    for (const i in check_at_symbol_execute_of_entrypoint_after) {
      if (this.isCheckOn(check_at_symbol_execute_of_entrypoint_after[i].getCheckerId())) {
        try {
          check_at_symbol_execute_of_entrypoint_after[i].triggerAtSymbolInterpretOfEntryPointAfter(
            analyzer,
            scope,
            node,
            state,
            info
          )
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_symbol_execute_of_entrypoint_after[i].getCheckerId()}.triggerAtSymbolInterpretOfEntryPointAfter! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_symbol_execute_of_entrypoint_after[i].getCheckerId()}.triggerAtSymbolInterpretOfEntryPointAfter! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }

    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   * @param node
   * @param scope
   * @param state
   * @param analyzer
   * @param info
   */
  checkAtVariableDeclaration(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()

    const { check_at_variable_declaration } = this.checkpoints
    for (const i in check_at_variable_declaration) {
      if (this.isCheckOn(check_at_variable_declaration[i].getCheckerId())) {
        try {
          check_at_variable_declaration[i].triggerAtVariableDeclaration(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_variable_declaration[i].getCheckerId()}.triggerAtVariableDeclaration! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_variable_declaration[i].getCheckerId()}.triggerAtVariableDeclaration! Stack detail has been logged in error log!`
          )
        }
      }
    }

    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   * check at the end of each ast node
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtEndOfNode(analyzer: any, scope: any, node: any, state: any, info: any) {
    const start_time: number = new Date().getTime()

    const { check_at_end_of_node } = this.checkpoints
    for (const i in check_at_end_of_node) {
      if (this.isCheckOn(check_at_end_of_node[i].getCheckerId())) {
        try {
          check_at_end_of_node[i].triggerAtEndOfNode(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_end_of_node[i].getCheckerId()}.triggerAtEndOfNode! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_end_of_node[i].getCheckerId()}.triggerAtEndOfNode! Stack detail has been logged in error log!`
          )
        }
        statistics.numChecks++
      }
    }

    const end_time = new Date().getTime()
    statistics.checkFiringTime += end_time - start_time
  }

  /**
   * where a particular kind of rule is activated
   * @param checkerId
   * @returns {boolean|*}
   */
  isCheckOn(checkerId?: any) {
    // TODO checker开关
    return true
  }

  /**
   *
   * @param CheckerClass
   * @param self
   * @param desc
   * @param resultManager
   */
  doRegister(CheckerClass: any, self: any, resultManager: any, desc: any) {
    const checker = new CheckerClass(resultManager)
    checker.desc = desc
    const checkerId = checker.getCheckerId()
    if (!checkerId) {
      logger.warn(`Checker-- ${checker.constructor.name} does not set checkerId. Ignore!!`)
      return
    }
    const checkerName = checker.getCheckerId()

    if (self.registered_checkers.hasOwnProperty(checkerName)) {
      logger.warn(`${checkerName} is already registered, new one will override the previous`)
    }
    // logger.info(checkerName);
    self.registered_checkers[checkerName] = checker

    if (CheckerClass.prototype.triggerAtStartOfAnalyze) {
      self.checkpoints.check_at_start_analyze.push(checker)
    }

    if (CheckerClass.prototype.triggerAtEndOfAnalyze) {
      self.checkpoints.check_at_end_analyze.push(checker)
    }

    if (CheckerClass.prototype.triggerAtCompileUnit) {
      self.checkpoints.check_at_compile_unit.push(checker)
    }

    if (CheckerClass.prototype.triggerAtEndOfCompileUnit) {
      self.checkpoints.check_at_end_compileunit.push(checker)
    }

    if (CheckerClass.prototype.triggerAtPreDeclaration) {
      self.checkpoints.check_at_pre_declaration.push(checker)
    }

    if (CheckerClass.prototype.triggerAtIfCondition) {
      self.checkpoints.check_at_ifcondition.push(checker)
    }

    if (CheckerClass.prototype.triggerAtFuncCallSyntax) {
      self.checkpoints.check_at_funccall_syntax.push(checker)
    }

    if (CheckerClass.prototype.triggerAtFunctionCallBefore) {
      self.checkpoints.check_at_function_call_before.push(checker)
    }

    if (CheckerClass.prototype.triggerAtFunctionCallAfter) {
      self.checkpoints.check_at_function_call_after.push(checker)
    }

    if (CheckerClass.prototype.triggerAtVariableDeclaration) {
      self.checkpoints.check_at_variable_declaration.push(checker)
    }

    if (CheckerClass.prototype.triggerAtFunctionDefinition) {
      self.checkpoints.check_at_function_definition.push(checker)
    }

    if (CheckerClass.prototype.triggerAtEndOfBlock) {
      self.checkpoints.check_at_end_block.push(checker)
    }

    if (CheckerClass.prototype.triggerAtAssignment) {
      self.checkpoints.check_at_assignment.push(checker)
    }

    if (CheckerClass.prototype.triggerAtBinaryOperation) {
      self.checkpoints.check_at_binary_operation.push(checker)
    }

    if (CheckerClass.prototype.triggerAtNewExpr) {
      self.checkpoints.check_at_new_expr.push(checker)
    }

    if (CheckerClass.prototype.triggerAtNewExprAfter) {
      self.checkpoints.check_at_new_expr_after.push(checker)
    }

    if (CheckerClass.prototype.triggerAtNewObject) {
      self.checkpoints.check_at_new_object.push(checker)
    }

    if (CheckerClass.prototype.triggerAtIdentifier) {
      self.checkpoints.check_at_identifier.push(checker)
    }

    if (CheckerClass.prototype.triggerAtMemberAccess) {
      self.checkpoints.check_at_member_access.push(checker)
    }

    if (CheckerClass.prototype.triggerAtSymbolInterpretOfEntryPointBefore) {
      self.checkpoints.check_at_symbol_execute_of_entrypoint_before.push(checker)
    }

    if (CheckerClass.prototype.triggerAtSymbolInterpretOfEntryPointAfter) {
      self.checkpoints.check_at_symbol_execute_of_entrypoint_after.push(checker)
    }

    if (CheckerClass.prototype.triggerAtEndOfNode) {
      self.checkpoints.check_at_end_of_node.push(checker)
    }

    //  add all checkpoints

    return checkerName
  }

  /**
   * Register all the checkers within the "filename" directory
   * @param self
   * @param filename
   * @param desc
   * @param resultManager
   */
  registerAllCheckers(self: any, filename: any, desc: any, resultManager: any) {
    let fileStat
    try {
      fileStat = fs.lstatSync(filename)
    } catch (e) {
      handleException(
        e,
        'Error occurred in CheckerManager.registerAllCheckers!!',
        'Error occurred in CheckerManager.registerAllCheckers!!'
      )
    }

    if (!fileStat) return

    const CheckerClass = require(filename)
    const checker = this.doRegister(CheckerClass, self, resultManager, desc)
    if ((filename.endsWith('.js') || filename.endsWith('.ts')) && checker) {
      return [checker]
    }
  }

  /**
   * load checker config
   */
  loadCheckerConfigAsMap() {
    const result = new Map()
    const checkerConfigPath = getAbsolutePath('resource/checker/checker-config.json')
    const checkerConfigArray = loadJSONfile(checkerConfigPath)
    if (Array.isArray(checkerConfigArray)) {
      for (const checkerConfig of checkerConfigArray) {
        if (checkerConfig.checkerId) {
          result.set(checkerConfig.checkerId, checkerConfig)
        }
      }
    }
    return result
  }

  /**
   * load checker pack config as map
   */
  loadCheckerPackConfigAsMap() {
    const result = new Map()
    const checkerPackConfigPath = getAbsolutePath('resource/checker/checker-pack-config.json')
    const checkerPackConfigArray = loadJSONfile(checkerPackConfigPath)
    if (Array.isArray(checkerPackConfigArray)) {
      for (const checkerPackConfig of checkerPackConfigArray) {
        if (checkerPackConfig.checkerPackId) {
          result.set(checkerPackConfig.checkerPackId, checkerPackConfig)
        }
      }
    }
    return result
  }
}

CheckerManager.resolveCheckerPath = resolveCheckerPath
CheckerManager.resolveProjectRootFromMainFile = resolveProjectRootFromMainFile

module.exports = CheckerManager
