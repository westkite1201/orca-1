import type { GitStatusResult } from '../../shared/git-status-types'
import { isGitRepoKind } from '../../shared/repo-kind'
import type { RuntimeWorktreeRecord } from '../../shared/runtime-types'
import { assertNoActiveHarnessRun } from './active-run-guard'
import type { HarnessRuntimeCaller } from './runtime-caller'
import type { HarnessStore } from './service'

type WorktreeShowResult = { worktree: RuntimeWorktreeRecord }

export type HarnessSourcePreflight = {
  source: RuntimeWorktreeRecord
  baseSha: string
}

export async function preflightHarnessSource(
  store: HarnessStore,
  runtime: HarnessRuntimeCaller,
  worktreeSelector: string
): Promise<HarnessSourcePreflight> {
  const worktree = worktreeSelector.trim()
  if (!worktree) {
    throw new Error('A worktree is required.')
  }
  const { worktree: source } = await runtime.call<WorktreeShowResult>('worktree.show', {
    worktree
  })
  assertNoActiveHarnessRun(store.listHarnessRuns(source.repoId), source.id)
  const repo = store.getRepo(source.repoId)
  if (!repo || !isGitRepoKind(repo)) {
    throw new Error('A Git repository is required.')
  }
  const status = await runtime.call<GitStatusResult>('git.status', {
    worktree: `id:${source.id}`
  })
  if (status.didHitLimit) {
    throw new Error(
      'The source worktree status was truncated, so cleanliness could not be verified.'
    )
  }
  if (status.entries.length > 0) {
    throw new Error('The source worktree must be clean.')
  }
  if (status.conflictOperation !== 'unknown') {
    throw new Error(`Cannot start while a ${status.conflictOperation} operation is in progress.`)
  }
  const baseSha = status.head?.trim()
  if (!baseSha) {
    throw new Error('Could not resolve the source HEAD.')
  }
  // Why: status lookup yields; recheck before callers synchronously persist a run or plan.
  assertNoActiveHarnessRun(store.listHarnessRuns(source.repoId), source.id)
  return { source, baseSha }
}
