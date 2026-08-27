import { describe, expect, it, vi } from 'vitest'
import type { MessageRow, TaskRow } from '../runtime/orchestration/types'
import type { Repo } from '../../shared/repo-types'
import { createHarnessRunMemoryStore } from './harness-run-memory-store'
import type { HarnessRuntimeCaller } from './runtime-caller'
import { advanceHarnessCompletion } from './verification'

const PARENT_TASK_ID = 'task-parent'
const PARENT_DISPATCH_ID = 'dispatch-parent'

function workerDone(
  taskId = PARENT_TASK_ID,
  dispatchId = PARENT_DISPATCH_ID,
  sequence = 1
): MessageRow {
  return {
    id: 'message-parent',
    run_id: 'run-1',
    from_handle: 'terminal-codex',
    to_handle: 'jaws-harness:run-1',
    subject: 'Integrated',
    body: 'All work is complete.',
    type: 'worker_done',
    priority: 'normal',
    thread_id: null,
    payload: JSON.stringify({ taskId, dispatchId }),
    read: 0,
    sequence,
    created_at: '2026-07-15 00:00:00',
    delivered_at: null,
    sender_pane_key: 'pane-codex'
  }
}

function childTask(): TaskRow {
  return {
    id: 'task-child',
    run_id: 'run-1',
    parent_id: PARENT_TASK_ID,
    created_by_terminal_handle: 'terminal-codex',
    created_by_pane_key: null,
    created_by_process_incarnation: null,
    created_by_run_generation: null,
    task_title: 'Child implementation',
    display_name: null,
    verification_required: 0,
    spec: 'Implement the child lane.',
    status: 'dispatched',
    deps: '[]',
    result: null,
    created_at: '2026-07-15 00:00:00',
    completed_at: null
  }
}

describe('orchestrator completion barrier', () => {
  it('drains then fails when the coordinator finishes ahead of a child lane', async () => {
    const repo = { id: 'repo-1', kind: 'git' } as Repo
    const { store } = createHarnessRunMemoryStore(repo)
    const run = store.createHarnessRun({
      mode: 'orchestrator',
      repoId: repo.id,
      sourceWorktreeId: 'source-1',
      sourceWorktreePath: '/repo',
      goal: 'Implement the issue.',
      verificationCommand: 'pnpm test',
      baseSha: 'a'.repeat(40)
    })
    store.updateHarnessCandidate(run.id, 'codex', {
      status: 'running',
      worktreeId: 'worktree-codex',
      worktreePath: '/repo-codex',
      branch: 'jaws-orchestrator',
      agentTerminalHandle: 'terminal-codex',
      agentTerminalPaneKey: 'pane-codex',
      orchestrationRunId: 'orchestration-run',
      taskId: PARENT_TASK_ID,
      dispatchId: PARENT_DISPATCH_ID
    })
    const runVerification = vi.fn()
    let childStatus: TaskRow['status'] = 'dispatched'
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'orchestration.check') {
        return {
          messages: [workerDone(), workerDone('task-child', 'dispatch-child', 2)],
          count: 2
        }
      }
      if (method === 'orchestration.dispatchShow') {
        if (params?.task === 'task-child') {
          return {
            dispatch: { id: 'dispatch-child', task_id: 'task-child', status: 'completed' },
            task: { ...childTask(), status: 'completed' }
          }
        }
        return {
          dispatch: {
            id: PARENT_DISPATCH_ID,
            task_id: PARENT_TASK_ID,
            status: 'completed'
          },
          task: { id: PARENT_TASK_ID, status: 'completed' }
        }
      }
      if (method === 'orchestration.taskList') {
        return { tasks: [{ ...childTask(), status: childStatus }], count: 1 }
      }
      throw new Error(`Unexpected call: ${method}`)
    })
    const runtime = {
      call,
      abandonDispatch: vi.fn(),
      runVerification
    } as unknown as HarnessRuntimeCaller

    await advanceHarnessCompletion({ store, runtime, runId: run.id, timeoutSeconds: 60 })

    expect(store.getHarnessRun(run.id)?.candidates[0]).toMatchObject({
      status: 'running',
      error: expect.stringContaining('child lanes were still active')
    })
    expect(call).toHaveBeenCalledWith('orchestration.taskList', {
      parent: PARENT_TASK_ID,
      run: 'orchestration-run',
      callerTerminalHandle: 'terminal-codex'
    })
    expect(runVerification).not.toHaveBeenCalled()

    childStatus = 'completed'
    await advanceHarnessCompletion({ store, runtime, runId: run.id, timeoutSeconds: 60 })

    expect(store.getHarnessRun(run.id)?.candidates[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Coordinator finished before child lane completion')
    })
    expect(runVerification).not.toHaveBeenCalled()
  })
})
