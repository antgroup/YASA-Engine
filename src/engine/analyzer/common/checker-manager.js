const fs = require('fs')
const logger = require('../../../util/logger')(__filename)
const stat = require('../../../util/statistics')
const kit = require('../../../checker/common/checker-kit')
const ResultManager = require('./result-manager')
const { getAbsolutePath, loadJSONfile } = require('../../../util/file-util')
const { handleException } = require('./exception-handler')

/**
 * Security checking rules
 */
class CheckerManager {
  /**
   *
   * @param _options
   * @param checkerIds
   * @param checkerPackIds
   * @param printers
   * @param Rules
   * @param resultManager
   */
  constructor(_options, checkerIds, checkerPackIds, printers, Rules, resultManager) {
    // super()
    this.options = _options
    this.checkerIds = checkerIds
    this.checkerPackIds = checkerPackIds
    this.sec_stat = {} // for security statistics
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
    logger.info('===================== Register rules ======================')
    try {
      this.kit = kit
      this.resultManager = resultManager || new ResultManager()

      const targetCheckerIds = []
      const targetCheckerPaths = []
      const loadCheckerNames = []
      const checkerConfigMap = this.loadCheckerConfigAsMap()
      if (this.checkerIds) {
        for (const checkerId of this.checkerIds) {
          if (checkerConfigMap.has(checkerId) && !targetCheckerIds.includes(checkerId)) {
            targetCheckerIds.push(checkerId)
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
                targetCheckerPaths.push(checkerConfigMap.get(checkerId).checkerPath)
              }
            }
          }
        }
      }
      for (let targetCheckerPath of targetCheckerPaths) {
        targetCheckerPath = getAbsolutePath(targetCheckerPath)
        const checkerNames = this.registerAllCheckers(this, targetCheckerPath, this.resultManager)
        if (checkerNames) {
          if (Array.isArray(checkerNames)) {
            loadCheckerNames.push(...checkerNames)
          } else {
            loadCheckerNames.push(checkerNames)
          }
        }
      }
      logger.info('load checkers:', loadCheckerNames)
    } catch (e) {
      handleException(e, 'Error occurred in CheckerManager_ctor', 'Error occurred in CheckerManager_ctor')
    }

    logger.info('===========================================================\n')
  }

  /**
   *
   */
  getResultManager() {
    return this.resultManager
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtStartOfAnalyze(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()
    const { check_at_start_analyze } = this.checkpoints
    for (const i in check_at_start_analyze) {
      if (this.isCheckOn(check_at_start_analyze[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_at_start_analyze[i].triggerAtStartOfAnalyze(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtStartOfAnalyze! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtStartOfAnalyze! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }
    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
  }

  /**
   * check at the end of analyzer processing
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtEndOfAnalyze(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()

    const { check_at_end_analyze } = this.checkpoints
    for (const i in check_at_end_analyze) {
      if (this.isCheckOn(check_at_end_analyze[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_at_end_analyze[i].triggerAtEndOfAnalyze(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtEndOfAnalyze! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtEndOfAnalyze! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }

    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
  }

  /**
   * check "CompileUnit" statement
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtCompileUnit(analyzer, scope, node, state, info) {
    let interruptFlag = false
    const start_time = new Date().getTime()
    const { check_at_compile_unit } = this.checkpoints
    for (const i in check_at_compile_unit) {
      if (this.isCheckOn(check_at_compile_unit[i].__proto__.constructor.GetCheckerId())) {
        try {
          interruptFlag |= check_at_compile_unit[i].triggerAtCompileUnit(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtCompileUnit! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtCompileUnit! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }
    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
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
  checkAtEndOfCompileUnit(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()
    const { check_at_end_compileunit } = this.checkpoints
    for (const i in check_at_end_compileunit) {
      if (this.isCheckOn(check_at_end_compileunit[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_at_end_compileunit[i].triggerAtEndOfCompileUnit(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtEndOfCompileUnit! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtEndOfCompileUnit! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }
    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
  }

  /**
   * check at binary operation
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtBinaryOperation(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()
    const { check_at_binary_operation } = this.checkpoints
    for (const i in check_at_binary_operation) {
      if (this.isCheckOn(check_at_binary_operation[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_at_binary_operation[i].triggerAtBinaryOperation(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.checkAtBinaryOperation! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.checkAtBinaryOperation! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }
    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtPreDeclaration(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()

    const { check_at_pre_declaration } = this.checkpoints
    for (const i in check_at_pre_declaration) {
      if (this.isCheckOn(check_at_pre_declaration[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_at_pre_declaration[i].triggerAtPreDeclaration(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtPreDeclaration! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtPreDeclaration! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }
    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
  }

  /**
   * examine the AST node at call sites
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtFuncCallSyntax(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()

    const { check_at_funccall_syntax } = this.checkpoints
    for (const i in check_at_funccall_syntax) {
      if (this.isCheckOn(check_at_funccall_syntax[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_at_funccall_syntax[i].triggerAtFuncCallSyntax(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtFuncCallSyntax! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtFuncCallSyntax! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }

    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
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
  checkAtFunctionCallBefore(analyzer, scope, node, state, info) {
    const { fclos } = info
    if (!fclos) return
    if (fclos.vtype === 'union' && Array.isArray(fclos.value)) {
      fclos.value.forEach((fClos) => {
        info.fclos = fClos
        this.checkAtFunctionCallBefore(analyzer, scope, node, state, info)
      })
      return
    }

    const start_time = new Date().getTime()

    const { check_at_function_call_before } = this.checkpoints
    for (const i in check_at_function_call_before) {
      if (this.isCheckOn(check_at_function_call_before[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_at_function_call_before[i].triggerAtFunctionCallBefore(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtFunctionCallBefore! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtFunctionCallBefore! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }

    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
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
  checkAtFunctionCallAfter(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()

    const { check_at_function_call_after } = this.checkpoints
    for (const i in check_at_function_call_after) {
      if (this.isCheckOn(check_at_function_call_after[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_at_function_call_after[i].triggerAtFunctionCallAfter(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtFunctionCallAfter! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtFunctionCallAfter! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }

    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtNewExpr(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()

    const check_new_expr = this.checkpoints.check_at_new_expr
    for (const i in check_new_expr) {
      if (this.isCheckOn(check_new_expr[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_new_expr[i].triggerAtNewExpr(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtNewExpr! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtNewExpr! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }

    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
  }

  /**
   * check at new object build
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtNewObject(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()
    const { check_at_new_object } = this.checkpoints
    for (const i in check_at_new_object) {
      if (this.isCheckOn(check_at_new_object[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_at_new_object[i].triggerAtNewObject(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtNewObject! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtNewObject! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }
    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtNewExprAfter(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()

    const check_new_expr_after = this.checkpoints.check_at_new_expr_after
    for (const i in check_new_expr_after) {
      if (this.isCheckOn(check_new_expr_after[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_new_expr_after[i].triggerAtNewExprAfter(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtNewExprAfter! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtNewExprAfter! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }

    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
  }

  /**
   * check "if" statement
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtIfCondition(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()

    const { check_at_ifcondition } = this.checkpoints
    for (const i in check_at_ifcondition) {
      if (this.isCheckOn(check_at_ifcondition[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_at_ifcondition[i].triggerAtIfCondition(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtIfCondition! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtIfCondition! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }

    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
  }

  /**
   * check point at assignment expression
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtAssignment(analyzer, scope, node, state, info) {
    const { lscope, lvalue, rvalue } = info
    if (!lscope || !rvalue) return

    const start_time = new Date().getTime()

    const { check_at_assignment } = this.checkpoints
    for (const i in check_at_assignment) {
      if (this.isCheckOn(check_at_assignment[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_at_assignment[i].triggerAtAssignment(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtAssignment! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtAssignment! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }

    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
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
  checkAtEndOfBlock(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()

    const { check_at_end_block } = this.checkpoints
    for (const i in check_at_end_block) {
      if (this.isCheckOn(check_at_end_block[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_at_end_block[i].triggerAtEndOfBlock(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtEndOfBlock! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtEndOfBlock! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }

    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtIdentifier(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()

    const { check_at_identifier } = this.checkpoints
    for (const i in check_at_identifier) {
      if (this.isCheckOn(check_at_identifier[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_at_identifier[i].triggerAtIdentifier(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtIdentifier! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtIdentifier! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }

    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtMemberAccess(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()

    const { check_at_member_access } = this.checkpoints
    for (const i in check_at_member_access) {
      if (this.isCheckOn(check_at_member_access[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_at_member_access[i].triggerAtMemberAccess(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtMemberAccess! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtMemberAccess! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }

    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
  }

  /**
   * check at the end of the block
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtFunctionDefinition(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()

    const { check_at_function_definition } = this.checkpoints
    for (const i in check_at_function_definition) {
      if (this.isCheckOn(check_at_function_definition[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_at_function_definition[i].triggerAtFunctionDefinition(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtFunctionDefinition! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtFunctionDefinition! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }

    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtSymbolInterpretOfEntryPointBefore(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()

    const { check_at_symbol_execute_of_entrypoint_before } = this.checkpoints
    for (const i in check_at_symbol_execute_of_entrypoint_before) {
      if (this.isCheckOn(check_at_symbol_execute_of_entrypoint_before[i].__proto__.constructor.GetCheckerId())) {
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
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtSymbolInterpretOfEntryPointBefore! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtSymbolInterpretOfEntryPointBefore! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }

    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtSymbolInterpretOfEntryPointAfter(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()

    const { check_at_symbol_execute_of_entrypoint_after } = this.checkpoints
    for (const i in check_at_symbol_execute_of_entrypoint_after) {
      if (this.isCheckOn(check_at_symbol_execute_of_entrypoint_after[i].__proto__.constructor.GetCheckerId())) {
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
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtSymbolInterpretOfEntryPointAfter! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtSymbolInterpretOfEntryPointAfter! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }

    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
  }

  /**
   * @param node
   * @param scope
   * @param state
   * @param analyzer
   * @param info
   */
  checkAtVariableDeclaration(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()

    const { check_at_variable_declaration } = this.checkpoints
    for (const i in check_at_variable_declaration) {
      if (this.isCheckOn(check_at_variable_declaration[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_at_variable_declaration[i].triggerAtVariableDeclaration(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtVariableDeclaration! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtVariableDeclaration! Stack detail has been logged in error log!`
          )
        }
      }
    }

    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
  }

  /**
   * check at the end of each ast node
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  checkAtEndOfNode(analyzer, scope, node, state, info) {
    const start_time = new Date().getTime()

    const { check_at_end_of_node } = this.checkpoints
    for (const i in check_at_end_of_node) {
      if (this.isCheckOn(check_at_end_of_node[i].__proto__.constructor.GetCheckerId())) {
        try {
          check_at_end_of_node[i].triggerAtEndOfNode(analyzer, scope, node, state, info)
        } catch (e) {
          handleException(
            e,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtEndOfNode! Stack detail has been logged in error log!`,
            `Error occured in:${check_at_start_analyze[i].__proto__.constructor.GetCheckerId()}.triggerAtEndOfNode! Stack detail has been logged in error log!`
          )
        }
        stat.numChecks++
      }
    }

    const end_time = new Date().getTime()
    stat.checkFiringTime += end_time - start_time
  }

  /**
   * where a particular kind of rule is activated
   * @returns {boolean|*}
   */
  isCheckOn() {
    // TODO checker开关
    return true
  }

  /**
   *
   * @param CheckerClass
   * @param self
   * @param resultManager
   */
  doRegister(CheckerClass, self, resultManager) {
    const getCheckerId = CheckerClass.GetCheckerId
    const checkerId = getCheckerId ? getCheckerId() : undefined
    if (!checkerId) {
      return
    }

    const checker = new CheckerClass(resultManager)
    const checkername = CheckerClass.GetCheckerId()

    if (self.registered_checkers.hasOwnProperty(checkername)) {
      logger.warn(`${checkername} is already registered, new one will override the previous`)
    }
    // logger.info(checkername);
    self.registered_checkers[checkername] = checker

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

    return checkername
  }

  /**
   * Register all the checkers within the "filename" directory
   * @param self
   * @param filename
   * @param resultManager
   */
  registerAllCheckers(self, filename, resultManager) {
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
    const checker = this.doRegister(CheckerClass, self, resultManager)
    if (!filename.endsWith('.js') || !checker) return
    return [checker]
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

module.exports = CheckerManager
