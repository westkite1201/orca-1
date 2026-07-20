import type { HarnessCandidate, HarnessRun, HarnessWorkerResult } from '../../shared/harness-types'
import type { Store } from '../persistence'
import type { MessageRow, TaskRow } from '../runtime/orchestration/types'
import { findOrchestratorChildLaneBlocker } from './orchestrator-child-lane-barrier'
import { findOrchestratorCompletionEvidenceError } from './orchestrator-completion-evidence'
import type { HarnessRuntimeCaller } from './runtime-caller'

type CompletionStore = Pick<Store, 'updateHarnessCandidate'>
type TaskListResult = { tasks: TaskRow[] }
type DispatchedChildLane = TaskRow & { dispatch_id?: string | null }
const CHILD_LANE_CHECK_ERROR_PREFIX = 'Child lane check failed:'
export const ORCHESTRATOR_CHILD_DRAIN_TIMEOUT_MS = 10 * 60 * 1000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function listChildLanes(
  runtime: HarnessRuntimeCaller,
  candidate: HarnessCandidate
): Promise<TaskRow[]> {
  return (
    await runtime.call<TaskListResult>('orchestration.taskList', {
      parent: candidate.taskId
    })
  ).tasks
}

async function handleActiveChildLaneDrain(args: {
  store: CompletionStore
  runtime: HarnessRuntimeCaller
  run: HarnessRun
  candidate: HarnessCandidate
  lanes: TaskRow[]
  failure: string
  workerResult?: HarnessWorkerResult
}): Promise<boolean> {
  const active = args.lanes.filter(
    (lane): lane is DispatchedChildLane => lane.status === 'dispatched'
  )
  if (active.length === 0) {
    if (args.candidate.childLaneDrainStartedAt !== null) {
      args.store.updateHarnessCandidate(args.run.id, args.candidate.agent, {
        childLaneDrainStartedAt: null
      })
    }
    return false
  }

  const startedAt = args.candidate.childLaneDrainStartedAt ?? Date.now()
  const workerPatch = args.workerResult
    ? {
        workerResult: args.workerResult,
        workerCompletedAt: args.workerResult.receivedAt
      }
    : {}
  if (Date.now() - startedAt < ORCHESTRATOR_CHILD_DRAIN_TIMEOUT_MS) {
    args.store.updateHarnessCandidate(args.run.id, args.candidate.agent, {
      ...workerPatch,
      recoveryStartedAt: null,
      childLaneDrainStartedAt: startedAt,
      error: `${args.failure} Waiting for ${active.length} active child lane${active.length === 1 ? '' : 's'} to stop.`
    })
    return true
  }

  const cleanupError = `Child lane drain timed out after ${
    ORCHESTRATOR_CHILD_DRAIN_TIMEOUT_MS / 60_000
  } minutes.`
  try {
    for (const lane of active) {
      if (!lane.dispatch_id) {
        throw new Error(`Active child lane ${lane.id} is missing its dispatch ID.`)
      }
      const stopped = await args.runtime.stopChildDispatch({
        dispatchId: lane.dispatch_id,
        taskId: lane.id,
        parentTaskId: args.candidate.taskId!,
        ownerHandle: `jaws-harness:${args.run.id}`,
        error: cleanupError
      })
      if (!stopped) {
        throw new Error(`Child lane ${lane.id} changed lifecycle during cleanup; retrying.`)
      }
    }
  } catch (error) {
    args.store.updateHarnessCandidate(args.run.id, args.candidate.agent, {
      ...workerPatch,
      childLaneDrainStartedAt: startedAt,
      error: `${args.failure} ${cleanupError} Cleanup failed: ${errorMessage(error)} An active child lane may still be running.`
    })
    return true
  }

  args.store.updateHarnessCandidate(args.run.id, args.candidate.agent, {
    ...workerPatch,
    status: 'failed',
    recoveryStartedAt: null,
    childLaneDrainStartedAt: null,
    error: `${args.failure} ${cleanupError} Stopped ${active.length} child lane${active.length === 1 ? '' : 's'} before releasing the run.`
  })
  return true
}

export async function settleOrchestratorWorkerCompletion(args: {
  store: CompletionStore
  runtime: HarnessRuntimeCaller
  run: HarnessRun
  candidate: HarnessCandidate
  workerResult: HarnessWorkerResult
  topWorkerMessage: MessageRow | undefined
}): Promise<boolean> {
  const { store, runtime, run, candidate, workerResult, topWorkerMessage } = args
  const workerFailed = /^\s*failed\s*:/i.test(workerResult.subject)
  let lanes: TaskRow[]
  try {
    lanes = await listChildLanes(runtime, candidate)
  } catch (error) {
    store.updateHarnessCandidate(run.id, candidate.agent, {
      workerResult,
      workerCompletedAt: workerResult.receivedAt,
      error: `${CHILD_LANE_CHECK_ERROR_PREFIX} ${errorMessage(error)}`
    })
    return false
  }

  const blocker = findOrchestratorChildLaneBlocker({ run, candidate, tasks: lanes })
  if (blocker) {
    const failure = workerFailed
      ? `Worker reported failure: ${workerResult.subject} ${blocker.message}`
      : blocker.message
    if (
      blocker.kind === 'active' &&
      (await handleActiveChildLaneDrain({
        store,
        runtime,
        run,
        candidate,
        lanes,
        failure,
        workerResult
      }))
    ) {
      return false
    }
    store.updateHarnessCandidate(run.id, candidate.agent, {
      status: 'failed',
      workerResult,
      recoveryStartedAt: null,
      childLaneDrainStartedAt: null,
      workerCompletedAt: workerResult.receivedAt,
      error: failure
    })
    return false
  }
  if (workerFailed) {
    store.updateHarnessCandidate(run.id, candidate.agent, {
      status: 'failed',
      workerResult,
      recoveryStartedAt: null,
      childLaneDrainStartedAt: null,
      workerCompletedAt: workerResult.receivedAt,
      error: `Worker reported failure: ${workerResult.subject}`
    })
    return false
  }
  if (!topWorkerMessage) {
    store.updateHarnessCandidate(run.id, candidate.agent, {
      status: 'failed',
      workerResult,
      childLaneDrainStartedAt: null,
      workerCompletedAt: workerResult.receivedAt,
      error: 'Coordinator completion message evidence is missing.'
    })
    return false
  }

  try {
    const evidenceError = await findOrchestratorCompletionEvidenceError({
      runtime,
      lanes,
      topWorkerMessage
    })
    if (evidenceError) {
      store.updateHarnessCandidate(run.id, candidate.agent, {
        status: 'failed',
        workerResult,
        childLaneDrainStartedAt: null,
        workerCompletedAt: workerResult.receivedAt,
        error: evidenceError
      })
      return false
    }
  } catch (error) {
    store.updateHarnessCandidate(run.id, candidate.agent, {
      workerResult,
      workerCompletedAt: workerResult.receivedAt,
      error: `${CHILD_LANE_CHECK_ERROR_PREFIX} ${errorMessage(error)}`
    })
    return false
  }
  return true
}

export async function deferOrchestratorFailureForActiveLanes(args: {
  store: CompletionStore
  runtime: HarnessRuntimeCaller
  run: HarnessRun
  candidate: HarnessCandidate
  failure: string
}): Promise<boolean> {
  if (args.run.mode !== 'orchestrator' || !args.candidate.taskId) {
    return false
  }
  try {
    const lanes = await listChildLanes(args.runtime, args.candidate)
    return await handleActiveChildLaneDrain({ ...args, lanes })
  } catch (error) {
    args.store.updateHarnessCandidate(args.run.id, args.candidate.agent, {
      error: `${args.failure} ${CHILD_LANE_CHECK_ERROR_PREFIX} ${errorMessage(error)}`
    })
    return true
  }
}
