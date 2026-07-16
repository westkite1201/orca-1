import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { makePaneKey } from '../../shared/stable-pane-id'
import { createHarnessRuntimeCaller } from './runtime-caller'

describe('HarnessRuntimeCaller child dispatch cleanup', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('resolves a reminted pane before stopping an owned child', async () => {
    db = new OrchestrationDb(':memory:')
    const ownerHandle = 'jaws-harness:run-1'
    const root = db.createTask({ spec: 'Coordinate', createdByTerminalHandle: ownerHandle })
    const child = db.createTask({
      spec: 'Implement',
      parentId: root.id,
      createdByTerminalHandle: 'coordinator-h0'
    })
    const leafId = '88888888-8888-4888-8888-888888888888'
    const persistedPaneKey = makePaneKey('tab-before-breakout', leafId)
    const currentPaneKey = makePaneKey('tab-after-breakout', leafId)
    const dispatch = db.createDispatchContext(child.id, 'child-h1', persistedPaneKey)
    const stopTerminalAndWait = vi.fn(async () => true)
    const runtime = {
      getOrchestrationDb: () => db!,
      resolveTerminalPane: vi.fn(() => ({
        handle: 'child-h2',
        tabId: 'tab-child',
        leafId: 'leaf-child',
        ptyId: 'pty-child'
      })),
      getTerminalPaneKey: vi.fn(() => currentPaneKey),
      stopTerminalAndWait
    } as unknown as OrcaRuntimeService

    const stopped = await createHarnessRuntimeCaller(runtime).stopChildDispatch({
      dispatchId: dispatch.id,
      taskId: child.id,
      parentTaskId: root.id,
      ownerHandle,
      error: 'Child lane drain timed out.'
    })

    expect(stopped).toBe(true)
    expect(runtime.resolveTerminalPane).toHaveBeenCalledWith(persistedPaneKey)
    expect(stopTerminalAndWait).toHaveBeenCalledWith('child-h2')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('failed')
    expect(db.getTask(child.id)?.status).toBe('failed')
  })

  it('does not stop a dispatch outside the persisted Harness root', async () => {
    db = new OrchestrationDb(':memory:')
    const root = db.createTask({
      spec: 'Other run',
      createdByTerminalHandle: 'jaws-harness:other-run'
    })
    const child = db.createTask({ spec: 'Implement', parentId: root.id })
    const dispatch = db.createDispatchContext(child.id, 'child-h1')
    const stopTerminalAndWait = vi.fn(async () => true)
    const runtime = {
      getOrchestrationDb: () => db!,
      stopTerminalAndWait
    } as unknown as OrcaRuntimeService

    await expect(
      createHarnessRuntimeCaller(runtime).stopChildDispatch({
        dispatchId: dispatch.id,
        taskId: child.id,
        parentTaskId: root.id,
        ownerHandle: 'jaws-harness:run-1',
        error: 'timeout'
      })
    ).rejects.toThrow('could not verify Harness ownership')
    expect(stopTerminalAndWait).not.toHaveBeenCalled()
  })

  it('resolves and validates a reminted verification pane before stopping it', async () => {
    const leafId = '99999999-9999-4999-8999-999999999999'
    const persistedPaneKey = makePaneKey('tab-before-breakout', leafId)
    const currentPaneKey = makePaneKey('tab-after-breakout', leafId)
    const stopTerminalAndWait = vi.fn(async () => true)
    const runtime = {
      resolveTerminalPane: vi.fn(() => ({
        handle: 'verify-h2',
        tabId: 'tab-after-breakout',
        leafId,
        ptyId: 'pty-verify'
      })),
      getTerminalPaneKey: vi.fn(() => currentPaneKey),
      showTerminal: vi.fn(async () => ({ worktreeId: 'worktree-codex' })),
      stopTerminalAndWait
    } as unknown as OrcaRuntimeService

    const stopped = await createHarnessRuntimeCaller(runtime).stopVerificationTerminal({
      handle: 'verify-h1',
      paneKey: persistedPaneKey,
      worktreeId: 'worktree-codex'
    })

    expect(stopped).toBe(true)
    expect(runtime.resolveTerminalPane).toHaveBeenCalledWith(persistedPaneKey)
    expect(stopTerminalAndWait).toHaveBeenCalledWith('verify-h2')
  })

  it('refuses to stop a verification pane from another worktree', async () => {
    const paneKey = makePaneKey('tab-verify', '77777777-7777-4777-8777-777777777777')
    const stopTerminalAndWait = vi.fn(async () => true)
    const runtime = {
      resolveTerminalPane: vi.fn(() => ({
        handle: 'verify-h2',
        tabId: 'tab-verify',
        leafId: '77777777-7777-4777-8777-777777777777',
        ptyId: 'pty-verify'
      })),
      getTerminalPaneKey: vi.fn(() => paneKey),
      showTerminal: vi.fn(async () => ({ worktreeId: 'other-worktree' })),
      stopTerminalAndWait
    } as unknown as OrcaRuntimeService

    await expect(
      createHarnessRuntimeCaller(runtime).stopVerificationTerminal({
        handle: 'verify-h1',
        paneKey,
        worktreeId: 'worktree-codex'
      })
    ).rejects.toThrow('different worktree')
    expect(stopTerminalAndWait).not.toHaveBeenCalled()
  })

  it('accepts fresh provider absence as proof that a verification PTY is gone', async () => {
    const paneKey = makePaneKey('tab-verify', '66666666-6666-4666-8666-666666666666')
    const stopTerminalAndWait = vi.fn(async () => true)
    const runtime = {
      resolveTerminalPane: vi.fn(() => {
        throw new Error('terminal_not_found')
      }),
      findFreshHarnessVerificationTerminal: vi.fn(async () => null),
      stopTerminalAndWait
    } as unknown as OrcaRuntimeService

    await expect(
      createHarnessRuntimeCaller(runtime).stopVerificationTerminal({
        handle: 'verify-h1',
        paneKey,
        worktreeId: 'worktree-codex'
      })
    ).resolves.toBe(true)
    expect(runtime.findFreshHarnessVerificationTerminal).toHaveBeenCalledWith({
      handle: 'verify-h1',
      worktreeId: 'worktree-codex'
    })
    expect(stopTerminalAndWait).not.toHaveBeenCalled()
  })

  it('recovers a preallocated handle when spawn completed before pane binding', async () => {
    const paneKey = makePaneKey('tab-verify', '44444444-4444-4444-8444-444444444444')
    const stopTerminalAndWait = vi.fn(async () => true)
    const runtime = {
      resolveTerminalPane: vi.fn(() => {
        throw new Error('terminal_not_found')
      }),
      findFreshHarnessVerificationTerminal: vi.fn(async () => 'verify-h1'),
      showTerminal: vi.fn(async () => ({ worktreeId: 'worktree-codex' })),
      stopTerminalAndWait
    } as unknown as OrcaRuntimeService

    await expect(
      createHarnessRuntimeCaller(runtime).stopVerificationTerminal({
        handle: 'verify-h1',
        paneKey,
        worktreeId: 'worktree-codex'
      })
    ).resolves.toBe(true)
    expect(stopTerminalAndWait).toHaveBeenCalledWith('verify-h1')
  })

  it('retains ownership when fresh provider liveness is unavailable', async () => {
    const paneKey = makePaneKey('tab-verify', '55555555-5555-4555-8555-555555555555')
    const runtime = {
      resolveTerminalPane: vi.fn(() => {
        throw new Error('terminal_not_found')
      }),
      findFreshHarnessVerificationTerminal: vi.fn(async () => {
        throw new Error('terminal_liveness_unavailable')
      }),
      stopTerminalAndWait: vi.fn(async () => true)
    } as unknown as OrcaRuntimeService

    await expect(
      createHarnessRuntimeCaller(runtime).stopVerificationTerminal({
        handle: 'verify-h1',
        paneKey,
        worktreeId: 'worktree-codex'
      })
    ).rejects.toThrow('terminal_liveness_unavailable')
    expect(runtime.stopTerminalAndWait).not.toHaveBeenCalled()
  })
})
