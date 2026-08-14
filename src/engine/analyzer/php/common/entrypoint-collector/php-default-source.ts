/**
 * PHP 默认 source 自采集
 *
 * 与语言/框架无关的 PHP 通用 source 清单，由 checker 层（php-default-taint-checker）
 * 在 triggerAtStartOfAnalyze 调用并 push 进 checkerRuleConfigContent.sources。
 *
 * 范围：
 * - 6 个超全局变量（_GET / _POST / _REQUEST / _COOKIE / _SERVER / _FILES）→ TaintSource
 * - 12 个框架请求 getter（readline + 11 条 calleeType='*' 的 getXxx/input/param）
 *   → FuncCallReturnValueTaintSource
 *
 * 不负责：
 * - EntryPoint 入参标 source（由 checker triggerAtSymbolInterpretOfEntryPointBefore 处理）
 * - entryPoint 收集（由 sparta / soa / custom-mvc / custom-databucket 4 个 collector 处理）
 *
 * entryPointMode 为 BOTH / SELF_COLLECT 时开启；ONLY_CUSTOM 完全遵循 ruleconfig，不注入默认 source。
 */

interface PhpTaintSourceRule {
  className: ''
  path: string
  scopeFile: 'all'
  scopeFunc: 'all'
}

interface PhpFuncCallReturnValueTaintSourceRule {
  fsig: string
  calleeType?: '*'
  values: ['0']
  scopeFile: 'all'
  scopeFunc: 'all'
}

interface PhpDefaultSourceResult {
  selfCollectTaintSource: PhpTaintSourceRule[]
  selfCollectFuncCallReturnValueTaintSource: PhpFuncCallReturnValueTaintSourceRule[]
}

const SUPERGLOBALS: readonly string[] = ['_GET', '_POST', '_REQUEST', '_COOKIE', '_SERVER', '_FILES']

/** readline 是 PHP 内置全局函数，无 callee；其余 getter 都是方法调用，calleeType='*' 通配接收者类型 */
const FRAMEWORK_GETTERS_WITH_CALLEE: readonly string[] = [
  'getRequest',
  'getPost',
  'getQuery',
  'getCookie',
  'getHeader',
  'getEnv',
  'getUnSafeData',
  'getAllRequest',
  'getAllGetAndPost',
  'input',
  'param',
]

/**
 * 返回 PHP 默认 source 列表（纯字面量常量，不依赖 analyzer / fileManager）。
 * @returns { selfCollectTaintSource, selfCollectFuncCallReturnValueTaintSource }
 */
function getPhpDefaultSourceList(): PhpDefaultSourceResult {
  const selfCollectTaintSource: PhpTaintSourceRule[] = SUPERGLOBALS.map((name) => ({
    className: '',
    path: name,
    scopeFile: 'all',
    scopeFunc: 'all',
  }))

  const selfCollectFuncCallReturnValueTaintSource: PhpFuncCallReturnValueTaintSourceRule[] = [
    { fsig: 'readline', values: ['0'], scopeFile: 'all', scopeFunc: 'all' },
    ...FRAMEWORK_GETTERS_WITH_CALLEE.map(
      (fsig): PhpFuncCallReturnValueTaintSourceRule => ({
        fsig,
        calleeType: '*',
        values: ['0'],
        scopeFile: 'all',
        scopeFunc: 'all',
      })
    ),
  ]

  return { selfCollectTaintSource, selfCollectFuncCallReturnValueTaintSource }
}

export = {
  getPhpDefaultSourceList,
}
