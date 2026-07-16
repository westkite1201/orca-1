import { afterEach, describe, expect, it } from 'vitest'
import { Coordinator, type CoordinatorRuntime } from './coordinator'
import { OrchestrationDb } from './db'

function createRuntime(): CoordinatorRuntime & {
  sent: { handle: string; prompt: string }[]
  terminals: { handle: string; worktreeId: string; connected: boolean; writable: boolean }[]
} {
  const runtime = {
    sent: [] as { handle: string; prompt: string }[],
    terminals: [] as {
      handle: string
      worktreeId: string
      connected: boolean
      writable: boolean
    }[],
    async sendTerminalAgentPrompt(handle: string, prompt: string) {
      runtime.sent.push({ handle, prompt })
      return {}
    },
    async listTerminals() {
      return { terminals: runtime.terminals }
    },
    async createTerminal() {
      const terminal = {
        handle: `worker-${runtime.terminals.length + 1}`,
        worktreeId: 'worktree-1',
        connected: true,
        writable: true
      }
      runtime.terminals.push(terminal)
      return terminal
    },
    async waitForTerminal(handle: string) {
      return { handle, condition: 'exit' }
    },
    async probeWorktreeDrift() {
      return null
    }
  }
  return runtime
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for coordinator state.')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function completeTask(db: OrchestrationDb, taskId: string, to = 'coord'): void {
  const dispatch = db.getDispatchContext(taskId)
  if (!dispatch?.assignee_handle) {
    throw new Error(`Task ${taskId} has no active dispatch.`)
  }
  db.insertMessage({
    from: dispatch.assignee_handle,
    to,
    subject: 'Done',
    type: 'worker_done',
    payload: JSON.stringify({ taskId, dispatchId: dispatch.id })
  })
}

describe('Coordinator Harness isolation', () => {
  let db: OrchestrationDb

  afterEach(() => db?.close())

  it('does not treat foreign Harness tasks as its decomposition', async () => {
    db = new OrchestrationDb(':memory:')
    db.createTask({
      spec: 'paired candidate work',
      createdByTerminalHandle: 'jaws-harness:foreign-run'
    })
    const coordinator = new Coordinator(db, createRuntime(), {
      spec: 'generic work',
      coordinatorHandle: 'coord'
    })

    await expect(coordinator.run()).rejects.toThrow('No tasks found')
  })

  it('does not adopt descendants from a foreign Harness root', async () => {
    db = new OrchestrationDb(':memory:')
    const root = db.createTask({
      spec: 'foreign coordinator',
      createdByTerminalHandle: 'jaws-harness:foreign-run'
    })
    db.createDispatchContext(root.id, 'foreign-coordinator', 'tab_foreign:leaf_foreign')
    db.createTask({
      spec: 'foreign child lane',
      parentId: root.id,
      createdByTerminalHandle: 'coord'
    })
    const coordinator = new Coordinator(db, createRuntime(), {
      spec: 'generic work',
      coordinatorHandle: 'coord'
    })

    await expect(coordinator.run()).rejects.toThrow('No tasks found')
  })

  it('never adopts Harness children even from the assigned coordinator pane', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createRuntime()
    runtime.terminals.push({
      handle: 'child-worker',
      worktreeId: 'worktree-child',
      connected: true,
      writable: true
    })
    runtime.getTerminalPaneKey = (handle) =>
      handle === 'term_live_coord' ? 'tab_coord:leaf_coord' : null
    const root = db.createTask({
      spec: 'Harness root',
      createdByTerminalHandle: 'jaws-harness:run-1'
    })
    db.createDispatchContext(root.id, 'term_old_coord', 'tab_coord:leaf_coord')
    const child = db.createTask({
      spec: 'created before handle remint',
      parentId: root.id,
      createdByTerminalHandle: 'term_old_coord'
    })
    const coordinator = new Coordinator(db, runtime, {
      spec: 'resume child lanes',
      coordinatorHandle: 'term_live_coord',
      pollIntervalMs: 10
    })

    await expect(coordinator.run()).rejects.toThrow('No tasks found')
    expect(db.getDispatchContext(child.id)).toBeUndefined()
  })

  it('ignores foreign Harness failures and decision gates while generic work converges', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createRuntime()
    runtime.terminals.push({
      handle: 'generic-worker',
      worktreeId: 'worktree-1',
      connected: true,
      writable: true
    })
    const foreignFailed = db.createTask({
      spec: 'failed candidate',
      createdByTerminalHandle: 'jaws-harness:foreign-run'
    })
    db.updateTaskStatus(foreignFailed.id, 'failed', 'candidate failed')
    const foreignGate = db.createTask({
      spec: 'candidate with gate',
      createdByTerminalHandle: 'jaws-harness:foreign-run'
    })
    const pendingGate = db.createGate({ taskId: foreignGate.id, question: 'Harness choice?' })
    db.updateTaskStatus(foreignGate.id, 'ready')
    const foreignMessage = db.createTask({
      spec: 'candidate message',
      createdByTerminalHandle: 'jaws-harness:foreign-run'
    })
    db.insertMessage({
      from: 'foreign-worker',
      to: 'coord',
      subject: 'Foreign gate',
      type: 'decision_gate',
      payload: JSON.stringify({ taskId: foreignMessage.id, question: 'Should Harness continue?' })
    })
    const ordinary = db.createTask({ spec: 'generic coordinator work' })
    const coordinator = new Coordinator(db, runtime, {
      spec: 'generic work',
      coordinatorHandle: 'coord',
      pollIntervalMs: 10
    })

    const resultPromise = coordinator.run()
    await waitFor(() => Boolean(db.getDispatchContext(ordinary.id)))
    completeTask(db, ordinary.id)
    const result = await resultPromise

    expect(result.status).toBe('completed')
    expect(result.completedTasks).toEqual([ordinary.id])
    expect(result.failedTasks).not.toContain(foreignFailed.id)
    expect(db.getTask(foreignGate.id)?.status).toBe('ready')
    expect(db.getGate(pendingGate.id)?.status).toBe('pending')
    expect(db.listGates({ taskId: foreignMessage.id })).toHaveLength(0)
    expect(db.getDispatchContext(foreignGate.id)).toBeUndefined()
    expect(db.getDispatchContext(foreignMessage.id)).toBeUndefined()
  })

  it('counts foreign Harness dispatches against global terminal capacity', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createRuntime()
    runtime.terminals.push(
      {
        handle: 'generic-worker',
        worktreeId: 'worktree-1',
        connected: true,
        writable: true
      },
      {
        handle: 'foreign-worker',
        worktreeId: 'worktree-2',
        connected: true,
        writable: true
      }
    )
    const foreign = db.createTask({
      spec: 'active candidate',
      createdByTerminalHandle: 'jaws-harness:foreign-run'
    })
    db.createDispatchContext(foreign.id, 'foreign-worker')
    const ordinary = db.createTask({ spec: 'generic coordinator work' })
    const coordinator = new Coordinator(db, runtime, {
      spec: 'generic work',
      coordinatorHandle: 'coord',
      pollIntervalMs: 10,
      maxConcurrent: 1
    })

    const resultPromise = coordinator.run()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(db.getTask(ordinary.id)?.status).toBe('ready')
    expect(runtime.sent).toHaveLength(0)

    db.updateTaskStatus(foreign.id, 'completed')
    await waitFor(() => Boolean(db.getDispatchContext(ordinary.id)))
    completeTask(db, ordinary.id)
    const result = await resultPromise

    expect(result.status).toBe('completed')
    expect(runtime.sent).toHaveLength(1)
    expect(runtime.sent[0].handle).toBe('generic-worker')
  })
})
