import { describe, expect, it, vi } from 'vitest'
import type { HarnessRun, HarnessRunCreateInput } from '../../shared/harness-types'
import type { Repo } from '../../shared/repo-types'
import { HarnessService, type HarnessStore } from './service'
import type { HarnessRuntimeCaller } from './runtime-caller'

const SOURCE = {
  id: 'source-1',
  repoId: 'repo-1',
  git: { path: '/repo', head: '0123456789abcdef', branch: 'main' }
}
const REPO = { id: 'repo-1', kind: 'git' } as Repo
const CLEAN_STATUS = {
  entries: [],
  conflictOperation: 'unknown' as const,
  head: '0123456789abcdef',
  branch: 'main'
}

function createStore(): { store: HarnessStore; runs: HarnessRun[] } {
  const runs: HarnessRun[] = []
  const store = {
    getRepo: (repoId: string) => (repoId === REPO.id ? REPO : undefined),
    listHarnessRuns: (repoId?: string) =>
      runs.filter((run) => repoId === undefined || run.repoId === repoId),
    getHarnessRun: (runId: string) => runs.find((run) => run.id === runId) ?? null,
    createHarnessRun: (input: HarnessRunCreateInput) => {
      const run = {
        id: `run-${runs.length + 1}`,
        ...input,
        mode: input.mode ?? 'comparison',
        candidates: [
          { id: 'candidate-codex', agent: 'codex', status: 'pending' },
          { id: 'candidate-claude', agent: 'claude', status: 'pending' }
        ],
        fatalError: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: null
      } as HarnessRun
      runs.push(run)
      return run
    },
    updateHarnessCandidate: vi.fn(),
    failHarnessRun: vi.fn()
  } satisfies HarnessStore
  return { store, runs }
}

describe('Harness active-run guard', () => {
  it('allows only one concurrent start after both cleanliness checks finish', async () => {
    const { store, runs } = createStore()
    let releaseStatus!: () => void
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve
    })
    const call = vi.fn(async (method: string) => {
      if (method === 'worktree.show') {
        return { worktree: SOURCE }
      }
      if (method === 'git.status') {
        await statusGate
        return CLEAN_STATUS
      }
      throw new Error(`Unexpected runtime call: ${method}`)
    })
    const runtime = {
      call,
      abandonDispatch: vi.fn(),
      runVerification: vi.fn()
    } as unknown as HarnessRuntimeCaller
    const service = new HarnessService(store, runtime, {
      autoMonitor: false,
      deferExecutionUntilMonitoring: true
    })

    const input = { worktree: 'id:source-1', verificationCommand: 'pnpm test' }
    const starts = [
      service.start({ ...input, goal: 'First goal' }),
      service.start({ ...input, goal: 'Second goal' })
    ]
    await vi.waitFor(() =>
      expect(call.mock.calls.filter(([method]) => method === 'git.status')).toHaveLength(2)
    )
    releaseStatus()
    const results = await Promise.allSettled(starts)

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
      { reason: expect.objectContaining({ message: expect.stringContaining('already exists') }) }
    ])
    expect(runs).toHaveLength(1)
  })
})
