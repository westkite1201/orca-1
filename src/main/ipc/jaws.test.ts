import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, isTrustedUIRenderer, callRuntimeEnvironment } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  isTrustedUIRenderer: vi.fn(),
  callRuntimeEnvironment: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
    )
  }
}))
vi.mock('./ui', () => ({ isTrustedUIRenderer }))
vi.mock('../persistence', () => ({ getCanonicalUserDataPath: () => '/user-data' }))
vi.mock('./runtime-environment-transport-routing', () => ({ callRuntimeEnvironment }))

import { registerJawsHandlers } from './jaws'

const APPROVAL = {
  runId: '11111111-1111-4111-8111-111111111111',
  revision: 1,
  planHash: 'a'.repeat(64)
}
describe('Jaws approval IPC', () => {
  const approve = vi.fn(async () => ({ id: APPROVAL.runId }))
  const retryReview = vi.fn(async () => ({ id: APPROVAL.runId }))
  const runtime = {
    getJawsService: () => ({
      approve,
      retryReview
    })
  }

  beforeEach(() => {
    handlers.clear()
    approve.mockClear()
    retryReview.mockClear()
    callRuntimeEnvironment.mockReset()
    isTrustedUIRenderer.mockReset()
    registerJawsHandlers(runtime as never)
  })

  it('rejects an untrusted renderer before starting approval', async () => {
    isTrustedUIRenderer.mockReturnValue(false)

    await expect(
      handlers.get('jaws:approvePlan')!({ sender: { id: 2 } }, APPROVAL)
    ).rejects.toThrow('untrusted_renderer')
    expect(approve).not.toHaveBeenCalled()
  })

  it('validates the exact revision and hash before forwarding approval', async () => {
    isTrustedUIRenderer.mockReturnValue(true)
    const handler = handlers.get('jaws:approvePlan')!

    await expect(handler({ sender: { id: 1 } }, { ...APPROVAL, planHash: 'bad' })).rejects.toThrow()
    await expect(handler({ sender: { id: 1 } }, APPROVAL)).resolves.toEqual({
      run: { id: APPROVAL.runId }
    })
    expect(approve).toHaveBeenCalledOnce()
    expect(approve).toHaveBeenCalledWith(APPROVAL)
  })

  it('relays a trusted remote approval without exposing it to renderer RPC', async () => {
    isTrustedUIRenderer.mockReturnValue(true)
    callRuntimeEnvironment.mockResolvedValue({
      ok: true,
      result: { run: { id: APPROVAL.runId } }
    })

    await expect(
      handlers.get('jaws:approvePlan')!(
        { sender: { id: 1 } },
        {
          ...APPROVAL,
          runtimeEnvironmentId: 'runtime-1'
        }
      )
    ).resolves.toEqual({ run: { id: APPROVAL.runId } })

    expect(callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'runtime-1',
      'jaws.planApprove',
      APPROVAL
    )
    expect(approve).not.toHaveBeenCalled()
  })

  it('keeps review retry behind the same trusted renderer boundary', async () => {
    const handler = handlers.get('jaws:retryReview')!
    isTrustedUIRenderer.mockReturnValue(false)
    await expect(handler({ sender: { id: 2 } }, { runId: APPROVAL.runId })).rejects.toThrow(
      'untrusted_renderer'
    )
    expect(retryReview).not.toHaveBeenCalled()

    isTrustedUIRenderer.mockReturnValue(true)
    await expect(handler({ sender: { id: 1 } }, { runId: APPROVAL.runId })).resolves.toEqual({
      run: { id: APPROVAL.runId }
    })
    expect(retryReview).toHaveBeenCalledWith({ runId: APPROVAL.runId })
  })
})
