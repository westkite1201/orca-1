import { describe, expect, it, vi } from 'vitest'
import {
  HARNESS_CANCEL_RUNTIME_CAPABILITY,
  HARNESS_ORCHESTRATOR_RUNTIME_CAPABILITY,
  HARNESS_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { HARNESS_METHODS } from './harness'

function request(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'token', method, params }
}

describe('harness RPC methods', () => {
  it('routes orchestrator runs through the owner runtime service', async () => {
    const run = { id: 'run-1', repoId: 'repo-1' }
    const service = {
      start: vi.fn().mockResolvedValue(run),
      list: vi.fn().mockReturnValue([run]),
      show: vi.fn().mockReturnValue(run),
      resume: vi.fn().mockReturnValue(run),
      cancel: vi.fn().mockReturnValue(run)
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getHarnessService: () => service,
      showRepo: vi.fn().mockResolvedValue({ id: 'repo-1' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: HARNESS_METHODS })

    const start = await dispatcher.dispatch(
      request('harness.start', {
        worktree: '  id:worktree-1  ',
        goal: '  Improve search  ',
        verificationCommand: '  npm test  ',
        mode: 'orchestrator'
      })
    )
    const list = await dispatcher.dispatch(request('harness.list', { repo: 'repo-selector' }))
    const show = await dispatcher.dispatch(request('harness.show', { run: 'run-1' }))
    const resume = await dispatcher.dispatch(request('harness.resume', { run: 'run-1' }))
    const cancel = await dispatcher.dispatch(request('harness.cancel', { run: 'run-1' }))

    expect(service.start).toHaveBeenCalledWith({
      worktree: 'id:worktree-1',
      goal: 'Improve search',
      verificationCommand: 'npm test',
      mode: 'orchestrator'
    })
    expect(runtime.showRepo).toHaveBeenCalledWith('repo-selector')
    expect(service.list).toHaveBeenCalledWith('repo-1')
    expect(service.show).toHaveBeenCalledWith('run-1')
    expect(service.resume).toHaveBeenCalledWith('run-1')
    expect(service.cancel).toHaveBeenCalledWith('run-1')
    for (const response of [start, list, show, resume, cancel]) {
      expect(response).toMatchObject({ ok: true })
    }
  })

  it('rejects blank required inputs before starting work', async () => {
    const start = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getHarnessService: () => ({ start })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: HARNESS_METHODS })

    const response = await dispatcher.dispatch(
      request('harness.start', {
        worktree: 'id:worktree-1',
        goal: '   ',
        verificationCommand: 'npm test'
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(start).not.toHaveBeenCalled()
  })

  it('advertises owner-runtime harness support', () => {
    expect(HARNESS_RUNTIME_CAPABILITY).toBe('harness.v1')
    expect(RUNTIME_CAPABILITIES).toContain(HARNESS_RUNTIME_CAPABILITY)
    expect(HARNESS_ORCHESTRATOR_RUNTIME_CAPABILITY).toBe('harness.orchestrator.v2')
    expect(RUNTIME_CAPABILITIES).toContain('harness.orchestrator.v1')
    expect(RUNTIME_CAPABILITIES).toContain(HARNESS_ORCHESTRATOR_RUNTIME_CAPABILITY)
    // Why: clients hide Cancel run rather than call a method older hosts reject.
    expect(HARNESS_CANCEL_RUNTIME_CAPABILITY).toBe('harness.cancel.v1')
    expect(RUNTIME_CAPABILITIES).toContain(HARNESS_CANCEL_RUNTIME_CAPABILITY)
  })

  it('rejects a blank run id before cancelling', async () => {
    const cancel = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getHarnessService: () => ({ cancel })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: HARNESS_METHODS })

    const response = await dispatcher.dispatch(request('harness.cancel', { run: '   ' }))

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(cancel).not.toHaveBeenCalled()
  })
})
