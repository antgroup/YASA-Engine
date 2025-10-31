const FindingUtil = require('../../../util/finding-util')

/**
 * ResultManager接口 - 用于管理检测结果
 */
export interface IResultManager {
  findings: Record<string, any[]>
  getFindings(): Record<string, any[]>
  clearFindings(): void
  newFinding(finding: Record<string, any>, outputStrategyId?: string): void
}

/**
 * ResultManager类 - 实现结果管理
 */
class ResultManager implements IResultManager {
  findings: Record<string, any[]>

  /**
   * Constructor of ResultManager
   */
  constructor() {
    this.findings = {}
  }

  /**
   * get all findings, including every checkers' findings
   */
  getFindings(): Record<string, any[]> {
    return this.findings
  }

  /**
   * clear all findings
   */
  clearFindings(): void {
    this.findings = {}
  }

  /**
   * add a new finding
   * @param finding finding object
   * @param outputStrategyId output Strategy Id
   */
  newFinding(finding: Record<string, any>, outputStrategyId?: string): void {
    if (finding.node) {
      FindingUtil.addFinding(this.findings, finding, outputStrategyId, finding.node.loc)
    } else {
      FindingUtil.addFinding(this.findings, finding, outputStrategyId)
    }
  }
}

module.exports = ResultManager
