import { describe, expect, it } from 'vitest'
import type { GitStatusResult } from '../../shared/git-status-types'
import type { GitBranchCompareResult } from '../../shared/types'
import { buildHarnessDiffSummary as buildHarnessDiffSummaryWithBase } from './diff-summary'

const EXPECTED_BRANCH = 'jaws-harness-run-codex'

function buildHarnessDiffSummary(
  input: Omit<Parameters<typeof buildHarnessDiffSummaryWithBase>[0], 'expectedBaseSha'> & {
    expectedBaseSha?: string
  }
) {
  return buildHarnessDiffSummaryWithBase({ expectedBaseSha: 'base-sha', ...input })
}

function status(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    entries: [],
    conflictOperation: 'unknown',
    head: 'head-sha',
    branch: `refs/heads/${EXPECTED_BRANCH}`,
    ...overrides
  }
}

function branchCompare(overrides: Partial<GitBranchCompareResult> = {}): GitBranchCompareResult {
  return {
    summary: {
      baseRef: 'base-sha',
      baseOid: 'base-sha',
      compareRef: 'HEAD',
      headOid: 'head-sha',
      mergeBase: 'base-sha',
      changedFiles: 0,
      status: 'ready'
    },
    entries: [],
    ...overrides
  }
}

describe('buildHarnessDiffSummary', () => {
  it('captures committed-only changes', () => {
    const result = buildHarnessDiffSummary({
      status: status(),
      branchCompare: branchCompare({
        entries: [{ path: 'src/feature.ts', status: 'added', added: 12 }]
      }),
      expectedBranch: EXPECTED_BRANCH,
      capturedAt: 123
    })

    expect(result).toEqual({
      headSha: 'head-sha',
      diffStat: '1 file · 1 added',
      changedFiles: [{ path: 'src/feature.ts', status: 'added', added: 12 }],
      untrackedPaths: [],
      capturedAt: 123,
      error: null
    })
  })

  it('captures and sorts untracked-only changes', () => {
    const result = buildHarnessDiffSummary({
      status: status({
        entries: [
          { path: 'z.txt', status: 'untracked', area: 'untracked' },
          { path: 'a.txt', status: 'untracked', area: 'untracked' }
        ]
      }),
      branchCompare: branchCompare(),
      expectedBranch: EXPECTED_BRANCH,
      capturedAt: 123
    })

    expect(result.changedFiles).toEqual([])
    expect(result.untrackedPaths).toEqual(['a.txt', 'z.txt'])
    expect(result.diffStat).toBe('2 files · 2 untracked')
  })

  it('deduplicates tracked paths and combines their line counts', () => {
    const result = buildHarnessDiffSummary({
      status: status({
        entries: [
          { path: 'b.ts', status: 'added', area: 'staged', added: 2 },
          { path: 'b.ts', status: 'modified', area: 'unstaged', added: 3, removed: 1 }
        ]
      }),
      branchCompare: branchCompare({
        entries: [
          { path: 'b.ts', status: 'modified', added: 1, removed: 2 },
          { path: 'a.ts', status: 'deleted', removed: 4 }
        ]
      }),
      expectedBranch: EXPECTED_BRANCH,
      capturedAt: 123
    })

    expect(result.changedFiles).toEqual([
      { path: 'a.ts', status: 'deleted', removed: 4 },
      { path: 'b.ts', status: 'added', added: 6, removed: 3 }
    ])
    expect(result.diffStat).toBe('2 files · 1 added · 1 deleted')
  })

  it('marks truncated or non-ready Git evidence as an error', () => {
    const result = buildHarnessDiffSummary({
      status: status({ didHitLimit: true }),
      branchCompare: branchCompare({
        summary: {
          ...branchCompare().summary,
          status: 'invalid-base',
          errorMessage: 'Base SHA is unavailable.'
        }
      }),
      expectedBranch: EXPECTED_BRANCH,
      capturedAt: 123
    })

    expect(result.error).toContain('Git status was truncated')
    expect(result.error).toContain('Base SHA is unavailable.')
  })

  it('rejects evidence while a conflict operation is in progress', () => {
    const result = buildHarnessDiffSummary({
      status: status({ conflictOperation: 'rebase' }),
      branchCompare: branchCompare(),
      expectedBranch: EXPECTED_BRANCH,
      capturedAt: 123
    })

    expect(result.error).toBe('Git rebase operation is in progress; diff evidence is incomplete.')
  })

  it('rejects unresolved index entries without an active conflict operation', () => {
    const result = buildHarnessDiffSummary({
      status: status({
        entries: [
          {
            path: 'src/conflicted.ts',
            status: 'modified',
            area: 'unstaged',
            conflictStatus: 'unresolved'
          }
        ]
      }),
      branchCompare: branchCompare(),
      expectedBranch: EXPECTED_BRANCH,
      capturedAt: 123
    })

    expect(result.error).toBe('Git has unresolved conflicts; diff evidence is incomplete.')
  })

  it.each(['baseOid', 'headOid', 'mergeBase'] as const)(
    'rejects ready evidence with a null %s',
    (field) => {
      const result = buildHarnessDiffSummary({
        status: status(),
        branchCompare: branchCompare({
          summary: { ...branchCompare().summary, [field]: null }
        }),
        expectedBranch: EXPECTED_BRANCH,
        capturedAt: 123
      })

      expect(result.error).toBe(
        'Branch comparison is missing commit ancestry; diff evidence is incomplete.'
      )
    }
  )

  it('rejects a candidate whose HEAD diverged behind the requested base', () => {
    const result = buildHarnessDiffSummary({
      status: status({ head: 'older-head' }),
      branchCompare: branchCompare({
        summary: {
          ...branchCompare().summary,
          headOid: 'older-head',
          mergeBase: 'older-head'
        }
      }),
      expectedBranch: EXPECTED_BRANCH,
      capturedAt: 123
    })

    expect(result.error).toBe(
      'Candidate HEAD does not descend from the requested base; diff evidence is incomplete.'
    )
  })

  it('rejects a comparison that resolved a different base object', () => {
    const result = buildHarnessDiffSummary({
      status: status(),
      branchCompare: branchCompare(),
      expectedBaseSha: 'requested-base',
      expectedBranch: EXPECTED_BRANCH,
      capturedAt: 123
    })

    expect(result.error).toBe(
      'Branch comparison resolved a different base; diff evidence is incomplete.'
    )
  })

  it.each([
    ['missing', undefined, 'Git status is missing HEAD evidence; diff evidence is incomplete.'],
    [
      'mismatched',
      'other-head',
      'Git status HEAD does not match branch comparison; diff evidence is incomplete.'
    ]
  ] as const)('rejects %s status HEAD evidence', (_label, head, expectedError) => {
    const result = buildHarnessDiffSummary({
      status: status({ head }),
      branchCompare: branchCompare(),
      expectedBranch: EXPECTED_BRANCH,
      capturedAt: 123
    })

    expect(result.error).toBe(expectedError)
  })

  it.each([
    ['missing', undefined],
    ['mismatched', 'other-branch']
  ] as const)('rejects %s candidate branch evidence', (_label, branch) => {
    const result = buildHarnessDiffSummary({
      status: status({ branch }),
      branchCompare: branchCompare(),
      expectedBranch: EXPECTED_BRANCH,
      capturedAt: 123
    })

    expect(result.error).toBe(
      branch
        ? `Candidate is on branch ${branch}, expected ${EXPECTED_BRANCH}.`
        : 'Git status is missing branch evidence; diff evidence is incomplete.'
    )
  })
})
