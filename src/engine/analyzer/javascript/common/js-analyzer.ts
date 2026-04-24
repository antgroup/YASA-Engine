import { INTERNAL_CALL } from '../../common/call-args'
const path = require('path')
const fs = require('fs-extra')
const globby = require('fast-glob')
const _ = require('lodash')
const UastSpec = require('@ant-yasa/uast-spec')
const logger = require('../../../../util/logger')(__filename)
const FileUtil = require('../../../../util/file-util')
const Statistics = require('../../../../util/statistics')
const { ErrorCode, Errors } = require('../../../../util/error-code')
const Parser = require('../../../parser/parser')
const Initializer = require('./js-initializer')
const BasicRuleHandler = require('../../../../checker/common/rules-basic-handler')
const { AstUtil } = require('../../../../checker/common/checker-kit')
const EntryPointConfig = require('../../common/current-entrypoint')
const { processBinaryOperator } = require('./builtins/operator-builtins')
const ScopeClass = require('../../common/scope')
const Analyzer: typeof import('../../common/analyzer').Analyzer = require('../../common/analyzer')
const Unit: typeof import('../../common/value/unit') = require('../../common/value/unit')
import type { Scope, State, Value, SymbolValue as SymbolValueType, VoidValue as VoidValueType, SpreadValue, BinaryExprValue, UnaryExprValue } from '../../../../types/analyzer'
import type {
  CallExpression,
  TryStatement,
  AssignmentExpression,
  MemberAccess,
  UnaryExpression,
  BinaryExpression,
  ConditionalExpression,
  VariableDeclaration,
  SpreadElement,
  ObjectExpression,
  ForStatement,
  ReturnStatement,
} from '../../../../types/uast'
const CheckerManager = require('../../common/checker-manager')

const {
  valueUtil: {
    ValueUtil: { FunctionValue, ObjectValue, Scoped, PrimitiveValue, UndefinedValue, VoidValue },
  },
} = require('../../common')
const { handleException } = require('../../common/exception-handler')
const constValue = require('../../../../util/constant')
const config = require('../../../../config')

/**
 *
 */
class JsAnalyzer extends Analyzer {
  /**
   *
   * @param options
   */
  constructor(options: any) {
    const checkerManager = new CheckerManager(
      options,
      options.checkerIds,
      options.checkerPackIds,
      options.printers,
      BasicRuleHandler
    )
    super(checkerManager, options)

    this.options = options
    this.sourceScope = {
      complete: false,
      value: [],
    }
  }

  /**
   * 单文件预处理：解析并处理单个文件
   *
   * @param source - 源代码内容
   * @param fileName - 文件名
   */
  preProcess4SingleFile(source: any, fileName: any) {
    this.initTopScope()
    this.state = this.initState(this.topScope)

    // 记录 parseCode 时间：解析源代码为 AST
    this.performanceTracker.start('preProcess.parseCode')
    const { options } = this
    options.sourcefile = fileName
    // 先填充 sourceCodeCache，parser 会优先使用
    this.sourceCodeCache.set(fileName, source.split(/\n/))
    this.uast = Parser.parseSingleFile(fileName, options, this.sourceCodeCache)
    this.performanceTracker.end('preProcess.parseCode')

    if (this.uast) {
      this.initModuleScope(this.uast, fileName)

      // 注意：直接调用 processModule 处理已解析的 AST，避免调用 processModuleSrc 导致重复解析

      // 直接处理已解析的 AST，避免重复解析
      this.performanceTracker.start('preProcess.processModule')
      this.processModule(this.uast, fileName)
      this.performanceTracker.end('preProcess.processModule')
    }
  }

  /**
   * 加载缓存后的初始化阶段，会创建一些全局builtin
   */
  initAfterUsingCache() {
    // init global scope
    Initializer.initGlobalScope(this.topScope)
  }

  /**
   * 预处理阶段：扫描模块并解析代码
   *
   * @param dir - 项目目录
   */
  async preProcess(dir: any) {
    Initializer.initGlobalScope(this.topScope)

    // just scan and execute every module
    await this.scanModules(dir)
  }

  /**
   *
   */
  symbolInterpret() {
    const { entryPoints } = this
    const state = this.initState(this.topScope)
    if (_.isEmpty(entryPoints)) {
      logger.info('[symbolInterpret]：EntryPoints are not found')
      return true
    }
    const hasAnalysised: any[] = []
    // 自定义source入口方式，并根据入口自主加载source
    for (const entryPoint of entryPoints) {
      this.symbolTable.clear()
      if (entryPoint.type === constValue.ENGIN_START_FUNCALL) {
        if (
          hasAnalysised.includes(
            `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?.qid}#${entryPoint.entryPointSymVal.ast.node.parameters}.${entryPoint.attribute}`
          )
        ) {
          continue
        }
        hasAnalysised.push(
          `${entryPoint.filePath}.${entryPoint.functionName}/${entryPoint?.entryPointSymVal?.qid}#${entryPoint.entryPointSymVal.ast.node.parameters}.${entryPoint.attribute}`
        )
        EntryPointConfig.setCurrentEntryPoint(entryPoint)
        logger.info(
          'EntryPoint [%s.%s] is executing',
          entryPoint.filePath?.substring(0, entryPoint.filePath?.lastIndexOf('.')),
          entryPoint.functionName ||
            `<anonymousFunc_${entryPoint.entryPointSymVal?.ast?.node?.loc.start?.line}_$${
              entryPoint.entryPointSymVal?.ast?.node?.loc.end?.line
            }>`
        )

        this.checkerManager.checkAtSymbolInterpretOfEntryPointBefore(this, null, null, null, null)

        const argValues: any[] = []
        for (const key in entryPoint.entryPointSymVal?.ast?.node?.parameters) {
          argValues.push(
            this.processInstruction(
              entryPoint.entryPointSymVal,
              entryPoint.entryPointSymVal?.ast?.node?.parameters[key]?.id,
              state
            )
          )
        }

        try {
          this.executeCall(
            entryPoint.entryPointSymVal?.ast?.node,
            entryPoint.entryPointSymVal,
            state,
            entryPoint.scopeVal,
            { callArgs: this.buildCallArgs(entryPoint.entryPointSymVal?.ast?.node, argValues, entryPoint.entryPointSymVal) }
          )
        } catch (e) {
          handleException(
            e,
            `[${entryPoint.entryPointSymVal?.ast?.node?.id?.name} symbolInterpret failed. Exception message saved in error log file`,
            `[${entryPoint.entryPointSymVal?.ast?.node?.id?.name} symbolInterpret failed. Exception message saved in error log file`
          )
        }
        this.checkerManager.checkAtSymbolInterpretOfEntryPointAfter(this, null, null, null, null)
      } else if (entryPoint.type === constValue.ENGIN_START_FILE_BEGIN) {
        if (hasAnalysised.includes(`fileBegin:${entryPoint.filePath}.${entryPoint.attribute}`)) {
          continue
        }
        hasAnalysised.push(`fileBegin:${entryPoint.filePath}.${entryPoint.attribute}`)
        EntryPointConfig.setCurrentEntryPoint(entryPoint)
        logger.info('EntryPoint [%s] is executing ', entryPoint.filePath)
        if (entryPoint.entryPointSymVal && entryPoint.scopeVal) {
          try {
            this.processCompileUnit(
              entryPoint.scopeVal,
              entryPoint.entryPointSymVal?.ast?.node,
              this.initState(this.topScope)
            )
          } catch (e) {
            handleException(
              e,
              `[${entryPoint.entryPointSymVal?.ast?.node?.loc?.sourcefile} symbolInterpret failed. Exception message saved in error log file`,
              `[${entryPoint.entryPointSymVal?.ast?.node?.loc?.sourcefile} symbolInterpret failed. Exception message saved in error log file`
            )
          }
        } else {
          const { filePath } = entryPoint
          entryPoint.entryPointSymVal = this.symbolTable.get(this.fileManager[filePath])
          entryPoint.scopeVal = this.symbolTable.get(this.fileManager[filePath])
          try {
            this.processCompileUnit(
              entryPoint.scopeVal,
              entryPoint.entryPointSymVal?.ast?.node,
              this.initState(this.topScope)
            )
          } catch (e) {
            handleException(
              e,
              `[${entryPoint.entryPointSymVal?.ast?.node?.loc?.sourcefile} symbolInterpret failed. Exception message saved in error log file`,
              `[${entryPoint.entryPointSymVal?.ast?.node?.loc?.sourcefile} symbolInterpret failed. Exception message saved in error log file`
            )
          }
        }
      }
    }
    return true
  }

  /**
   * 扫描模块：使用统一的 parseProject 接口，支持增量并行解析
   * @param dir - 项目目录
   */
  async scanModules(dir: any) {
    const PARSE_CODE_STAGE = 'preProcess.parseCode'
    const PROCESS_MODULE_STAGE = 'preProcess.processModule'

    // 开始解析阶段：使用统一的 parseProject 接口，支持增量并行
    this.performanceTracker.start(PARSE_CODE_STAGE)
    const astMap = await Parser.parseProject(dir, this.options, this.sourceCodeCache)
    this.performanceTracker.end(PARSE_CODE_STAGE)

    // 防御性检查：确保 astMap 不为 null 或 undefined
    if (!astMap) {
      handleException(
        null,
        'JsAnalyzer.scanModules: parseProject returned null or undefined',
        'JsAnalyzer.scanModules: parseProject returned null or undefined'
      )
      return
    }

    // 检查是否有文件被解析
    const fileCount = Object.keys(astMap).length
    if (fileCount === 0) {
      handleException(
        null,
        'find no target compileUnit of the project : no js/ts file found in source path',
        'find no target compileUnit of the project : no js/ts file found in source path'
      )
      process.exit(0)
    }

    // 开始 ProcessModule 阶段：处理所有模块（分析 AST）
    this.performanceTracker.start(PROCESS_MODULE_STAGE)
    for (const filename in astMap) {
      const ast = astMap[filename]
      if (ast) {
        // sourceCodeCache 已在 parseProject 中自动填充，不需要重新读取
        this.processModule(ast, filename)
      }
    }
    this.performanceTracker.end(PROCESS_MODULE_STAGE)
  }

  /**
   * 处理模块源代码：解析并处理单个模块
   *
   * @param source - 源代码内容
   * @param filename - 文件名
   * @returns 处理结果
   */
  processModuleSrc(source: any, filename: any) {
    const { options } = this
    options.sourcefile = filename

    // 先填充 sourceCodeCache，parser 会优先使用
    this.performanceTracker.record('preProcess.parseCode')?.start()
    const ast = Parser.parseSingleFile(filename, options, this.sourceCodeCache)
    this.performanceTracker.record('preProcess.parseCode')?.end()

    this.sourceCodeCache.set(filename, source.split(/\n/))
    if (ast) {
      // 记录 processModule 时间：处理模块（分析 AST）
      this.performanceTracker.record('preProcess.processModule')?.start()
      const result = this.processModule(ast, filename)
      this.performanceTracker.record('preProcess.processModule')?.end()

      return result
    }
  }

  /**
   * process module with cache
   * @param ast
   * @param filename
   * @returns {*}
   */
  processModule(ast: any, filename: any) {
    if (!ast) {
      process.exitCode = ErrorCode.fail_to_parse
      const sourceFile = filename
      Statistics.fileIssues[sourceFile] = 'Parsing Error'
      handleException(
        null,
        `Error occurred in JsAnalyzer.processModule: ${sourceFile} parse error`,
        `Error occurred in JsAnalyzer.processModule: ${sourceFile} parse error`
      )
      return
    }
    let m = this.topScope.context.modules.members.get(filename)
    if (m && typeof m === 'object') return m

    // set this.importedModules before processModuleDirect for handling cyclic dependencies properly
    // module scope init
    // value specifies what module exports, closure specifies module closure
    const modClos = this.initModuleScope(ast, filename)
    this.topScope.context.modules.members.set(filename, modClos.getFieldValue('module.exports'))
    m = this.processModuleDirect(ast, filename, modClos)
    if (m && typeof m !== 'undefined' && typeof m === 'object') {
      m.ast = ast
      this.topScope.context.modules.members.set(filename, m)
      this.fileManager[filename] = m.uuid
    }
    return m
  }

  /**
   * builtin variables and constant for module
   * @param node
   * @param file
   * @returns Unit
   */
  override initModuleScope(node: any, file: any) {
    // init for module
    // const modScope = {id:file, vtype: 'modScope', value:{}, closure:{}, decls:node, parent : this.topScope, fdef:node};
    if (!file) return
    const prefix = file.substring(config.maindirPrefix?.length)
    const lastDotIndex = prefix.lastIndexOf('.')
    const result = lastDotIndex >= 0 ? prefix.substring(0, lastDotIndex) : prefix
    const modClos = new Scoped('<global>', {
      sid: result,
      parent: this.topScope,
      decls: {},
      ast: node,
    })
    modClos.ast.fdef = node
    ;(modClos as any)._this = modClos

    const mod = new ObjectValue(modClos.qid, { sid: 'module', parent: modClos })
    modClos.value.module = mod
    const exp = new ObjectValue(modClos.qid, { sid: 'module.exports', parent: modClos })
    mod.value.exports = exp
    modClos.value.exports = exp
    return modClos
  }

  // explore individual module
  /**
   *
   * @param node
   * @param filename
   * @param modClos
   */
  processModuleDirect(node: any, filename: any, modClos: any) {
    if (!node || node.type !== 'CompileUnit') {
      handleException(
        null,
        `node type should be CompileUnit, but ${node.type}`,
        `node type should be CompileUnit, but ${node.type}`
      )
      return undefined
    }
    // module scope init
    // value specifies what module exports, closure specifies module closure
    modClos = modClos || this.initModuleScope(node, filename)

    this.entry_fclos = modClos
    this.thisFClos = modClos

    const state = this.initState(modClos)
    this.processInstruction(modClos, node, state) // process compile unit

    // post handle module for module export
    const moduleExports = modClos.getFieldValue('module.exports')

    // 处理export是function类型的场景
    const moduleDefault = moduleExports?.members?.get('default')
    if (moduleDefault?.vtype === 'fclos') {
      this.executeCall(moduleDefault.ast?.node, moduleDefault, state, modClos, INTERNAL_CALL)
      for (const key of this.entry_fclos.members.keys()) {
        moduleExports.members.set(key, this.entry_fclos.members.get(key))
      }
    }
    if (this.checkerManager && this.checkerManager.checkAtEndOfCompileUnit) {
      this.checkerManager.checkAtEndOfCompileUnit(this, null, null, state, null)
    }
    // 获取file中export出来的部分
    return moduleExports
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processCallExpression(scope: Scope, node: CallExpression, state: State): SymbolValueType {
    let res
    try {
      res = super.processCallExpression(scope, node, state)
      return res
    } catch (e) {
      // const errorMsg = `YASA Simulation Execution Error in processCallExpression.Loc is ${node.loc.sourcefile} line:${node.loc.start?.line}`
      // handleException(e, errorMsg)
      return new UndefinedValue()
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   * @returns {UndefinedValue}
   */
  override processTryStatement(scope: Scope, node: TryStatement, state: State): VoidValueType {
    // 往state中创建throwstack
    state.throwstack = state.throwstack ?? []
    // 处理try的body
    this.processInstruction(scope, node.body, state)
    // 抛出了异常，且catch不为空 处理catch
    // try嵌套时 state.throwstack可能被提前删除，因此需要用可选链操作符？
    if (node.handlers && node.handlers.length > 0) {
      // nodejs 一个try只有一个catch 因此只取第一个
      const handler = node.handlers[0]
      if (handler) {
        const subScope = ScopeClass.createSubScope(
          `<catchBlock_${node.loc?.start?.line}_${node.loc?.start?.column}_${node.loc?.end?.line}_${node.loc?.end?.column}>`,
          scope
        )
        // 如果有异常则初始化异常的init
        if (state?.throwstack?.length > 0) {
          const throw_value = state.throwstack[0]
          for (const param of handler.parameter) {
            if (param && param.type === 'VariableDeclaration' && param.init === null) {
              param._meta.isCatchParam = true
              // 尽管throwvalue在state中
              // 但还是要设置init,如果init为空会优先进入默认的初始化逻辑
              // 则无法从state.throwstack取值
              param.init = {
                type: 'Identifier',
                // 此处替换成 最近一个throw的值即可
                name: throw_value.sid,
                callee: param.varType.id,
                arguments: [],
                _meta: param._meta,
                loc: param.loc,
                parent: param.parent,
              } as any
            }
          }
        }
        // 先处理catch的参数 为e赋值
        handler.parameter.forEach((param: any) => this.processInstruction(subScope, param, state))
        // 赋值后的e再处理body
        this.processInstruction(subScope, handler.body, state)
      }
    }
    // 最后处理finally
    if (node.finalizer) this.processInstruction(scope, node.finalizer, state)
    // 当throwstack为空时删除throwstack
    // try嵌套时 state.throwstack可能被提前删除，因此需要用可选链操作符？
    if (state?.throwstack?.length === 0) {
      delete state.throwstack
    }
    return new VoidValue()
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processAssignmentExpression(scope: Scope, node: AssignmentExpression, state: State): SymbolValueType {
    let res
    try {
      res = super.processAssignmentExpression(scope, node, state)
    } catch (e) {
      return new UndefinedValue()
    }

    // 如果是解构赋值，且处理最后的rest的赋值，需要对rest的下标进行重整
    // [r1,r2,...rest] = [1,2,3,4]
    // rest <=> [3,4] rest[0]=3 rest[1]=4
    if ((res as any)?.ast?.node?._meta?.isArray) {
      const rawRestIndexs = [...res.members.keys()]
        .map((keyStr) => parseInt(keyStr))
        .filter((keyNum) => Number.isInteger(keyNum))
        .sort()
      // 找到第一个vtype不是undefine的下标
      const offset = rawRestIndexs.findIndex((index) => res.members.get(index.toString())?.vtype !== 'undefine')
      if (offset > 0) {
        // 将数组划分为2部分 第一部分全是undefined数据，第二部分为有效数据
        // 将第二部分数据往左平移，并删除多余索引
        // arr = [undefinevalue,undefinevalue,objectvalue,objectvalue,objectvalue]
        // 平移以后 arr=[objectvalue,objectvalue,objectvalue]
        for (let i = 0; i < rawRestIndexs.length; i++) {
          if (i < rawRestIndexs.length - offset) {
            const shifted = res.members.get((offset + i).toString())
            if (shifted) res.members.set(i.toString(), shifted)
          } else {
            res.members.delete(i.toString())
          }
        }
        this.saveVarInScope(scope, node.left, res, state)
      }
    }
    // Assignment brings trace back，sometimes in obj (if ObjExpression)
    if (res && res?.taint?.isTaintedRec && node?.operator !== '=' && !res?.taint.hasTraces()) {
      // this.processAssignmentToBinary(res)
      ;(res as any).taint.clearTrace()
    }
    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processMemberAccess(scope: Scope, node: MemberAccess, state: State): SymbolValueType {
    let res
    try {
      res = super.processMemberAccess(scope, node, state)
    } catch (e) {
      return new UndefinedValue()
    }
    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processUnaryExpression(scope: Scope, node: UnaryExpression, state: State): UnaryExprValue {
    const nodeValue = super.processUnaryExpression(scope, node, state)
    if (node.operator === 'delete') {
      // 根据 delete 的 arguments 获取对应 scope 的 field 存储的值
      // 传入 node.argument.object 获取 field 中对应的值，才能通过 target?.field[property.name] 访问目标 property
      // delete 只能作用在变量的属性上，不能直接作用在变量上
      const argAny = node.argument as any
      const target = this.getDeleteTargetInScopeField(scope, argAny?.object ?? node.argument)
      if (target != null) {
        const index = argAny?.computed ? argAny?.property?.value : argAny?.property?.name
        const indexKey = index != null ? String(index) : null
        const targetMember = indexKey != null ? target?.members?.get(indexKey) : null
        if (targetMember != null) {
          target.setFieldValue(
            index,
            new UndefinedValue({
              sid: targetMember.sid,
              qid: targetMember.qid,
              parent: target,
            })
          )
        }
      }
      return target ?? nodeValue
    }
    return nodeValue
  }

  /**
   *
   * @param scope
   * @param argNode
   */
  getDeleteTargetInScopeField(scope: any, argNode: any): any {
    if (!argNode || (argNode.type !== 'MemberAccess' && argNode.type !== 'Identifier')) return

    const argNodeAny = argNode as any
    const propName = argNodeAny?.property?.name
    if (argNode.type === 'Identifier' || argNodeAny?.object?.type === 'Identifier') {
      // 单层访问 a.b的情况
      const defScope = ScopeClass.getDefScope(scope, argNode)
      if (!propName) {
        // 当前argnode本身就是object了
        return defScope?.getFieldValue(argNodeAny.name)
        // return field[argNode.name]
      }
      const objName = argNodeAny.object?.name
      return defScope?.getFieldValue(objName)?.getFieldValue(propName)
      // return field[objName].field[propName]
    }
    // 多层访问 a.b.c
    if (argNode?.object?.type === 'MemberAccess') {
      const objField: any = this.getDeleteTargetInScopeField(scope, argNode.object)
      return objField?.members?.get(propName)
    }
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processBinaryExpression(scope: Scope, node: BinaryExpression, state: State): BinaryExprValue {
    let res = super.processBinaryExpression(scope, node, state)
    res = processBinaryOperator(res, scope, node, state)
    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processConditionalExpression(scope: Scope, node: ConditionalExpression, state: State): SymbolValueType {
    const res = super.processConditionalExpression(scope, node, state)
    if (
      typeof (res as any)._field !== 'undefined' &&
      (Array.isArray((res as any)._field) || Object.getOwnPropertyNames((res as any)._field).length !== 0) &&
      (res as any).taint?.isTaintedRec !== true
    ) {
      try {
        ;(res as any)._field.forEach((arg: any) => {
          if (arg.taint?.isTaintedRec) {
            ;(res as any).taint?.markSource()
            throw new Error('LoopInterrupt')
          }
        })
      } catch (e) {}
    }
    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processVariableDeclaration(scope: Scope, node: VariableDeclaration, state: State): SymbolValueType {
    const res = super.processVariableDeclaration(scope, node, state)

    // Array内置函数适配，由于array的构造不需要构造方法，因此无法像promise、map、set一样在初始化的时候填充内置函数
    // 只能在数组初始化以后往proto里填充内置的函数和方法
    if (node?.varType?.type === 'ArrayType') {
      Initializer.initArrayBuiltin(res)
    }


    if ((res as any)?.vtype === 'union') {
      if ((res as any).getFieldValue('0')?.taint?.isTaintedRec || (res as any).getFieldValue('1')?.taint?.isTaintedRec) {
        ;(res as any).taint?.markSource()
      }
    }
    return res
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processSpreadElement(scope: Scope, node: SpreadElement, state: State): SpreadValue {
    let res = super.processSpreadElement(scope, node, state)
    if (res) {
      // 检查 SpreadValue 是否为空，如果为空则重新计算并替换
      // 保持与原始行为一致：当 spread 结果为空时，直接返回 argument 的处理结果
      if (Array.isArray(res) && (res as any).length === 0) {
        res = this.processInstruction(scope, node.argument, state) as any
      }
      
      // 检查 SpreadValue 的污点信息（兼容数组和 SpreadValue）
      if (Array.isArray(res)) {
        const anyHasTag = (res as any).some((item: any) => {
          return item instanceof Unit && item.taint?.isTaintedRec
        })
        // 如果每一个元素都没有污点才return
        if (!anyHasTag) {
          return res as SpreadValue
        }
      }

      if (scope?.ast?.node?.type === 'ObjectExpression') {
        if ((scope as any).taint?.isTaintedRec !== true && res instanceof Unit) {
          ;(scope as any).taint?.propagateFrom(res)
        }
        if ((scope as any).taint?.isTaintedRec) {
          if (Array.isArray((scope as any)._field)) {
            ;(scope as any)._field.push(res)
          } else {
            let flag = 0
            let tmp = `YASATmp${flag}`
            while ((scope as any).members?.get(tmp)) {
              flag++
              tmp = `YASATmp${flag}`
            }
            ;(scope as any).members?.set(tmp, res)
          }
        }
      }
    }
    return res as SpreadValue
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processObjectExpression(scope: Scope, node: ObjectExpression, state: State): SymbolValueType {
    const res = super.processObjectExpression(scope, node, state)
    if ((res as any).value) {
      for (const val in (res as any).value) {
        if (
          (val.includes('CallBack') || val.includes('callback') || val.includes('callBacks')) &&
          (res as any).value[val].vtype === 'fclos' &&
          (res as any).value[val].ast.fdef
        ) {
          const argvalues: any[] = []
          if ((res as any).value[val].ast.fdef?.parameters && (res as any).value[val].ast.fdef.parameters.length > 0) {
            for (const para of (res as any).value[val].ast.fdef.parameters) {
              const argv = this.processInstruction(scope, para, state)
              if (Array.isArray(argv)) {
                argvalues.push(...argv)
              } else {
                argvalues.push(argv)
              }
            }
          }
          // execute call callback
          this.executeCall((res as any).value[val].ast.fdef, (res as any).value[val], state, scope, { callArgs: this.buildCallArgs((res as any).value[val].ast.fdef, argvalues, (res as any).value[val]) })
        }
      }
    }
    return res
  }

  /**
   *
   * @param fclos
   * @param node
   * @param scope
   * @param state
   */
  override postProcessFunctionDefinition(fclos: any, node: any, scope: any, state: any) {
    super.postProcessFunctionDefinition(fclos, node, scope, state)

    /** add function builtin * */
    // FIXME check builtin override
    const builtins = [
      new FunctionValue(fclos.qid, {
        sid: 'apply',
        _this: (this as any).thisFClos,
        parent: null,
        runtime: { execute: Initializer.builtin['function.apply'] },
      }),
      new FunctionValue(fclos.qid, {
        sid: 'call',
        _this: (this as any).thisFClos,
        parent: null,
        runtime: { execute: Initializer.builtin['function.call'] },
      }),
      //  TODO  function.bind
    ]

    for (const builtin of builtins) {
      this.saveVarInCurrentScope(
        fclos,
        new PrimitiveValue(fclos.qid, builtin.sid, builtin.sid, null, 'Literal'),
        builtin,
        state
      )
      builtin.parent = fclos
    }
  }

  /**
   * handle module imports: import "module"
   * @param scope
   * @param node
   * @param state
   * @returns {*}
   */
  processImportDirect(scope: Scope, node: any, state: State): Value {
    if (node?.from) {
      node = node.from
    }
    // if (DEBUG) logger.info('require: ' + formatNode(node));
    const fname =
      node?.value || AstUtil.prettyPrint(node) || `<unkonwn_module>${node.loc.start?.line}_${node.loc.start?.column}`

    if (fname[0] !== '.' || fname.endsWith('.less')) {
      // load predefined builtin models
      return this.loadPredefinedModule(scope, fname, node, state)
    }

    let sourcefile
    while (node) {
      sourcefile = node.sourcefile || node.loc.sourcefile
      if (sourcefile) break
      node = node.parent
    }
    if (!sourcefile) {
      handleException(
        null,
        'Error occurred in JsAnalyzer.processImportDirect: failed to sourcefile in ast',
        'Error occurred in JsAnalyzer.processImportDirect: failed to sourcefile in ast'
      )
      return new UndefinedValue()
    }

    let pathname = path.resolve(path.dirname(sourcefile.toString()), fname)
    // handle ext
    if (!fs.existsSync(pathname) || !fs.statSync(pathname).isFile()) {
      let isExist = false

      if (pathname.endsWith('.js')) { // handle ts
        const tsPathname = pathname.replace(/\.js$/, '.ts')
        if (fs.existsSync(tsPathname) && fs.statSync(tsPathname).isFile()) {
          pathname = tsPathname
          isExist = true
        }
      }

      if (!isExist) {
        let cwd
        let filename

        cwd = path.join(pathname, '../')
        filename = pathname.split('/').pop()
        const files = [`${filename}.(js|ts|mjs|cjs)`]
        const filepaths = globby.sync(files, { cwd, caseSensitiveMatch: false })
        if (filepaths && filepaths.length !== 0) {
          pathname = path.join(cwd, filepaths[0])
          isExist = true
        } else if (fs.existsSync(pathname)) {
          cwd = pathname
          filename = '(i|I)ndex'
          const files = [`${filename}.(js|ts|mjs|cjs)`]
          const filepaths = globby.sync(files, { cwd, caseSensitiveMatch: false })
          if (filepaths && filepaths.length !== 0) {
            pathname = path.join(pathname, filepaths[0])
            isExist = true
          }
        }
      }

      if (!isExist) {
        return this.loadPredefinedModule(scope, pathname, node, state)
      }
    }

    // check cached imports first
    const m = this.topScope.context.modules.members.get(pathname)
    if (m && typeof m === 'object') return m

    let res
    try {
      const prog = FileUtil.loadAllFileText(pathname, ['js', 'ts', 'mjs', 'cjs', 'json'])[0]
      if (prog) {
        // 先填充 sourceCodeCache，parser 会优先使用
        const fileContent = pathname.endsWith('json') ? `module.exports = ${prog.content}` : prog.content
        this.sourceCodeCache.set(prog.file, fileContent.split(/\n/))
        const ast = Parser.parseSingleFile(prog.file, { ...this.options, sourcefile: prog.file }, this.sourceCodeCache)
        if (ast) {
          this.sourceCodeCache.set(prog.file, prog.content.split(/\n/))
          res = this.processModule(ast, pathname)
        }
      }
    } catch (e) {
      handleException(
        e,
        `Error in JsAnalyzer.processImportDirect: failed to loading: ${pathname}`,
        `Error in JsAnalyzer.processImportDirect: failed to loading: ${pathname}`
      )
    }
    if (!res) {
      return this.loadPredefinedModule(scope, pathname, node, state)
    }

    return res
  }

  // load predefined module
  /**
   *
   * @param scope
   * @param fname
   * @param node
   * @param state
   */
  loadPredefinedModule(scope: any, fname: any, node: any, state: any) {
    // TODO modeling module more precisely
    // considering two aspect:
    // 1. built-in module
    // 2. importing from third party package in node_modules

    let m = this.topScope.context.modules.members.get(fname)
    if (m && typeof m === 'object') return m
    m = new ObjectValue(this.topScope.context.modules.qid, {
      sid: fname,
      parent: this.topScope.context.modules,
      node_module: true,
    })
    // v.parent = m;
    this.topScope.context.modules.members.set(fname, m)
    return m
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processForStatement(scope: Scope, node: ForStatement, state: State): VoidValueType {
    // If ForStatement is aim at iterating over target, tweak node to RangeStatement for better evaluation
    const { test, update } = node
    // matching iteration over pattern
    if (
      test?.type === 'BinaryExpression' &&
      test?.right?.type === 'MemberAccess' &&
      test?.right?.property?.type === 'Identifier' &&
      test?.right?.property?.name === 'length' &&
      update?.type === 'UnaryExpression' &&
      update?.operator === '++'
    ) {
      const right = test.right.object
      const key = UastSpec.variableDeclaration(update.argument, null, false, UastSpec.dynamicType())
      key.loc = node?.init?.loc
      const rangeStatement = UastSpec.rangeStatement(key, null, right, node.body)
      rangeStatement.loc = node.loc
      return this.processInstruction(scope, rangeStatement, state)
    }
    if (node.init === null && node.test === null && node.update === null) {
      // for(;;)
      return this.processScopedStatement(scope, node.body as any, state)
    }
    return super.processForStatement(scope, node, state)
  }

  /**
   *
   */
  override initTopScope() {
    Initializer.initGlobalScope(this.topScope)
  }

  /**
   *
   * @param scope
   * @param node
   * @param state
   */
  override processReturnStatement(scope: Scope, node: ReturnStatement, state: State): VoidValueType {
    let retVal
    try {
      retVal = super.processReturnStatement(scope, node, state)
    } catch (e) {
      return new UndefinedValue()
    }

    if ((node as any).isYield && (retVal.sid === 'Promise' || retVal.sid.includes('Promise<instance'))) {
      const promiseMisc = (retVal as any).getMisc('promise')
      if (!promiseMisc) return retVal
      const { resolve, reject } = promiseMisc
      return resolve || retVal
    }
    return retVal
  }
}

export = JsAnalyzer
