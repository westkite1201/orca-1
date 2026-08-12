import { randomUUID } from 'node:crypto'
import type { AutomationPrecheckResult } from '../../shared/automations-types'
import type { HarnessAgent } from '../../shared/harness-types'
import { hasSamePaneIdentity } from '../../shared/stable-pane-id'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'

export type HarnessRuntimeCaller = {
  call<T>(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<T>
  abandonDispatch(args: { dispatchId: string; taskId: string; error: string }): Promise<boolean>
  stopChildDispatch(args: {
    dispatchId: string
    taskId: string
    parentTaskId: string
    ownerHandle: string
    error: string
  }): Promise<boolean>
  stopVerificationTerminal(args: {
    handle: string
    paneKey: string
    worktreeId: string
  }): Promise<boolean>
  runVerification(args: {
    runId: string
    agent: HarnessAgent
    worktree: string
    command: string
    timeoutSeconds: number
  }): Promise<AutomationPrecheckResult>
}

export function createHarnessRuntimeCaller(runtime: OrcaRuntimeService): HarnessRuntimeCaller {
  const dispatcher = new RpcDispatcher({ runtime })
  return {
    async call<T>(method, params, options): Promise<T> {
      const response = await dispatcher.dispatch(
        {
          id: randomUUID(),
          authToken: 'jaws-harness',
          method,
          params
        },
        { ...options, internalCaller: 'harness' }
      )
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result as T
    },
    async abandonDispatch(args): Promise<boolean> {
      const db = runtime.getOrchestrationDb()
      const dispatch = db.getDispatchContextById(args.dispatchId)
      if (!dispatch || dispatch.task_id !== args.taskId) {
        throw new Error('Dispatch cleanup could not verify task ownership.')
      }
      // Why: worker_done can win after the timeout check. Never rewrite a
      // completed dispatch just to make delayed recovery cleanup succeed.
      if (dispatch.status !== 'dispatched') {
        return false
      }
      db.failDispatch(dispatch.id, args.error)
      db.updateTaskStatus(args.taskId, 'failed', args.error)
      return true
    },
    async stopChildDispatch(args): Promise<boolean> {
      const db = runtime.getOrchestrationDb()
      const parent = db.getTask(args.parentTaskId)
      const task = db.getTask(args.taskId)
      const dispatch = db.getDispatchContextById(args.dispatchId)
      if (
        !parent ||
        parent.created_by_terminal_handle !== args.ownerHandle ||
        !task ||
        task.parent_id !== parent.id ||
        !dispatch ||
        dispatch.task_id !== task.id
      ) {
        throw new Error('Child dispatch cleanup could not verify Harness ownership.')
      }
      if (dispatch.status !== 'dispatched') {
        return false
      }
      if (!dispatch.assignee_handle) {
        throw new Error('Child dispatch cleanup is missing its terminal handle.')
      }
      let terminalHandle = dispatch.assignee_handle
      if (dispatch.assignee_pane_key) {
        const resolved = runtime.resolveTerminalPane(dispatch.assignee_pane_key)
        const resolvedPaneKey = runtime.getTerminalPaneKey(resolved.handle)
        if (!resolvedPaneKey || !hasSamePaneIdentity(dispatch.assignee_pane_key, resolvedPaneKey)) {
          throw new Error('Child dispatch cleanup resolved a different terminal pane.')
        }
        terminalHandle = resolved.handle
      }
      const stopped = await runtime.stopTerminalAndWait(terminalHandle)
      if (!stopped) {
        throw new Error('Child terminal stop could not be verified.')
      }
      const current = db.getDispatchContextById(dispatch.id)
      // Why: stopAndWait proves the process is gone; only then may cleanup
      // close a lifecycle row if the exit callback did not already do so.
      if (current?.status === 'dispatched') {
        db.failDispatch(dispatch.id, args.error)
        db.updateTaskStatus(task.id, 'failed', args.error)
      }
      return true
    },
    async stopVerificationTerminal(args): Promise<boolean> {
      let terminalHandle: string | null = null
      try {
        const resolved = runtime.resolveTerminalPane(args.paneKey)
        const resolvedPaneKey = runtime.getTerminalPaneKey(resolved.handle)
        if (!resolvedPaneKey || !hasSamePaneIdentity(args.paneKey, resolvedPaneKey)) {
          throw new Error('Verification cleanup resolved a different terminal pane.')
        }
        terminalHandle = resolved.handle
      } catch (error) {
        if (error instanceof Error && error.message.includes('different terminal pane')) {
          throw error
        }
        // Why: ORCA_TERMINAL_HANDLE is preallocated into the PTY environment,
        // so a host-scoped fresh provider listing recovers even a spawn whose
        // pane binding response was lost. Disconnected SSH hosts throw.
        terminalHandle = await runtime.findFreshHarnessVerificationTerminal({
          handle: args.handle,
          worktreeId: args.worktreeId
        })
        if (!terminalHandle) {
          return true
        }
      }
      const terminal = await runtime.showTerminal(terminalHandle)
      if (terminal.worktreeId !== args.worktreeId) {
        throw new Error('Verification cleanup resolved a different worktree.')
      }
      return await runtime.stopTerminalAndWait(terminalHandle)
    },
    async runVerification(args): Promise<AutomationPrecheckResult> {
      return await runtime.runHarnessVerification(args)
    }
  }
}
