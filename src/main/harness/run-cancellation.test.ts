import { describe, expect, it } from 'vitest'
import { HarnessService } from './service'
import { HARNESS_RUN_CANCELLED } from '../../shared/harness-candidate-notice'
import { createMemoryStore, createRuntime, startHarness } from './harness-service-test-scenario'

describe('HarnessService cancellation', () => {
  it('releases the source worktree once a stuck run is cancelled', async () => {
    const { store } = createMemoryStore()
    const { runtime } = createRuntime()
    const service = new HarnessService(store, runtime, {
      autoMonitor: false,
      pollIntervalMs: 60_000
    })
    const run = await startHarness(service)
    await service.waitForExecution(run.id)

    await expect(startHarness(service)).rejects.toThrow(
      'An active run already exists for this worktree.'
    )

    const cancelled = service.cancel(run.id)

    expect(cancelled.fatalError).toBe(HARNESS_RUN_CANCELLED)
    // Why: a lane left non-terminal would keep the run active for the guard.
    expect(cancelled.candidates.every((candidate) => candidate.status === 'failed')).toBe(true)
    await expect(startHarness(service)).resolves.toMatchObject({ fatalError: null })
  })

  it('keeps the cancellation reason when an in-flight tick fails afterwards', async () => {
    const { store } = createMemoryStore()
    const { runtime } = createRuntime()
    const service = new HarnessService(store, runtime, {
      autoMonitor: false,
      pollIntervalMs: 60_000
    })
    const run = await startHarness(service)
    await service.waitForExecution(run.id)

    service.cancel(run.id)
    // The next tick's candidate write is rejected by the now-fatal run; that
    // rejection must not replace the user's reason.
    service.resume(run.id)
    await service.waitForExecution(run.id)

    expect(service.show(run.id).fatalError).toBe(HARNESS_RUN_CANCELLED)
  })

  it('leaves an already terminal run untouched when cancel arrives twice', async () => {
    const { store } = createMemoryStore()
    const { runtime } = createRuntime()
    const service = new HarnessService(store, runtime, {
      autoMonitor: false,
      pollIntervalMs: 60_000
    })
    const run = await startHarness(service)
    await service.waitForExecution(run.id)

    const first = service.cancel(run.id)
    const second = service.cancel(run.id)

    expect(second.fatalError).toBe(HARNESS_RUN_CANCELLED)
    expect(second.completedAt).toBe(first.completedAt)
  })
})
