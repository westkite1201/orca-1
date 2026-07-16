import { describe, expect, it, vi } from 'vitest'
import { createHarnessRunFixture } from './verification-test-fixtures'
import { harnessCandidateBranch, harnessRecoveryStartedAt } from './candidate-recovery'

describe('Harness candidate recovery identity', () => {
  it('keeps millisecond recovery precision and the full run and candidate IDs', () => {
    const base = createHarnessRunFixture()
    const run = { ...base, id: '12345678-full-run-id' }
    const candidate = { ...run.candidates[0], id: 'full-candidate-id' }
    const now = 1_789_123_456_789
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(now)

    expect(harnessRecoveryStartedAt()).toBe(now)
    expect(harnessCandidateBranch(run, candidate)).toBe(
      'jaws-harness-12345678-full-run-id-full-candidate-id'
    )

    dateNow.mockRestore()
  })
})
