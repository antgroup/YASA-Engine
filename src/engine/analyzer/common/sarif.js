const { formatSanitizerTags } = require('../../../checker/sanitizer/sanitizer-checker')

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
 */
function prepareResult(title, level, rank, entrypoint, sinkInfo, trace, location, matchedSanitizerTags) {
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
 * @param affectedNodeName
 */
function prepareLocation(startLine, startColumn, endLine, endColumn, uri, snippetText, affectedNodeName) {
  const res = {
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
    },
  }
  if (affectedNodeName) {
    res.physicalLocation.region.snippet.affectedNodeName = affectedNodeName
  }
  return res
}

/**
 *
 * @param locations
 */
function prepareTrace(locations) {
  const newLocations = []
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
function prepareSarifFormat(results, graphs) {
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

module.exports = { prepareResult, prepareLocation, prepareTrace, prepareSarifFormat }
