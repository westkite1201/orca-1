import type { GitBranchChangeStatus } from './git-status-types'

export type HarnessAgent = 'codex' | 'claude'

export type HarnessRunMode = 'comparison' | 'orchestrator'

export type HarnessCandidateStatus =
  | 'pending'
  | 'creating'
  | 'ready'
  | 'running'
  | 'worker_done'
  | 'verifying'
  | 'verified'
  | 'failed'

export type HarnessRunStatus = 'preparing' | 'running' | 'verifying' | 'completed' | 'failed'

export type HarnessVerificationSummary = {
  command: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  outputTail: string
  outputTruncated: boolean
  error: string | null
  startedAt: number
  completedAt: number
}

export type HarnessChangedFile = {
  path: string
  status: GitBranchChangeStatus
  oldPath?: string
  added?: number
  removed?: number
}

export type HarnessDiffSummary = {
  headSha: string | null
  diffStat: string
  changedFiles: HarnessChangedFile[]
  untrackedPaths: string[]
  capturedAt: number
  error: string | null
}

export type HarnessWorkerResult = {
  messageId: string
  subject: string
  body: string
  payload: string | null
  receivedAt: number
}

export type HarnessCandidate<TAgent extends HarnessAgent = HarnessAgent> = {
  id: string
  agent: TAgent
  status: HarnessCandidateStatus
  worktreeId: string | null
  worktreePath: string | null
  branch: string | null
  agentTerminalHandle: string | null
  agentTerminalPaneKey: string | null
  verificationTerminalHandle: string | null
  verificationTerminalPaneKey: string | null
  verificationTerminalOwnership: 'pending' | 'owned' | 'stopped' | null
  taskId: string | null
  dispatchId: string | null
  workerResult: HarnessWorkerResult | null
  verification: HarnessVerificationSummary | null
  diff: HarnessDiffSummary | null
  error: string | null
  createdAt: number
  updatedAt: number
  startedAt: number | null
  recoveryStartedAt: number | null
  /** Persists the child-lane shutdown deadline across app restarts. */
  childLaneDrainStartedAt: number | null
  /** Worker completion stays explicit because verification cannot substitute for worker_done. */
  workerCompletedAt: number | null
  completedAt: number | null
}

export type HarnessRun = {
  id: string
  mode: HarnessRunMode
  repoId: string
  sourceWorktreeId: string
  sourceWorktreePath: string
  goal: string
  verificationCommand: string
  baseSha: string
  candidates: HarnessCandidate[]
  fatalError: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export type HarnessRunCreateInput = Pick<
  HarnessRun,
  'repoId' | 'sourceWorktreeId' | 'sourceWorktreePath' | 'goal' | 'verificationCommand' | 'baseSha'
> & { mode?: HarnessRunMode }

export type HarnessStartInput = {
  /** Runtime worktree selector, such as `id:<worktree-id>`. */
  worktree: string
  goal: string
  verificationCommand: string
  mode?: HarnessRunMode
}

export type HarnessCandidatePatch = Partial<
  Pick<
    HarnessCandidate,
    | 'status'
    | 'worktreeId'
    | 'worktreePath'
    | 'branch'
    | 'agentTerminalHandle'
    | 'agentTerminalPaneKey'
    | 'verificationTerminalHandle'
    | 'verificationTerminalPaneKey'
    | 'verificationTerminalOwnership'
    | 'taskId'
    | 'dispatchId'
    | 'workerResult'
    | 'verification'
    | 'diff'
    | 'error'
    | 'startedAt'
    | 'recoveryStartedAt'
    | 'childLaneDrainStartedAt'
    | 'workerCompletedAt'
    | 'completedAt'
  >
>

const NEXT_HARNESS_CANDIDATE_STATUS = {
  pending: 'creating',
  creating: 'ready',
  ready: 'running',
  running: 'worker_done',
  worker_done: 'verifying',
  verifying: 'verified'
} as const satisfies Record<
  Exclude<HarnessCandidateStatus, 'verified' | 'failed'>,
  HarnessCandidateStatus
>

export function canTransitionHarnessCandidateStatus(
  from: HarnessCandidateStatus,
  to: HarnessCandidateStatus
): boolean {
  if (from === 'verified' || from === 'failed') {
    return false
  }
  return to === 'failed' || NEXT_HARNESS_CANDIDATE_STATUS[from] === to
}

function isTerminalHarnessCandidateStatus(status: HarnessCandidateStatus): boolean {
  return status === 'verified' || status === 'failed'
}

export function deriveHarnessRunStatus(run: HarnessRun): HarnessRunStatus {
  if (run.fatalError !== null) {
    return 'failed'
  }
  // Why: a comparison can finish with failed candidates, but a single
  // coordinator failure is the Orchestrator run's outcome.
  if (
    run.mode === 'orchestrator' &&
    run.candidates.length === 1 &&
    run.candidates[0].status === 'failed'
  ) {
    return 'failed'
  }
  if (run.candidates.every((candidate) => isTerminalHarnessCandidateStatus(candidate.status))) {
    return 'completed'
  }
  if (
    run.candidates.some(
      (candidate) => candidate.status === 'verifying' || candidate.status === 'verified'
    )
  ) {
    return 'verifying'
  }
  if (
    run.candidates.some(
      (candidate) =>
        candidate.status === 'running' ||
        candidate.status === 'worker_done' ||
        candidate.status === 'failed'
    )
  ) {
    return 'running'
  }
  return 'preparing'
}

export function hasHarnessActualChanges(diff: HarnessDiffSummary | null): boolean {
  // A rendered diffstat is not evidence by itself; require paths collected from Git.
  return (
    diff !== null &&
    diff.error === null &&
    (diff.changedFiles.length > 0 || diff.untrackedPaths.length > 0)
  )
}

export function isHarnessCandidateVerified(
  candidate: HarnessCandidate,
  expectedVerificationCommand: string
): boolean {
  const verification = candidate.verification
  return (
    candidate.status === 'verified' &&
    candidate.error === null &&
    candidate.workerResult != null &&
    candidate.workerCompletedAt !== null &&
    candidate.workerResult.receivedAt <= candidate.workerCompletedAt &&
    verification !== null &&
    verification.command === expectedVerificationCommand &&
    verification.exitCode === 0 &&
    !verification.timedOut &&
    verification.error === null &&
    verification.startedAt >= candidate.workerCompletedAt &&
    verification.completedAt >= verification.startedAt &&
    hasHarnessActualChanges(candidate.diff)
  )
}
