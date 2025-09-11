/**
 *
 */
class OutputStrategy {
  outputFilePath

  /**
   *
   */
  getOutputFilePath() {
    return this.outputFilePath
  }

  /**
   * interface to output the finding
   *
   * @param resultManager
   * @param outputFilePath
   * @param config
   * @param printf
   */
  outputFindings(resultManager, outputFilePath, config, printf) {}
}

module.exports = OutputStrategy
