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
  // TODO: 排查为什么会不是string
  if (affectedNodeName && typeof affectedNodeName === 'string') {
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
 * 按 (sink_uri, sink_line, entrypoint) 聚合同 sink 同 ep 的多条 result，
 * 把各自的 codeFlows 合并到一条 result 的 codeFlows 数组中。
 * 用途：D24 triage 发现 43% 的 SARIF result 是同 sink 不同 codeFlow 的枚举重复，
 * 下游人工 triage 成本巨大；SARIF 规范允许一个 result 携带多个 codeFlows。
 *
 * 聚合 key：`uri|startLine|ep.filePath::ep.functionName::ep.funcReceiverType::ep.attribute`。
 * 以下情况不聚合（按原顺序独立保留）：
 *   - locations 为空或缺失 physicalLocation / startLine
 *   - entrypoint 缺失 functionName（无法判定同 ep）
 * 合并时保留第一条 result 的非 codeFlows 字段（level / rank / message / sinkInfo /
 * callstack / matchedSanitizerTags），codeFlows 依原始顺序拼接且自动去重完全相同的枝。
 * @param results
 */
function dedupResultsBySinkAndEntrypoint(results: SarifResult[]): SarifResult[] {
  if (!Array.isArray(results) || results.length <= 1) {
    return results
  }
  const keyToIdx = new Map<string, number>()
  const seenFlowsPerKey = new Map<string, Set<string>>()
  const final: SarifResult[] = []

  for (const r of results) {
    const key = buildDedupKey(r)
    if (key === null) {
      final.push(r)
      continue
    }
    const existingIdx = keyToIdx.get(key)
    if (existingIdx === undefined) {
      keyToIdx.set(key, final.length)
      final.push(r)
      const seen = new Set<string>()
      for (const flow of toFlowArray(r.codeFlows)) {
        seen.add(serializeFlow(flow))
      }
      seenFlowsPerKey.set(key, seen)
      continue
    }
    const existing = final[existingIdx]
    if (!Array.isArray(existing.codeFlows)) {
      existing.codeFlows = []
    }
    const seen = seenFlowsPerKey.get(key)!
    for (const flow of toFlowArray(r.codeFlows)) {
      const sig = serializeFlow(flow)
      if (seen.has(sig)) continue
      seen.add(sig)
      existing.codeFlows.push(flow)
    }
  }
  return final
}

function buildDedupKey(r: SarifResult): string | null {
  const loc = r?.locations?.[0]
  const uri = loc?.physicalLocation?.artifactLocation?.uri
  const startLine = loc?.physicalLocation?.region?.startLine
  const ep = r?.entrypoint
  const epFuncName = ep?.functionName
  if (!uri || typeof startLine !== 'number' || !epFuncName) {
    return null
  }
  const epFilePath = ep?.filePath ?? ''
  const epAttr = ep?.attribute ?? ''
  const epReceiver = ep?.funcReceiverType ?? ''
  return `${uri}|${startLine}|${epFilePath}::${epFuncName}::${epReceiver}::${epAttr}`
}

function toFlowArray(codeFlows: any): any[] {
  if (!codeFlows) return []
  if (Array.isArray(codeFlows)) return codeFlows
  return [codeFlows]
}

function serializeFlow(flow: any): string {
  try {
    return JSON.stringify(flow)
  } catch (_err) {
    // 极端场景下 flow 含循环引用，退化为唯一随机签名（不聚合）
    return `__ref__${Math.random()}`
  }
}

/**
 *
 * @param results
 * @param graphs
 */
function prepareSarifFormat(results: SarifResult[], graphs: any): Record<string, any> {
  const deduped = results
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
        results: deduped,
      },
    ],
    version: '2.1.0',
  }
}

/**
 * 将原始 callstack（fclos 数组）转换为 CallstackElement 数组
 * 如果传入 sinkNode，会在末尾追加 sink 点（type: 1），与 callchain 的约定一致
 * @param callstack
 * @param sinkNode
 */
function prepareCallstackElements(callstack: any[], sinkNode?: any): CallstackElement[] {
  const resultArray: CallstackElement[] = []
  if (!callstack && !sinkNode) {
    return resultArray
  }

  if (callstack) {
    for (const element of callstack) {
      if (element.vtype === 'fclos') {
        const callstackElement: CallstackElement = {
          type: 0,
          nodeHash: element.ast?.node?._meta?.nodehash,
        }
        resultArray.push(callstackElement)
      }
    }
  }

  if (sinkNode) {
    resultArray.push({
      type: 1,
      nodeHash: sinkNode._meta?.nodehash,
    })
  }

  return resultArray
}

module.exports = {
  prepareResult,
  prepareLocation,
  prepareTrace,
  prepareSarifFormat,
  prepareCallstackElements,
  dedupResultsBySinkAndEntrypoint,
}
