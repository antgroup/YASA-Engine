/**
 * AnalysisContext - 项目级分析上下文
 *
 * 仅 topScope 持有，Analyzer 共享引用。
 * 统一归组项目级分析数据，替代 topScope 上散落的 manager 属性。
 */
export class AnalysisContext {
  ast: any = null
  symbols: any = null
  modules: any = null
  packages: any = null
  files: Record<string, any> | null = null
  funcs: Record<string, any> | null = null
}
