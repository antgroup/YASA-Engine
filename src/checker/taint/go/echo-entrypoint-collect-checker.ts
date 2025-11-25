import type Unit from '../../../engine/analyzer/common/value/unit'
import { flattenUnionValues, processEntryPointAndTaintSource } from './util'

const config = require('../../../config')
const GoAnalyzer = require('../../../engine/analyzer/golang/common/go-analyzer')

const KnownPackageName = {
  'github.com/labstack/echo/v4': 'echo',
  'github.com/labstack/echo-jwt/v4': 'echojwt',
}

const RouteRegistryObject = ['github.com/labstack/echo/v4.New()']

const MiddlewareHandlerRegistryObject = [
  'github.com/labstack/echo/v4/middleware',
  'github.com/labstack/echo-contrib/casbin',
  'github.com/labstack/echo-jwt/v4',
  'github.com/labstack/echo-contrib/echoprometheus',
  'github.com/labstack/echo-contrib/session',
]

const ConfigObjectCollectionTable = new Map<string, Array<{ name: string; source: string }>>([
  [
    'BasicAuthWithConfig',
    [
      { name: 'Skipper', source: '0' },
      { name: 'Validator', source: '0, 1, 2' },
    ],
  ],
  [
    'BodyDumpWithConfig',
    [
      { name: 'Skipper', source: '0' },
      { name: 'Handler', source: '0, 1, 2' },
    ],
  ],
  ['BodyLimitWithConfig', [{ name: 'Skipper', source: '0' }]],
  [
    'MiddlewareWithConfig',
    [
      { name: 'Skipper', source: '0' },
      { name: 'EnforceHandler', source: '0, 1' },
      { name: 'UserGetter', source: '0' },
      { name: 'ErrorHandler', source: '0, 1' },
    ],
  ],
  [
    'ContextTimeoutWithConfig',
    [
      { name: 'Skipper', source: '0' },
      { name: 'ErrorHandler', source: '0, 1' },
    ],
  ],
  [
    'CORSWithConfig',
    [
      { name: 'Skipper', source: '0' },
      { name: 'AllowOriginFunc', source: '0' },
    ],
  ],
  [
    'CSRFWithConfig',
    [
      { name: 'Skipper', source: '0' },
      { name: 'ErrorHandler', source: '0, 1' },
    ],
  ],
  ['DecompressWithConfig', [{ name: 'Skipper', source: '0' }]],
  ['GzipWithConfig', [{ name: 'Skipper', source: '0' }]],
  [
    'WithConfig',
    [
      { name: 'Skipper', source: '0' },
      { name: 'BeforeFunc', source: '0' },
      { name: 'SuccessHandler', source: '0' },
      { name: 'ErrorHandler', source: '0, 1' },
      { name: 'KeyFunc', source: '0' },
      { name: 'ParseTokenFunc', source: '0' },
      { name: 'NewClaimsFunc', source: '0' },
    ],
  ],
  [
    'KeyAuthWithConfig',
    [
      { name: 'Skipper', source: '0' },
      { name: 'Validator', source: '0, 1' },
      { name: 'ErrorHandler', source: '0, 1' },
    ],
  ],
  [
    'LoggerWithConfig',
    [
      { name: 'Skipper', source: '0' },
      { name: 'CustomTagFunc', source: '0' },
    ],
  ],
  [
    'RequestLoggerWithConfig',
    [
      { name: 'Skipper', source: '0' },
      { name: 'BeforeNextFunc', source: '0' },
      { name: 'LogValuesFunc', source: '0, 1' },
    ],
  ],
  [
    'MethodOverrideWithConfig',
    [
      { name: 'Skipper', source: '0' },
      { name: 'Getter', source: '0' },
    ],
  ],
  [
    'NewMiddlewareWithConfig',
    [
      { name: 'Skipper', source: '0' },
      { name: 'BeforeNext', source: '0' },
      { name: 'AfterNext', source: '0, 1' },
      { name: 'StatusCodeResolver', source: '0, 1' },
    ],
  ],
  ['Proxy', [{ name: 'Next', source: '0' }]],
  [
    'ProxyWithConfig',
    [
      { name: 'Skipper', source: '0' },
      { name: 'RetryFilter', source: '0, 1' },
      { name: 'ErrorHandler', source: '0, 1' },
      { name: 'ModifyResponse', source: '0' },
    ],
  ],
  ['RateLimiter', [{ name: 'Allow', source: '0' }]],
  [
    'RateLimiterWithConfig',
    [
      { name: 'Skipper', source: '0' },
      { name: 'BeforeFunc', source: '0' },
      { name: 'IdentifierExtractor', source: '0' },
      { name: 'ErrorHandler', source: '0, 1' },
      { name: 'DenyHandler', source: '0, 1, 2' },
    ],
  ],
  [
    'RecoverWithConfig',
    [
      { name: 'Skipper', source: '0' },
      { name: 'LogErrorFunc', source: '0, 1' },
    ],
  ],
  ['HTTPSRedirectWithConfig', [{ name: 'Skipper', source: '0' }]],
  [
    'RequestIDWithConfig',
    [
      { name: 'Skipper', source: '0' },
      { name: 'RequestIDHandler', source: '0, 1' },
    ],
  ],
  ['RewriteWithConfig', [{ name: 'Skipper', source: '0' }]],
  ['SecureWithConfig', [{ name: 'Skipper', source: '0' }]],
  [
    'Middleware',
    [
      { name: 'Get', source: '0' },
      { name: 'New', source: '0' },
      { name: 'Save', source: '0' },
    ],
  ],
  ['StaticWithConfig', [{ name: 'Skipper', source: '0' }]],
  ['AddTrailingSlashWithConfig', [{ name: 'Skipper', source: '0' }]],
  ['RemoveTrailingSlashWithConfig', [{ name: 'Skipper', source: '0' }]],
])

const Checker = require('../../common/checker')

const processedRouteRegistry = new Set<string>()

/**
 *
 */
class EchoEntrypointCollectChecker extends Checker {
  /**
   *
   * @param resultManager
   */
  constructor(resultManager: any) {
    super(resultManager, 'echo-entrypoint-collect-checker')
    GoAnalyzer.registerKnownPackageNames(KnownPackageName)
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtFunctionCallBefore(analyzer: any, scope: any, node: any, state: any, info: any) {
    const { fclos, argvalues } = info
    if (config.entryPointMode === 'ONLY_CUSTOM') return
    if (!(fclos && fclos.object && fclos.property)) return
    const { object, property } = fclos
    if (!object._qid || !property.name) return
    if (!RouteRegistryObject.some((obj) => object._qid.includes(obj))) return
    switch (property.name) {
      case 'Use':
      case 'Pre':
        this.handleMiddlewareArgs(analyzer, scope, state, argvalues)
        break
      case 'CONNECT':
      case 'DELETE':
      case 'GET':
      case 'HEAD':
      case 'OPTIONS':
      case 'PATCH':
      case 'POST':
      case 'PUT':
      case 'TRACE':
      case 'RouteNotFound':
      case 'Any':
        processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, argvalues[1], '0')
        this.handleMiddlewareArgs(analyzer, scope, state, argvalues.slice(2))
        break
      case 'Match':
      case 'Add':
        processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, argvalues[2], '0')
        this.handleMiddlewareArgs(analyzer, scope, state, argvalues.slice(3))
        break
      case 'File':
        this.handleMiddlewareArgs(analyzer, scope, state, argvalues.slice(2))
        break
      case 'FileFS':
        flattenUnionValues([argvalues[2]]).forEach((fs) => {
          processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, fs.field.Open, '0')
        })
        this.handleMiddlewareArgs(analyzer, scope, state, argvalues.slice(3))
        break
      case 'Host':
      case 'Group':
        this.handleMiddlewareArgs(analyzer, scope, state, argvalues.slice(1))
        break
      default:
        break
    }
  }

  /**
   *
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
   *
   * @param analyzer
   * @param scope
   * @param node
   * @param state
   * @param info
   */
  triggerAtAssignment(analyzer: any, scope: any, node: any, state: any, info: any) {
    if (config.entryPointMode === 'ONLY_CUSTOM') return
    const { lvalue, rvalue } = info
    if (!(lvalue.object && lvalue.property)) return
    const { object, property } = lvalue
    if (!object._qid || !property.name) return
    if (!RouteRegistryObject.some((obj) => object._qid.includes(obj))) return
    const rvalueObjs = flattenUnionValues([rvalue])
    switch (property.name) {
      case 'HTTPErrorHandler':
        rvalueObjs.forEach((obj) =>
          processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, obj, '0, 1')
        )
        break
      case 'Binder':
        rvalueObjs.forEach((obj) =>
          processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, obj.field.Bind, '1')
        )
        break
      case 'Renderer':
        rvalueObjs.forEach((obj) =>
          processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, obj.field.Render, '3')
        )
        break
      case 'Filesystem':
        rvalueObjs.forEach((obj) =>
          processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, obj.field.Open, '0')
        )
        break
      default:
        break
    }
  }

  /**
   *
   * @param analyzer
   * @param state
   * @param symbol
   */
  handleConfigObjectCollection(analyzer: any, state: any, symbol: any) {
    const rules = ConfigObjectCollectionTable.get(symbol.expression?.name)
    if (!rules) return
    flattenUnionValues([symbol.arguments[0]]).forEach((middlewareConfig) => {
      rules.forEach((rule) => {
        const fieldValue = middlewareConfig.field[rule.name]
        if (!fieldValue) return
        processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, fieldValue, rule.source)
      })
    })
  }

  /**
   *
   * @param analyzer
   * @param state
   * @param symbol
   */
  handleKnownEchoMiddlewares(analyzer: any, state: any, symbol: any) {
    if (symbol.type !== 'CallExpression') return
    const objectQid = symbol.expression?._qid
    if (!(objectQid && MiddlewareHandlerRegistryObject.some((obj) => objectQid.startsWith(obj)))) return

    switch (symbol.expression.name) {
      case 'BasicAuth':
        processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, symbol.arguments[0], '0, 1, 2')
        break
      case 'BodyDump':
        processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, symbol.arguments[0], '0, 1, 2')
        break
      case 'KeyAuth':
        processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, symbol.arguments[0], '0, 1')
        break
      case 'WithConfig':
        flattenUnionValues([symbol.arguments[0]]).forEach((middlewareConfig) => {
          const tokenLookupFuncs = middlewareConfig.field.TokenLookupFuncs
          if (!tokenLookupFuncs) return
          Object.values(tokenLookupFuncs.value).forEach((v) => {
            processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, v as Unit, '0')
          })
        })
        this.handleConfigObjectCollection(analyzer, state, symbol)
        break
      case 'NewMiddlewareWithConfig':
        flattenUnionValues([symbol.arguments[0]]).forEach((middlewareConfig) => {
          const labelFuncs = middlewareConfig.field.LabelFuncs
          if (!labelFuncs) return
          Object.values(labelFuncs.value).forEach((v) => {
            processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, v as Unit, '0, 1')
          })
        })
        this.handleConfigObjectCollection(analyzer, state, symbol)
        break
      case 'ProxyWithConfig':
        flattenUnionValues([symbol.arguments[0]]).forEach((middlewareConfig) => {
          const balancerNext = middlewareConfig.field?.Balancer?.field?.Next
          if (balancerNext) {
            processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, balancerNext, '0')
          }
          const transportRoundTrip = middlewareConfig.field?.Transport?.field?.RoundTrip
          if (transportRoundTrip) {
            processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, transportRoundTrip, '0')
          }
        })
        this.handleConfigObjectCollection(analyzer, state, symbol)
        break
      case 'RateLimiterWithConfig':
        flattenUnionValues([symbol.arguments[0]]).forEach((middlewareConfig) => {
          const allow = middlewareConfig.field?.Store?.field?.Allow
          if (allow) {
            processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, allow, '0')
          }
        })
        this.handleConfigObjectCollection(analyzer, state, symbol)
        break
      case 'MiddlewareWithConfig':
        flattenUnionValues([symbol.arguments[0]]).forEach((middlewareConfig) => {
          const store = middlewareConfig.field.Store
          if (!store) return
          ;[store.field.Get, store.field.New, store.field.Save]
            .filter((v) => v)
            .forEach((v) => {
              processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, v, '0')
            })
        })
        this.handleConfigObjectCollection(analyzer, state, symbol)
        break
      case 'StaticWithConfig':
        flattenUnionValues([symbol.arguments[0]]).forEach((middlewareConfig) => {
          const open = middlewareConfig.field?.Filesystem?.field?.Open
          if (open) {
            processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, open, '0')
          }
        })
        this.handleConfigObjectCollection(analyzer, state, symbol)
        break
      default:
        this.handleConfigObjectCollection(analyzer, state, symbol)
        break
    }
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param state
   * @param middlewareFunctionValue
   */
  handleCustomMiddleware(analyzer: any, scope: any, state: any, middlewareFunctionValue: any) {
    const retVal = analyzer.processAndCallFuncDef(scope, middlewareFunctionValue.fdef, middlewareFunctionValue, state)
    processEntryPointAndTaintSource(analyzer, state, processedRouteRegistry, retVal, '0')
  }

  /**
   *
   * @param analyzer
   * @param scope
   * @param state
   * @param list
   */
  handleMiddlewareArgs(analyzer: any, scope: any, state: any, list: Array<Unit>) {
    const flattened = flattenUnionValues(list)
    flattened.forEach((unit) => {
      if (unit.vtype === 'symbol') {
        this.handleKnownEchoMiddlewares(analyzer, state, unit)
      } else if (unit.vtype === 'fclos') {
        this.handleCustomMiddleware(analyzer, scope, state, unit)
      }
    })
  }
}

module.exports = EchoEntrypointCollectChecker
