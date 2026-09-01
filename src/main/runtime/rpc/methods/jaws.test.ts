import { describe, expect, it, vi } from 'vitest'
import {
  JAWS_NATIVE_PLANNER_RUNTIME_CAPABILITY,
  JAWS_TRUSTED_APPROVAL_RELAY_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { JAWS_METHODS } from './jaws'

function request(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'token', method, params }
}

describe('jaws RPC methods', () => {
  it('routes native planner calls through the Jaws service', async () => {
    const planningId = '33333333-3333-4333-8333-333333333333'
    const service = {
      startPlanning: vi.fn().mockResolvedValue({ id: planningId, status: 'planning' }),
      listPlanning: vi.fn().mockReturnValue([{ id: planningId, status: 'planning' }]),
      showPlanning: vi.fn().mockResolvedValue({ id: planningId, status: 'planning' }),
      cancelPlanning: vi.fn().mockResolvedValue({ id: planningId, status: 'canceled' }),
      propose: vi.fn().mockResolvedValue({ id: 'run-1' }),
      list: vi.fn().mockReturnValue([{ id: 'run-1' }]),
      show: vi.fn().mockReturnValue({ id: 'run-1' })
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getJawsService: () => service,
      showRepo: vi.fn().mockResolvedValue({ id: 'repo-1' }),
      showManagedWorktree: vi.fn().mockResolvedValue({ id: 'worktree-1' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: JAWS_METHODS })

    const start = await dispatcher.dispatch(
      request('jaws.planningStart', {
        goal: '  Build billing recovery  ',
        worktreeSelector: '  id:worktree-1  '
      })
    )
    const list = await dispatcher.dispatch(
      request('jaws.planningList', { worktree: 'id:worktree-1' })
    )
    const show = await dispatcher.dispatch(
      request('jaws.planningShow', { planningId: `  ${planningId}  ` })
    )
    const cancel = await dispatcher.dispatch(request('jaws.planningCancel', { planningId }))

    expect(service.startPlanning).toHaveBeenCalledWith({
      goal: 'Build billing recovery',
      worktreeSelector: 'id:worktree-1'
    })
    expect(service.listPlanning).toHaveBeenCalledWith({ sourceWorktreeId: 'worktree-1' })
    expect(service.showPlanning).toHaveBeenCalledWith({ planningId })
    expect(service.cancelPlanning).toHaveBeenCalledWith({ planningId })
    for (const response of [start, list, show, cancel]) {
      expect(response).toMatchObject({ ok: true })
    }
  })

  it('rejects blank planner inputs before starting work', async () => {
    const startPlanning = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getJawsService: () => ({ startPlanning })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: JAWS_METHODS })

    const response = await dispatcher.dispatch(
      request('jaws.planningStart', {
        goal: '   ',
        worktreeSelector: 'id:worktree-1'
      })
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(startPlanning).not.toHaveBeenCalled()
  })

  it('advertises native planner capability', () => {
    expect(JAWS_NATIVE_PLANNER_RUNTIME_CAPABILITY).toBe('jaws.native-planner.v1')
    expect(RUNTIME_CAPABILITIES).toContain(JAWS_NATIVE_PLANNER_RUNTIME_CAPABILITY)
  })

  it('keeps remote approval behind the authenticated Electron relay capability', async () => {
    const approve = vi.fn().mockResolvedValue({ id: 'run-1' })
    const runtime = {
      getJawsService: () => ({ approve })
    } as unknown as OrcaRuntimeService
    const method = JAWS_METHODS.find((entry) => entry.name === 'jaws.planApprove')!
    const approval = {
      runId: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      planHash: 'a'.repeat(64)
    }

    await expect(method.handler(approval, { runtime })).rejects.toThrow('trusted_renderer_required')
    await expect(
      method.handler(approval, {
        runtime,
        clientKind: 'runtime',
        clientCapabilities: [JAWS_TRUSTED_APPROVAL_RELAY_RUNTIME_CAPABILITY]
      })
    ).resolves.toEqual({ run: { id: 'run-1' } })
    expect(approve).toHaveBeenCalledOnce()
  })
})
