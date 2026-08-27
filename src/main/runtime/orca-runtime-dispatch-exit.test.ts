import { afterEach, describe, expect, it, vi } from 'vitest'

import { makePaneKey } from '../../shared/stable-pane-id'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'

describe('OrcaRuntimeService dispatch cleanup on terminal exit', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('fails the pane-owned dispatch after its terminal handle was reminted', () => {
    const runtime = new OrcaRuntimeService()
    db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)

    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = makePaneKey('tab-worker', leafId)
    const task = db.createTask({ spec: 'work' })
    const dispatch = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_before_restart',
      assigneePaneKey: paneKey,
      creator: { kind: 'system' },
      maxDepth: 4
    })
    const remintedHandle = runtime.preAllocateHandleForPty('pty-worker')
    expect(remintedHandle).not.toBe(dispatch.assignee_handle)

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-worker',
          worktreeId: 'worktree-1',
          title: 'Worker',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-worker',
          worktreeId: 'worktree-1',
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-worker'
        }
      ]
    })

    runtime.onPtyExit('pty-worker', 9)

    expect(db.getDispatchContextById(dispatch.id)).toMatchObject({
      status: 'failed',
      last_failure: 'Agent process exited with code 9'
    })
    expect(db.getTask(task.id)?.status).toBe('ready')
  })

  it('keeps a Harness-owned exit scoped to its Run', () => {
    const runtime = new OrcaRuntimeService()
    db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)

    const leafId = '22222222-2222-4222-8222-222222222222'
    const paneKey = makePaneKey('tab-harness-worker', leafId)
    const run = db.createRun({
      objective: 'Jaws Harness: Codex',
      coordinatorHandle: 'terminal-codex',
      coordinatorPaneKey: paneKey
    })
    const task = db.createTask({
      spec: 'Harness work',
      createdByTerminalHandle: 'terminal-codex',
      runId: run.id
    })
    const dispatch = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_before_restart',
      assigneePaneKey: paneKey,
      creator: { kind: 'system' },
      maxDepth: 4
    })
    db.createCoordinatorRun({ spec: 'unrelated work', coordinatorHandle: 'generic-coordinator' })
    runtime.preAllocateHandleForPty('pty-harness-worker')

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-harness-worker',
          worktreeId: 'worktree-1',
          title: 'Harness worker',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-harness-worker',
          worktreeId: 'worktree-1',
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-harness-worker'
        }
      ]
    })

    runtime.onPtyExit('pty-harness-worker', 9)

    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('failed')
    expect(db.getTask(task.id)).toMatchObject({
      status: 'ready',
      result: null
    })
    expect(db.getUnreadMessages('generic-coordinator')).toEqual([])
    expect(
      db.getOrCreateRunDelivery({
        runId: run.id,
        consumerGeneration: run.consumer_generation
      })?.messages
    ).toEqual([expect.objectContaining({ run_id: run.id, type: 'escalation' })])
  })

  it('wakes the Harness coordinator when a delegated child exits', () => {
    const runtime = new OrcaRuntimeService()
    db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)

    const run = db.createRun({
      objective: 'Jaws Orchestrator',
      coordinatorHandle: 'term_coord_h0',
      coordinatorPaneKey: 'tab-coord:leaf-coord'
    })
    const root = db.createTask({
      spec: 'Coordinate work',
      createdByTerminalHandle: 'term_coord_h0',
      runId: run.id
    })
    db.createDispatchContext({
      taskId: root.id,
      assigneeHandle: 'term_coord_live_h1',
      assigneePaneKey: 'tab-coord:leaf-coord',
      creator: { kind: 'system' },
      maxDepth: 4
    })
    const child = db.createTask({
      spec: 'Delegated work',
      parentId: root.id,
      createdByTerminalHandle: 'term_coord_h0',
      runId: run.id
    })
    const leafId = '33333333-3333-4333-8333-333333333333'
    const paneKey = makePaneKey('tab-child', leafId)
    db.createDispatchContext({
      taskId: child.id,
      assigneeHandle: 'term_child_old',
      assigneePaneKey: paneKey,
      creator: { kind: 'system' },
      maxDepth: 4
    })
    runtime.preAllocateHandleForPty('pty-child')
    const notify = vi.spyOn(runtime, 'notifyMessageArrived')

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-child',
          worktreeId: 'worktree-child',
          title: 'Child',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-child',
          worktreeId: 'worktree-child',
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-child'
        }
      ]
    })

    runtime.onPtyExit('pty-child', 7)

    expect(db.getTask(child.id)?.status).toBe('ready')
    expect(
      db.getOrCreateRunDelivery({
        runId: run.id,
        consumerGeneration: run.consumer_generation
      })?.messages
    ).toEqual([
      expect.objectContaining({ type: 'escalation', subject: expect.stringContaining('code 7') })
    ])
    expect(db.getUnreadMessages('term_coord_live_h1')).toEqual([])
    expect(notify).toHaveBeenCalledWith(`run:${run.id}`, 'escalation')
  })
})
