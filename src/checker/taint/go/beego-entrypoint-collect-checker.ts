import type Unit from '../../../engine/analyzer/common/value/unit'
import { flattenUnionValues, processEntryPointAndTaintSource } from './util'

const config = require('../../../config')

const Checker = require('../../common/checker')
const IntroduceTaint = require('../common-kit/source-util')
const completeEntryPoint = require('../common-kit/entry-points-util')

const processedRouteRegistry = new Set<string>()
const controllerQids = new Set<string>()
const directTaintSourceFuncs = new Set<string>([
  'GetBool',
  'GetFile',
  'GetFiles',
  'GetFloat',
  'GetInt',
  'GetInt16',
  'GetInt32',
  'GetInt64',
  'GetInt8',
  'GetString',
  'GetStrings',
  'GetUint16',
  'GetUint32',
  'GetUint64',
  'GetUint8',
])

/**
 *
 */
class BeegoEntrypointCollectChecker extends Checker {
  /**
   * constructor
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'beego-entrypoint-collect-checker')
  }

  /**
   * pre function call hook
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   * @param info.fclos
   * @param info.argvalues
   */
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { fclos, argvalues } = info
    if (config.entryPointMode === 'ONLY_CUSTOM') return
    if (fclos.vtype === 'symbol') {
      if (fclos.type === 'Identifier') {
        if (fclos._qid.startsWith('github.com/beego/beego/v2/server/web/filter/apiauth.APISecretAuth')) {
          processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, argvalues[0], '0')
        } else if (fclos._qid.startsWith('github.com/beego/beego/v2/server/web/filter/auth.NewBasicAuthenticator')) {
          processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, argvalues[0], '0, 1')
        } else if (fclos._qid.startsWith('github.com/beego/beego/v2/server/web')) {
          this.handleHttpServerMethod(analyzer, scope, state, fclos.name, argvalues)
        }
      } else if (fclos.type === 'MemberAccess') {
        if (controllerQids.has(fclos.object._qid) && fclos.property.name === 'Mapping') {
          const controllerMethodVal = argvalues[1]
          if (controllerMethodVal?.ast.loc) {
            const hash = JSON.stringify(controllerMethodVal.ast.loc)
            if (!processedRouteRegistry.has(hash)) {
              processedRouteRegistry.add(hash)
              const entryPoint = completeEntryPoint(controllerMethodVal)
              analyzer.entryPoints.push(entryPoint)
            }
          }
        } else if (fclos._qid.startsWith('github.com/beego/beego/v2/server/web.NewNamespace')) {
          this.handleNamespaceMethod(analyzer, scope, state, fclos.property.name, argvalues)
        }
      }
    }
  }

  /**
   * post function call hook
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallAfter(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { fclos, argvalues, ret } = info
    if (config.entryPointMode === 'ONLY_CUSTOM') return
    if (fclos.vtype === 'symbol' && fclos.type === 'MemberAccess') {
      if (controllerQids.has(fclos.object._qid)) {
        if (directTaintSourceFuncs.has(fclos.property.name)) {
          IntroduceTaint.markTaintSource(ret, { path: node, kind: 'GO_INPUT' })
        } else if (fclos.property.name === 'Bind') {
          IntroduceTaint.markTaintSource(argvalues[0], { path: node, kind: 'GO_INPUT' })
        }
      } else if (fclos.property.name === 'Bind' && controllerQids.has(fclos.object?.object?.object?._qid)) {
        // e.g., this.Ctx.Input.Bind
        IntroduceTaint.markTaintSource(argvalues[0], { path: node, kind: 'GO_INPUT' })
      }
    }
  }

  /**
   * post member access hook
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtMemberAccess(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { res } = info
    if (config.entryPointMode === 'ONLY_CUSTOM') return
    if (
      res.vtype === 'symbol' &&
      res.type === 'MemberAccess' &&
      controllerQids.has(res.object._qid) &&
      res.property.name === 'Ctx'
    ) {
      IntroduceTaint.markTaintSource(res, { path: node, kind: 'GO_INPUT' })
    }
  }

  /**
   * variable assignment hook
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtAssignment(analyzer: any, scope: any, node: any, state: any, info: any) {
    if (config.entryPointMode === 'ONLY_CUSTOM') return
    const { rvalue } = info
    const { left } = node
    if (
      analyzer.processInstruction(scope, left.object, state)?._qid === 'github.com/beego/beego/v2/server/web.BConfig' &&
      left.property?.name === 'RecoverFunc'
    ) {
      processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, rvalue, '0')
    }
  }

  /**
   * post entry point interpretation hook
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtSymbolInterpretOfEntryPointAfter(analyzer: any, scope: any, node: any, state: any, info: any) {
    if (info?.entryPoint.functionName === 'main') processedRouteRegistry.clear()
  }

  /**
   * check if a method is a valid controller method
   * @param name - the method name to check
   * @param value - the method value to validate
   * @returns {boolean} true if the method is a valid controller method, false otherwise
   */
  isControllerMethod(name: string, value: any): boolean {
    if (!name[0] || name[0] < 'A' || name[0] > 'Z') return false
    if (!value || value.vtype !== 'fclos') return false
    if (value.fdef.returnType.type !== 'VoidType') return false
    return value.fdef.parameters.length === 0
  }

  /**
   * handle method calls on web.HttpServer
   * @param analyzer
   * @param scope
   * @param state
   * @param name method name
   * @param argvalues
   */
  // eslint-disable-next-line complexity
  handleHttpServerMethod(analyzer: any, scope: any, state: any, name: string, argvalues: Array<Unit>) {
    switch (name) {
      case 'AutoRouter':
      case 'NSAutoRouter':
        this.handleAutoControllerArgVal(analyzer, argvalues[0])
        break
      case 'AutoPrefix':
      case 'NSAutoPrefix':
        this.handleAutoControllerArgVal(analyzer, argvalues[1])
        break
      case 'InsertFilter':
        processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, argvalues[2], '0')
        break
      case 'InsertFilterChain':
        flattenUnionValues([argvalues[1]])
          .filter((unit) => unit.vtype === 'fclos')
          .forEach((fclos) => {
            const retVal = analyzer.processAndCallFuncDef(scope, (fclos as any).fdef, fclos, state)
            processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, retVal, '0')
          })
        break
      case 'Handler':
        flattenUnionValues([argvalues[1]]).forEach((handlerVal) => {
          const serveHttp = handlerVal.field?.ServeHTTP
          if (serveHttp) {
            processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, serveHttp, '1')
          }
        })
        break
      case 'Include':
      case 'NSInclude':
        flattenUnionValues(argvalues).forEach((mappingController) => {
          const urlMapping = mappingController.field?.URLMapping
          if (urlMapping) {
            controllerQids.add(mappingController._qid)
            analyzer.processAndCallFuncDef(scope, urlMapping.fdef, urlMapping, state)
          }
        })
        break
      case 'CtrlGet':
      case 'CtrlPost':
      case 'CtrlDelete':
      case 'CtrlAny':
      case 'CtrlHead':
      case 'CtrlOptions':
      case 'CtrlPatch':
      case 'CtrlPut':
      case 'NSCtrlGet':
      case 'NSCtrlPost':
      case 'NSCtrlDelete':
      case 'NSCtrlAny':
      case 'NSCtrlHead':
      case 'NSCtrlOptions':
      case 'NSCtrlPatch':
      case 'NSCtrlPut':
        flattenUnionValues([argvalues[1]])
          .filter((unit) => unit.vtype === 'fclos')
          .forEach((unboundMethodVal: any) => {
            const instance = analyzer.buildNewObject(
              unboundMethodVal.__this.cdef,
              [],
              unboundMethodVal.__this,
              state,
              null,
              scope
            )
            const boundMethodVal = instance.field?.[unboundMethodVal.fdef.id.name]
            if (boundMethodVal?.ast.loc) {
              const hash = JSON.stringify(boundMethodVal.ast.loc)
              if (!processedRouteRegistry.has(hash)) {
                processedRouteRegistry.add(hash)
                controllerQids.add(boundMethodVal.__this._qid)
                const entryPoint = completeEntryPoint(boundMethodVal)
                analyzer.entryPoints.push(entryPoint)
              }
            }
          })
        break
      case 'Router':
      case 'NSRouter':
        flattenUnionValues(argvalues.slice(2))
          .filter((unit: any) => unit.vtype === 'primitive' && unit.literalType === 'STRING')
          .forEach((stringVal) => {
            const methodName = stringVal.value.slice(1, -1).split(':')[1]
            flattenUnionValues([argvalues[1]]).forEach((controllerVal) => {
              const controllerMethodVal = controllerVal.field?.[methodName]
              if (controllerMethodVal?.ast.loc) {
                const hash = JSON.stringify(controllerMethodVal.ast.loc)
                if (!processedRouteRegistry.has(hash)) {
                  processedRouteRegistry.add(hash)
                  controllerQids.add(controllerMethodVal.__this._qid)
                  const entryPoint = completeEntryPoint(controllerMethodVal)
                  analyzer.entryPoints.push(entryPoint)
                }
              }
            })
          })
        break
      case 'Get':
      case 'Post':
      case 'Delete':
      case 'Any':
      case 'Head':
      case 'Options':
      case 'Patch':
      case 'Put':
      case 'NSGet':
      case 'NSPost':
      case 'NSDelete':
      case 'NSAny':
      case 'NSHead':
      case 'NSOptions':
      case 'NSPatch':
      case 'NSPut':
        processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, argvalues[1], '0')
        break
      case 'NSCond':
        processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, argvalues[0], '0')
        break
      case 'NSBefore':
      case 'NSAfter':
        argvalues.forEach((val) => processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, val, '0'))
        break
      case 'ErrorController':
        this.handleErrorControllerArgVal(analyzer, argvalues[0])
        break
      default:
        break
    }
  }

  /**
   * handle method calls on web.Namespace
   * @param analyzer
   * @param scope
   * @param state
   * @param name
   * @param argvalues
   */
  handleNamespaceMethod(analyzer: any, scope: any, state: any, name: string, argvalues: Array<Unit>) {
    switch (name) {
      case 'Filter':
        argvalues
          .slice(1)
          .forEach((val) => processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, val, '0'))
        break
      case 'Cond':
        processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, argvalues[0], '0')
        break
      default:
        break
    }
  }

  /**
   * handle ErrorController registration
   * @param analyzer
   * @param controllerArgVal
   */
  handleErrorControllerArgVal(analyzer: any, controllerArgVal: Unit) {
    flattenUnionValues([controllerArgVal])
      .flatMap((v) => Object.entries(v.field))
      .filter(([fieldName, fieldVal]) => this.isControllerMethod(fieldName, fieldVal) && fieldName.startsWith('Error'))
      .map(([, controllerMethodVal]) => controllerMethodVal as Unit)
      .forEach((controllerMethodVal) => {
        if (controllerMethodVal?.ast.loc) {
          const hash = JSON.stringify(controllerMethodVal.ast.loc)
          if (!processedRouteRegistry.has(hash)) {
            processedRouteRegistry.add(hash)
            controllerQids.add(controllerMethodVal.__this._qid)
            const entryPoint = completeEntryPoint(controllerMethodVal)
            analyzer.entryPoints.push(entryPoint)
          }
        }
      })
  }

  /**
   * handle AutoXXX API based controller registration
   * @param analyzer
   * @param controllerArgVal
   */
  handleAutoControllerArgVal(analyzer: any, controllerArgVal: Unit) {
    flattenUnionValues([controllerArgVal])
      .flatMap((v) => Object.entries(v.field))
      .filter(([fieldName, fieldVal]) => this.isControllerMethod(fieldName, fieldVal))
      .map(([, controllerMethodVal]) => controllerMethodVal as Unit)
      .forEach((controllerMethodVal) => {
        if (controllerMethodVal?.ast.loc) {
          const hash = JSON.stringify(controllerMethodVal.ast.loc)
          if (!processedRouteRegistry.has(hash)) {
            processedRouteRegistry.add(hash)
            controllerQids.add(controllerMethodVal.__this._qid)
            const entryPoint = completeEntryPoint(controllerMethodVal)
            analyzer.entryPoints.push(entryPoint)
          }
        }
      })
  }
}

module.exports = BeegoEntrypointCollectChecker
