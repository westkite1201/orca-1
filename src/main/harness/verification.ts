import type { HarnessRun } from '../../shared/harness-types'
import type { Store } from '../persistence'
import type { DispatchContextRow, MessageRow, TaskRow } from '../runtime/orchestration/types'
import { verifyHarnessCandidate, type HarnessVerificationRunner } from './candidate-verification'
import {
  persistHarnessCandidateVerification,
  VERIFICATION_INTERRUPTED_ERROR
} from './candidate-verification-persistence'
import { HARNESS_DISPATCH_CONFIRMATION_TIMEOUT_MS } from './candidate-launch'
import {
  deferOrchestratorFailureForActiveLanes,
  settleOrchestratorWorkerCompletion
} from './orchestrator-completion'
import type { HarnessRuntimeCaller } from './runtime-caller'
import { findHarnessWorkerResult } from './worker-result'

export { verifyHarnessCandidate }
export type { HarnessVerificationRunner }

type CompletionStore = Pick<Store, 'getRepo' | 'getHarnessRun' | 'updateHarnessCandidate'>
type WorkerDoneCheckResult = { messages: MessageRow[]; count: number }
type DispatchShowResult = { dispatch: DispatchContextRow | null; task: TaskRow | null }
const COMPLETION_CHECK_ERROR_PREFIX = 'Completion check failed:'
const DISPATCH_CHECK_ERROR_PREFIX = 'Dispatch check failed:'
const MISSING_WORKER_RESULT_ERROR = 'Completed dispatch is missing worker_done evidence.'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function timestampMs(value: string | null): number | null {
  if (!value) {
    return null
  }
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function requireRun(store: CompletionStore, runId: string): HarnessRun {
  const run = store.getHarnessRun(runId)
  if (!run) {
    throw new Error('Run not found.')
  }
  return run
}

export async function advanceHarnessCompletion(args: {
  store: CompletionStore
  runtime: HarnessRuntimeCaller
  runId: string
  timeoutSeconds: number
  runPrecheck?: HarnessVerificationRunner
}): Promise<void> {
  const { store, runtime } = args
  let run = requireRun(store, args.runId)
  if (run.fatalError) {
    return
  }
  const running = run.candidates.filter((candidate) => candidate.status === 'running')
  if (running.length > 0) {
    let messages: MessageRow[] = []
    let messagesLoaded = false
    try {
      if (
        running.some((candidate) => !candidate.agentTerminalHandle || !candidate.orchestrationRunId)
      ) {
        throw new Error('A running candidate is missing its orchestration identity.')
      }
      messages = (
        await Promise.all(
          running.map(
            async (candidate) =>
              (
                await runtime.call<WorkerDoneCheckResult>('orchestration.check', {
                  terminal: candidate.agentTerminalHandle!,
                  run: candidate.orchestrationRunId!,
                  all: true,
                  types: 'worker_done'
                })
              ).messages
          )
        )
      ).flat()
      messagesLoaded = true
      for (const candidate of running) {
        if (candidate.error?.startsWith(COMPLETION_CHECK_ERROR_PREFIX)) {
          store.updateHarnessCandidate(run.id, candidate.agent, { error: null })
        }
      }
    } catch (error) {
      const message = `${COMPLETION_CHECK_ERROR_PREFIX} ${errorMessage(error)}`
      for (const candidate of running) {
        if (candidate.error !== message) {
          store.updateHarnessCandidate(run.id, candidate.agent, { error: message })
        }
      }
    }

    for (const candidate of running) {
      let lifecycle: DispatchShowResult
      try {
        lifecycle = await runtime.call<DispatchShowResult>('orchestration.dispatchShow', {
          task: candidate.taskId
        })
      } catch (error) {
        store.updateHarnessCandidate(run.id, candidate.agent, {
          error: `${DISPATCH_CHECK_ERROR_PREFIX} ${errorMessage(error)}`
        })
        continue
      }

      const dispatch = lifecycle.dispatch
      const task = lifecycle.task
      if (
        !candidate.taskId ||
        !candidate.dispatchId ||
        !dispatch ||
        !task ||
        dispatch.id !== candidate.dispatchId ||
        dispatch.task_id !== candidate.taskId ||
        task.id !== candidate.taskId
      ) {
        const failure = 'Candidate lifecycle evidence is missing or inconsistent.'
        if (
          await deferOrchestratorFailureForActiveLanes({
            store,
            runtime,
            run,
            candidate,
            failure
          })
        ) {
          continue
        }
        store.updateHarnessCandidate(run.id, candidate.agent, {
          status: 'failed',
          childLaneDrainStartedAt: null,
          error: failure
        })
        continue
      }

      const lifecycleCompleted = dispatch.status === 'completed' && task.status === 'completed'
      const lifecycleRunning = dispatch.status === 'dispatched' && task.status === 'dispatched'
      if (!lifecycleCompleted && !lifecycleRunning) {
        const failure =
          dispatch.last_failure ??
          `Candidate dispatch ended without completion (${dispatch.status}/${task.status}).`
        if (
          await deferOrchestratorFailureForActiveLanes({
            store,
            runtime,
            run,
            candidate,
            failure
          })
        ) {
          continue
        }
        store.updateHarnessCandidate(run.id, candidate.agent, {
          status: 'failed',
          childLaneDrainStartedAt: null,
          error: failure
        })
        continue
      }
      if (candidate.error?.startsWith(DISPATCH_CHECK_ERROR_PREFIX)) {
        store.updateHarnessCandidate(run.id, candidate.agent, { error: null })
      }
      if (lifecycleRunning && candidate.recoveryStartedAt !== null) {
        const heartbeatAt = timestampMs(dispatch.last_heartbeat_at)
        if (heartbeatAt !== null && heartbeatAt > candidate.recoveryStartedAt) {
          store.updateHarnessCandidate(run.id, candidate.agent, {
            recoveryStartedAt: null,
            error: null
          })
        } else if (
          Date.now() - candidate.recoveryStartedAt >=
          HARNESS_DISPATCH_CONFIRMATION_TIMEOUT_MS
        ) {
          const timeoutError = 'Candidate dispatch was not confirmed after restart.'
          try {
            const abandoned = await runtime.abandonDispatch({
              dispatchId: candidate.dispatchId,
              taskId: candidate.taskId,
              error: timeoutError
            })
            if (abandoned) {
              const deferred = await deferOrchestratorFailureForActiveLanes({
                store,
                runtime,
                run,
                candidate,
                failure: timeoutError
              })
              if (!deferred) {
                store.updateHarnessCandidate(run.id, candidate.agent, {
                  status: 'failed',
                  childLaneDrainStartedAt: null,
                  error: timeoutError
                })
              }
            }
          } catch (error) {
            store.updateHarnessCandidate(run.id, candidate.agent, {
              error: `Dispatch cleanup failed: ${errorMessage(error)}`
            })
          }
        }
        continue
      }
      if (!messagesLoaded || !lifecycleCompleted) {
        continue
      }

      const workerResult = findHarnessWorkerResult(messages, candidate)
      if (!workerResult) {
        const terminalFailure = candidate.error === MISSING_WORKER_RESULT_ERROR
        if (
          terminalFailure &&
          (await deferOrchestratorFailureForActiveLanes({
            store,
            runtime,
            run,
            candidate,
            failure: MISSING_WORKER_RESULT_ERROR
          }))
        ) {
          continue
        }
        store.updateHarnessCandidate(run.id, candidate.agent, {
          ...(terminalFailure ? { status: 'failed' as const } : {}),
          ...(terminalFailure ? { childLaneDrainStartedAt: null } : {}),
          error: MISSING_WORKER_RESULT_ERROR
        })
        continue
      }
      const workerFailed = /^\s*failed\s*:/i.test(workerResult.subject)
      if (run.mode === 'orchestrator') {
        const ready = await settleOrchestratorWorkerCompletion({
          store,
          runtime,
          run,
          candidate,
          workerResult,
          topWorkerMessage: messages.find((message) => message.id === workerResult.messageId)
        })
        if (!ready) {
          continue
        }
      } else if (workerFailed) {
        store.updateHarnessCandidate(run.id, candidate.agent, {
          status: 'failed',
          workerResult,
          recoveryStartedAt: null,
          childLaneDrainStartedAt: null,
          workerCompletedAt: workerResult.receivedAt,
          error: `Worker reported failure: ${workerResult.subject}`
        })
        continue
      }
      store.updateHarnessCandidate(run.id, candidate.agent, {
        status: 'worker_done',
        workerResult,
        recoveryStartedAt: null,
        childLaneDrainStartedAt: null,
        workerCompletedAt: workerResult.receivedAt,
        error: null
      })
    }
  }

  run = requireRun(store, args.runId)
  if (
    run.candidates.some((candidate) =>
      ['pending', 'creating', 'ready', 'running'].includes(candidate.status)
    )
  ) {
    return
  }
  // Why: user-supplied verification commands can bind shared ports or saturate
  // the host. Waiting for both workers and running serially gives equal slots.
  for (const candidate of run.candidates.filter(
    (entry) =>
      entry.status === 'worker_done' ||
      (entry.status === 'verifying' &&
        (entry.error === null || entry.verification?.error === VERIFICATION_INTERRUPTED_ERROR))
  )) {
    await persistHarnessCandidateVerification({
      store,
      runtime,
      run,
      candidate,
      timeoutSeconds: args.timeoutSeconds,
      runPrecheck: args.runPrecheck
    })
  }
}
