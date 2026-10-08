const FindingUtil = require('../../../util/finding-util')

/**
 * ResultManager接口 - 用于管理检测结果
 */
export interface IResultManager {
  findings: Record<string, any[]>
  /** 跨入口 dedop 用的轻量 finding 记录（已 snapshot，无 AST 重引用） */
  dedupIndex: Record<string, any[]>
  /** 累积的 SARIF results（按 strategyId 存储已序列化的 SARIF 报告） */
  sarifResultsAccumulator: Record<string, any>
  getFindings(): Record<string, any[]>
  clearFindings(): void
  /** 清空当前 findings，保留 dedupIndex 和 sarifResultsAccumulator */
  clearFindingsKeepDedup(): void
  newFinding(finding: Record<string, any>, outputStrategyId?: string): void
}

/**
 * ResultManager类 - 实现结果管理
 */
class ResultManager implements IResultManager {
  findings: Record<string, any[]>
  dedupIndex: Record<string, any[]>
  sarifResultsAccumulator: Record<string, any>

  /**
   * Constructor of ResultManager
   */
  constructor() {
    this.findings = {}
    this.dedupIndex = {}
    this.sarifResultsAccumulator = {}
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
   * 清空当前批次 findings（释放 AST 重引用），保留 dedupIndex 和 sarifResultsAccumulator
   */
  clearFindingsKeepDedup(): void {
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
