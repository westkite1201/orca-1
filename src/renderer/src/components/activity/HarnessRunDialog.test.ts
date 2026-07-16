import { describe, expect, it } from 'vitest'

import type { HarnessCandidateStatus, HarnessRun } from '../../../../shared/harness-types'
import {
  formatHarnessDiffSummary,
  getHarnessDialogCopy,
  getHarnessStatusLabel
} from './harness-status-label'
import { findHarnessRunToReconnect, isHarnessRunActive } from './use-harness-active-run-reconnect'

function runWith(
  statuses: HarnessCandidateStatus[],
  fatalError: string | null = null,
  overrides: Partial<HarnessRun> = {}
): HarnessRun {
  return {
    id: 'run',
    mode: 'comparison',
    sourceWorktreeId: 'worktree-1',
    createdAt: 1,
    fatalError,
    candidates: statuses.map((status) => ({ status })),
    ...overrides
  } as HarnessRun
}

describe('isHarnessRunActive', () => {
  it('stops polling only after both candidates are terminal or the run is fatal', () => {
    expect(isHarnessRunActive(runWith(['creating', 'failed']))).toBe(true)
    expect(isHarnessRunActive(runWith(['verified', 'failed']))).toBe(false)
    expect(isHarnessRunActive(runWith(['running', 'running'], 'source worktree missing'))).toBe(
      false
    )
  })

  it('supports a single orchestrator coordinator', () => {
    expect(isHarnessRunActive(runWith(['running'], null, { mode: 'orchestrator' }))).toBe(true)
    expect(isHarnessRunActive(runWith(['verified'], null, { mode: 'orchestrator' }))).toBe(false)
  })

  it('prefers the newest active run, then restores the newest terminal run', () => {
    const older = runWith(['running', 'running'], null, { id: 'older', createdAt: 10 })
    const newer = runWith(['worker_done', 'running'], null, { id: 'newer', createdAt: 20 })
    const completed = runWith(['verified', 'failed'], null, {
      id: 'completed',
      createdAt: 30
    })
    const otherWorktree = runWith(['running', 'running'], null, {
      id: 'other',
      sourceWorktreeId: 'worktree-2',
      createdAt: 40
    })

    expect(findHarnessRunToReconnect([completed, older, otherWorktree, newer], 'worktree-1')).toBe(
      newer
    )
    expect(findHarnessRunToReconnect([completed], 'worktree-1')).toBe(completed)
    expect(findHarnessRunToReconnect([completed], 'worktree-1', false)).toBeNull()
  })

  it('localizes every candidate status label', () => {
    const statuses: HarnessCandidateStatus[] = [
      'pending',
      'creating',
      'ready',
      'running',
      'worker_done',
      'verifying',
      'verified',
      'failed'
    ]

    expect(statuses.map(getHarnessStatusLabel)).toEqual([
      'Pending',
      'Creating',
      'Ready',
      'Running',
      'Worker done',
      'Verifying',
      'Verified',
      'Failed'
    ])
  })

  it('renders structured Git counts instead of the persisted English diffstat', () => {
    expect(
      formatHarnessDiffSummary({
        headSha: 'abc',
        diffStat: 'legacy English text',
        changedFiles: [
          { path: 'a.ts', status: 'modified' },
          { path: 'b.ts', status: 'added' }
        ],
        untrackedPaths: ['c.ts'],
        capturedAt: 1,
        error: null
      })
    ).toBe('3 files · 1 added · 1 modified · 1 untracked')
  })

  it('uses start, active, result, and legacy comparison dialog copy', () => {
    expect(getHarnessDialogCopy(null, false).title).toBe('Start orchestrator')
    expect(getHarnessDialogCopy('orchestrator', true).title).toBe('Orchestrator run')
    expect(getHarnessDialogCopy('orchestrator', false).title).toBe('Orchestrator result')
    expect(getHarnessDialogCopy('comparison', true).title).toBe('Comparison run')
    expect(getHarnessDialogCopy('comparison', false).title).toBe('Comparison result')
  })
})
