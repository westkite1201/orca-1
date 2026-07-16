import { deriveHarnessRunStatus, type HarnessRun } from '../../shared/harness-types'

export function assertNoActiveHarnessRun(
  runs: readonly HarnessRun[],
  sourceWorktreeId: string
): void {
  const activeRun = runs.find(
    (run) =>
      run.sourceWorktreeId === sourceWorktreeId &&
      !['completed', 'failed'].includes(deriveHarnessRunStatus(run))
  )
  if (activeRun) {
    throw new Error('An active run already exists for this worktree.')
  }
}
