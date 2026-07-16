import type { AutomationPrecheckResult } from '../../shared/automations-types'
import type { HarnessAgent, HarnessCandidate, HarnessRun } from '../../shared/harness-types'
import type { GitBranchCompareResult } from '../../shared/types'

export const HARNESS_TEST_BASE_SHA = '0123456789abcdef'

function createHarnessCandidate<TAgent extends HarnessAgent>(
  agent: TAgent
): HarnessCandidate<TAgent> {
  return {
    id: `candidate-${agent}`,
    agent,
    status: 'running',
    worktreeId: `worktree-${agent}`,
    worktreePath: `candidate-${agent}`,
    branch: `harness-${agent}`,
    agentTerminalHandle: `terminal-${agent}`,
    agentTerminalPaneKey: `pane-${agent}`,
    verificationTerminalHandle: null,
    verificationTerminalPaneKey: null,
    verificationTerminalOwnership: null,
    taskId: `task-${agent}`,
    dispatchId: `dispatch-${agent}`,
    workerResult: null,
    verification: null,
    diff: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
    recoveryStartedAt: null,
    childLaneDrainStartedAt: null,
    workerCompletedAt: null,
    completedAt: null
  }
}

export function createHarnessRunFixture(): HarnessRun {
  return {
    id: 'run-1',
    mode: 'comparison',
    repoId: 'repo-1',
    sourceWorktreeId: 'source-1',
    sourceWorktreePath: 'source-root',
    goal: 'Implement the goal.',
    verificationCommand: 'pnpm test',
    baseSha: HARNESS_TEST_BASE_SHA,
    candidates: [createHarnessCandidate('codex'), createHarnessCandidate('claude')],
    fatalError: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null
  }
}

export function createHarnessBranchCompareFixture(
  agent: HarnessAgent,
  hasChanges = true,
  path = `src/${agent}.ts`
): GitBranchCompareResult {
  return {
    summary: {
      baseRef: HARNESS_TEST_BASE_SHA,
      baseOid: HARNESS_TEST_BASE_SHA,
      compareRef: 'HEAD',
      headOid: `head-${agent}`,
      mergeBase: HARNESS_TEST_BASE_SHA,
      changedFiles: hasChanges ? 1 : 0,
      status: 'ready'
    },
    entries: hasChanges ? [{ path, status: 'modified', added: 2, removed: 1 }] : []
  }
}

export function createHarnessPrecheckResult(exitCode: number): AutomationPrecheckResult {
  const startedAt = Date.now()
  return {
    command: 'pnpm test',
    exitCode,
    timedOut: false,
    durationMs: 5,
    stdout: exitCode === 0 ? 'passed' : '',
    stderr: exitCode === 0 ? '' : 'failed',
    stdoutTruncated: false,
    stderrTruncated: false,
    error: null,
    startedAt,
    completedAt: startedAt + 5
  }
}
