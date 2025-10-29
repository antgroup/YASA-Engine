const logger = require('./logger')(__filename)

// various statistics data
const Statistics = {
  numProcessedFiles: 0,
  numFailedParsingFiles: 0,
  fileIssues: {} as Record<string, number>,

  numProcessedFunctions: 0,

  numProcessedInstructions: 0,

  numContexts: 0,
  numChecks: 0 as number,

  parsingTime: 0,

  checkFiringTime: 0 as number,
  singleCheckTimes: new Map(),
  singleTriggerTimes: new Map(),

  taintCheckTime: 0,
  recordTriggerTime(trigger: string, n: number) {
    const t = this.singleTriggerTimes.get(trigger) || 0
    this.singleTriggerTimes.set(trigger, n + t)
  },

  print() {
    if (this.numProcessedFiles) logger.info('Number of scanned files:', this.numProcessedFiles.toLocaleString())
    if (this.numFailedParsingFiles)
      logger.info('\t#files unable to be parsed:', this.numFailedParsingFiles.toLocaleString())
    printFileIssues(this.fileIssues, (this as any).maindir)

    if (this.numProcessedFunctions)
      logger.info('Number of scanned functions (function closures):', this.numProcessedFunctions.toLocaleString())
    if (this.numContexts) logger.info('Number of contexts:', this.numContexts)

    logger.info('Loading and parsing:', `${this.parsingTime.toLocaleString()}ms`)
    logger.info('Checking rule firing:', `${this.checkFiringTime.toLocaleString()}ms`)
    if (this.taintCheckTime) logger.info('\tTaint checking:', `${this.taintCheckTime.toLocaleString()}ms`)
    logger.info('Number of checks:', this.numChecks.toLocaleString())
    // logger.info(this.singleTriggerTimes.toLocaleString());
  },
}

/**
 * Print "filename: #issues"
 * @param fileIssueMap
 * @param fileIssues
 * @param maindir
 */
function printFileIssues(fileIssues: Record<string, number>, maindir: string) {
  logger.info('Scanned source file and its #defects:')
  let maindir_len = 0
  if (maindir) {
    const last_s = maindir.lastIndexOf('/')
    if (last_s > 0) maindir_len = last_s + 1
  }

  for (const key in fileIssues) {
    if (typeof key === 'string') {
      const fname = maindir_len ? key.substring(maindir_len) : key
      logger.info('\t', fname, ':', fileIssues[key])
    }
  }
}

/**
 * increase by 1 the number of issues associated with a file
 * @param fname
 */
;(Statistics as any).incFileIssues = function (fname: string): void {
  const n = Statistics.fileIssues[fname]
  if (!n) Statistics.fileIssues[fname] = 1
  else Statistics.fileIssues[fname] = n + 1
}

// ***

export default Statistics
