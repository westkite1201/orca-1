// Scenario builders for the Harness service suites: an in-memory store paired
// with the scripted runtime caller, plus the start/persist helpers on top.
import type { vi } from 'vitest'
import type { HarnessRun, HarnessRunMode } from '../../shared/harness-types'
import { HarnessService, type HarnessStore } from './service'
import { createHarnessRunMemoryStore } from './harness-run-memory-store'
import {
  createRuntime,
  type HarnessRuntimeStub,
  type RuntimeScenario
} from './harness-runtime-caller-stub'
import { BASE_SHA, REPO, SOURCE } from './harness-scenario-fixtures'

export * from './harness-scenario-fixtures'
export { createRuntime, type RuntimeScenario } from './harness-runtime-caller-stub'

export const createMemoryStore = () => createHarnessRunMemoryStore(REPO)

export function callsFor(
  call: ReturnType<typeof vi.fn>,
  method: string
): Record<string, unknown>[] {
  return call.mock.calls
    .filter(([calledMethod]) => calledMethod === method)
    .map(([, params]) => params as Record<string, unknown>)
}

export function startHarness(
  service: HarnessService,
  goal = 'Goal',
  mode?: HarnessRunMode
): Promise<HarnessRun> {
  return service.start({ worktree: 'id:source-1', goal, verificationCommand: 'pnpm test', mode })
}

export function createPersistedRun(store: HarnessStore): HarnessRun {
  return store.createHarnessRun({
    repoId: REPO.id,
    sourceWorktreeId: SOURCE.id,
    sourceWorktreePath: SOURCE.git.path,
    goal: 'Goal',
    verificationCommand: 'pnpm test',
    baseSha: BASE_SHA
  })
}

export function createHarnessScenario(
  scenario: RuntimeScenario = {}
): HarnessRuntimeStub & ReturnType<typeof createMemoryStore> & { service: HarnessService } {
  const { store, runs } = createMemoryStore()
  const { runtime, call } = createRuntime(scenario)
  const service = new HarnessService(store, runtime, { autoMonitor: false })
  return { store, runs, runtime, call, service }
}
