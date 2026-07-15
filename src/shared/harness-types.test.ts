import { describe, expect, it } from 'vitest'
import {
  canTransitionHarnessCandidateStatus,
  deriveHarnessRunStatus,
  hasHarnessActualChanges,
  isHarnessCandidateVerified,
  type HarnessAgent,
  type HarnessCandidate,
  type HarnessCandidateStatus,
  type HarnessDiffSummary,
  type HarnessRun,
  type HarnessRunStatus
} from './harness-types'

const VERIFY_COMMAND = 'pnpm test'

function createCandidate<TAgent extends HarnessAgent>(
  agent: TAgent,
  status: HarnessCandidateStatus = 'pending'
): HarnessCandidate<TAgent> {
  return {
    id: `candidate-${agent}`,
    agent,
    status,
    worktreeId: null,
    worktreePath: null,
    branch: null,
    agentTerminalHandle: null,
    verificationTerminalHandle: null,
    taskId: null,
    dispatchId: null,
    verification: null,
    diff: null,
    error: null,
    createdAt: 10,
    updatedAt: 10,
    startedAt: null,
    workerCompletedAt: null,
    completedAt: null
  }
}

function createRun(
  codexStatus: HarnessCandidateStatus = 'pending',
  claudeStatus: HarnessCandidateStatus = 'pending'
): HarnessRun {
  return {
    id: 'run-1',
    repoId: 'repo-1',
    sourceWorktreeId: 'source-worktree',
    sourceWorktreePath: '/repo',
    goal: 'Implement the feature',
    verificationCommand: VERIFY_COMMAND,
    baseSha: 'a'.repeat(40),
    candidates: [createCandidate('codex', codexStatus), createCandidate('claude', claudeStatus)],
    fatalError: null,
    createdAt: 10,
    updatedAt: 10,
    completedAt: null
  }
}

function createDiff(overrides: Partial<HarnessDiffSummary> = {}): HarnessDiffSummary {
  return {
    headSha: 'b'.repeat(40),
    diffStat: '1 file changed, 1 insertion(+)',
    changedFiles: [{ path: 'src/feature.ts', status: 'modified' }],
    untrackedPaths: [],
    capturedAt: 40,
    error: null,
    ...overrides
  }
}

function createVerifiedCandidate(): HarnessCandidate<'codex'> {
  return {
    ...createCandidate('codex', 'verified'),
    workerCompletedAt: 20,
    completedAt: 40,
    verification: {
      command: VERIFY_COMMAND,
      exitCode: 0,
      timedOut: false,
      durationMs: 10,
      outputTail: 'passed',
      outputTruncated: false,
      error: null,
      startedAt: 30,
      completedAt: 40
    },
    diff: createDiff()
  }
}

describe('Harness candidate transitions', () => {
  it('allows each forward lifecycle step', () => {
    const statuses: HarnessCandidateStatus[] = [
      'pending',
      'creating',
      'ready',
      'running',
      'worker_done',
      'verifying',
      'verified'
    ]

    for (let index = 0; index < statuses.length - 1; index += 1) {
      expect(canTransitionHarnessCandidateStatus(statuses[index], statuses[index + 1])).toBe(true)
    }
  })

  it('allows failure from every nonterminal state', () => {
    const nonterminal: HarnessCandidateStatus[] = [
      'pending',
      'creating',
      'ready',
      'running',
      'worker_done',
      'verifying'
    ]

    for (const status of nonterminal) {
      expect(canTransitionHarnessCandidateStatus(status, 'failed')).toBe(true)
    }
  })

  it('rejects skips, reversals, repeats, and transitions out of terminal states', () => {
    expect(canTransitionHarnessCandidateStatus('pending', 'ready')).toBe(false)
    expect(canTransitionHarnessCandidateStatus('worker_done', 'running')).toBe(false)
    expect(canTransitionHarnessCandidateStatus('ready', 'ready')).toBe(false)
    expect(canTransitionHarnessCandidateStatus('verified', 'failed')).toBe(false)
    expect(canTransitionHarnessCandidateStatus('failed', 'pending')).toBe(false)
  })
})

describe('Harness run status', () => {
  it.each([
    ['pending', 'creating', 'preparing'],
    ['ready', 'ready', 'preparing'],
    ['running', 'ready', 'running'],
    ['worker_done', 'running', 'running'],
    ['failed', 'ready', 'running'],
    ['verifying', 'running', 'verifying'],
    ['verified', 'worker_done', 'verifying'],
    ['verified', 'failed', 'completed'],
    ['failed', 'failed', 'completed']
  ] satisfies [HarnessCandidateStatus, HarnessCandidateStatus, HarnessRunStatus][])(
    'derives %s and %s as %s',
    (codexStatus, claudeStatus, expected) => {
      expect(deriveHarnessRunStatus(createRun(codexStatus, claudeStatus))).toBe(expected)
    }
  )

  it('gives a run-level fatal error precedence', () => {
    const run = createRun('verified', 'failed')
    run.fatalError = 'Base SHA changed'

    expect(deriveHarnessRunStatus(run)).toBe('failed')
  })
})

describe('Harness verification evidence', () => {
  it('requires changed or untracked paths rather than diffstat text', () => {
    expect(hasHarnessActualChanges(createDiff())).toBe(true)
    expect(
      hasHarnessActualChanges(createDiff({ changedFiles: [], untrackedPaths: ['new-file.ts'] }))
    ).toBe(true)
    expect(hasHarnessActualChanges(createDiff({ changedFiles: [], untrackedPaths: [] }))).toBe(
      false
    )
    expect(hasHarnessActualChanges(createDiff({ error: 'git diff failed' }))).toBe(false)
    expect(hasHarnessActualChanges(null)).toBe(false)
  })

  it('accepts only verified candidates with worker, command, test, and Git evidence', () => {
    expect(isHarnessCandidateVerified(createVerifiedCandidate(), VERIFY_COMMAND)).toBe(true)

    const untrackedOnly = createVerifiedCandidate()
    untrackedOnly.diff = createDiff({ changedFiles: [], untrackedPaths: ['new-file.ts'] })
    expect(isHarnessCandidateVerified(untrackedOnly, VERIFY_COMMAND)).toBe(true)

    const withoutWorkerCompletion = createVerifiedCandidate()
    withoutWorkerCompletion.workerCompletedAt = null
    expect(isHarnessCandidateVerified(withoutWorkerCompletion, VERIFY_COMMAND)).toBe(false)

    const failedVerification = createVerifiedCandidate()
    failedVerification.verification = { ...failedVerification.verification!, exitCode: 1 }
    expect(isHarnessCandidateVerified(failedVerification, VERIFY_COMMAND)).toBe(false)

    const withoutChanges = createVerifiedCandidate()
    withoutChanges.diff = createDiff({ changedFiles: [], untrackedPaths: [] })
    expect(isHarnessCandidateVerified(withoutChanges, VERIFY_COMMAND)).toBe(false)

    expect(isHarnessCandidateVerified(createVerifiedCandidate(), 'pnpm lint')).toBe(false)
  })
})
