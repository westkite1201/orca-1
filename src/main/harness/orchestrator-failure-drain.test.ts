import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MessageRow, TaskRow } from '../runtime/orchestration/types'
import type { Repo } from '../../shared/types'
import { createHarnessRunMemoryStore } from './harness-run-memory-store'
import type { HarnessRuntimeCaller } from './runtime-caller'
import { ORCHESTRATOR_CHILD_DRAIN_TIMEOUT_MS } from './orchestrator-completion'
import { advanceHarnessCompletion } from './verification'

function topWorkerDone(subject: string): MessageRow {
  return {
    id: 'message-top',
    from_handle: 'terminal-codex',
    to_handle: 'jaws-harness:run-1',
    subject,
    body: 'Coordinator stopped.',
    type: 'worker_done',
    priority: 'normal',
    thread_id: null,
    payload: JSON.stringify({ taskId: 'task-top', dispatchId: 'dispatch-top' }),
    read: 0,
    sequence: 5,
    created_at: '2026-07-15 00:00:05',
    delivered_at: null,
    sender_pane_key: 'pane-codex'
  }
}

function child(status: TaskRow['status']): TaskRow & {
  dispatch_id?: string
  assignee_handle?: string
} {
  return {
    id: 'task-child',
    parent_id: 'task-top',
    created_by_terminal_handle: 'terminal-codex',
    task_title: 'Child',
    display_name: null,
    execution_kind: 'worktree',
    agent_slot: 'codex',
    spec: 'Child work.',
    status,
    deps: '[]',
    result: null,
    created_at: '2026-07-15 00:00:00',
    completed_at: status === 'completed' ? '2026-07-15 00:00:06' : null,
    ...(status === 'dispatched'
      ? { dispatch_id: 'dispatch-child', assignee_handle: 'terminal-child' }
      : {})
  }
}

function setupRun() {
  const repo = { id: 'repo-1', kind: 'git' } as Repo
  const { store } = createHarnessRunMemoryStore(repo)
  const run = store.createHarnessRun({
    mode: 'orchestrator',
    repoId: repo.id,
    sourceWorktreeId: 'source-1',
    sourceWorktreePath: '/repo',
    goal: 'Coordinate work.',
    verificationCommand: 'pnpm test',
    baseSha: 'a'.repeat(40)
  })
  store.updateHarnessCandidate(run.id, 'codex', {
    status: 'running',
    taskId: 'task-top',
    dispatchId: 'dispatch-top',
    agentTerminalHandle: 'terminal-codex'
  })
  return { store, run }
}

describe('orchestrator failure drain', () => {
  afterEach(() => vi.useRealTimers())

  it('does not terminalize a failed coordinator while a child is dispatched', async () => {
    const { store, run } = setupRun()
    let childStatus: TaskRow['status'] = 'dispatched'
    const runVerification = vi.fn()
    const call = vi.fn(async (method: string) => {
      if (method === 'orchestration.check') {
        return { messages: [topWorkerDone('Failed: integration conflict')], count: 1 }
      }
      if (method === 'orchestration.taskList') {
        return { tasks: [child(childStatus)], count: 1 }
      }
      return {
        dispatch: { id: 'dispatch-top', task_id: 'task-top', status: 'completed' },
        task: { id: 'task-top', status: 'completed' }
      }
    })
    const runtime = {
      call,
      abandonDispatch: vi.fn(),
      runVerification
    } as unknown as HarnessRuntimeCaller

    await advanceHarnessCompletion({ store, runtime, runId: run.id, timeoutSeconds: 60 })
    expect(store.getHarnessRun(run.id)?.candidates[0].status).toBe('running')

    childStatus = 'completed'
    await advanceHarnessCompletion({ store, runtime, runId: run.id, timeoutSeconds: 60 })
    expect(store.getHarnessRun(run.id)?.candidates[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Worker reported failure')
    })
    expect(runVerification).not.toHaveBeenCalled()
  })

  it('waits for a dispatched child after the coordinator lifecycle fails', async () => {
    const { store, run } = setupRun()
    let childStatus: TaskRow['status'] = 'dispatched'
    const runVerification = vi.fn()
    const call = vi.fn(async (method: string) => {
      if (method === 'orchestration.check') {
        return { messages: [], count: 0 }
      }
      if (method === 'orchestration.taskList') {
        return { tasks: [child(childStatus)], count: 1 }
      }
      return {
        dispatch: {
          id: 'dispatch-top',
          task_id: 'task-top',
          status: 'failed',
          last_failure: 'Coordinator crashed.'
        },
        task: { id: 'task-top', status: 'failed' }
      }
    })
    const runtime = {
      call,
      abandonDispatch: vi.fn(),
      runVerification
    } as unknown as HarnessRuntimeCaller

    await advanceHarnessCompletion({ store, runtime, runId: run.id, timeoutSeconds: 60 })
    expect(store.getHarnessRun(run.id)?.candidates[0].status).toBe('running')

    childStatus = 'completed'
    await advanceHarnessCompletion({ store, runtime, runId: run.id, timeoutSeconds: 60 })
    expect(store.getHarnessRun(run.id)?.candidates[0]).toMatchObject({
      status: 'failed',
      error: 'Coordinator crashed.'
    })
    expect(runVerification).not.toHaveBeenCalled()
  })

  it('stops an owned child after the persisted drain deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'))
    const { store, run } = setupRun()
    const stopChildDispatch = vi.fn(async () => true)
    const call = vi.fn(async (method: string) => {
      if (method === 'orchestration.check') {
        return { messages: [topWorkerDone('Failed: coordinator exited')], count: 1 }
      }
      if (method === 'orchestration.taskList') {
        return { tasks: [child('dispatched')], count: 1 }
      }
      return {
        dispatch: { id: 'dispatch-top', task_id: 'task-top', status: 'completed' },
        task: { id: 'task-top', status: 'completed' }
      }
    })
    const runtime = {
      call,
      abandonDispatch: vi.fn(),
      stopChildDispatch,
      runVerification: vi.fn()
    } as unknown as HarnessRuntimeCaller

    await advanceHarnessCompletion({ store, runtime, runId: run.id, timeoutSeconds: 60 })
    expect(store.getHarnessRun(run.id)?.candidates[0].childLaneDrainStartedAt).toBe(Date.now())

    vi.advanceTimersByTime(ORCHESTRATOR_CHILD_DRAIN_TIMEOUT_MS)
    await advanceHarnessCompletion({ store, runtime, runId: run.id, timeoutSeconds: 60 })

    expect(stopChildDispatch).toHaveBeenCalledWith({
      dispatchId: 'dispatch-child',
      taskId: 'task-child',
      parentTaskId: 'task-top',
      ownerHandle: `jaws-harness:${run.id}`,
      error: expect.stringContaining('drain timed out')
    })
    expect(store.getHarnessRun(run.id)?.candidates[0]).toMatchObject({
      status: 'failed',
      childLaneDrainStartedAt: null,
      error: expect.stringContaining('Stopped 1 child lane')
    })
  })

  it('keeps the run locked when a timed-out child changes lifecycle during cleanup', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T00:00:00Z'))
    const { store, run } = setupRun()
    const stopChildDispatch = vi.fn(async () => false)
    const call = vi.fn(async (method: string) => {
      if (method === 'orchestration.check') {
        return { messages: [topWorkerDone('Failed: coordinator exited')], count: 1 }
      }
      if (method === 'orchestration.taskList') {
        return { tasks: [child('dispatched')], count: 1 }
      }
      return {
        dispatch: { id: 'dispatch-top', task_id: 'task-top', status: 'completed' },
        task: { id: 'task-top', status: 'completed' }
      }
    })
    const runtime = {
      call,
      abandonDispatch: vi.fn(),
      stopChildDispatch,
      runVerification: vi.fn()
    } as unknown as HarnessRuntimeCaller

    await advanceHarnessCompletion({ store, runtime, runId: run.id, timeoutSeconds: 60 })
    vi.advanceTimersByTime(ORCHESTRATOR_CHILD_DRAIN_TIMEOUT_MS)
    await advanceHarnessCompletion({ store, runtime, runId: run.id, timeoutSeconds: 60 })

    expect(store.getHarnessRun(run.id)?.candidates[0]).toMatchObject({
      status: 'running',
      error: expect.stringContaining('An active child lane may still be running')
    })
  })
})
