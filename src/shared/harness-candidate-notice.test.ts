import { describe, expect, it } from 'vitest'
import type { HarnessCandidate, HarnessCandidateStatus } from './harness-types'
import {
  HARNESS_AGENT_TERMINAL_PENDING,
  HARNESS_DISPATCH_CONFIRMATION_PENDING,
  HARNESS_WORKTREE_CREATION_PENDING,
  HARNESS_WORKTREE_LISTING_PENDING,
  canResumeHarnessCandidate,
  harnessCandidateFailure,
  harnessCandidatePendingNotice,
  isHarnessCandidatePendingNotice
} from './harness-candidate-notice'

function candidate(status: HarnessCandidateStatus, error: string | null = null): HarnessCandidate {
  return {
    id: 'run-1-codex',
    agent: 'codex',
    status,
    worktreeId: null,
    worktreePath: null,
    branch: null,
    agentTerminalHandle: null,
    agentTerminalPaneKey: null,
    verificationTerminalHandle: null,
    verificationTerminalPaneKey: null,
    verificationTerminalOwnership: null,
    taskId: null,
    dispatchId: null,
    workerResult: null,
    verification: null,
    diff: null,
    error,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    recoveryStartedAt: null,
    childLaneDrainStartedAt: null,
    workerCompletedAt: null,
    completedAt: null
  }
}

const PENDING_NOTICES = [
  HARNESS_DISPATCH_CONFIRMATION_PENDING,
  HARNESS_WORKTREE_LISTING_PENDING,
  HARNESS_WORKTREE_CREATION_PENDING,
  HARNESS_AGENT_TERMINAL_PENDING
]

describe('isHarnessCandidatePendingNotice', () => {
  it.each(PENDING_NOTICES)('treats %s as progress', (notice) => {
    expect(isHarnessCandidatePendingNotice(notice)).toBe(true)
  })

  it('treats a null error and real failures as not pending', () => {
    expect(isHarnessCandidatePendingNotice(null)).toBe(false)
    expect(isHarnessCandidatePendingNotice('The source worktree must be clean.')).toBe(false)
    // A pending notice embedded in a longer failure is still a failure.
    expect(
      isHarnessCandidatePendingNotice(`Dispatch check failed: ${HARNESS_AGENT_TERMINAL_PENDING}`)
    ).toBe(false)
  })
})

describe('harnessCandidatePendingNotice / harnessCandidateFailure', () => {
  it('routes a progress notice to the pending channel only', () => {
    const recovering = candidate('running', HARNESS_DISPATCH_CONFIRMATION_PENDING)
    expect(harnessCandidatePendingNotice(recovering)).toBe(HARNESS_DISPATCH_CONFIRMATION_PENDING)
    expect(harnessCandidateFailure(recovering)).toBeNull()
  })

  it('routes a real failure to the failure channel only', () => {
    const broken = candidate('running', 'Dispatch check failed: host unreachable')
    expect(harnessCandidateFailure(broken)).toBe('Dispatch check failed: host unreachable')
    expect(harnessCandidatePendingNotice(broken)).toBeNull()
  })

  it('reports neither channel when there is no error', () => {
    const healthy = candidate('running')
    expect(harnessCandidateFailure(healthy)).toBeNull()
    expect(harnessCandidatePendingNotice(healthy)).toBeNull()
  })
})

describe('canResumeHarnessCandidate', () => {
  // Why: restart recovery writes its notice onto `running` candidates, which the
  // previous status allowlist excluded — leaving the user with no Resume action.
  const NON_TERMINAL: HarnessCandidateStatus[] = [
    'pending',
    'creating',
    'ready',
    'running',
    'worker_done',
    'verifying'
  ]

  it.each(NON_TERMINAL)('offers resume for a failed %s candidate', (status) => {
    expect(canResumeHarnessCandidate(candidate(status, 'Dispatch check failed: boom'))).toBe(true)
  })

  it.each(NON_TERMINAL)('does not offer resume while %s is only pending', (status) => {
    expect(
      canResumeHarnessCandidate(candidate(status, HARNESS_DISPATCH_CONFIRMATION_PENDING))
    ).toBe(false)
  })

  it('does not offer resume for terminal candidates', () => {
    expect(canResumeHarnessCandidate(candidate('verified'))).toBe(false)
    expect(canResumeHarnessCandidate(candidate('failed', 'Worker reported failure: nope'))).toBe(
      false
    )
  })

  it('does not offer resume for a healthy candidate', () => {
    expect(canResumeHarnessCandidate(candidate('running'))).toBe(false)
  })
})
