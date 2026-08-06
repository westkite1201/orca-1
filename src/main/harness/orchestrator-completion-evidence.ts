import type { DispatchContextRow, MessageRow, TaskRow } from '../runtime/orchestration/types'
import type { HarnessRuntimeCaller } from './runtime-caller'

type MessageListResult = { messages: MessageRow[]; count: number }
type DispatchShowResult = { dispatch: DispatchContextRow | null; task: TaskRow | null }

function workerDoneTarget(message: MessageRow): { taskId: string; dispatchId: string } | null {
  if (message.type !== 'worker_done' || !message.payload) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(message.payload)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const payload = parsed as Record<string, unknown>
    if (
      typeof payload.taskId !== 'string' ||
      typeof payload.dispatchId !== 'string' ||
      Object.prototype.hasOwnProperty.call(payload, '_orcaLifecycleRejection')
    ) {
      return null
    }
    return { taskId: payload.taskId, dispatchId: payload.dispatchId }
  } catch {
    return null
  }
}

function laneName(task: TaskRow): string {
  return task.display_name?.trim() || task.task_title?.trim() || task.id
}

export async function findOrchestratorCompletionEvidenceError(args: {
  runtime: HarnessRuntimeCaller
  lanes: readonly TaskRow[]
  topWorkerMessage: MessageRow
  orchestrationRunId: string
  coordinatorHandle: string
}): Promise<string | null> {
  const { runtime, lanes, topWorkerMessage, orchestrationRunId, coordinatorHandle } = args
  if (lanes.length === 0) {
    return null
  }
  const childMessages = (
    await runtime.call<MessageListResult>('orchestration.check', {
      terminal: coordinatorHandle,
      run: orchestrationRunId,
      all: true,
      types: 'worker_done'
    })
  ).messages

  for (const lane of lanes) {
    const lifecycle = await runtime.call<DispatchShowResult>('orchestration.dispatchShow', {
      task: lane.id
    })
    const dispatch = lifecycle.dispatch
    if (
      !dispatch ||
      !lifecycle.task ||
      dispatch.task_id !== lane.id ||
      dispatch.status !== 'completed' ||
      lifecycle.task.status !== 'completed'
    ) {
      return `Child lane lacks completed dispatch evidence: ${laneName(lane)}.`
    }
    const completion = childMessages
      .filter((message) => {
        const target = workerDoneTarget(message)
        return target?.taskId === lane.id && target.dispatchId === dispatch.id
      })
      .sort((left, right) => left.sequence - right.sequence)[0]
    if (!completion) {
      return `Child lane lacks accepted worker_done evidence: ${laneName(lane)}.`
    }
    if (/^\s*failed\s*:/i.test(completion.subject)) {
      return `Child lane reported failure: ${laneName(lane)}.`
    }
    if (completion.sequence >= topWorkerMessage.sequence) {
      return `Coordinator finished before child lane completion: ${laneName(lane)}.`
    }
  }
  return null
}
