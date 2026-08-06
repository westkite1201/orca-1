import type { Store } from '../persistence'
import type { HarnessCandidate, HarnessRun } from '../../shared/harness-types'
import type { GitStatusResult } from '../../shared/git-status-types'
import type {
  RuntimeTerminalResolvePane,
  RuntimeTerminalWait,
  RuntimeWorktreeCreateResult
} from '../../shared/runtime-types'
import { hasSamePaneIdentity } from '../../shared/stable-pane-id'
import type { DispatchContextRow, TaskRow } from '../runtime/orchestration/types'
import {
  harnessCandidateBranch,
  harnessRecoveryStartedAt,
  isSameHarnessBranch,
  recoverHarnessCandidate
} from './candidate-recovery'
import { finalizeLegacyHarnessDispatchFailure } from './candidate-dispatch-failure'
import type { HarnessRuntimeCaller } from './runtime-caller'

type CandidateStore = Pick<Store, 'updateHarnessCandidate'>
type TerminalWaitResult = { wait: RuntimeTerminalWait }
type DispatchResult = { dispatch: { id: string } | null; injected: boolean }
type DispatchShowResult = {
  dispatch: DispatchContextRow | null
  task: TaskRow | null
}
type TerminalResolvePaneResult = { terminal: RuntimeTerminalResolvePane }

const AGENT_READY_TIMEOUT_MS = 120_000
export const HARNESS_DISPATCH_CONFIRMATION_PENDING =
  'Dispatch recovered after restart; waiting for worker confirmation.'
export const HARNESS_DISPATCH_CONFIRMATION_TIMEOUT_MS = 10 * 60_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function createHarnessCandidate(args: {
  store: CandidateStore
  runtime: HarnessRuntimeCaller
  run: HarnessRun
  candidate: HarnessCandidate
}): Promise<void> {
  const { store, runtime, run, candidate } = args
  const creatingRun = store.updateHarnessCandidate(run.id, candidate.agent, {
    status: 'creating',
    error: null
  })
  const creatingCandidate =
    creatingRun.candidates.find((entry) => entry.agent === candidate.agent) ?? candidate
  const branch = harnessCandidateBranch(run, candidate)
  let created: RuntimeWorktreeCreateResult
  try {
    created = await runtime.call<RuntimeWorktreeCreateResult>('worktree.create', {
      repo: `id:${run.repoId}`,
      name: branch,
      baseBranch: run.baseSha,
      branchNameOverride: branch,
      noParent: true,
      setupDecision: 'skip',
      startupAgent: candidate.agent,
      activate: false
    })
  } catch (error) {
    const recovered = await recoverHarnessCandidate({
      store,
      runtime,
      run,
      candidate: creatingCandidate,
      createRejectionError: errorMessage(error)
    })
    if (recovered) {
      await waitForHarnessCandidate({ store, runtime, run, candidate: recovered })
    }
    return
  }

  const worktree = created.worktree
  const handle = created.agentTerminalHandle ?? created.startupTerminal?.handle ?? null
  const paneKey = created.startupTerminal?.paneKey ?? null
  const evidence = {
    worktreeId: worktree.id,
    worktreePath: worktree.git.path,
    branch: worktree.git.branch,
    agentTerminalHandle: handle,
    agentTerminalPaneKey: paneKey
  }
  const failure =
    worktree.git.head !== run.baseSha
      ? `Candidate started at ${worktree.git.head}, expected ${run.baseSha}.`
      : !isSameHarnessBranch(worktree.git.branch, branch)
        ? `Candidate created branch ${worktree.git.branch}, expected ${branch}.`
        : worktree.parentWorktreeId !== null
          ? 'Candidate worktree unexpectedly has a parent.'
          : !handle
            ? 'Candidate agent terminal did not start.'
            : !paneKey
              ? 'Candidate agent terminal has no stable pane identity.'
              : null
  if (failure) {
    store.updateHarnessCandidate(run.id, candidate.agent, {
      ...evidence,
      status: 'failed',
      error: failure
    })
    return
  }

  const persisted = store.updateHarnessCandidate(run.id, candidate.agent, {
    ...evidence,
    error: null
  })
  const next = persisted.candidates.find((entry) => entry.agent === candidate.agent)
  if (next) {
    await waitForHarnessCandidate({
      store,
      runtime,
      run,
      candidate: next
    })
  }
}

export async function waitForHarnessCandidate(args: {
  store: CandidateStore
  runtime: HarnessRuntimeCaller
  run: HarnessRun
  candidate: HarnessCandidate
}): Promise<void> {
  const { store, runtime, run } = args
  let { candidate } = args
  if (!candidate.worktreeId || !candidate.agentTerminalPaneKey) {
    const recovered = await recoverHarnessCandidate({ store, runtime, run, candidate })
    if (!recovered) {
      return
    }
    candidate = recovered
  }

  let wait: RuntimeTerminalWait
  try {
    const resolved = await runtime.call<TerminalResolvePaneResult>('terminal.resolvePane', {
      paneKey: candidate.agentTerminalPaneKey
    })
    const handle = resolved.terminal.handle
    if (handle !== candidate.agentTerminalHandle) {
      store.updateHarnessCandidate(run.id, candidate.agent, { agentTerminalHandle: handle })
    }
    const result = await runtime.call<TerminalWaitResult>('terminal.wait', {
      terminal: handle,
      for: 'tui-idle',
      timeoutMs: AGENT_READY_TIMEOUT_MS
    })
    wait = result.wait
  } catch (error) {
    store.updateHarnessCandidate(run.id, candidate.agent, { error: errorMessage(error) })
    return
  }
  if (wait.satisfied) {
    let status: GitStatusResult
    try {
      status = await runtime.call<GitStatusResult>('git.status', {
        worktree: `id:${candidate.worktreeId}`
      })
    } catch (error) {
      store.updateHarnessCandidate(run.id, candidate.agent, { error: errorMessage(error) })
      return
    }

    const statusBranch = status.branch?.trim() ?? ''
    const expectedBranch = harnessCandidateBranch(run, candidate)
    const branchMatches =
      statusBranch.length > 0 &&
      isSameHarnessBranch(statusBranch, expectedBranch) &&
      (!candidate.branch || isSameHarnessBranch(statusBranch, candidate.branch))
    const setupFailure = status.didHitLimit
      ? 'Candidate setup status was truncated; cleanliness could not be proven.'
      : status.head?.trim() !== run.baseSha
        ? `Candidate setup changed HEAD to ${status.head?.trim() || 'unknown'}, expected ${run.baseSha}.`
        : !branchMatches
          ? `Candidate setup is on ${statusBranch || 'an unknown branch'}, expected ${expectedBranch}.`
          : status.conflictOperation !== 'unknown'
            ? `Candidate setup left a ${status.conflictOperation} operation in progress.`
            : status.entries.length > 0
              ? 'Candidate setup modified the worktree before dispatch.'
              : null
    store.updateHarnessCandidate(run.id, candidate.agent, {
      status: setupFailure ? 'failed' : 'ready',
      error: setupFailure
    })
  } else if (wait.status === 'exited') {
    store.updateHarnessCandidate(run.id, candidate.agent, {
      status: 'failed',
      error: `Candidate agent exited before becoming ready (exit ${wait.exitCode ?? 'unknown'}).`
    })
  } else {
    store.updateHarnessCandidate(run.id, candidate.agent, {
      error: wait.blockedReason
        ? `Candidate agent needs attention: ${wait.blockedReason}.`
        : 'Candidate agent did not become ready before the timeout.'
    })
  }
}

export async function dispatchHarnessCandidate(args: {
  store: CandidateStore
  runtime: HarnessRuntimeCaller
  run: HarnessRun
  candidate: HarnessCandidate
}): Promise<void> {
  const { store, runtime, run, candidate } = args
  if (!candidate.taskId || !candidate.agentTerminalPaneKey) {
    return
  }

  try {
    const existing = await runtime.call<DispatchShowResult>('orchestration.dispatchShow', {
      task: candidate.taskId
    })
    const dispatch = existing.dispatch
    if (dispatch) {
      const belongsToCandidate =
        dispatch.task_id === candidate.taskId &&
        (dispatch.assignee_pane_key
          ? hasSamePaneIdentity(dispatch.assignee_pane_key, candidate.agentTerminalPaneKey)
          : dispatch.assignee_handle === candidate.agentTerminalHandle)
      if (!belongsToCandidate) {
        store.updateHarnessCandidate(run.id, candidate.agent, {
          status: 'failed',
          error: 'Existing task dispatch belongs to a different candidate terminal.'
        })
        return
      }
      if (
        (dispatch.status === 'dispatched' && existing.task?.status === 'dispatched') ||
        (dispatch.status === 'completed' && existing.task?.status === 'completed')
      ) {
        // Why: a crash can leave a dispatch row before prompt injection. Keep
        // monitoring it, but require worker liveness within a bounded window.
        store.updateHarnessCandidate(run.id, candidate.agent, {
          status: 'running',
          dispatchId: dispatch.id,
          recoveryStartedAt: dispatch.status === 'dispatched' ? harnessRecoveryStartedAt() : null,
          error: dispatch.status === 'dispatched' ? HARNESS_DISPATCH_CONFIRMATION_PENDING : null
        })
        return
      }
      if (dispatch.status === 'circuit_broken' || existing.task?.status === 'failed') {
        store.updateHarnessCandidate(run.id, candidate.agent, {
          status: 'failed',
          error: dispatch.last_failure ?? 'Candidate dispatch is no longer retryable.'
        })
        return
      }
      if (dispatch.status === 'failed' && existing.task?.status === 'ready') {
        await finalizeLegacyHarnessDispatchFailure(args, existing.task, dispatch.last_failure)
        return
      }
      if (dispatch.status !== 'failed' || existing.task?.status !== 'ready') {
        store.updateHarnessCandidate(run.id, candidate.agent, {
          status: 'failed',
          error: `Candidate dispatch is inconsistent (${dispatch.status}/${existing.task?.status ?? 'missing'}).`
        })
        return
      }
    }
  } catch (error) {
    store.updateHarnessCandidate(run.id, candidate.agent, {
      status: 'failed',
      error: `Could not reconcile candidate dispatch: ${errorMessage(error)}`
    })
    return
  }

  let terminalHandle: string
  try {
    const resolved = await runtime.call<TerminalResolvePaneResult>('terminal.resolvePane', {
      paneKey: candidate.agentTerminalPaneKey
    })
    terminalHandle = resolved.terminal.handle
    if (terminalHandle !== candidate.agentTerminalHandle) {
      store.updateHarnessCandidate(run.id, candidate.agent, {
        agentTerminalHandle: terminalHandle
      })
    }
  } catch (error) {
    store.updateHarnessCandidate(run.id, candidate.agent, {
      error: `Could not resolve candidate terminal: ${errorMessage(error)}`
    })
    return
  }

  try {
    const result = await runtime.call<DispatchResult>('orchestration.dispatch', {
      task: candidate.taskId,
      to: terminalHandle,
      from: terminalHandle,
      run: candidate.orchestrationRunId,
      inject: true
    })
    if (!result.injected || !result.dispatch?.id) {
      throw new Error('The task was not injected into the candidate agent.')
    }
    store.updateHarnessCandidate(run.id, candidate.agent, {
      status: 'running',
      dispatchId: result.dispatch.id,
      error: null
    })
  } catch (error) {
    // Why: the peer dispatch is attempted from the same snapshot. A transport
    // failure must become terminal so the comparison cannot remain half-active.
    store.updateHarnessCandidate(run.id, candidate.agent, {
      status: 'failed',
      error: errorMessage(error)
    })
  }
}
