import { describe, expect, it, vi } from 'vitest'

import { getDefaultPersistedState } from '../../../shared/constants'
import { JawsRunPersistence } from './jaws-run-persistence'
import { normalizeJawsPlanningRuns } from './jaws-planning-run-state'

const CLIENT_REQUEST_ID = '44444444-4444-4444-8444-444444444444'

describe('Jaws planning persistence', () => {
  it('persists the planner lifecycle before the approval-ready Jaws run exists', () => {
    const state = getDefaultPersistedState('/tmp')
    const flushOrThrow = vi.fn()
    const store = new JawsRunPersistence({ state, flushOrThrow } as never)

    const created = store.createJawsPlanningRun({
      clientRequestId: CLIENT_REQUEST_ID,
      repoId: 'repo-1',
      sourceWorktreeId: 'repo-1::/repo',
      sourceWorktreePath: '/repo',
      baseSha: 'a'.repeat(40),
      goal: 'Implement recovery'
    })
    const updated = store.updateJawsPlanningRun(created.id, { status: 'planning' })

    expect(store.getJawsPlanningRun(created.id)).toEqual(updated)
    expect(store.listJawsPlanningRuns({ sourceWorktreeId: created.sourceWorktreeId })).toEqual([
      updated
    ])
    expect(flushOrThrow).toHaveBeenCalledTimes(2)
  })

  it('marks an in-flight planner interrupted after runtime restart', () => {
    const markNeedsSave = vi.fn()
    const [recovered] = normalizeJawsPlanningRuns(
      [
        {
          id: '33333333-3333-4333-8333-333333333333',
          clientRequestId: CLIENT_REQUEST_ID,
          repoId: 'repo-1',
          sourceWorktreeId: 'repo-1::/repo',
          sourceWorktreePath: '/repo',
          baseSha: 'a'.repeat(40),
          goal: 'Implement recovery',
          status: 'planning',
          question: null,
          jawsRunId: null,
          error: null,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      markNeedsSave
    )

    expect(recovered).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('interrupted')
    })
    expect(markNeedsSave).toHaveBeenCalled()
  })
})
