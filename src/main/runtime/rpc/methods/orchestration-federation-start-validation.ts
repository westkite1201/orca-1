import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { z } from 'zod'
import type { FederationAttachStartParams } from './orchestration-federation-start-schema'

type FederationAttachStartInput = z.infer<typeof FederationAttachStartParams>

export function assertFederationAttachmentStart(params: FederationAttachStartInput): boolean {
  if (params.worktree === 'current' || params.worktree === 'new-child') {
    throw new OrchestrationError(
      'invalid_argument',
      'A remote worker requires an exact existing worktree or new-top-level.'
    )
  }
  const createsWorktree = params.worktree === 'new-top-level'
  if (createsWorktree && (!params.name || !params.repo)) {
    throw new OrchestrationError(
      'invalid_argument',
      'A remote new-top-level worktree requires --name and an explicit --repo.'
    )
  }
  if (createsWorktree && params.terminal) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal cannot combine with remote new-worktree creation.'
    )
  }
  if (
    !createsWorktree &&
    (params.name ||
      params.repo ||
      params.baseBranch ||
      params.displayName ||
      params.comment ||
      params.setup ||
      params.setupSource ||
      params.linearIssue ||
      params.linearWorkspace)
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      'Creation and setup options apply only to remote new-top-level worktrees.'
    )
  }
  if (params.linearWorkspace && !params.linearIssue) {
    throw new OrchestrationError('invalid_argument', '--linear-workspace requires --linear-issue.')
  }
  if (params.terminal && params.agent) {
    throw new OrchestrationError(
      'invalid_argument',
      '--terminal reuses an existing agent and cannot combine with --agent.'
    )
  }
  if (!params.terminal && (!params.agent || !isTuiAgent(params.agent))) {
    throw new OrchestrationError(
      'agent_unconfigured',
      'A configured --agent is required when federated worker-start creates a terminal.'
    )
  }
  return createsWorktree
}
