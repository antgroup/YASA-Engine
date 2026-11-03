// finding flush 后的 snapshot 转换：
// SARIF 已从 live AST 生成（含 snippet），flush 后将 live mutable reference 字段
// 替换为 primitive-only 结构，使 dedupIndex 中的 finding 与 analyzer 运行时解耦。
// 不预计算 _prettyPrint（SARIF 已写入，不再需要 snippet）。

function deepCloneLoc(loc: any): any {
  if (!loc) return undefined
  return {
    sourcefile: loc.sourcefile,
    start: loc.start ? { line: loc.start.line, column: loc.start.column } : undefined,
    end: loc.end ? { line: loc.end.line, column: loc.end.column } : undefined,
  }
}

export function snapshotFinding(finding: any): any {
  // 1. trace[].node → minimal snapshot（不预算 _prettyPrint，SARIF 已写入）
  if (finding.trace && Array.isArray(finding.trace)) {
    for (const item of finding.trace) {
      if (item.node) {
        item.node = {
          loc: deepCloneLoc(item.node.loc),
          _meta: item.node._meta ? { nodehash: item.node._meta.nodehash } : undefined,
        }
      }
    }
  }

  // 2. finding.node → minimal snapshot（不预算 _prettyPrint）
  if (finding.node) {
    finding.node = {
      loc: deepCloneLoc(finding.node.loc),
      _meta: finding.node._meta ? { nodehash: finding.node._meta.nodehash } : undefined,
      type: finding.node.type,
    }
  }

  // 3. callstack[] → minimal fclos snapshot（保留 ast.node.loc 供 dedup / SARIF 消费）
  if (finding.callstack && Array.isArray(finding.callstack)) {
    finding.callstack = finding.callstack.map((f: any) => {
      const nodeLoc = f?.ast?.node?.loc
      const nodeHash = f?.ast?.node?._meta?.nodehash
      return {
        qid: f?.qid,
        name: f?.name,
        sid: f?.sid,
        vtype: f?.vtype,
        ast: (nodeLoc || nodeHash) ? {
          node: {
            loc: deepCloneLoc(nodeLoc),
            _meta: nodeHash != null ? { nodehash: nodeHash } : undefined,
          },
        } : undefined,
      }
    })
  }

  // 4. callsites[] → deep clone loc
  if (finding.callsites && Array.isArray(finding.callsites)) {
    finding.callsites = finding.callsites.map((s: any) => ({
      code: s.code,
      nodeHash: s.nodeHash,
      loc: deepCloneLoc(s.loc),
    }))
  }

  // 5. nd / argNode 清空：与 analyzer 运行时解耦；dedup 走 finding.trace（getDedupTrace）
  finding.nd = undefined
  finding.argNode = undefined

  // 6. fclos / entry_fclos → minimal snapshot
  if (finding.fclos) {
    finding.fclos = {
      qid: finding.fclos.qid,
      sid: finding.fclos.sid,
      name: finding.fclos.name,
    }
  }
  if (finding.entry_fclos) {
    finding.entry_fclos = {
      qid: finding.entry_fclos.qid,
      sid: finding.entry_fclos.sid,
      name: finding.entry_fclos.name,
    }
  }

  // 7. entrypointLoc → deep clone
  if (finding.entrypointLoc) {
    finding.entrypointLoc = deepCloneLoc(finding.entrypointLoc)
  }

  return finding
}
