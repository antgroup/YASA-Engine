import type { IResultManager } from './result-manager'

/**
 * ResultManagerProxy：checker 持有的 ResultManager 替身。
 * finding 直接写入全局 ResultManager，避免 executor scope 内重复构造合并视图。
 */
export class ResultManagerProxy implements IResultManager {
  private readonly globalResultManager: IResultManager

  constructor(globalResultManager: IResultManager) {
    this.globalResultManager = globalResultManager
  }

  get findings(): Record<string, any[]> {
    return this.globalResultManager.findings
  }

  set findings(value: Record<string, any[]>) {
    this.globalResultManager.findings = value
  }

  getFindings(): Record<string, any[]> {
    return this.globalResultManager.getFindings()
  }

  clearFindings(): void {
    this.globalResultManager.clearFindings()
  }

  newFinding(finding: Record<string, any>, outputStrategyId?: string): void {
    // 当前 EP 的去重视图保持全局一致，避免本地合并视图反复分配临时数组。
    this.globalResultManager.newFinding(finding, outputStrategyId)
  }

  /**
   * 获取底层全局 ResultManager，用于 executor 结束后的指标与兼容合并路径。
   */
  getGlobalResultManager(): IResultManager {
    return this.globalResultManager
  }
}
