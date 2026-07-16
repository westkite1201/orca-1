import { describe, expect, it } from 'vitest'
import type { MessageRow } from '../runtime/orchestration/types'
import { createHarnessRunFixture } from './verification-test-fixtures'
import { findHarnessWorkerResult } from './worker-result'

function completion(id: string, sequence: number): MessageRow {
  return {
    id,
    from_handle: 'terminal-codex',
    to_handle: 'jaws-harness:run-1',
    subject: 'Done',
    body: id,
    type: 'worker_done',
    priority: 'normal',
    thread_id: null,
    payload: JSON.stringify({ taskId: 'task-codex', dispatchId: 'dispatch-codex' }),
    read: 0,
    sequence,
    created_at: `2026-07-15 00:00:0${sequence}`,
    delivered_at: null,
    sender_pane_key: 'pane-codex'
  }
}

describe('Harness worker result', () => {
  it('uses the first accepted completion when a send is retried', () => {
    const candidate = createHarnessRunFixture().candidates[0]

    const result = findHarnessWorkerResult(
      [completion('retry', 7), completion('first', 5)],
      candidate
    )

    expect(result).toMatchObject({ messageId: 'first', body: 'first' })
  })
})
