import { describe, expect, it, vi } from 'vitest'
import type { HarnessRun } from '../../shared/harness-types'
import type { HarnessStore } from './service'
import { HarnessService } from './service'
import type { HarnessRuntimeCaller } from './runtime-caller'

describe('Harness preflight', () => {
  it('rechecks for an active run after the asynchronous status lookup', async () => {
    const activeRun = {
      sourceWorktreeId: 'source-1',
      mode: 'orchestrator',
      candidates: [{ status: 'pending' }],
      fatalError: null
    } as HarnessRun
    let listCalls = 0
    const store = {
      listHarnessRuns: vi.fn(() => (++listCalls === 1 ? [] : [activeRun])),
      getRepo: vi.fn(() => ({ kind: 'git' }))
    } as unknown as HarnessStore
    const runtime = {
      call: vi.fn(async (method: string) =>
        method === 'worktree.show'
          ? {
              worktree: {
                id: 'source-1',
                repoId: 'repo-1',
                git: { path: '/repo' }
              }
            }
          : {
              entries: [],
              conflictOperation: 'unknown',
              head: '0123456789abcdef'
            }
      )
    } as unknown as HarnessRuntimeCaller
    const service = new HarnessService(store, runtime, { autoMonitor: false })

    await expect(service.preflight('id:source-1')).rejects.toThrow('active run')
  })
})
