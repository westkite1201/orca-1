import { describe, expect, it, vi } from 'vitest'
import type { HarnessRuntimeCaller } from './runtime-caller'
import { dispatchHarnessCandidate } from './candidate-launch'
import { createHarnessRunFixture } from './verification-test-fixtures'

describe('dispatchHarnessCandidate legacy dispatch recovery', () => {
  it('finalizes an exact-owner failed dispatch instead of retrying it', async () => {
    const run = createHarnessRunFixture()
    const candidate = run.candidates[0]
    const updateHarnessCandidate = vi.fn(() => run)
    const call = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'orchestration.dispatchShow') {
        return {
          dispatch: {
            id: candidate.dispatchId,
            task_id: candidate.taskId,
            assignee_handle: candidate.agentTerminalHandle,
            assignee_pane_key: candidate.agentTerminalPaneKey,
            status: 'failed',
            failure_count: 1,
            last_failure: 'terminal exited',
            dispatched_at: '2026-01-01 00:00:00',
            completed_at: null,
            created_at: '2026-01-01 00:00:00',
            last_heartbeat_at: null
          },
          task: {
            id: candidate.taskId,
            created_by_terminal_handle: candidate.agentTerminalHandle,
            status: 'ready'
          }
        }
      }
      if (method === 'orchestration.taskUpdate') {
        return { task: { id: candidate.taskId, status: 'failed' } }
      }
      throw new Error(`Unexpected runtime call: ${method}`)
    })
    const runtime = {
      call,
      abandonDispatch: vi.fn(async () => true),
      stopChildDispatch: vi.fn(async () => true),
      stopVerificationTerminal: vi.fn(async () => true),
      runVerification: vi.fn()
    } as HarnessRuntimeCaller

    await dispatchHarnessCandidate({
      store: { updateHarnessCandidate },
      runtime,
      run,
      candidate
    })

    expect(call).toHaveBeenCalledWith('orchestration.taskUpdate', {
      id: candidate.taskId,
      status: 'failed',
      result: 'terminal exited',
      run: candidate.orchestrationRunId,
      callerTerminalHandle: candidate.agentTerminalHandle
    })
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      'orchestration.dispatchShow',
      'orchestration.taskUpdate'
    ])
    expect(updateHarnessCandidate).toHaveBeenCalledWith(run.id, candidate.agent, {
      status: 'failed',
      error: 'terminal exited'
    })
  })
})
