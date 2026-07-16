/* eslint-disable max-lines -- Why: orchestration tests share a mock runtime factory; splitting by method would duplicate 40 lines of setup per file without improving clarity. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from './orchestration'
import { RpcDispatcher } from '../dispatcher'
import { buildRegistry, type RpcContext, type RpcRequest } from '../core'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'
import type Database from '../../../sqlite/sync-database'

function lifecycleGroupRecipientError(type: 'worker_done' | 'heartbeat'): string {
  return `${type} messages must be sent to a concrete coordinator terminal handle, not a group address.`
}

describe('orchestration RPC methods', () => {
  let db: OrchestrationDb
  let dbOpen = false
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    dbOpen = true
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    ctx = { runtime }
  }

  afterEach(() => {
    if (!dbOpen) {
      return
    }
    const currentDb = db
    // Why: parser-only tests do not call setup(), so cleanup must not reuse
    // the previous test's already-closed in-memory DB.
    dbOpen = false
    currentDb.close()
  })

  function findMethod(name: string) {
    const method = ORCHESTRATION_METHODS.find((m) => m.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method
  }

  async function call(name: string, params: Record<string, unknown>) {
    const method = findMethod(name)
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  function makeRequest(method: string, params: Record<string, unknown>): RpcRequest {
    return { id: 'req_1', authToken: 'token', method, params }
  }

  it('registers all expected methods', () => {
    const registry = buildRegistry(ORCHESTRATION_METHODS)
    expect(registry.size).toBe(16)
    expect(registry.has('orchestration.send')).toBe(true)
    expect(registry.has('orchestration.check')).toBe(true)
    expect(registry.has('orchestration.reply')).toBe(true)
    expect(registry.has('orchestration.inbox')).toBe(true)
    expect(registry.has('orchestration.taskCreate')).toBe(true)
    expect(registry.has('orchestration.taskList')).toBe(true)
    expect(registry.has('orchestration.taskUpdate')).toBe(true)
    expect(registry.has('orchestration.dispatch')).toBe(true)
    expect(registry.has('orchestration.dispatchShow')).toBe(true)
    expect(registry.has('orchestration.ask')).toBe(true)
    expect(registry.has('orchestration.run')).toBe(true)
    expect(registry.has('orchestration.runStop')).toBe(true)
    expect(registry.has('orchestration.gateCreate')).toBe(true)
    expect(registry.has('orchestration.gateResolve')).toBe(true)
    expect(registry.has('orchestration.gateList')).toBe(true)
    expect(registry.has('orchestration.reset')).toBe(true)
  })

  describe('orchestration.send', () => {
    it('sends a message', async () => {
      setup()
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: 'term_b',
        subject: 'hello'
      })) as { message: { id: string; from_handle: string } }

      expect(result.message.id).toMatch(/^msg_/)
      expect(result.message.from_handle).toBe('term_a')
      expect(runtime.deliverPendingMessagesForHandle).toHaveBeenCalledWith('term_b')
    })

    it('stores the sender pane key on the message row', async () => {
      setup()
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: 'term_b',
        subject: 'hello',
        senderPaneKey: 'tab_a:leaf_a'
      })) as { message: { id: string } }

      expect(db.getMessageById(result.message.id)?.sender_pane_key).toBe('tab_a:leaf_a')
    })

    it('recovers missing sender pane identity from the resolved handle', async () => {
      setup()
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_worker:leaf_worker')
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})

      const result = (await call('orchestration.send', {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'hello'
      })) as { message: { id: string } }

      expect(runtime.getTerminalPaneKey).toHaveBeenCalledWith('term_worker')
      expect(db.getMessageById(result.message.id)?.sender_pane_key).toBe('tab_worker:leaf_worker')
    })

    it('completes an identity-less injected send through its explicit worker handle', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      const dispatch = db.createDispatchContext(task.id, 'term_worker', 'tab_worker:leaf_worker')
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_worker' ? 'tab_worker:leaf_worker' : null
      )
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})

      await call('orchestration.send', {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id })
      })

      expect(db.getTask(task.id)?.status).toBe('completed')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    })

    it('rejects an identity-less lifecycle send resolved through the coordinator handle', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      const dependent = db.createTask({ spec: 'dependent', deps: [task.id] })
      const dispatch = db.createDispatchContext(task.id, 'term_worker', 'tab_worker:leaf_worker')
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_coord' ? 'tab_coord:leaf_coord' : null
      )
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})

      await call('orchestration.send', {
        from: 'term_coord',
        to: 'term_coord',
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id })
      })

      expect(db.getTask(task.id)?.status).toBe('dispatched')
      expect(db.getTask(dependent.id)?.status).toBe('pending')
    })

    it('does not replace a foreign sender pane with its claimed assignee handle pane', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      const dispatch = db.createDispatchContext(task.id, 'term_worker', 'tab_worker:leaf_worker')
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_worker:leaf_worker')
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

      const result = (await call('orchestration.send', {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'Done',
        type: 'worker_done',
        senderPaneKey: 'tab_foreign:leaf_foreign',
        payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id })
      })) as {
        message: { id: string; type: string; subject: string }
        lifecycle: { action: string; code: string; reason: string }
      }

      expect(db.getTask(task.id)?.status).toBe('dispatched')
      expect(result.lifecycle).toMatchObject({
        action: 'rejected',
        code: 'sender_not_assignee',
        reason: expect.stringContaining('expected handle term_worker')
      })
      expect(result.message).toMatchObject({
        type: 'worker_done',
        subject: 'Rejected worker_done: Done'
      })
      expect(db.getUnreadMessages('term_coord')).toEqual([
        expect.objectContaining({ id: result.message.id, type: 'worker_done' })
      ])
      expect(runtime.notifyMessageArrived).toHaveBeenCalledWith('term_coord', 'worker_done')
    })

    it('does not wake waiters for a heartbeat suppressed at send time', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      const dispatch = db.createDispatchContext(task.id, 'term_worker')
      db.updateTaskStatus(task.id, 'completed')
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
      const notify = vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

      const result = (await call('orchestration.send', {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'alive',
        type: 'heartbeat',
        payload: JSON.stringify({ dispatchId: dispatch.id })
      })) as { message: { id: string } }

      expect(notify).not.toHaveBeenCalled()
      expect(db.getMessageById(result.message.id)).toMatchObject({ read: 1 })
    })

    it('still wakes waiters for a heartbeat on an active dispatch', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      const dispatch = db.createDispatchContext(task.id, 'term_worker')
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
      const notify = vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

      await call('orchestration.send', {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'alive',
        type: 'heartbeat',
        payload: JSON.stringify({ dispatchId: dispatch.id })
      })

      expect(notify).toHaveBeenCalledWith('term_coord', 'heartbeat')
    })

    it('rejects missing --to', () => {
      const method = findMethod('orchestration.send')
      expect(() => method.params!.parse({ subject: 'hi' })).toThrow()
    })

    it('rejects missing --subject', () => {
      const method = findMethod('orchestration.send')
      expect(() => method.params!.parse({ to: 'b' })).toThrow()
    })

    it('rejects invalid enum values', () => {
      const method = findMethod('orchestration.send')
      expect(() => method.params!.parse({ to: 'b', subject: 'hi', type: 'typo' })).toThrow()
      expect(() => method.params!.parse({ to: 'b', subject: 'hi', priority: 'medium' })).toThrow()
    })

    it.each(['@all', '@idle', '@worktree:wt_1', '@codex', '@nobody'])(
      'rejects worker_done to group recipient %s without inserting rows',
      async (to) => {
        setup()
        const listTerminals = vi.spyOn(runtime, 'listTerminals')

        await expect(
          call('orchestration.send', {
            from: 'term_worker',
            to,
            subject: 'done',
            type: 'worker_done'
          })
        ).rejects.toThrow(lifecycleGroupRecipientError('worker_done'))

        expect(db.getInbox(100)).toHaveLength(0)
        expect(listTerminals).not.toHaveBeenCalled()
      }
    )

    it('rejects worker_done groups before terminal listing failures can win', async () => {
      setup()
      const listTerminals = vi
        .spyOn(runtime, 'listTerminals')
        .mockRejectedValue(new Error('terminal listing failed'))

      await expect(
        call('orchestration.send', {
          from: 'term_worker',
          to: '@all',
          subject: 'done',
          type: 'worker_done'
        })
      ).rejects.toThrow(lifecycleGroupRecipientError('worker_done'))

      expect(listTerminals).not.toHaveBeenCalled()
      expect(db.getInbox(100)).toHaveLength(0)
    })

    it('returns invalid_argument for worker_done group sends through the dispatcher', async () => {
      setup()
      const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
      const listTerminals = vi.spyOn(runtime, 'listTerminals')

      const response = await dispatcher.dispatch(
        makeRequest('orchestration.send', {
          from: 'term_worker',
          to: '@all',
          subject: 'done',
          type: 'worker_done'
        })
      )

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'invalid_argument',
          message: lifecycleGroupRecipientError('worker_done')
        }
      })
      expect(listTerminals).not.toHaveBeenCalled()
      expect(db.getInbox(100)).toHaveLength(0)
    })

    function makeSummary(
      handle: string,
      opts: Partial<RuntimeTerminalSummary> = {}
    ): RuntimeTerminalSummary {
      return {
        handle,
        ptyId: opts.ptyId ?? handle,
        worktreeId: opts.worktreeId ?? 'wt_default',
        worktreePath: opts.worktreePath ?? '/tmp/wt',
        branch: opts.branch ?? 'main',
        tabId: opts.tabId ?? 'tab_1',
        leafId: opts.leafId ?? handle,
        title: opts.title ?? null,
        connected: opts.connected ?? true,
        writable: opts.writable ?? true,
        lastOutputAt: opts.lastOutputAt ?? null,
        preview: opts.preview ?? ''
      }
    }

    function setupWithTerminals(
      terminals: RuntimeTerminalSummary[],
      agentStatuses?: Record<string, string>
    ): void {
      setup()
      vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
        terminals,
        totalCount: terminals.length,
        truncated: false
      })
      vi.spyOn(runtime, 'getAgentStatusForHandle').mockImplementation(
        (handle: string) => agentStatuses?.[handle] ?? null
      )
    }

    it('fans out @all to all terminals except sender', async () => {
      setupWithTerminals([makeSummary('term_a'), makeSummary('term_b'), makeSummary('term_c')])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@all',
        subject: 'broadcast'
      })) as { messages: { to_handle: string }[]; recipients: number }

      expect(result.recipients).toBe(2)
      expect(result.messages).toHaveLength(2)
      const recipients = result.messages.map((m) => m.to_handle).sort()
      expect(recipients).toEqual(['term_b', 'term_c'])
    })

    it('continues to fan out status messages to groups', async () => {
      setupWithTerminals([makeSummary('term_a'), makeSummary('term_b'), makeSummary('term_c')])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@all',
        subject: 'status broadcast',
        type: 'status'
      })) as { messages: { to_handle: string; type: string }[]; recipients: number }

      expect(result.recipients).toBe(2)
      expect(result.messages.map((m) => m.to_handle).sort()).toEqual(['term_b', 'term_c'])
      expect(result.messages.every((m) => m.type === 'status')).toBe(true)
    })

    it('rejects heartbeat group sends before inserting rows', async () => {
      setup()
      const listTerminals = vi.spyOn(runtime, 'listTerminals')

      await expect(
        call('orchestration.send', {
          from: 'term_worker',
          to: '@all',
          subject: 'alive',
          type: 'heartbeat',
          payload: JSON.stringify({ taskId: 'task_1', dispatchId: 'ctx_1' })
        })
      ).rejects.toThrow(lifecycleGroupRecipientError('heartbeat'))

      expect(listTerminals).not.toHaveBeenCalled()
      expect(db.getInbox(100)).toHaveLength(0)
    })

    it('continues to send worker_done to a concrete terminal handle', async () => {
      setup()

      const result = (await call('orchestration.send', {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'done',
        type: 'worker_done',
        payload: JSON.stringify({ taskId: 'task_1', dispatchId: 'ctx_1' })
      })) as { message: { to_handle: string; type: string; payload: string | null } }

      expect(result.message.to_handle).toBe('term_coord')
      expect(result.message.type).toBe('worker_done')
      expect(result.message.payload).toBe(JSON.stringify({ taskId: 'task_1', dispatchId: 'ctx_1' }))
    })

    it('fans out @idle to only idle agents', async () => {
      setupWithTerminals([makeSummary('term_a'), makeSummary('term_b'), makeSummary('term_c')], {
        term_b: 'idle',
        term_c: 'busy'
      })

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@idle',
        subject: 'idle check'
      })) as { messages: { to_handle: string }[]; recipients: number }

      expect(result.recipients).toBe(1)
      expect(result.messages[0].to_handle).toBe('term_b')
    })

    it('fans out agent name group (@claude) by title match', async () => {
      setupWithTerminals([
        makeSummary('term_a', { title: 'Claude Code' }),
        makeSummary('term_b', { title: 'Claude Code' }),
        makeSummary('term_c', { title: 'Codex' })
      ])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@claude',
        subject: 'claude only'
      })) as { messages: { to_handle: string }[]; recipients: number }

      expect(result.recipients).toBe(1)
      expect(result.messages[0].to_handle).toBe('term_b')
    })

    it('fans out @droid by title match', async () => {
      setupWithTerminals([
        makeSummary('term_a', { title: 'Codex' }),
        makeSummary('term_b', { title: 'Droid ready' }),
        makeSummary('term_c', { title: 'Android build' })
      ])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@droid',
        subject: 'droid only'
      })) as { messages: { to_handle: string }[]; recipients: number }

      expect(result.recipients).toBe(1)
      expect(result.messages[0].to_handle).toBe('term_b')
    })

    it('fans out @cursor by title match without claiming a cursor-mentioning title', async () => {
      setupWithTerminals([
        makeSummary('term_a', { title: 'Codex' }),
        makeSummary('term_b', { title: 'Cursor ready' }),
        makeSummary('term_c', { title: '✳ Fix the text cursor blink' })
      ])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@cursor',
        subject: 'cursor only'
      })) as { messages: { to_handle: string }[]; recipients: number }

      expect(result.recipients).toBe(1)
      expect(result.messages[0].to_handle).toBe('term_b')
    })

    it('fans out @worktree:<id> to matching worktree', async () => {
      setupWithTerminals([
        makeSummary('term_a', { worktreeId: 'wt_1' }),
        makeSummary('term_b', { worktreeId: 'wt_1' }),
        makeSummary('term_c', { worktreeId: 'wt_2' })
      ])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@worktree:wt_1',
        subject: 'worktree msg'
      })) as { messages: { to_handle: string }[]; recipients: number }

      expect(result.recipients).toBe(1)
      expect(result.messages[0].to_handle).toBe('term_b')
    })

    it('shares thread_id across fan-out messages', async () => {
      setupWithTerminals([makeSummary('term_a'), makeSummary('term_b'), makeSummary('term_c')])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@all',
        subject: 'threaded',
        threadId: 'my_thread'
      })) as { messages: { thread_id: string }[] }

      expect(result.messages[0].thread_id).toBe('my_thread')
      expect(result.messages[1].thread_id).toBe('my_thread')
    })

    it('generates a shared thread_id when none provided', async () => {
      setupWithTerminals([makeSummary('term_a'), makeSummary('term_b'), makeSummary('term_c')])

      const result = (await call('orchestration.send', {
        from: 'term_a',
        to: '@all',
        subject: 'auto thread'
      })) as { messages: { thread_id: string }[] }

      expect(result.messages[0].thread_id).toMatch(/^thread_/)
      expect(result.messages[0].thread_id).toBe(result.messages[1].thread_id)
    })

    it('throws when group resolves to no recipients', async () => {
      setupWithTerminals([makeSummary('term_a')])

      await expect(
        call('orchestration.send', {
          from: 'term_a',
          to: '@all',
          subject: 'nobody home'
        })
      ).rejects.toThrow('No recipients resolved for group address')
    })

    it('releases dispatch lock before waking recipients when worker_done is sent via send', async () => {
      setup()
      const task = db.createTask({ spec: 'lock-release work' })
      const dispatch = db.createDispatchContext(task.id, 'term_worker')

      // Why: assert lock is already gone at delivery time, not just after the call.
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {
        expect(db.getActiveDispatchForTerminal('term_worker')).toBeUndefined()
      })

      const result = (await call('orchestration.send', {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'done',
        type: 'worker_done',
        payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id })
      })) as { message: { type: string } }

      expect(result.message.type).toBe('worker_done')
      expect(db.getTask(task.id)?.status).toBe('completed')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
      expect(db.getActiveDispatchForTerminal('term_worker')).toBeUndefined()
      // Lock released — a new dispatch to the same terminal must succeed.
      const t2 = db.createTask({ spec: 'follow-up work' })
      expect(() => db.createDispatchContext(t2.id, 'term_worker')).not.toThrow()
    })

    it('records heartbeat when heartbeat is sent via send', async () => {
      setup()
      const task = db.createTask({ spec: 'heartbeat work' })
      const dispatch = db.createDispatchContext(task.id, 'term_worker')
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})

      await call('orchestration.send', {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'alive',
        type: 'heartbeat',
        payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id })
      })

      expect(db.getTask(task.id)?.status).toBe('dispatched')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
      expect(db.getDispatchContextById(dispatch.id)?.last_heartbeat_at).toBeTruthy()
      expect(db.getActiveDispatchForTerminal('term_worker')).toBeDefined()
    })

    it('does not release dispatch lock for non-lifecycle sends', async () => {
      setup()
      const task = db.createTask({ spec: 'in-flight work' })
      const dispatch = db.createDispatchContext(task.id, 'term_worker')
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})

      await call('orchestration.send', {
        from: 'term_coord',
        to: 'term_worker',
        subject: 'how is it going?',
        type: 'status'
      })

      expect(db.getTask(task.id)?.status).toBe('dispatched')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
      expect(db.getActiveDispatchForTerminal('term_worker')).toBeDefined()
    })
  })

  describe('orchestration.check', () => {
    function createDispatchedTask(assigneeHandle = 'term_worker', assigneePaneKey?: string) {
      const task = db.createTask({ spec: 'manual check work' })
      const dispatch = db.createDispatchContext(task.id, assigneeHandle, assigneePaneKey)
      return { task, dispatch }
    }

    function insertWorkerDone(params: {
      from?: string
      to?: string
      taskId?: string
      dispatchId?: string
      filesModified?: string[]
      senderPaneKey?: string
    }): void {
      const payload: Record<string, unknown> = {}
      if (params.taskId !== undefined) {
        payload.taskId = params.taskId
      }
      if (params.dispatchId !== undefined) {
        payload.dispatchId = params.dispatchId
      }
      if (params.filesModified !== undefined) {
        payload.filesModified = params.filesModified
      }

      db.insertMessage({
        from: params.from ?? 'term_worker',
        to: params.to ?? 'term_coord',
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify(payload),
        senderPaneKey: params.senderPaneKey
      })
    }

    it('returns unread messages for a terminal', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      db.insertMessage({ from: 'a', to: 'b', subject: 'two' })
      db.insertMessage({ from: 'a', to: 'c', subject: 'other' })

      const result = (await call('orchestration.check', {
        terminal: 'b'
      })) as { messages: unknown[]; count: number }

      expect(result.count).toBe(2)
    })

    it('returns formatted output with --inject', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'test' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        inject: true
      })) as { formatted: string; count: number }

      expect(result.formatted).toContain('Subject: test')
      expect(result.count).toBe(1)
    })

    it('filters by type', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'status', type: 'status' })
      db.insertMessage({ from: 'a', to: 'b', subject: 'done', type: 'worker_done' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        types: 'worker_done'
      })) as { count: number }

      expect(result.count).toBe(1)
    })

    it('reconciles worker_done returned by a waiting manual check', async () => {
      setup()
      const { task, dispatch } = createDispatchedTask()
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
        insertWorkerDone({
          taskId: task.id,
          dispatchId: dispatch.id,
          filesModified: ['src/file.ts']
        })
      })

      const result = (await call('orchestration.check', {
        terminal: 'term_coord',
        wait: true,
        timeoutMs: 100,
        types: 'worker_done,escalation,decision_gate'
      })) as { count: number; messages: { type: string }[] }

      expect(result.count).toBe(1)
      expect(result.messages[0].type).toBe('worker_done')
      expect(db.getTask(task.id)?.status).toBe('completed')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
      expect(db.getUnreadMessages('term_coord')).toHaveLength(0)
      const taskList = (await call('orchestration.taskList', {})) as {
        tasks: {
          id: string
          status: string
          assignee_handle?: string | null
          dispatch_id?: string | null
        }[]
      }
      const listedTask = taskList.tasks.find((t) => t.id === task.id)
      expect(listedTask?.status).toBe('completed')
      expect(listedTask).not.toHaveProperty('assignee_handle')
      expect(listedTask).not.toHaveProperty('dispatch_id')
      const shownDispatch = (await call('orchestration.dispatchShow', {
        task: task.id
      })) as { dispatch: { status: string } | null }
      expect(shownDispatch.dispatch?.status).toBe('completed')

      const completedAt = db.getTask(task.id)?.completed_at
      const taskResult = db.getTask(task.id)?.result
      const repeated = (await call('orchestration.check', {
        terminal: 'term_coord',
        types: 'worker_done'
      })) as { count: number }
      expect(repeated.count).toBe(0)
      expect(db.getTask(task.id)?.completed_at).toBe(completedAt)
      expect(db.getTask(task.id)?.result).toBe(taskResult)
    })

    it('repairs a legacy half-completion in check --all without marking messages read', async () => {
      setup()
      const { task, dispatch } = createDispatchedTask()
      const sqlite = (db as unknown as { db: Database.Database }).db
      sqlite
        .prepare("UPDATE tasks SET status = 'completed', result = 'legacy-result' WHERE id = ?")
        .run(task.id)
      const heartbeat = db.insertMessage({
        from: 'term_worker',
        to: 'term_coord',
        subject: 'alive',
        type: 'heartbeat',
        payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id })
      })
      insertWorkerDone({ taskId: task.id, dispatchId: dispatch.id })

      const result = (await call('orchestration.check', {
        terminal: 'term_coord',
        all: true,
        types: 'worker_done'
      })) as { count: number }

      expect(result.count).toBe(1)
      expect(db.getTask(task.id)?.status).toBe('completed')
      expect(db.getTask(task.id)?.result).toBe('legacy-result')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
      expect(db.getUnreadMessages('term_coord', ['worker_done'])).toHaveLength(1)
      expect(db.getMessageById(heartbeat.id)).toMatchObject({ read: 0, delivered_at: null })
    })

    it('repairs the inverse legacy half-completion from the exact durable replay', async () => {
      setup()
      const { task, dispatch } = createDispatchedTask()
      db.completeDispatch(dispatch.id)
      insertWorkerDone({ taskId: task.id, dispatchId: dispatch.id })

      const result = (await call('orchestration.check', {
        terminal: 'term_coord',
        all: true,
        types: 'worker_done'
      })) as { count: number }

      expect(result.count).toBe(1)
      expect(db.getTask(task.id)?.status).toBe('completed')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    })

    it('does not complete worker_done missing taskId or dispatchId', async () => {
      setup()
      const { task, dispatch } = createDispatchedTask()
      insertWorkerDone({ dispatchId: dispatch.id })
      insertWorkerDone({ taskId: task.id })

      const result = (await call('orchestration.check', {
        terminal: 'term_coord',
        types: 'worker_done'
      })) as { count: number }

      expect(result.count).toBe(2)
      expect(db.getTask(task.id)?.status).toBe('dispatched')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    })

    it('completes worker_done by payload IDs when the sender handle changed', async () => {
      setup()
      const leafId = '11111111-1111-4111-8111-111111111111'
      const { task, dispatch } = createDispatchedTask('term_owner', `tab_before:${leafId}`)
      insertWorkerDone({
        from: 'term_reminted',
        taskId: task.id,
        dispatchId: dispatch.id,
        senderPaneKey: `tab_after:${leafId}`
      })

      const result = (await call('orchestration.check', {
        terminal: 'term_coord',
        types: 'worker_done'
      })) as { count: number }

      expect(result.count).toBe(1)
      expect(db.getTask(task.id)?.status).toBe('completed')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    })

    it('does not complete worker_done for a stale inactive dispatch', async () => {
      setup()
      const task = db.createTask({ spec: 'retry-sensitive work' })
      const staleDispatch = db.createDispatchContext(task.id, 'term_old')
      db.failDispatch(staleDispatch.id, 'retry elsewhere')
      const activeDispatch = db.createDispatchContext(task.id, 'term_current')
      insertWorkerDone({
        from: 'term_old',
        taskId: task.id,
        dispatchId: staleDispatch.id
      })

      const result = (await call('orchestration.check', {
        terminal: 'term_coord',
        types: 'worker_done'
      })) as { count: number }

      expect(result.count).toBe(1)
      expect(db.getTask(task.id)?.status).toBe('dispatched')
      expect(db.getDispatchContextById(staleDispatch.id)?.status).toBe('failed')
      expect(db.getDispatchContextById(activeDispatch.id)?.status).toBe('dispatched')
    })

    it('returns a persisted foreign completion as a rejection diagnostic', async () => {
      setup()
      const { task, dispatch } = createDispatchedTask('term_worker', 'tab_worker:leaf_worker')
      insertWorkerDone({
        from: 'term_foreign',
        taskId: task.id,
        dispatchId: dispatch.id,
        senderPaneKey: 'tab_foreign:leaf_foreign'
      })

      const result = (await call('orchestration.check', {
        terminal: 'term_coord',
        types: 'worker_done'
      })) as { count: number; messages: { type: string; subject: string; body: string }[] }

      expect(result).toMatchObject({
        count: 1,
        messages: [
          {
            type: 'worker_done',
            subject: 'Rejected worker_done: Done',
            body: expect.stringContaining('expected handle term_worker')
          }
        ]
      })
      expect(db.getTask(task.id)?.status).toBe('dispatched')
    })

    it('records heartbeat returned by unread manual check', async () => {
      setup()
      const { task, dispatch } = createDispatchedTask()
      const msg = db.insertMessage({
        from: 'term_worker',
        to: 'term_coord',
        subject: 'alive',
        type: 'heartbeat',
        payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id })
      })

      const result = (await call('orchestration.check', {
        terminal: 'term_coord',
        types: 'heartbeat'
      })) as { count: number }

      expect(result.count).toBe(1)
      expect(db.getDispatchContextById(dispatch.id)?.last_heartbeat_at).toBe(msg.created_at)
    })

    it('keeps an inactive heartbeat unread during check --all reconciliation', async () => {
      setup()
      const { task, dispatch } = createDispatchedTask()
      db.updateTaskStatus(task.id, 'completed')
      const heartbeat = db.insertMessage({
        from: 'term_worker',
        to: 'term_coord',
        subject: 'late heartbeat',
        type: 'heartbeat',
        payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id })
      })

      const result = (await call('orchestration.check', {
        terminal: 'term_coord',
        all: true,
        types: 'heartbeat'
      })) as { count: number }

      expect(result.count).toBe(1)
      expect(db.getUnreadMessages('term_coord', ['heartbeat']).map((row) => row.id)).toEqual([
        heartbeat.id
      ])
    })

    it('rejects invalid type filters', async () => {
      setup()
      await expect(
        call('orchestration.check', {
          terminal: 'b',
          types: 'worker_done,typo'
        })
      ).rejects.toThrow('Invalid --types')
    })

    it('rejects conflicting message read modes', () => {
      const method = findMethod('orchestration.check')
      expect(() => method.params!.parse({ unread: true, peek: true })).toThrow(/read mode/)
    })

    it('default (unread only) marks returned rows as read', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      db.insertMessage({ from: 'a', to: 'b', subject: 'two' })

      const first = (await call('orchestration.check', { terminal: 'b' })) as {
        count: number
      }
      expect(first.count).toBe(2)

      const second = (await call('orchestration.check', { terminal: 'b' })) as {
        count: number
      }
      expect(second.count).toBe(0)
    })

    it('--peek returns unread messages without marking them read', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        peek: true
      })) as { count: number }

      expect(result.count).toBe(1)
      expect(db.getUnreadMessages('b')).toHaveLength(1)
    })

    it("treats the CLI's {peek, unread:false} compat pair as peek, not all", async () => {
      setup()
      const seen = db.insertMessage({ from: 'a', to: 'b', subject: 'seen' })
      db.markAsRead([seen.id])
      db.insertMessage({ from: 'a', to: 'b', subject: 'fresh' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        peek: true,
        unread: false
      })) as { messages: { subject: string }[]; count: number }

      expect(result.count).toBe(1)
      expect(result.messages[0]?.subject).toBe('fresh')
      expect(db.getUnreadMessages('b')).toHaveLength(1)
    })

    it('--all returns every message for the handle without marking read', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      const second = db.insertMessage({ from: 'a', to: 'b', subject: 'two' })
      db.markAsRead([second.id])

      const result = (await call('orchestration.check', {
        terminal: 'b',
        all: true
      })) as { messages: { read: number }[]; count: number }

      expect(result.count).toBe(2)
      // Must not have flipped the remaining unread row
      const stillUnread = db.getUnreadMessages('b')
      expect(stillUnread).toHaveLength(1)
    })

    it('--all applies type filters without marking rows as read', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'status', type: 'status' })
      db.insertMessage({ from: 'a', to: 'b', subject: 'dispatch', type: 'dispatch' })
      db.insertMessage({ from: 'a', to: 'b', subject: 'done', type: 'worker_done' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        all: true,
        types: 'worker_done,dispatch'
      })) as { messages: { type: string }[]; count: number }

      expect(result.count).toBe(2)
      expect(result.messages.map((m) => m.type).sort()).toEqual(['dispatch', 'worker_done'])
      expect(db.getUnreadMessages('b')).toHaveLength(3)
    })

    it('--all returns rows with delivered_at set after push-on-idle stamped them', async () => {
      setup()
      const msg = db.insertMessage({ from: 'a', to: 'b', subject: 'hi' })
      // Why: simulate push-on-idle stamping delivered_at without the runtime loop.
      db.markAsDelivered([msg.id])

      const result = (await call('orchestration.check', {
        terminal: 'b',
        all: true
      })) as { messages: { id: string; delivered_at: string | null }[]; count: number }

      expect(result.count).toBe(1)
      expect(result.messages[0].delivered_at).not.toBeNull()
    })

    it('--all --terminal <unknown> returns empty list', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })

      const result = (await call('orchestration.check', {
        terminal: 'does_not_exist',
        all: true
      })) as { count: number }
      expect(result.count).toBe(0)
    })

    it('unread:false compat shim behaves like --all (one-release bridge)', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        unread: false
      })) as { count: number }
      expect(result.count).toBe(1)

      // Must not have marked read
      expect(db.getUnreadMessages('b')).toHaveLength(1)
    })

    it('does not mark messages read when a waiting check is aborted', async () => {
      setup()
      const abortController = new AbortController()
      ctx = { runtime, signal: abortController.signal }
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
        db.insertMessage({ from: 'a', to: 'b', subject: 'arrived during close' })
        abortController.abort()
      })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        wait: true,
        timeoutMs: 100
      })) as { messages: unknown[]; count: number }

      expect(result).toEqual({ messages: [], count: 0 })
      expect(db.getUnreadMessages('b')).toHaveLength(1)
    })

    it('keeps waiting for requested types when an unrelated heartbeat arrives', async () => {
      setup()

      const waitPromise = call('orchestration.check', {
        terminal: 'coord',
        wait: true,
        timeoutMs: 5000,
        types: 'worker_done,escalation'
      }) as Promise<{ count: number; messages: { type: string }[] }>
      await Promise.resolve()

      await call('orchestration.send', {
        from: 'worker',
        to: 'coord',
        subject: 'alive',
        type: 'heartbeat'
      })

      const early = await Promise.race([
        waitPromise.then(() => 'settled'),
        Promise.resolve('pending')
      ])
      expect(early).toBe('pending')

      await call('orchestration.send', {
        from: 'worker',
        to: 'coord',
        subject: 'done',
        type: 'worker_done'
      })

      const result = await waitPromise
      expect(result.count).toBe(1)
      expect(result.messages[0].type).toBe('worker_done')
    })

    it('does not mark existing messages read when the check starts aborted', async () => {
      setup()
      const abortController = new AbortController()
      abortController.abort()
      ctx = { runtime, signal: abortController.signal }
      db.insertMessage({ from: 'a', to: 'b', subject: 'already unread' })

      const result = (await call('orchestration.check', {
        terminal: 'b',
        wait: true,
        timeoutMs: 100
      })) as { messages: unknown[]; count: number }

      expect(result).toEqual({ messages: [], count: 0 })
      expect(db.getUnreadMessages('b')).toHaveLength(1)
    })
  })

  describe('orchestration.reply', () => {
    it('replies to a message', async () => {
      setup()
      const original = db.insertMessage({ from: 'a', to: 'b', subject: 'question' })

      const result = (await call('orchestration.reply', {
        id: original.id,
        body: 'answer',
        from: 'b'
      })) as { message: { to_handle: string; subject: string; thread_id: string } }

      expect(result.message.to_handle).toBe('a')
      expect(result.message.subject).toBe('Re: question')
      expect(result.message.thread_id).toBe(original.id)
    })

    it('throws on nonexistent message', async () => {
      setup()
      await expect(call('orchestration.reply', { id: 'msg_fake', body: 'nope' })).rejects.toThrow(
        'Message not found'
      )
    })
  })

  describe('orchestration.inbox', () => {
    it('returns all messages', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      db.insertMessage({ from: 'c', to: 'd', subject: 'two' })

      const result = (await call('orchestration.inbox', {})) as { count: number }
      expect(result.count).toBe(2)
    })

    it('--terminal <handle> matches check --all output for the same handle', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      db.insertMessage({ from: 'a', to: 'b', subject: 'two' })
      db.insertMessage({ from: 'a', to: 'c', subject: 'other' })

      const inbox = (await call('orchestration.inbox', { terminal: 'b' })) as {
        messages: { id: string; to_handle: string }[]
        count: number
      }
      const check = (await call('orchestration.check', {
        terminal: 'b',
        all: true
      })) as { messages: { id: string; to_handle: string }[]; count: number }

      expect(inbox.count).toBe(2)
      expect(check.count).toBe(2)
      // Same rows in the same order — both use sequence DESC
      expect(inbox.messages.map((m) => m.id)).toEqual(check.messages.map((m) => m.id))
      expect(inbox.messages.every((m) => m.to_handle === 'b')).toBe(true)
    })

    it('--terminal <unknown_handle> returns empty list without erroring', async () => {
      setup()
      db.insertMessage({ from: 'a', to: 'b', subject: 'one' })

      const result = (await call('orchestration.inbox', {
        terminal: 'does_not_exist'
      })) as { count: number }
      expect(result.count).toBe(0)
    })
  })

  describe('orchestration.taskCreate', () => {
    it('creates a task', async () => {
      setup()
      const result = (await call('orchestration.taskCreate', {
        spec: 'implement feature X',
        taskTitle: 'Feature X',
        displayName: 'Implement feature X'
      })) as { task: { id: string; status: string } }

      expect(result.task.id).toMatch(/^task_/)
      expect(result.task.status).toBe('ready')
      expect(db.getTask(result.task.id)?.task_title).toBe('Feature X')
      expect(db.getTask(result.task.id)?.display_name).toBe('Implement feature X')
    })

    it('creates a task with deps', async () => {
      setup()
      const t1 = db.createTask({ spec: 'first' })

      const result = (await call('orchestration.taskCreate', {
        spec: 'second',
        deps: JSON.stringify([t1.id])
      })) as { task: { status: string } }

      expect(result.task.status).toBe('pending')
    })

    it('round-trips execution kind and agent slot', async () => {
      setup()
      const result = (await call('orchestration.taskCreate', {
        spec: 'inspect the implementation',
        executionKind: 'read-only',
        agentSlot: 'codex'
      })) as { task: { id: string; execution_kind: string; agent_slot: string } }

      expect(result.task).toMatchObject({
        execution_kind: 'read-only',
        agent_slot: 'codex'
      })
      const listed = (await call('orchestration.taskList', {})) as {
        tasks: { id: string; execution_kind: string; agent_slot: string }[]
      }
      expect(listed.tasks.find((task) => task.id === result.task.id)).toMatchObject({
        execution_kind: 'read-only',
        agent_slot: 'codex'
      })
    })

    it('records the caller terminal handle when creating a task', async () => {
      setup()
      const result = (await call('orchestration.taskCreate', {
        spec: 'spawn related workspace',
        callerTerminalHandle: 'term_creator'
      })) as { task: { id: string } }

      expect(db.getTask(result.task.id)?.created_by_terminal_handle).toBe('term_creator')
    })

    it('allows only the pane assigned to a Harness root to create direct child lanes', async () => {
      setup()
      const root = db.createTask({
        spec: 'coordinate',
        createdByTerminalHandle: 'jaws-harness:run-1'
      })
      db.createDispatchContext(root.id, 'term_old_coord', 'tab_coord:leaf_coord')
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
        handle === 'term_live_coord' ? 'tab_coord:leaf_coord' : 'tab_other:leaf_other'
      )

      const result = (await call('orchestration.taskCreate', {
        spec: 'child lane',
        parent: root.id,
        executionKind: 'read-only',
        callerTerminalHandle: 'term_live_coord'
      })) as { task: { id: string } }

      expect(db.getTask(result.task.id)).toMatchObject({
        parent_id: root.id,
        created_by_terminal_handle: 'term_live_coord',
        execution_kind: 'read-only',
        agent_slot: 'codex'
      })
      await expect(
        call('orchestration.taskCreate', {
          spec: 'foreign child',
          parent: root.id,
          callerTerminalHandle: 'term_foreign'
        })
      ).rejects.toThrow('Only the assigned Orchestrator coordinator')

      db.updateTaskStatus(root.id, 'completed')
      await expect(
        call('orchestration.taskCreate', {
          spec: 'late child',
          parent: root.id,
          callerTerminalHandle: 'term_live_coord',
          callerPaneKey: 'tab_coord:leaf_coord'
        })
      ).rejects.toThrow('task tree is sealed')
    })

    it('rejects nested or unparented lanes from an active Harness coordinator', async () => {
      setup()
      const root = db.createTask({
        spec: 'coordinate',
        createdByTerminalHandle: 'jaws-harness:run-1'
      })
      db.createDispatchContext(root.id, 'term_coord', 'tab_coord:leaf_coord')
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_coord:leaf_coord')
      const child = db.createTask({
        spec: 'direct child',
        parentId: root.id,
        createdByTerminalHandle: 'term_coord'
      })
      const genericParent = db.createTask({ spec: 'unrelated generic task' })

      await expect(
        call('orchestration.taskCreate', {
          spec: 'nested child',
          parent: child.id,
          callerTerminalHandle: 'term_coord'
        })
      ).rejects.toThrow('assigned top-level task as parent')
      await expect(
        call('orchestration.taskCreate', {
          spec: 'hidden under generic parent',
          parent: genericParent.id,
          callerTerminalHandle: 'term_coord'
        })
      ).rejects.toThrow('assigned top-level task as parent')
      await expect(
        call('orchestration.taskCreate', {
          spec: 'missing parent',
          callerTerminalHandle: 'term_coord'
        })
      ).rejects.toThrow('must specify the assigned parent task')
    })

    it('rejects invalid deps JSON', async () => {
      setup()
      await expect(
        call('orchestration.taskCreate', { spec: 'bad', deps: 'not-json' })
      ).rejects.toThrow('Invalid --deps')
    })

    it('rejects invalid task contracts and dependencies outside the Harness root', async () => {
      setup()
      const root = db.createTask({
        spec: 'coordinate',
        createdByTerminalHandle: 'jaws-harness:run-1'
      })
      db.createDispatchContext(root.id, 'term_coord', 'tab_coord:leaf_coord')
      const sibling = db.createTask({ spec: 'sibling', parentId: root.id })
      const foreign = db.createTask({ spec: 'foreign' })

      await expect(
        call('orchestration.taskCreate', {
          spec: 'missing contract',
          parent: root.id,
          callerTerminalHandle: 'term_coord',
          callerPaneKey: 'tab_coord:leaf_coord'
        })
      ).rejects.toThrow('must specify --execution-kind')
      await expect(
        call('orchestration.taskCreate', {
          spec: 'wrong agent',
          parent: root.id,
          executionKind: 'worktree',
          agentSlot: 'claude',
          callerTerminalHandle: 'term_coord',
          callerPaneKey: 'tab_coord:leaf_coord'
        })
      ).rejects.toThrow('only the codex agent slot')
      await expect(
        call('orchestration.taskCreate', {
          spec: 'cross-root dep',
          parent: root.id,
          executionKind: 'worktree',
          deps: JSON.stringify([foreign.id]),
          callerTerminalHandle: 'term_coord',
          callerPaneKey: 'tab_coord:leaf_coord'
        })
      ).rejects.toThrow('direct lanes in the same run')

      await expect(
        call('orchestration.taskCreate', {
          spec: 'same-root dep',
          parent: root.id,
          executionKind: 'worktree',
          deps: JSON.stringify([sibling.id]),
          callerTerminalHandle: 'term_coord',
          callerPaneKey: 'tab_coord:leaf_coord'
        })
      ).resolves.toMatchObject({ task: { status: 'pending' } })
      expect(() =>
        findMethod('orchestration.taskCreate').params!.parse({
          spec: 'invalid kind',
          executionKind: 'network'
        })
      ).toThrow()
    })
  })

  describe('orchestration.taskList', () => {
    it('lists all tasks', async () => {
      setup()
      db.createTask({ spec: 'a' })
      db.createTask({ spec: 'b' })

      const result = (await call('orchestration.taskList', {})) as { count: number }
      expect(result.count).toBe(2)
    })

    it('filters by status', async () => {
      setup()
      db.createTask({ spec: 'a' })
      const t2 = db.createTask({ spec: 'b' })
      db.updateTaskStatus(t2.id, 'completed')

      const result = (await call('orchestration.taskList', {
        status: 'ready'
      })) as { count: number }
      expect(result.count).toBe(1)
    })

    it('filters direct child lanes by parent', async () => {
      setup()
      const firstRoot = db.createTask({ spec: 'first root' })
      const secondRoot = db.createTask({ spec: 'second root' })
      const firstChild = db.createTask({ spec: 'first child', parentId: firstRoot.id })
      db.createTask({ spec: 'second child', parentId: secondRoot.id })

      const result = (await call('orchestration.taskList', {
        parent: firstRoot.id
      })) as { tasks: { id: string }[]; count: number }

      expect(result.tasks.map((task) => task.id)).toEqual([firstChild.id])
      expect(result.count).toBe(1)
    })

    it('rejects invalid status filters', () => {
      const method = findMethod('orchestration.taskList')
      expect(() => method.params!.parse({ status: 'done-ish' })).toThrow()
    })

    it('includes assignee_handle and dispatch_id for dispatched tasks', async () => {
      setup()
      const t1 = db.createTask({ spec: 'ready work' })
      const t2 = db.createTask({ spec: 'active work' })
      const ctx = db.createDispatchContext(t2.id, 'term_worker')

      const result = (await call('orchestration.taskList', {})) as {
        tasks: {
          id: string
          status: string
          assignee_handle?: string | null
          dispatch_id?: string | null
        }[]
      }

      const ready = result.tasks.find((t) => t.id === t1.id)
      const dispatched = result.tasks.find((t) => t.id === t2.id)
      expect(ready).toBeDefined()
      expect(dispatched).toBeDefined()
      // Non-dispatched tasks keep the legacy shape — no assignee/dispatch fields.
      expect(ready).not.toHaveProperty('assignee_handle')
      expect(ready).not.toHaveProperty('dispatch_id')
      // Dispatched tasks surface the active dispatch.
      expect(dispatched?.assignee_handle).toBe('term_worker')
      expect(dispatched?.dispatch_id).toBe(ctx.id)
    })
  })

  describe('orchestration.taskList --brief', () => {
    it('abbreviates specs server-side so full text never crosses the wire', async () => {
      setup()
      db.createTask({ spec: `First line\n${'detail '.repeat(40)}` })
      db.createTask({ spec: 'Short task' })

      const result = (await call('orchestration.taskList', { brief: true })) as {
        tasks: { spec: string; spec_truncated: boolean }[]
      }

      const [long, short] = result.tasks
      expect(long.spec).toHaveLength(160)
      expect(long.spec_truncated).toBe(true)
      expect(short.spec).toBe('Short task')
      expect(short.spec_truncated).toBe(false)
    })
  })

  describe('orchestration.taskUpdate', () => {
    it('updates task status', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })

      const result = (await call('orchestration.taskUpdate', {
        id: task.id,
        status: 'completed',
        result: '{"ok": true}'
      })) as { task: { status: string; result: string } }

      expect(result.task.status).toBe('completed')
      expect(result.task.result).toBe('{"ok": true}')
    })

    it('completion frees the active dispatch context', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      db.createDispatchContext(task.id, 'term_a')

      await call('orchestration.taskUpdate', {
        id: task.id,
        status: 'completed'
      })

      expect(db.getActiveDispatchForTerminal('term_a')).toBeUndefined()
    })

    it('throws on nonexistent task', async () => {
      setup()
      await expect(
        call('orchestration.taskUpdate', { id: 'task_fake', status: 'completed' })
      ).rejects.toThrow('Task not found')
    })

    it('rejects direct lifecycle edits while a Harness child dispatch is active', async () => {
      setup()
      const root = db.createTask({
        spec: 'coordinate',
        createdByTerminalHandle: 'jaws-harness:run-1'
      })
      db.createDispatchContext(root.id, 'term_coord')
      const child = db.createTask({
        spec: 'child',
        parentId: root.id,
        createdByTerminalHandle: 'term_coord',
        executionKind: 'read-only',
        agentSlot: 'codex'
      })
      const childDispatch = db.createDispatchContext(child.id, 'term_child')

      for (const status of ['completed', 'failed', 'blocked'] as const) {
        await expect(call('orchestration.taskUpdate', { id: child.id, status })).rejects.toThrow(
          'lifecycle is owned by worker_done and terminal exit'
        )
      }
      expect(db.getTask(child.id)?.status).toBe('dispatched')
      expect(db.getDispatchContextById(childDispatch.id)?.status).toBe('dispatched')
    })
  })

  describe('orchestration.dispatch', () => {
    function mockCodexAgentTarget(): void {
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
      vi.spyOn(runtime, 'getTerminalAgentType').mockResolvedValue('codex')
      vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
        handle: 'term_worker',
        accepted: true,
        bytesWritten: 1
      })
    }

    it('dispatches a task to a terminal', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })

      const result = (await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_a'
      })) as { dispatch: { task_id: string; status: string } }

      expect(result.dispatch.task_id).toBe(task.id)
      expect(result.dispatch.status).toBe('dispatched')
    })

    it('records the assignee pane key on the dispatch context', async () => {
      setup()
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_w:leaf_w')
      const task = db.createTask({ spec: 'work' })

      const result = (await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_a'
      })) as { dispatch: { id: string } }

      expect(runtime.getTerminalPaneKey).toHaveBeenCalledWith('term_a')
      expect(db.getDispatchContextById(result.dispatch.id)?.assignee_pane_key).toBe('tab_w:leaf_w')
    })

    it('rejects a Harness child target without a stable pane identity', async () => {
      setup()
      const root = db.createTask({
        spec: 'coordinate',
        createdByTerminalHandle: 'jaws-harness:run-1'
      })
      db.createDispatchContext(root.id, 'term_coord', 'tab_coord:leaf_coord')
      const child = db.createTask({
        spec: 'child',
        parentId: root.id,
        createdByTerminalHandle: 'term_coord'
      })
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(null)

      await expect(
        call('orchestration.dispatch', {
          task: child.id,
          to: 'term_worker',
          from: 'term_coord',
          senderPaneKey: 'tab_coord:leaf_coord'
        })
      ).rejects.toThrow('requires a stable target pane identity')

      expect(db.getTask(child.id)?.status).toBe('ready')
      expect(db.getDispatchContext(child.id)).toBeUndefined()
    })

    it('requires injected delivery for a Harness child lane', async () => {
      setup()
      const root = db.createTask({
        spec: 'coordinate',
        createdByTerminalHandle: 'jaws-harness:run-1'
      })
      db.createDispatchContext(root.id, 'term_coord', 'tab_coord:leaf_coord', {
        assigneeWorktreeId: 'wt_integration'
      })
      const child = db.createTask({
        spec: 'inspect',
        parentId: root.id,
        createdByTerminalHandle: 'term_coord',
        executionKind: 'read-only',
        agentSlot: 'codex'
      })
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_worker:leaf_worker')

      await expect(
        call('orchestration.dispatch', {
          task: child.id,
          to: 'term_worker',
          from: 'term_coord',
          senderPaneKey: 'tab_coord:leaf_coord'
        })
      ).rejects.toThrow('requires --inject')

      expect(db.getTask(child.id)?.status).toBe('ready')
      expect(db.getDispatchContext(child.id)).toBeUndefined()
    })

    it('requires the Harness child target to run its assigned agent', async () => {
      setup()
      const root = db.createTask({
        spec: 'coordinate',
        createdByTerminalHandle: 'jaws-harness:run-1'
      })
      db.createDispatchContext(root.id, 'term_coord', 'tab_coord:leaf_coord', {
        assigneeWorktreeId: 'wt_integration'
      })
      const child = db.createTask({
        spec: 'inspect',
        parentId: root.id,
        createdByTerminalHandle: 'term_coord',
        executionKind: 'read-only',
        agentSlot: 'codex'
      })
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_worker:leaf_worker')
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
      vi.spyOn(runtime, 'showTerminal').mockResolvedValue({ worktreeId: 'wt_integration' } as never)
      vi.spyOn(runtime, 'getTerminalAgentType').mockResolvedValue('claude')
      const sendPrompt = vi.spyOn(runtime, 'sendTerminalAgentPrompt')

      await expect(
        call('orchestration.dispatch', {
          task: child.id,
          to: 'term_worker',
          from: 'term_coord',
          senderPaneKey: 'tab_coord:leaf_coord',
          inject: true
        })
      ).rejects.toThrow('must be the codex agent')

      expect(sendPrompt).not.toHaveBeenCalled()
      expect(db.getTask(child.id)?.status).toBe('ready')
      expect(db.getDispatchContext(child.id)).toBeUndefined()
    })

    it('keeps Harness child replies on the stable coordinator inbox after remint', async () => {
      setup()
      const root = db.createTask({
        spec: 'coordinate',
        createdByTerminalHandle: 'jaws-harness:run-1'
      })
      db.createDispatchContext(root.id, 'term_live_h1', 'tab_coord:leaf_coord')
      const child = db.createTask({
        spec: 'child',
        parentId: root.id,
        createdByTerminalHandle: 'term_stable_h0',
        executionKind: 'read-only',
        agentSlot: 'codex'
      })
      const genericTask = db.createTask({ spec: 'unrelated generic work' })
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
        if (handle === 'term_live_h1') {
          return 'tab_coord:leaf_coord'
        }
        if (handle === 'term_worker') {
          return 'tab_worker:leaf_worker'
        }
        return 'tab_foreign:leaf_foreign'
      })
      vi.spyOn(runtime, 'resolveTerminalPane').mockReturnValue({
        handle: 'term_live_h1',
        tabId: 'tab_coord',
        leafId: 'leaf_coord',
        ptyId: 'pty_coord'
      })
      vi.spyOn(runtime, 'showTerminal').mockResolvedValue({ worktreeId: 'wt_integration' } as never)
      mockCodexAgentTarget()

      await expect(
        call('orchestration.dispatch', {
          task: child.id,
          to: 'term_worker',
          from: 'term_foreign'
        })
      ).rejects.toThrow('must use its task creator as --from')

      await expect(
        call('orchestration.dispatch', {
          task: child.id,
          to: 'term_worker',
          from: 'term_live_h1',
          senderPaneKey: 'tab_coord:leaf_coord'
        })
      ).rejects.toThrow('must use its task creator as --from')

      await expect(
        call('orchestration.dispatch', {
          task: genericTask.id,
          to: 'term_worker',
          from: 'term_stable_h0',
          senderPaneKey: 'tab_coord:leaf_coord'
        })
      ).rejects.toThrow('may dispatch only their direct child lanes')

      const result = (await call('orchestration.dispatch', {
        task: child.id,
        to: 'term_worker',
        from: 'term_stable_h0',
        senderPaneKey: 'tab_coord:leaf_coord',
        inject: true,
        returnPreamble: true
      })) as { dispatch: { task_id: string }; preamble: string }
      expect(result.dispatch.task_id).toBe(child.id)
      expect(result.preamble).toContain('--to term_stable_h0')
      expect(result.preamble).toContain('This is a read-only lane')
      expect(db.getDispatchContext(root.id)?.assignee_worktree_id).toBe('wt_integration')
      expect(db.getDispatchContext(child.id)?.assignee_worktree_id).toBe('wt_integration')
    })

    it('rejects a read-only Harness lane outside the integration worktree', async () => {
      setup()
      const root = db.createTask({
        spec: 'coordinate',
        createdByTerminalHandle: 'jaws-harness:run-1'
      })
      db.createDispatchContext(root.id, 'term_coord', 'tab_coord:leaf_coord', {
        assigneeWorktreeId: 'wt_integration'
      })
      const child = db.createTask({
        spec: 'inspect',
        parentId: root.id,
        createdByTerminalHandle: 'term_coord',
        executionKind: 'read-only',
        agentSlot: 'codex'
      })
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_worker:leaf_worker')
      vi.spyOn(runtime, 'showTerminal').mockResolvedValue({ worktreeId: 'wt_isolated' } as never)
      mockCodexAgentTarget()

      await expect(
        call('orchestration.dispatch', {
          task: child.id,
          to: 'term_worker',
          from: 'term_coord',
          senderPaneKey: 'tab_coord:leaf_coord',
          inject: true
        })
      ).rejects.toThrow('must use the integration worktree')
      expect(db.getTask(child.id)?.status).toBe('ready')
      expect(db.getDispatchContext(child.id)).toBeUndefined()
    })

    it('accepts only a clean start-SHA worktree created for the mutating Harness lane', async () => {
      setup()
      const root = db.createTask({
        spec: 'coordinate',
        createdByTerminalHandle: 'jaws-harness:run-1'
      })
      db.createDispatchContext(root.id, 'term_coord', 'tab_coord:leaf_coord', {
        assigneeWorktreeId: 'wt_integration'
      })
      const child = db.createTask({
        spec: 'implement',
        parentId: root.id,
        createdByTerminalHandle: 'term_coord',
        executionKind: 'worktree',
        agentSlot: 'codex'
      })
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_worker:leaf_worker')
      vi.spyOn(runtime, 'showTerminal').mockResolvedValue({ worktreeId: 'wt_lane' } as never)
      mockCodexAgentTarget()
      vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
        id: 'wt_lane',
        repoId: 'repo-1',
        createdWithAgent: 'codex',
        lineage: {
          origin: 'orchestration',
          taskId: child.id,
          parentWorktreeId: 'wt_integration'
        }
      } as never)
      vi.spyOn(runtime, 'getHarnessService').mockReturnValue({
        show: vi.fn().mockReturnValue({ repoId: 'repo-1', baseSha: 'abc123' })
      } as never)
      vi.spyOn(runtime, 'getRuntimeGitStatus').mockResolvedValue({
        head: 'abc123',
        entries: [],
        conflictOperation: 'unknown'
      })

      const result = (await call('orchestration.dispatch', {
        task: child.id,
        to: 'term_worker',
        from: 'term_coord',
        senderPaneKey: 'tab_coord:leaf_coord',
        inject: true,
        returnPreamble: true
      })) as { dispatch: { assignee_worktree_id: string }; preamble: string }

      expect(result.dispatch.assignee_worktree_id).toBe('wt_lane')
      expect(result.preamble).toContain('assigned isolated worktree')
      expect(runtime.getRuntimeGitStatus).toHaveBeenCalledWith('id:wt_lane')
    })

    it('leaves a mutating Harness lane ready when its worktree is dirty', async () => {
      setup()
      const root = db.createTask({
        spec: 'coordinate',
        createdByTerminalHandle: 'jaws-harness:run-1'
      })
      db.createDispatchContext(root.id, 'term_coord', 'tab_coord:leaf_coord', {
        assigneeWorktreeId: 'wt_integration'
      })
      const child = db.createTask({
        spec: 'implement',
        parentId: root.id,
        createdByTerminalHandle: 'term_coord',
        executionKind: 'worktree',
        agentSlot: 'codex'
      })
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_worker:leaf_worker')
      vi.spyOn(runtime, 'showTerminal').mockResolvedValue({ worktreeId: 'wt_lane' } as never)
      mockCodexAgentTarget()
      vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
        repoId: 'repo-1',
        createdWithAgent: 'codex',
        lineage: {
          origin: 'orchestration',
          taskId: child.id,
          parentWorktreeId: 'wt_integration'
        }
      } as never)
      vi.spyOn(runtime, 'getHarnessService').mockReturnValue({
        show: vi.fn().mockReturnValue({ repoId: 'repo-1', baseSha: 'abc123' })
      } as never)
      vi.spyOn(runtime, 'getRuntimeGitStatus').mockResolvedValue({
        head: 'abc123',
        entries: [{ path: 'src/dirty.ts' }],
        conflictOperation: 'unknown'
      } as never)

      await expect(
        call('orchestration.dispatch', {
          task: child.id,
          to: 'term_worker',
          from: 'term_coord',
          senderPaneKey: 'tab_coord:leaf_coord',
          inject: true
        })
      ).rejects.toThrow('worktree is dirty')
      expect(db.getTask(child.id)?.status).toBe('ready')
      expect(db.getDispatchContext(child.id)).toBeUndefined()
    })

    it('caps active Harness child dispatches at four lanes', async () => {
      setup()
      const root = db.createTask({
        spec: 'coordinate',
        createdByTerminalHandle: 'jaws-harness:run-1'
      })
      db.createDispatchContext(root.id, 'term_coord', 'tab_coord:leaf_coord', {
        assigneeWorktreeId: 'wt_integration'
      })
      const children = Array.from({ length: 5 }, (_, index) =>
        db.createTask({
          spec: `inspect ${index}`,
          parentId: root.id,
          createdByTerminalHandle: 'term_coord',
          executionKind: 'read-only',
          agentSlot: 'codex'
        })
      )
      vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation(
        (handle) => `tab_workers:${handle}`
      )
      vi.spyOn(runtime, 'showTerminal').mockResolvedValue({ worktreeId: 'wt_integration' } as never)
      mockCodexAgentTarget()

      for (let index = 0; index < 4; index += 1) {
        await call('orchestration.dispatch', {
          task: children[index].id,
          to: `term_worker_${index}`,
          from: 'term_coord',
          senderPaneKey: 'tab_coord:leaf_coord',
          inject: true
        })
      }
      await expect(
        call('orchestration.dispatch', {
          task: children[4].id,
          to: 'term_worker_4',
          from: 'term_coord',
          senderPaneKey: 'tab_coord:leaf_coord',
          inject: true
        })
      ).rejects.toThrow('maximum is 4')
      expect(db.getTask(children[4].id)?.status).toBe('ready')
    })

    it('rejects dispatch for a pending task', async () => {
      setup()
      const parent = db.createTask({ spec: 'parent' })
      const child = db.createTask({ spec: 'child', deps: [parent.id] })

      await expect(
        call('orchestration.dispatch', {
          task: child.id,
          to: 'term_a'
        })
      ).rejects.toThrow('only ready tasks can be dispatched')
    })

    it('rolls back active dispatch when injection fails', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
      vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockRejectedValue(
        new Error('terminal_not_writable')
      )

      await expect(
        call('orchestration.dispatch', {
          task: task.id,
          to: 'term_a',
          inject: true
        })
      ).rejects.toThrow('terminal_not_writable')

      expect(db.getTask(task.id)?.status).toBe('ready')
      expect(db.getActiveDispatchForTerminal('term_a')).toBeUndefined()
    })

    it('finalizes its exact Harness task when injection fails', async () => {
      setup()
      const owner = 'jaws-harness:run-1'
      const task = db.createTask({ spec: 'work', createdByTerminalHandle: owner })
      vi.spyOn(runtime, 'showTerminal').mockResolvedValue({ worktreeId: 'wt_candidate' } as never)
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
      vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockRejectedValue(
        new Error('terminal_not_writable')
      )

      await expect(
        call('orchestration.dispatch', {
          task: task.id,
          to: 'term_a',
          from: owner,
          inject: true
        })
      ).rejects.toThrow('terminal_not_writable')

      expect(db.getTask(task.id)).toMatchObject({
        status: 'failed',
        result: 'terminal_not_writable'
      })
      expect(db.getActiveDispatchForTerminal('term_a')).toBeUndefined()
    })

    it('uses a non-interactive preamble when a non-Harness caller dispatches a Harness task', async () => {
      setup()
      const owner = 'jaws-harness:run-1'
      const task = db.createTask({ spec: 'work', createdByTerminalHandle: owner })
      vi.spyOn(runtime, 'showTerminal').mockResolvedValue({ worktreeId: 'wt_candidate' } as never)

      const result = (await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_a',
        from: 'term_coord',
        returnPreamble: true
      })) as { preamble: string }

      expect(result.preamble).toContain('=== NON-INTERACTIVE COMPARISON RULES ===')
      expect(result.preamble).not.toMatch(/orchestration ask --to/)
      expect(result.preamble).not.toContain('--type escalation')
    })

    it('uses caller-provided dev mode for injected preamble', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
      const send = vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
        handle: 'term_a',
        accepted: true,
        bytesWritten: 1
      })

      await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_a',
        inject: true,
        devMode: true
      })

      expect(send).toHaveBeenCalledWith(
        'term_a',
        expect.stringContaining('orca-dev orchestration send')
      )
    })

    it('uses the target pane CLI command for the returned preamble', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca-ide')

      const result = (await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_wsl',
        returnPreamble: true
      })) as { preamble: string }

      expect(runtime.getTerminalOrchestrationCliCommand).toHaveBeenCalledWith('term_wsl')
      expect(result.preamble).toContain('orca-ide orchestration send')
      expect(result.preamble).not.toMatch(/(^|\s)orca orchestration/m)
    })

    it('injects preamble through the agent prompt path instead of raw terminal send', async () => {
      setup()
      const task = db.createTask({ spec: 'line one\nline two' })
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
      const agentPrompt = vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
        handle: 'term_a',
        accepted: true,
        bytesWritten: 1
      })
      const rawSend = vi.spyOn(runtime, 'sendTerminal')

      await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_a',
        inject: true,
        from: 'term_coord'
      })

      expect(agentPrompt).toHaveBeenCalledWith(
        'term_a',
        expect.stringContaining('line one\nline two')
      )
      expect(rawSend).not.toHaveBeenCalled()
    })

    it('rejects inject to terminal without recognized agent', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(false)

      await expect(
        call('orchestration.dispatch', {
          task: task.id,
          to: 'term_a',
          inject: true
        })
      ).rejects.toThrow('no recognized agent detected')
    })

    it('rejects dispatch to occupied terminal', async () => {
      setup()
      const t1 = db.createTask({ spec: 'first' })
      const t2 = db.createTask({ spec: 'second' })
      db.createDispatchContext(t1.id, 'term_a')

      await expect(call('orchestration.dispatch', { task: t2.id, to: 'term_a' })).rejects.toThrow(
        /already has an active dispatch/
      )
    })

    it('dry-run returns the preamble without mutating state', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })

      const result = (await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_a',
        inject: true,
        dryRun: true,
        from: 'term_coord'
      })) as {
        dispatch: null
        dryRun: boolean
        preamble: string
        injected: boolean
      }

      expect(result.dryRun).toBe(true)
      expect(result.dispatch).toBeNull()
      expect(result.injected).toBe(false)
      expect(result.preamble).toContain('work')
      expect(result.preamble).toContain(task.id)
      expect(result.preamble).toContain('term_coord')
      // Task state must not change on dry-run.
      expect(db.getTask(task.id)?.status).toBe('ready')
      expect(db.getDispatchContext(task.id)).toBeUndefined()
    })

    it('returnPreamble includes preamble in the response', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })

      const result = (await call('orchestration.dispatch', {
        task: task.id,
        to: 'term_a',
        returnPreamble: true,
        from: 'term_coord'
      })) as { dispatch: { id: string }; preamble: string }

      expect(result.dispatch.id).toMatch(/^ctx_/)
      expect(result.preamble).toContain(task.id)
      expect(result.preamble).toContain('term_coord')
    })
  })

  describe('orchestration.dispatchShow', () => {
    it('shows dispatch context for a task', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      db.createDispatchContext(task.id, 'term_a')

      const result = (await call('orchestration.dispatchShow', {
        task: task.id
      })) as { dispatch: { task_id: string } | null; task: { id: string } | null }

      expect(result.dispatch?.task_id).toBe(task.id)
      expect(result.task?.id).toBe(task.id)
    })

    it('returns null for unknown task', async () => {
      setup()
      const result = (await call('orchestration.dispatchShow', {
        task: 'task_fake'
      })) as { dispatch: null; task: null }

      expect(result.dispatch).toBeNull()
      expect(result.task).toBeNull()
    })

    it('--preamble returns the preamble text', async () => {
      setup()
      const task = db.createTask({ spec: 'refactor auth' })
      db.createDispatchContext(task.id, 'term_a')

      const result = (await call('orchestration.dispatchShow', {
        task: task.id,
        preamble: true,
        from: 'term_coord'
      })) as { dispatch: { task_id: string } | null; preamble: string }

      expect(result.preamble).toContain('refactor auth')
      expect(result.preamble).toContain(task.id)
      expect(result.preamble).toContain('term_coord')
      expect(result.dispatch?.task_id).toBe(task.id)
    })

    it('--preamble works when no dispatch exists yet', async () => {
      setup()
      const task = db.createTask({ spec: 'build feature' })

      const result = (await call('orchestration.dispatchShow', {
        task: task.id,
        preamble: true,
        from: 'term_coord'
      })) as { dispatch: null; preamble: string }

      expect(result.dispatch).toBeNull()
      expect(result.preamble).toContain('build feature')
    })

    it('--preamble throws for unknown task', async () => {
      setup()
      await expect(
        call('orchestration.dispatchShow', { task: 'task_fake', preamble: true })
      ).rejects.toThrow('Task not found')
    })
  })

  describe('orchestration.run', () => {
    it('does not start the server Coordinator over an active Harness tree', async () => {
      setup()
      const root = db.createTask({
        spec: 'coordinate',
        createdByTerminalHandle: 'jaws-harness:run-1'
      })
      db.createDispatchContext(root.id, 'term_coord')

      await expect(
        call('orchestration.run', { spec: 'take over', from: 'term_coord' })
      ).rejects.toThrow('while a Harness lane is active')
      expect(db.getActiveCoordinatorRun()).toBeUndefined()
    })
  })

  describe('orchestration.gateCreate', () => {
    it('creates a decision gate and blocks the task', async () => {
      setup()
      const task = db.createTask({ spec: 'needs approval' })

      const result = (await call('orchestration.gateCreate', {
        task: task.id,
        question: 'Proceed with migration?',
        options: JSON.stringify(['yes', 'no', 'defer'])
      })) as { gate: { id: string; task_id: string; status: string } }

      expect(result.gate.id).toMatch(/^gate_/)
      expect(result.gate.task_id).toBe(task.id)
      expect(result.gate.status).toBe('pending')

      const updated = db.getTask(task.id)
      expect(updated?.status).toBe('blocked')
    })

    it('keeps active Harness dispatches out of persisted decision gates', async () => {
      setup()
      const root = db.createTask({
        spec: 'coordinate',
        createdByTerminalHandle: 'jaws-harness:run-1'
      })
      db.createDispatchContext(root.id, 'term_coord')

      await expect(
        call('orchestration.gateCreate', {
          task: root.id,
          question: 'Proceed?'
        })
      ).rejects.toThrow('use ask/reply')
      expect(db.getTask(root.id)?.status).toBe('dispatched')
      expect(db.getDispatchContext(root.id)?.status).toBe('dispatched')
    })

    it('rejects invalid options JSON', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      await expect(
        call('orchestration.gateCreate', {
          task: task.id,
          question: 'ok?',
          options: 'not-json'
        })
      ).rejects.toThrow('Invalid --options')
    })

    it('rejects options that are not string arrays', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      await expect(
        call('orchestration.gateCreate', {
          task: task.id,
          question: 'ok?',
          options: JSON.stringify(['yes', 1])
        })
      ).rejects.toThrow('Invalid --options')
    })
  })

  describe('orchestration.gateResolve', () => {
    it('resolves a gate and unblocks the task', async () => {
      setup()
      const task = db.createTask({ spec: 'needs approval' })
      const gate = db.createGate({ taskId: task.id, question: 'Proceed?' })

      const result = (await call('orchestration.gateResolve', {
        id: gate.id,
        resolution: 'yes'
      })) as { gate: { id: string; status: string; resolution: string } }

      expect(result.gate.status).toBe('resolved')
      expect(result.gate.resolution).toBe('yes')

      const updated = db.getTask(task.id)
      expect(updated?.status).toBe('ready')
    })

    it('does not resolve a legacy gate on an active Harness task', async () => {
      setup()
      const root = db.createTask({
        spec: 'coordinate',
        createdByTerminalHandle: 'jaws-harness:run-1'
      })
      const gate = db.createGate({ taskId: root.id, question: 'Proceed?' })
      db.updateTaskStatus(root.id, 'ready')
      db.createDispatchContext(root.id, 'term_coord')

      await expect(
        call('orchestration.gateResolve', { id: gate.id, resolution: 'yes' })
      ).rejects.toThrow('use ask/reply')
      expect(db.getGate(gate.id)?.status).toBe('pending')
      expect(db.getDispatchContext(root.id)?.status).toBe('dispatched')
    })

    it('throws on nonexistent gate', async () => {
      setup()
      await expect(
        call('orchestration.gateResolve', { id: 'gate_fake', resolution: 'yes' })
      ).rejects.toThrow('Gate not found')
    })
  })

  describe('orchestration.gateList', () => {
    it('lists all gates', async () => {
      setup()
      const t1 = db.createTask({ spec: 'a' })
      const t2 = db.createTask({ spec: 'b' })
      db.createGate({ taskId: t1.id, question: 'q1' })
      db.createGate({ taskId: t2.id, question: 'q2' })

      const result = (await call('orchestration.gateList', {})) as { count: number }
      expect(result.count).toBe(2)
    })

    it('filters by status', async () => {
      setup()
      const task = db.createTask({ spec: 'work' })
      const gate = db.createGate({ taskId: task.id, question: 'q' })
      db.resolveGate(gate.id, 'yes')

      const result = (await call('orchestration.gateList', {
        status: 'resolved'
      })) as { count: number }
      expect(result.count).toBe(1)
    })

    it('rejects invalid status filters', () => {
      const method = findMethod('orchestration.gateList')
      expect(() => method.params!.parse({ status: 'closed' })).toThrow()
    })
  })

  describe('orchestration.ask', () => {
    it('sends a decision_gate and returns the first thread reply', async () => {
      setup()
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
        // Simulate coordinator replying in the thread during the wait
        const outbound = db.getInbox(10).find((m) => m.type === 'decision_gate')
        if (outbound) {
          db.insertMessage({
            from: 'term_coord',
            to: 'term_worker',
            subject: 'Re: Question',
            body: 'go ahead',
            threadId: outbound.id
          })
        }
      })

      const result = (await call('orchestration.ask', {
        from: 'term_worker',
        to: 'term_coord',
        question: 'proceed?',
        options: 'yes, no',
        timeoutMs: 500
      })) as {
        answer: string
        messageId: string
        threadId: string
        timedOut: boolean
      }

      expect(result.timedOut).toBe(false)
      expect(result.answer).toBe('go ahead')
      expect(result.messageId).toMatch(/^msg_/)

      // Outbound decision_gate message was persisted with parsed options.
      const outbound = db.getInbox(10).find((m) => m.type === 'decision_gate')
      expect(outbound).toBeTruthy()
      expect(outbound?.subject).toBe('Question')
      expect(outbound?.body).toBe('proceed?')
      const payload = JSON.parse(outbound!.payload ?? '{}')
      expect(payload.question).toBe('proceed?')
      expect(payload.options).toEqual(['yes', 'no'])
    })

    it('returns timedOut when no reply arrives in the window', async () => {
      setup()
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
      vi.spyOn(runtime, 'waitForMessage').mockResolvedValue()

      const result = (await call('orchestration.ask', {
        from: 'term_worker',
        to: 'term_coord',
        question: 'still there?',
        timeoutMs: 1
      })) as { answer: string | null; timedOut: boolean; messageId: string | null }

      expect(result.timedOut).toBe(true)
      expect(result.answer).toBeNull()
      expect(result.messageId).toBeNull()
      // Outbound message still persisted (coordinator can still see it).
      const outbound = db.getInbox(10).find((m) => m.type === 'decision_gate')
      expect(outbound).toBeTruthy()
    })

    it('returns promptly when the RPC signal aborts while waiting', async () => {
      setup()
      vi.useFakeTimers()
      const controller = new AbortController()
      const method = findMethod('orchestration.ask')
      const parsed = method.params!.parse({
        from: 'term_worker',
        to: 'term_coord',
        question: 'still there?',
        timeoutMs: 60_000
      })

      try {
        const promise = method.handler(parsed, {
          runtime,
          signal: controller.signal
        }) as Promise<{ timedOut: boolean }>

        controller.abort()
        const outcomePromise = Promise.race([
          promise.then((result) => (result.timedOut ? 'aborted' : 'answered')),
          new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0))
        ])
        await vi.advanceTimersByTimeAsync(0)
        const outcome = await outcomePromise

        expect(outcome).toBe('aborted')
      } finally {
        vi.useRealTimers()
      }
    })

    it('rejects group addresses with a dedicated error (no message persisted)', async () => {
      setup()
      await expect(
        call('orchestration.ask', {
          from: 'term_worker',
          to: '@reviewers',
          question: 'ok?'
        })
      ).rejects.toThrow(/does not support group addresses/)
      expect(db.getInbox(10)).toHaveLength(0)
    })

    it('does not return distractor messages on a different thread', async () => {
      setup()
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
      let wakeCount = 0
      vi.spyOn(runtime, 'waitForMessage').mockImplementation(async () => {
        wakeCount++
        const outbound = db.getInbox(20).find((m) => m.type === 'decision_gate')
        if (wakeCount === 1 && outbound) {
          // First wake: distractor in a DIFFERENT thread — must be ignored.
          db.insertMessage({
            from: 'term_coord',
            to: 'term_worker',
            subject: 'unrelated',
            body: 'other',
            threadId: 'thread_other'
          })
        } else if (wakeCount === 2 && outbound) {
          // Second wake: correct thread reply.
          db.insertMessage({
            from: 'term_coord',
            to: 'term_worker',
            subject: 'Re: Question',
            body: 'correct answer',
            threadId: outbound.id
          })
        }
      })

      const result = (await call('orchestration.ask', {
        from: 'term_worker',
        to: 'term_coord',
        question: 'filter?',
        timeoutMs: 2_000
      })) as { answer: string; timedOut: boolean }

      expect(result.timedOut).toBe(false)
      expect(result.answer).toBe('correct answer')
    })

    it('parses options CSV with whitespace and empty entries', async () => {
      setup()
      vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})
      vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
      vi.spyOn(runtime, 'waitForMessage').mockResolvedValue()

      await call('orchestration.ask', {
        from: 'w',
        to: 'c',
        question: 'q',
        options: 'a, b ,,c',
        timeoutMs: 1
      })

      const outbound = db.getInbox(10).find((m) => m.type === 'decision_gate')
      const payload = JSON.parse(outbound!.payload ?? '{}')
      expect(payload.options).toEqual(['a', 'b', 'c'])
    })
  })

  describe('orchestration.reset', () => {
    function seedResetState(): void {
      db.insertMessage({ from: 'a', to: 'b', subject: 'test' })
      db.createTask({ spec: 'work' })
    }

    it('resets all state', async () => {
      setup()
      seedResetState()

      const result = (await call('orchestration.reset', { all: true })) as { reset: string }
      expect(result.reset).toBe('all')
      expect(db.getInbox()).toHaveLength(0)
      expect(db.listTasks()).toHaveLength(0)
    })

    it('resets tasks only', async () => {
      setup()
      seedResetState()

      await call('orchestration.reset', { tasks: true })
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(0)
    })

    it('resets messages only', async () => {
      setup()
      seedResetState()

      await call('orchestration.reset', { messages: true })
      expect(db.getInbox()).toHaveLength(0)
      expect(db.listTasks()).toHaveLength(1)
    })

    it.each([{ all: true }, { tasks: true }])(
      'preserves active Harness ownership for reset %o',
      async (scope) => {
        setup()
        const root = db.createTask({
          spec: 'coordinate',
          createdByTerminalHandle: 'jaws-harness:run-1'
        })
        db.createDispatchContext(root.id, 'term_coord')
        const child = db.createTask({
          spec: 'child',
          parentId: root.id,
          createdByTerminalHandle: 'term_coord'
        })
        db.createDispatchContext(child.id, 'term_child')

        await expect(call('orchestration.reset', scope)).rejects.toThrow(
          'while a Harness lane is active'
        )
        expect(db.getTask(root.id)).toBeDefined()
        expect(db.getActiveDispatchForTerminal('term_coord')).toBeDefined()
        expect(db.getActiveDispatchForTerminal('term_child')).toBeDefined()
      }
    )

    it.each([
      ['empty params', {}],
      ['false-only params', { all: false }],
      ['multi-scope task and messages params', { tasks: true, messages: true }],
      ['multi-scope all and tasks params', { all: true, tasks: true }],
      ['non-boolean params', { all: 'true' }]
    ])('rejects %s without mutating state', async (_name, params) => {
      setup()
      seedResetState()

      await expect(call('orchestration.reset', params)).rejects.toThrow()
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(1)
    })

    it('ignores false scopes when exactly one scope is true', async () => {
      setup()
      seedResetState()

      const result = (await call('orchestration.reset', { all: false, tasks: true })) as {
        reset: string
      }

      expect(result.reset).toBe('tasks')
      expect(db.getInbox()).toHaveLength(1)
      expect(db.listTasks()).toHaveLength(0)
    })

    it('ignores non-boolean scopes when exactly one real boolean scope is true', async () => {
      setup()
      seedResetState()

      const result = (await call('orchestration.reset', { all: 'true', messages: true })) as {
        reset: string
      }

      expect(result.reset).toBe('messages')
      expect(db.getInbox()).toHaveLength(0)
      expect(db.listTasks()).toHaveLength(1)
    })
  })
})
