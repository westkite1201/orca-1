import { describe, expect, it } from 'vitest'
import { compileHarnessAllocationPlan } from './worktree-allocation-compiler'
import type { HarnessExecutionPlanV1 } from '../../shared/harness-allocation-types'

function item(
  key: string,
  overrides: Partial<HarnessExecutionPlanV1['items'][number]> = {}
): HarnessExecutionPlanV1['items'][number] {
  return {
    key,
    title: key,
    objective: `Implement ${key}.`,
    execution: 'worktree',
    dependencies: [],
    fileScopes: [`src/${key}`],
    acceptanceCriteria: ['The item is complete.'],
    verificationCommands: ['pnpm test'],
    ...overrides
  }
}

function plan(items: HarnessExecutionPlanV1['items']): HarnessExecutionPlanV1 {
  return { version: 1, revision: 1, planHash: 'hash-1', maxConcurrency: 2, items }
}

describe('Harness worktree allocation compiler', () => {
  it('gives independent worktree items the immutable Run base policy', () => {
    const result = compileHarnessAllocationPlan(plan([item('api'), item('ui')]))

    expect(result.topologicalOrder).toEqual(['api', 'ui'])
    expect(result.conflicts).toEqual([])
    expect(result.items.map((entry) => entry.basePolicy)).toEqual(['run-base', 'run-base'])
  })

  it('serializes direct scope overlap and global scopes', () => {
    const result = compileHarnessAllocationPlan(
      plan([
        item('api', { fileScopes: ['src/main'] }),
        item('api-file', { fileScopes: ['src/main/api.ts'] }),
        item('unknown', { fileScopes: [] })
      ])
    )

    expect(result.conflicts).toEqual([
      { leftKey: 'api', rightKey: 'api-file', reason: 'ancestor-scope' },
      { leftKey: 'api', rightKey: 'unknown', reason: 'global-scope' },
      { leftKey: 'api-file', rightKey: 'unknown', reason: 'global-scope' }
    ])
  })

  it('uses the verified integration HEAD policy for transitive mutating dependencies', () => {
    const result = compileHarnessAllocationPlan(
      plan([
        item('foundation'),
        item('research', { execution: 'read-only', fileScopes: [] }),
        item('dependent', { dependencies: ['foundation', 'research'] }),
        item('read-only-follow-up', { execution: 'read-only', dependencies: ['dependent'] })
      ])
    )

    expect(result.topologicalOrder).toEqual([
      'foundation',
      'research',
      'dependent',
      'read-only-follow-up'
    ])
    expect(result.items.map((entry) => [entry.itemKey, entry.basePolicy])).toEqual([
      ['foundation', 'run-base'],
      ['research', 'integration-head-snapshot'],
      ['dependent', 'verified-integration-head'],
      ['read-only-follow-up', 'integration-head-snapshot']
    ])
    expect(result.conflicts).toEqual([
      { leftKey: 'foundation', rightKey: 'dependent', reason: 'dependency' }
    ])
  })

  it('marks direct mutating dependencies as conflicts even with disjoint scopes', () => {
    const result = compileHarnessAllocationPlan(
      plan([item('foundation'), item('dependent', { dependencies: ['foundation'] })])
    )

    expect(result.conflicts).toEqual([
      { leftKey: 'foundation', rightKey: 'dependent', reason: 'dependency' }
    ])
    expect(result.items[1].conflictsWith).toEqual(['foundation'])
  })
})
