import { describe, expect, it } from 'vitest'
import { normalizeHarnessExecutionPlan } from './allocation-validation'

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'api-contract',
    title: 'API contract',
    objective: 'Define the API contract.',
    execution: 'worktree',
    dependencies: [],
    fileScopes: ['src\\main\\api/./contracts.ts'],
    acceptanceCriteria: ['The contract is documented.'],
    verificationCommands: ['pnpm test -- api'],
    ...overrides
  }
}

function plan(items: unknown[] = [item()]): Record<string, unknown> {
  return {
    version: 1,
    revision: 1,
    planHash: 'hash-1',
    items,
    maxConcurrency: undefined
  }
}

describe('Harness execution plan validation', () => {
  it('normalizes repository-relative scopes and applies the default concurrency', () => {
    expect(normalizeHarnessExecutionPlan(plan())).toMatchObject({
      maxConcurrency: 2,
      items: [{ fileScopes: ['src/main/api/contracts.ts'] }]
    })
  })

  it('accepts a dependency DAG and preserves stable item order', () => {
    const result = normalizeHarnessExecutionPlan(
      plan([
        item({ key: 'api-contract' }),
        item({ key: 'api-tests', dependencies: ['api-contract'], fileScopes: ['src/main/api'] })
      ])
    )

    expect(result.items.map((entry) => entry.key)).toEqual(['api-contract', 'api-tests'])
  })

  it.each([
    ['a duplicate item key', [item(), item()]],
    ['a missing dependency', [item({ dependencies: ['missing-item'] })]],
    [
      'a dependency cycle',
      [
        item({ key: 'first', dependencies: ['second'] }),
        item({ key: 'second', dependencies: ['first'] })
      ]
    ]
  ])('rejects %s', (_label, items) => {
    expect(() => normalizeHarnessExecutionPlan(plan(items))).toThrow(
      /Invalid Harness execution plan/
    )
  })

  it.each([
    ['an absolute POSIX scope', '/tmp/file.ts'],
    ['an absolute Windows scope', 'C:/repo/file.ts'],
    ['a parent traversal', '../outside.ts']
  ])('rejects %s', (_label, scope) => {
    expect(() => normalizeHarnessExecutionPlan(plan([item({ fileScopes: [scope] })]))).toThrow(
      /repository-relative Git path|must not escape/
    )
  })

  it('rejects unsupported concurrency and incomplete worktree items', () => {
    expect(() => normalizeHarnessExecutionPlan({ ...plan(), maxConcurrency: 4 })).toThrow(
      /maxConcurrency/
    )
    expect(() => normalizeHarnessExecutionPlan(plan([item({ acceptanceCriteria: [] })]))).toThrow(
      /acceptanceCriteria/
    )
    expect(() => normalizeHarnessExecutionPlan(plan([item({ verificationCommands: [] })]))).toThrow(
      /verificationCommands/
    )
  })
})
