import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { WorkerStartInput } from './orchestration-worker-start-schema'

export function assertLocalWorkerStartOptions(
  params: WorkerStartInput,
  createsWorktree: boolean
): void {
  if (params.terminal && params.agent) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal reuses an existing agent and cannot combine with --agent.'
    )
  }
  if (createsWorktree && params.terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal cannot combine with new-worktree creation.'
    )
  }
  if (createsWorktree && !params.name) {
    throw new OrchestrationError('invalid_argument', 'New worktrees require --name.')
  }
  if (
    !createsWorktree &&
    (params.name ||
      params.repo ||
      params.baseBranch ||
      params.displayName ||
      params.comment ||
      params.setup ||
      params.linearIssue ||
      params.linearWorkspace)
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      'Creation and setup options apply only to new-child or new-top-level worktrees.'
    )
  }
  if (params.linearWorkspace && !params.linearIssue) {
    throw new OrchestrationError('invalid_argument', '--linear-workspace requires --linear-issue.')
  }
}
