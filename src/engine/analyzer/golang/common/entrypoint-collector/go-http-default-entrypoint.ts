export {}

// net/http 形态默认 source 清单：覆盖 *http.Request / *url.URL / url.Values 三类典型 Web 入口
// 与 gin-default-entrypoint 互不重叠（calleeType 不同，不会双注入）

const HttpRequestType = '*http.Request'
const UrlURLType = '*url.URL'
const UrlValuesType = 'url.Values'

// 字段访问 source：r.URL（MemberAccess 起点，覆盖节点 1）
const defaultHttpRequestFieldTaintSource = ['URL']

// 返回值 source：方法调用结果作为 taint
// *http.Request: FormValue / PostFormValue（旁路：典型 Web 输入方法）
// *url.URL: Query（覆盖节点 2 .Query()）
// url.Values: Get（覆盖节点 3 .Get(...)）
const defaultHttpRequestFuncCallReturnValueTaintSource = ['FormValue', 'PostFormValue']
const defaultUrlURLFuncCallReturnValueTaintSource = ['Query']
const defaultUrlValuesFuncCallReturnValueTaintSource = ['Get']

/**
 * 获取 net/http default source（仅 source，无 entrypoint 自采集）
 * @returns 三类 taint source 数组
 */
function getGoHttpEntryPointAndSource(): {
  TaintSource: any[]
  FuncCallArgTaintSource: any[]
  FuncCallReturnValueTaintSource: any[]
} {
  const TaintSource: any[] = []
  const FuncCallArgTaintSource: any[] = []
  const FuncCallReturnValueTaintSource: any[] = []

  // *http.Request 字段 source
  for (const fieldName of defaultHttpRequestFieldTaintSource) {
    TaintSource.push({
      className: HttpRequestType,
      introPoint: 4,
      kind: 'GO_INPUT',
      path: fieldName,
      scopeFile: 'all',
      scopeFunc: 'all',
    })
  }

  // *http.Request 方法返回值 source
  for (const funcName of defaultHttpRequestFuncCallReturnValueTaintSource) {
    FuncCallReturnValueTaintSource.push({
      values: [0],
      calleeType: HttpRequestType,
      introPoint: 4,
      kind: 'GO_INPUT',
      fsig: funcName,
      scopeFile: 'all',
      scopeFunc: 'all',
    })
  }

  // *url.URL 方法返回值 source
  for (const funcName of defaultUrlURLFuncCallReturnValueTaintSource) {
    FuncCallReturnValueTaintSource.push({
      values: [0],
      calleeType: UrlURLType,
      introPoint: 4,
      kind: 'GO_INPUT',
      fsig: funcName,
      scopeFile: 'all',
      scopeFunc: 'all',
    })
  }

  // url.Values 方法返回值 source
  for (const funcName of defaultUrlValuesFuncCallReturnValueTaintSource) {
    FuncCallReturnValueTaintSource.push({
      values: [0],
      calleeType: UrlValuesType,
      introPoint: 4,
      kind: 'GO_INPUT',
      fsig: funcName,
      scopeFile: 'all',
      scopeFunc: 'all',
    })
  }

  return {
    TaintSource,
    FuncCallArgTaintSource,
    FuncCallReturnValueTaintSource,
  }
}

module.exports = {
  getGoHttpEntryPointAndSource,
}
