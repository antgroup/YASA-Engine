import assert from 'assert'
import { describe, it } from 'mocha'
import {
  JavaEntrypointFindingCollector,
  JavaEntrypointFindingCollectorRegistry,
} from '../src/checker/taint/java/java-entrypoint-finding-collector'

type Finding = { id: string }

describe('Java entrypoint finding collector', () => {
  it('keeps overload candidates and normal signatures, then emits only unmatched candidates', () => {
    const collector = new JavaEntrypointFindingCollector<string, Finding>()
    collector.recordCandidate('candidate', { id: 'first' })
    collector.recordCandidate('candidate', { id: 'duplicate' })
    collector.recordCandidate('normal', { id: 'suppressed' })
    collector.recordNormal('normal')
    collector.recordNormal('normal')

    const emitted: Finding[] = []
    const checked: Finding[] = []
    collector.complete((finding) => {
      checked.push(finding)
      return true
    }, (finding) => emitted.push(finding))

    assert.deepStrictEqual(checked, [{ id: 'first' }])
    assert.deepStrictEqual(emitted, [{ id: 'first' }])
    assert.strictEqual(collector.isEmpty, true)
  })

  it('does not globally emit a candidate before complete promotes it', () => {
    const collector = new JavaEntrypointFindingCollector<string, Finding>()
    const globalFindings: Finding[] = []
    collector.registerCandidate('candidate', { id: 'candidate' })
    assert.deepStrictEqual(globalFindings, [])
    collector.complete(() => true, (finding) => globalFindings.push(finding))
    assert.deepStrictEqual(globalFindings, [{ id: 'candidate' }])
  })

  it('retains state across a timeout rerun and clears after final timeout', () => {
    const collector = new JavaEntrypointFindingCollector<string, Finding>()
    collector.recordCandidate('candidate', { id: 'before-rerun' })
    collector.deferForRerun()
    collector.recordNormal('normal-on-rerun')
    assert.strictEqual(collector.isEmpty, false)
    collector.finalize('timeout')
    assert.strictEqual(collector.isEmpty, true)
  })

  it('isolates consecutive and concurrent logical entrypoints', () => {
    const registry = new JavaEntrypointFindingCollectorRegistry<string, Finding>()
    const first = registry.get('first')
    const second = registry.get('second')
    first.recordCandidate('same-signature', { id: 'first' })
    second.recordCandidate('same-signature', { id: 'second' })

    const emitted: Finding[] = []
    registry.complete('first', () => true, (finding) => emitted.push(finding))
    assert.deepStrictEqual(emitted, [{ id: 'first' }])
    assert.strictEqual(registry.size, 1)

    registry.finalize('second', 'skip')
    assert.strictEqual(registry.size, 0)
    assert.strictEqual(first.isEmpty, true)
    assert.strictEqual(second.isEmpty, true)
  })

  it('promotes candidates through a configured adapter on normal completion', () => {
    const registry = new JavaEntrypointFindingCollectorRegistry<string, Finding>()
    const promoted: Finding[] = []
    registry.configurePromoter({ isNewFinding: () => true, emit: (finding) => promoted.push(finding) })
    registry.get('normal').recordCandidate('candidate', { id: 'promoted' })
    registry.complete('normal')
    assert.deepStrictEqual(promoted, [{ id: 'promoted' }])
    assert.strictEqual(registry.size, 0)
  })

  it('does not promote candidates after an execution exception', () => {
    const registry = new JavaEntrypointFindingCollectorRegistry<string, Finding>()
    const promoted: Finding[] = []
    registry.configurePromoter({ isNewFinding: () => true, emit: (finding) => promoted.push(finding) })
    registry.get('exception').recordCandidate('candidate', { id: 'discarded' })
    registry.finalize('exception', 'exception')
    assert.deepStrictEqual(promoted, [])
    assert.strictEqual(registry.size, 0)
  })

  it('promotes after rerun success and aborts after final timeout', () => {
    const registry = new JavaEntrypointFindingCollectorRegistry<string, Finding>()
    const promoted: Finding[] = []
    registry.configurePromoter({ isNewFinding: () => true, emit: (finding) => promoted.push(finding) })
    registry.get('rerun').recordCandidate('candidate', { id: 'rerun-success' })
    registry.complete('rerun')
    assert.deepStrictEqual(promoted, [{ id: 'rerun-success' }])
    registry.get('timeout').recordCandidate('candidate', { id: 'timeout-discarded' })
    registry.finalize('timeout', 'timeout')
    assert.strictEqual(registry.size, 0)
    assert.deepStrictEqual(promoted, [{ id: 'rerun-success' }])
  })


  it('isolates a new production run and terminalizes same-key reruns only once', () => {
    const registry = new JavaEntrypointFindingCollectorRegistry<string, Finding>()
    const promoted: Finding[] = []
    registry.configurePromoter({ isNewFinding: () => true, emit: (finding) => promoted.push(finding) })
    const collector = registry.get('same-key')
    collector.recordCandidate('first', { id: 'first-run' })
    collector.deferForRerun()
    collector.recordCandidate('second', { id: 'second-run' })
    registry.beginRun()
    assert.strictEqual(registry.size, 0)
    registry.get('same-key').recordCandidate('new-run', { id: 'new-run' })
    registry.complete('same-key')
    assert.deepStrictEqual(promoted, [{ id: 'new-run' }])
    assert.strictEqual(registry.size, 0)
  })

  it('keeps caught exceptions and cross-entry timeout states from promoting', () => {
    const registry = new JavaEntrypointFindingCollectorRegistry<string, Finding>()
    const promoted: Finding[] = []
    registry.configurePromoter({ isNewFinding: () => true, emit: (finding) => promoted.push(finding) })
    registry.get('java-exception').recordCandidate('candidate', { id: 'java-error' })
    registry.get('spring-timeout').recordCandidate('candidate', { id: 'spring-timeout' })
    registry.finalize('java-exception', 'exception')
    registry.finalize('spring-timeout', 'timeout')
    assert.deepStrictEqual(promoted, [])
    assert.strictEqual(registry.size, 0)
  })

  it('promotes normal entry A while aborting timed-out entry B', () => {
    const registry = new JavaEntrypointFindingCollectorRegistry<string, Finding>()
    const promoted: Finding[] = []
    registry.configurePromoter({ isNewFinding: () => true, emit: (finding) => promoted.push(finding) })
    registry.get('entry-A').recordCandidate('candidate', { id: 'A' })
    registry.get('entry-B').recordCandidate('candidate', { id: 'B' })
    registry.complete('entry-A')
    registry.finalize('entry-B', 'timeout')
    assert.deepStrictEqual(promoted, [{ id: 'A' }])
    assert.strictEqual(registry.size, 0)
  })


  it('retains first-timeout candidates for rerun promotion, then aborts final timeout', () => {
    const registry = new JavaEntrypointFindingCollectorRegistry<string, Finding>()
    const promoted: Finding[] = []
    registry.configurePromoter({ isNewFinding: () => true, emit: (finding) => promoted.push(finding) })
    const success = registry.get('rerun-success')
    success.recordCandidate('candidate', { id: 'first-timeout' })
    success.deferForRerun()
    assert.strictEqual(success.isEmpty, false)
    registry.complete('rerun-success')
    assert.deepStrictEqual(promoted, [{ id: 'first-timeout' }])
    const failure = registry.get('rerun-final-timeout')
    failure.recordCandidate('candidate', { id: 'discarded' })
    failure.deferForRerun()
    registry.finalize('rerun-final-timeout', 'timeout')
    assert.deepStrictEqual(promoted, [{ id: 'first-timeout' }])
    assert.strictEqual(registry.size, 0)
  })


  it('aggregates same-key reruns and terminalizes only at group end', () => {
    const registry = new JavaEntrypointFindingCollectorRegistry<string, Finding>()
    const promoted: Finding[] = []
    registry.configurePromoter({ isNewFinding: () => true, emit: (finding) => promoted.push(finding) })
    const collector = registry.get('java-multi-rerun')
    collector.recordCandidate('candidate', { id: 'candidate' })
    collector.deferForRerun()
    assert.strictEqual(collector.isEmpty, false)
    collector.deferForRerun()
    assert.strictEqual(collector.isEmpty, false)
    registry.complete('java-multi-rerun')
    assert.deepStrictEqual(promoted, [{ id: 'candidate' }])
  })


  it('failure takes priority over same-key timeout and survives rerun group', () => {
    const registry = new JavaEntrypointFindingCollectorRegistry<string, Finding>()
    const promoted: Finding[] = []
    registry.configurePromoter({ isNewFinding: () => true, emit: (finding) => promoted.push(finding) })
    const collector = registry.get('spring-failed-timeout')
    collector.recordCandidate('candidate', { id: 'must-abort' })
    collector.deferForRerun()
    registry.finalize('spring-failed-timeout', 'exception')
    assert.deepStrictEqual(promoted, [])
    assert.strictEqual(registry.size, 0)
  })

  it('clears state when the dedup callback throws', () => {
    const collector = new JavaEntrypointFindingCollector<string, Finding>()
    collector.recordCandidate('candidate', { id: 'candidate' })
    assert.throws(() => collector.complete(() => { throw new Error('dedup failed') }, () => undefined), /dedup failed/)
    assert.strictEqual(collector.isEmpty, true)
  })
})
