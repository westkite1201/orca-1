import { isTerminalHarnessCandidateStatus, type HarnessCandidate } from './harness-types'

// Why: the main process also reads these strings back as persisted state
// markers, so recovery progress cannot get its own field without reworking the
// candidate state machine. Naming them here lets the UI tell "still working"
// apart from "broken" without duplicating literals across processes.
export const HARNESS_DISPATCH_CONFIRMATION_PENDING =
  'Dispatch recovered after restart; waiting for worker confirmation.'
export const HARNESS_WORKTREE_LISTING_PENDING =
  'Candidate worktree recovery is waiting for a complete worktree listing.'
export const HARNESS_WORKTREE_CREATION_PENDING =
  'Candidate worktree recovery is waiting for creation to finish.'
export const HARNESS_AGENT_TERMINAL_PENDING =
  'Candidate recovery is waiting for its agent terminal.'

/** Recorded as the run's fatal error when the user releases a stuck run. */
export const HARNESS_RUN_CANCELLED = 'Run cancelled.'

const HARNESS_CANDIDATE_PENDING_NOTICES: ReadonlySet<string> = new Set([
  HARNESS_DISPATCH_CONFIRMATION_PENDING,
  HARNESS_WORKTREE_LISTING_PENDING,
  HARNESS_WORKTREE_CREATION_PENDING,
  HARNESS_AGENT_TERMINAL_PENDING
])

export function isHarnessCandidatePendingNotice(message: string | null): boolean {
  return message !== null && HARNESS_CANDIDATE_PENDING_NOTICES.has(message)
}

/** The candidate's `error` when it reports progress rather than a failure. */
export function harnessCandidatePendingNotice(candidate: HarnessCandidate): string | null {
  return isHarnessCandidatePendingNotice(candidate.error) ? candidate.error : null
}

/** The candidate's `error` when it reports a real failure. */
export function harnessCandidateFailure(candidate: HarnessCandidate): string | null {
  return isHarnessCandidatePendingNotice(candidate.error) ? null : candidate.error
}

export function terminalizeHarnessCandidates(
  candidates: readonly HarnessCandidate[],
  fatalError: string,
  now: number
): HarnessCandidate[] {
  // Why: a fatal run rejects every later candidate write, so a lane left
  // non-terminal could never be updated or monitored again.
  return candidates.map((candidate) =>
    isTerminalHarnessCandidateStatus(candidate.status)
      ? candidate
      : {
          ...candidate,
          status: 'failed' as const,
          error: harnessCandidateFailure(candidate) ?? fatalError,
          updatedAt: now,
          completedAt: candidate.completedAt ?? now
        }
  )
}

export function canResumeHarnessCandidate(candidate: HarnessCandidate): boolean {
  // Why: resuming only helps a lane that is still live and stuck on a real
  // failure; a pending notice means monitoring is already making progress.
  return (
    !isTerminalHarnessCandidateStatus(candidate.status) &&
    harnessCandidateFailure(candidate) !== null
  )
}
