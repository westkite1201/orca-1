import type { AutomationPrecheckResult } from '../../shared/automations-types'
import type { GitStatusResult } from '../../shared/git-status-types'
import {
  hasHarnessActualChanges,
  type HarnessCandidate,
  type HarnessDiffSummary,
  type HarnessRun,
  type HarnessVerificationSummary
} from '../../shared/harness-types'
import type { GitBranchCompareResult, Repo } from '../../shared/types'
import type { runAutomationPrecheck } from '../automations/precheck-runner'
import { buildHarnessDiffSummary } from './diff-summary'
import type { HarnessRuntimeCaller } from './runtime-caller'
import { isUnverifiedVerificationStopError } from './verification-terminal-error'

export type HarnessVerificationRunner = typeof runAutomationPrecheck

type VerificationEvidence = {
  diff: HarnessDiffSummary
  verification: HarnessVerificationSummary
  error: string | null
  retryable: boolean
}

type VerificationCommandStart = {
  diff: HarnessDiffSummary
  startedAt: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failedDiff(error: string, capturedAt: number): HarnessDiffSummary {
  return {
    headSha: null,
    diffStat: '',
    changedFiles: [],
    untrackedPaths: [],
    capturedAt,
    error
  }
}

function toVerificationSummary(result: AutomationPrecheckResult): HarnessVerificationSummary {
  const separator = result.stdout && result.stderr ? '\n' : ''
  return {
    command: result.command,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    outputTail: `${result.stdout}${separator}${result.stderr}`,
    outputTruncated: result.stdoutTruncated || result.stderrTruncated,
    error: result.error,
    startedAt: result.startedAt,
    completedAt: result.completedAt
  }
}

function failedVerification(
  command: string,
  startedAt: number,
  error: unknown
): HarnessVerificationSummary {
  const completedAt = Date.now()
  return {
    command,
    exitCode: null,
    timedOut: false,
    durationMs: Math.max(0, completedAt - startedAt),
    outputTail: '',
    outputTruncated: false,
    error: errorMessage(error),
    startedAt,
    completedAt
  }
}

function changedPaths(diff: HarnessDiffSummary): Set<string> {
  return new Set([
    ...diff.changedFiles.flatMap((entry) =>
      entry.oldPath ? [entry.path, entry.oldPath] : [entry.path]
    ),
    ...diff.untrackedPaths
  ])
}

function verificationError(
  run: HarnessRun,
  candidate: HarnessCandidate,
  preVerificationDiff: HarnessDiffSummary,
  finalDiff: HarnessDiffSummary,
  verification: HarnessVerificationSummary
): string | null {
  if (!candidate.workerResult) {
    return 'Worker completion evidence is missing.'
  }
  if (preVerificationDiff.error) {
    return `Pre-verification Git evidence failed: ${preVerificationDiff.error}`
  }
  if (!hasHarnessActualChanges(preVerificationDiff)) {
    return 'Candidate produced no Git changes before verification.'
  }
  if (finalDiff.error) {
    return `Post-verification Git evidence failed: ${finalDiff.error}`
  }
  if (!hasHarnessActualChanges(finalDiff)) {
    return 'Verification removed all candidate Git changes.'
  }
  const finalPaths = changedPaths(finalDiff)
  const removedWorkerPaths = [...changedPaths(preVerificationDiff)].filter(
    (path) => !finalPaths.has(path)
  )
  if (removedWorkerPaths.length > 0) {
    return `Verification removed candidate changes: ${removedWorkerPaths.slice(0, 3).join(', ')}.`
  }
  if (verification.command !== run.verificationCommand) {
    return 'Verification did not run the requested command.'
  }
  if (
    candidate.workerCompletedAt === null ||
    verification.startedAt < candidate.workerCompletedAt
  ) {
    return 'Verification started before worker completion was recorded.'
  }
  if (verification.timedOut) {
    return 'Verification timed out.'
  }
  if (verification.error) {
    return `Verification failed: ${verification.error}`
  }
  return verification.exitCode === 0
    ? null
    : `Verification exited with code ${verification.exitCode ?? 'unknown'}.`
}

async function captureHarnessDiff(args: {
  runtime: HarnessRuntimeCaller
  worktree: string
  baseSha: string
  expectedBranch: string
  capturedAt: number
}): Promise<HarnessDiffSummary> {
  const [statusResult, compareResult] = await Promise.allSettled([
    args.runtime.call<GitStatusResult>('git.status', { worktree: args.worktree }),
    args.runtime.call<GitBranchCompareResult>('git.branchCompare', {
      worktree: args.worktree,
      baseRef: args.baseSha
    })
  ])
  return statusResult.status === 'fulfilled' && compareResult.status === 'fulfilled'
    ? buildHarnessDiffSummary({
        status: statusResult.value,
        branchCompare: compareResult.value,
        expectedBaseSha: args.baseSha,
        expectedBranch: args.expectedBranch,
        capturedAt: args.capturedAt
      })
    : failedDiff(
        [statusResult, compareResult]
          .flatMap((result) => (result.status === 'rejected' ? [errorMessage(result.reason)] : []))
          .join(' '),
        args.capturedAt
      )
}

async function runVerificationCommand(args: {
  run: HarnessRun
  agent: HarnessCandidate['agent']
  worktreeId: string
  worktreePath: string
  repo: Repo
  runtime: HarnessRuntimeCaller
  timeoutSeconds: number
  runPrecheck?: HarnessVerificationRunner
}): Promise<AutomationPrecheckResult> {
  if (args.runPrecheck) {
    return await args.runPrecheck({
      precheck: {
        command: args.run.verificationCommand,
        timeoutSeconds: args.timeoutSeconds
      },
      target: args.repo.connectionId
        ? {
            type: 'ssh',
            cwd: args.worktreePath,
            connectionId: args.repo.connectionId
          }
        : { type: 'local', cwd: args.worktreePath }
    })
  }

  return await args.runtime.runVerification({
    runId: args.run.id,
    agent: args.agent,
    worktree: `id:${args.worktreeId}`,
    command: args.run.verificationCommand,
    timeoutSeconds: args.timeoutSeconds
  })
}

export async function verifyHarnessCandidate(args: {
  run: HarnessRun
  candidate: HarnessCandidate
  repo: Repo
  runtime: HarnessRuntimeCaller
  timeoutSeconds: number
  runPrecheck?: HarnessVerificationRunner
  capturedAt?: number
  onCommandStart?: (evidence: VerificationCommandStart) => void | Promise<void>
}): Promise<VerificationEvidence> {
  const { run, candidate, repo, runtime } = args
  if (!candidate.worktreeId || !candidate.worktreePath || !candidate.branch) {
    throw new Error('Candidate worktree evidence is missing.')
  }

  const worktree = `id:${candidate.worktreeId}`
  const preVerificationDiff = await captureHarnessDiff({
    runtime,
    worktree,
    baseSha: run.baseSha,
    expectedBranch: candidate.branch,
    capturedAt: args.capturedAt ?? Date.now()
  })

  const startedAt = Date.now()
  if (preVerificationDiff.error || !hasHarnessActualChanges(preVerificationDiff)) {
    // Why: the command may mutate the tree. Never start it until the worker's
    // baseline is durable, or a later retry could validate its own mutations.
    const verification = failedVerification(
      run.verificationCommand,
      startedAt,
      preVerificationDiff.error
        ? 'Verification did not start because Git evidence was unavailable.'
        : 'Verification did not start because the candidate had no Git changes.'
    )
    return {
      diff: preVerificationDiff,
      verification,
      error: verificationError(
        run,
        candidate,
        preVerificationDiff,
        preVerificationDiff,
        verification
      ),
      retryable: preVerificationDiff.error !== null
    }
  }

  // Why: persist a restart barrier before a user command can mutate the
  // candidate; an interrupted command must never be replayed against its output.
  await args.onCommandStart?.({ diff: preVerificationDiff, startedAt })

  let verification: HarnessVerificationSummary
  try {
    const result = await runVerificationCommand({
      run,
      agent: candidate.agent,
      worktreeId: candidate.worktreeId,
      worktreePath: candidate.worktreePath,
      repo,
      runtime,
      timeoutSeconds: args.timeoutSeconds,
      runPrecheck: args.runPrecheck
    })
    verification = toVerificationSummary(result)
  } catch (error) {
    if (isUnverifiedVerificationStopError(error)) {
      throw error
    }
    verification = failedVerification(run.verificationCommand, startedAt, error)
  }

  // Why: verification commands may generate or delete files; only the state
  // left for human comparison is durable evidence.
  const diff = await captureHarnessDiff({
    runtime,
    worktree,
    baseSha: run.baseSha,
    expectedBranch: candidate.branch,
    capturedAt: Date.now()
  })

  return {
    diff,
    verification,
    error: verificationError(run, candidate, preVerificationDiff, diff, verification),
    // Why: once a command may have run, repeating it against its own output is
    // unsafe. Post-start infrastructure failures require a fresh comparison.
    retryable: false
  }
}
