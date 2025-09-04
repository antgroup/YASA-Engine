const _ = require('lodash')
const commonUtil = require('../../../util/common-util')
const { completeEntryPoint, entryPointsUpToUser } = require('./entry-points-util')
const AstUtil = require('../../../util/ast-util')
const config = require('../../../config')
const IntroduceTaint = require('../common-kit/source-util')

const processedCompileUnit = new Set()
const registerServerPoints = {}
const processedRegisterEntryPoints = new Set()

const CheckerId = 'gRpc-entryPoint-collect-checker'
const interfaceEntryPointsMap = {}
/**
 * gRpc entrypoint采集以及框架source添加
 */
class GRpcEntrypointCollectChecker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager) {
    this.sourceScope = {
      complete: false,
      value: [],
    }
    this.resultManager = resultManager
    commonUtil.initSourceScope(this.sourceScope)
  }

  /**
   * @returns {string}
   * @constructor
   */
  static GetCheckerId() {
    return CheckerId
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtCompileUnit(analyzer, scope, node, state, info) {
    const fileName = node.loc?.sourcefile
    if (!fileName) return
    if (!fileName.endsWith('.pb.go')) return
    if (processedCompileUnit.has(fileName)) return

    // 只处理类、接口和注册方法
    node.body.forEach((exp) => {
      if (!exp || !exp.type || !exp.id?.name) return
      const { name } = exp.id
      switch (exp.type) {
        case 'ClassDefinition':
          if (!exp.body) return
          if (exp._meta?.isInterface) {
            // 只采集非Unsafe的Server端接口
            if (
              !name.endsWith('Server') ||
              (name.indexOf('Unsafe') === name.lastIndexOf('Unsafe') && name.startsWith('Unsafe'))
            )
              break
            this.collectInterfaceEntryPoints(exp, name, scope)
          }
          if (
            name.indexOf('Unimplemented') === name.lastIndexOf('Unimplemented') &&
            name.startsWith('Unimplemented') &&
            name.endsWith('Server')
          )
            break
          // 处理所有接口和类声明
          analyzer.processClassDefinition(scope, exp, state)
          break

        case 'FunctionDefinition':
          const match = name.match(/^Register(.*Server)$/)
          if (match) {
            const serverName = match[1]
            const fClos = analyzer.processFunctionDefinition(scope, exp, state)
            if (fClos?._qid) registerServerPoints[fClos._qid] = serverName
          }
          break

        default:
          break
      }
    })
    processedCompileUnit.add(fileName)
    return true
  }

  /**
   * 扫描到grpc_pb.go中的接口时，记录其中声明的方法(实现类的entryPoints名)
   * @param interfaceExp
   * @param interfaceName
   * @param scope
   */
  collectInterfaceEntryPoints(interfaceExp, interfaceName, scope) {
    if (config.entryPointMode === 'ONLY_CUSTOM' && entryPointsUpToUser) return // 不路由自采集
    interfaceExp.body.forEach((funcType) => {
      if (
        !funcType ||
        funcType.type !== 'FuncType' ||
        !funcType.id?.name ||
        funcType.id.name === `mustEmbedUnimplemented${interfaceName}`
      )
        return
      interfaceEntryPointsMap[interfaceName] = (interfaceEntryPointsMap[interfaceName] ||= new Set()).add(
        funcType.id.name
      )
    })
  }

  /**
   * call Register_xxx_Server时，添加具体实现类的entryPoints
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer, scope, node, state, info) {
    const { fclos, argvalues } = info
    if (config.entryPointMode === 'ONLY_CUSTOM' && entryPointsUpToUser) return // 不路由自采集
    if (!(fclos._qid in registerServerPoints)) return // 处理Register_xxx_Server函数，即实现类注册点
    if (!Array.isArray(argvalues) || argvalues.length < 1) return
    const serverName = registerServerPoints[fclos._qid]
    const implServer = argvalues[1]
    this.searchServiceEntryPoints(serverName, implServer, fclos, state, analyzer)
  }

  /**
   * 去实现类中找到具体的entryPoints方法，并添加到analyzer.entryPoints
   * @param serverName
   * @param implServer
   * @param calleeFClos
   * @param state
   * @param analyzer
   */
  searchServiceEntryPoints(serverName, implServer, calleeFClos, state, analyzer) {
    const interfaceEntryPoints = interfaceEntryPointsMap[serverName]
    if (!interfaceEntryPoints) return
    const serviceEntryPoints = []
    interfaceEntryPoints.forEach((entryPointName) => {
      const ep = AstUtil.satisfy(
        implServer,
        (n) => n.vtype === 'fclos' && n?.ast?.id.name === entryPointName,
        (node, prop) => prop === 'field',
        null,
        false
      )

      if (ep) {
        const hash = JSON.stringify(ep.ast.loc)
        if (!hash || processedRegisterEntryPoints.has(hash)) return
        processedRegisterEntryPoints.add(hash)
        this.introduceGrpcTaint(ep, state, analyzer)
        serviceEntryPoints.push(completeEntryPoint(ep))
      }
    })
    analyzer.entryPoints.push(...serviceEntryPoints)
  }

  /**
   *
   * @param entryPoint
   * @param state
   * @param analyzer
   */
  introduceGrpcTaint(entryPoint, state, analyzer) {
    IntroduceTaint.introduceFuncArgTaintBySelfCollection(entryPoint, state, analyzer, '1:', 'GO_INPUT')
  }

  /**
   * 每次运行完main后清空hash
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtSymbolInterpretOfEntryPointAfter(analyzer, scope, node, state, info) {
    if (info?.entryPoint.functionName === 'main') {
      processedRegisterEntryPoints.clear()
    }
  }
}
module.exports = GRpcEntrypointCollectChecker
