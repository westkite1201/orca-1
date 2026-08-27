import type { HarnessCandidate, HarnessWorkerResult } from '../../shared/harness-types'
import type { MessageRow } from '../runtime/orchestration/types'

function receivedAt(createdAt: string, fallback: number): number {
  const normalized = createdAt.includes('T') ? createdAt : `${createdAt.replace(' ', 'T')}Z`
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function findHarnessWorkerResult(
  messages: readonly MessageRow[],
  candidate: HarnessCandidate,
  observedAt = Date.now()
): HarnessWorkerResult | null {
  if (!candidate.taskId || !candidate.dispatchId) {
    return null
  }
  let earliest: MessageRow | null = null
  for (const message of messages) {
    if (message.type !== 'worker_done' || !message.payload) {
      continue
    }
    try {
      const payload: unknown = JSON.parse(message.payload)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        continue
      }
      const record = payload as Record<string, unknown>
      // Why: IDs bind completion to this dispatch; the send-path rejection
      // marker preserves pane authority even when a tab breakout remints the handle.
      if (
        record.taskId !== candidate.taskId ||
        record.dispatchId !== candidate.dispatchId ||
        Object.hasOwn(record, '_orcaLifecycleRejection')
      ) {
        continue
      }
      if (!earliest || message.sequence < earliest.sequence) {
        earliest = message
      }
    } catch {
      continue
    }
  }
  return earliest
    ? {
        messageId: earliest.id,
        subject: earliest.subject,
        body: earliest.body,
        payload: earliest.payload,
        receivedAt: receivedAt(earliest.created_at, observedAt)
      }
    : null
}
