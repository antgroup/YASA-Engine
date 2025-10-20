const FindingUtil = require('../../../util/finding-util')

/**
 *
 */
class ResultManager {
  /**
   * Constructor of ResultManager
   */
  constructor() {
    this.findings = {}
  }

  /**
   * get all findings, including every checkers' findings
   */
  getFindings() {
    return this.findings
  }

  /**
   * clear all findings
   */
  clearFindings() {
    this.findings = {}
  }

  /**
   * add a new finding
   * @param finding finding object
   * @param outputStrategyId output Strategy Id
   */
  newFinding(finding, outputStrategyId) {
    if (finding.node) {
      FindingUtil.addFinding(this.findings, finding, outputStrategyId, finding.node.loc)
    } else {
      FindingUtil.addFinding(this.findings, finding, outputStrategyId)
    }
  }
}

module.exports = ResultManager
