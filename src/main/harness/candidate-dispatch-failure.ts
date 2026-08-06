import type { HarnessCandidate, HarnessRun } from '../../shared/harness-types'
import type { Store } from '../persistence'
import type { TaskRow } from '../runtime/orchestration/types'
import type { HarnessRuntimeCaller } from './runtime-caller'

type HarnessDispatchContext = {
  store: Pick<Store, 'updateHarnessCandidate'>
  runtime: HarnessRuntimeCaller
  run: HarnessRun
  candidate: HarnessCandidate
}

export async function finalizeLegacyHarnessDispatchFailure(
  context: HarnessDispatchContext,
  task: TaskRow,
  lastFailure: string | null
): Promise<void> {
  const { store, runtime, run, candidate } = context
  const owner = candidate.agentTerminalHandle
  if (task.created_by_terminal_handle !== owner) {
    store.updateHarnessCandidate(run.id, candidate.agent, {
      status: 'failed',
      error: 'Existing task is not owned by this run.'
    })
    return
  }

  const failure = lastFailure ?? 'Candidate dispatch failed before completion.'
  // Why: older runtimes returned failed dispatches to ready; exact ownership
  // lets Harness close only its own stranded task without enabling a retry.
  await runtime.call('orchestration.taskUpdate', {
    id: task.id,
    status: 'failed',
    result: failure,
    run: candidate.orchestrationRunId,
    callerTerminalHandle: candidate.agentTerminalHandle
  })
  store.updateHarnessCandidate(run.id, candidate.agent, {
    status: 'failed',
    error: failure
  })
}
