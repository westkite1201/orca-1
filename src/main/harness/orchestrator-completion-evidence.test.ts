import { describe, expect, it, vi } from 'vitest'
import type { HarnessRuntimeCaller } from './runtime-caller'
import type { MessageRow, TaskRow } from '../runtime/orchestration/types'
import { findOrchestratorCompletionEvidenceError } from './orchestrator-completion-evidence'

function message(id: string, taskId: string, dispatchId: string, sequence: number): MessageRow {
  return {
    id,
    from_handle: 'worker',
    to_handle: 'coordinator',
    subject: 'Done',
    body: '',
    type: 'worker_done',
    priority: 'normal',
    thread_id: null,
    payload: JSON.stringify({ taskId, dispatchId }),
    read: 0,
    sequence,
    created_at: '2026-07-15 00:00:00',
    delivered_at: null,
    sender_pane_key: 'pane-worker'
  }
}

function lane(): TaskRow {
  return {
    id: 'task-child',
    parent_id: 'task-codex',
    created_by_terminal_handle: 'terminal-codex',
    task_title: 'Child lane',
    display_name: null,
    execution_kind: 'worktree',
    agent_slot: 'codex',
    spec: 'Implement child.',
    status: 'completed',
    deps: '[]',
    result: null,
    created_at: '2026-07-15 00:00:00',
    completed_at: '2026-07-15 00:00:01'
  }
}

describe('orchestrator completion evidence', () => {
  it('uses the stable task-creator inbox after the live handle is reminted', async () => {
    const child = lane()
    let childSequences = [6, 4]
    const call = vi.fn(async (method: string) => {
      if (method === 'orchestration.check') {
        return {
          messages: childSequences.map((sequence) =>
            message(`child-message-${sequence}`, child.id, 'child-dispatch', sequence)
          )
        }
      }
      return {
        dispatch: { id: 'child-dispatch', task_id: child.id, status: 'completed' },
        task: child
      }
    })
    const runtime = { call } as unknown as HarnessRuntimeCaller
    const topMessage = message('top-message', 'task-codex', 'dispatch-codex', 5)

    await expect(
      findOrchestratorCompletionEvidenceError({
        runtime,
        lanes: [child],
        topWorkerMessage: topMessage
      })
    ).resolves.toBeNull()

    childSequences = [6]
    await expect(
      findOrchestratorCompletionEvidenceError({
        runtime,
        lanes: [child],
        topWorkerMessage: topMessage
      })
    ).resolves.toContain('Coordinator finished before child lane completion')
    expect(call).toHaveBeenCalledWith('orchestration.check', {
      terminal: 'terminal-codex',
      all: true,
      types: 'worker_done'
    })
  })
})
