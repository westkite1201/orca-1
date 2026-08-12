import { describe, expect, it } from 'vitest'
import { compileHarnessAllocationPlan } from './worktree-allocation-compiler'
import { selectHarnessReadyLanes } from './worktree-lane-scheduler'
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

function compilation(items: HarnessExecutionPlanV1['items']) {
  return compileHarnessAllocationPlan({
    version: 1,
    revision: 1,
    planHash: 'hash-1',
    maxConcurrency: 2,
    items
  })
}

describe('Harness ready-lane scheduler', () => {
  it('selects ready lanes in approved plan order within the concurrency cap', () => {
    const result = selectHarnessReadyLanes({
      compilation: compilation([item('first'), item('second'), item('third')]),
      readyKeys: ['third', 'first', 'second'],
      activeKeys: [],
      maxConcurrent: 2
    })

    expect(result).toEqual({ selectedKeys: ['first', 'second'], deferredKeys: ['third'] })
  })

  it('defers a scope-conflicting lane while allowing an independent lane', () => {
    const result = selectHarnessReadyLanes({
      compilation: compilation([
        item('first', { fileScopes: ['src/main'] }),
        item('conflict', { fileScopes: ['src/main/api.ts'] }),
        item('independent', { fileScopes: ['src/renderer'] })
      ]),
      readyKeys: ['first', 'conflict', 'independent'],
      activeKeys: [],
      maxConcurrent: 3
    })

    expect(result).toEqual({
      selectedKeys: ['first', 'independent'],
      deferredKeys: ['conflict']
    })
  })

  it('counts read-only lanes against concurrency but does not create a worktree scope lock', () => {
    const result = selectHarnessReadyLanes({
      compilation: compilation([
        item('research', { execution: 'read-only', fileScopes: [] }),
        item('implementation', { fileScopes: ['src/main'] })
      ]),
      readyKeys: ['implementation', 'research'],
      activeKeys: [],
      maxConcurrent: 2
    })

    expect(result.selectedKeys).toEqual(['research', 'implementation'])
  })

  it('does not select a lane conflicting with an active lane', () => {
    const result = selectHarnessReadyLanes({
      compilation: compilation([
        item('active', { fileScopes: ['src/main'] }),
        item('conflict', { fileScopes: ['src/main/api.ts'] }),
        item('independent', { fileScopes: ['src/renderer'] })
      ]),
      readyKeys: ['conflict', 'independent'],
      activeKeys: ['active'],
      maxConcurrent: 2
    })

    expect(result).toEqual({ selectedKeys: ['independent'], deferredKeys: ['conflict'] })
  })
})
