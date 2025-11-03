const { formatSanitizerTags } = require('../../../checker/sanitizer/sanitizer-checker')

interface SarifLocation {
  physicalLocation?: {
    artifactLocation?: { uri: string }
    region?: any
    nodeHash: string
  }
  [key: string]: any
}

interface CallstackElement {
  type: number
  nodeHash: string
}

interface SarifResult {
  message: { text: string }
  level: string
  rank: number
  entrypoint: any
  sinkInfo: any
  codeFlows: any
  locations: SarifLocation[]
  matchedSanitizerTags: any
  callstack: CallstackElement[]
}

/**
 *
 * @param title
 * @param level
 * @param rank
 * @param entrypoint
 * @param sinkInfo
 * @param trace
 * @param location
 * @param matchedSanitizerTags
 * @param callstackElments
 */
function prepareResult(
  title: string,
  level: string,
  rank: number,
  entrypoint: any,
  sinkInfo: any,
  trace: any,
  location: SarifLocation,
  matchedSanitizerTags: any,
  callstackElments: CallstackElement[]
): SarifResult {
  return {
    message: {
      text: title,
    },
    level,
    rank,
    entrypoint,
    sinkInfo,
    codeFlows: trace,
    locations: [location],
    matchedSanitizerTags: formatSanitizerTags(matchedSanitizerTags),
    callstack: callstackElments,
  }
}

/**
 *
 * @param startLine
 * @param startColumn
 * @param endLine
 * @param endColumn
 * @param uri
 * @param snippetText
 * @param nodeHash
 * @param affectedNodeName
 */
function prepareLocation(
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
  uri: string,
  snippetText: string,
  nodeHash: string,
  affectedNodeName?: string
): SarifLocation {
  const res: SarifLocation = {
    physicalLocation: {
      artifactLocation: { uri },
      region: {
        startLine,
        startColumn,
        endLine,
        endColumn,
        snippet: {
          text: snippetText,
        },
      },
      nodeHash,
    },
  }
  if (affectedNodeName) {
    res.physicalLocation!.region.snippet.affectedNodeName = affectedNodeName
  }
  return res
}

/**
 *
 * @param locations
 */
function prepareTrace(locations: SarifLocation[]): any[] {
  const newLocations: any[] = []
  for (let i = 0; i < locations.length; i++) {
    newLocations.push({
      location: {
        message: {
          text: `Step ${i.toString()}`,
        },
        physicalLocation: locations[i].physicalLocation,
      },
    })
  }
  return [
    {
      threadFlows: [
        {
          locations: newLocations,
        },
      ],
    },
  ]
}

/**
 *
 * @param results
 * @param graphs
 */
function prepareSarifFormat(results: SarifResult[], graphs: any): Record<string, any> {
  return {
    runs: [
      {
        tool: {
          driver: {
            name: 'yasa',
            version: '0.1',
          },
        },
        graphs,
        results,
      },
    ],
    version: '2.1.0',
  }
}

/**
 *
 */
function prepareCallstackElements(callstack: any[]): CallstackElement[] {
  const resultArray: CallstackElement[] = []
  if (!callstack) {
    return resultArray
  }

  for (const element of callstack) {
    if (element.vtype === 'fclos') {
      const callstackElement: CallstackElement = {
        type: 0,
        nodeHash: element.ast?._meta?.nodehash || '',
      }
      resultArray.push(callstackElement)
    }
  }

  return resultArray
}

module.exports = { prepareResult, prepareLocation, prepareTrace, prepareSarifFormat, prepareCallstackElements }
