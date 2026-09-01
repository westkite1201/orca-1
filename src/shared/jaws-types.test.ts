import { describe, expect, it } from 'vitest'
import { jawsPlanSchema } from './jaws-types'

const task = (key: string, dependsOn: string[] = []) => ({
  key,
  title: `Task ${key}`,
  objective: `Implement ${key}`,
  dependsOn
})

describe('Jaws plan validation', () => {
  it('accepts a dependency-aware multi-worktree plan', () => {
    expect(
      jawsPlanSchema.parse({
        goal: 'Implement the feature',
        verificationCommand: 'pnpm test',
        maxConcurrency: 2,
        tasks: [task('API'), task('UI', ['API'])]
      })
    ).toMatchObject({
      tasks: [{ key: 'API' }, { key: 'UI', dependsOn: ['API'] }]
    })
  })

  it('preserves richer per-task execution fields when provided', () => {
    expect(
      jawsPlanSchema.parse({
        goal: 'Implement the feature',
        verificationCommand: 'pnpm test',
        maxConcurrency: 1,
        tasks: [
          {
            ...task('research'),
            execution: 'read-only',
            fileScopes: ['docs/plan.md'],
            acceptanceCriteria: ['Relevant code paths are identified.'],
            verificationCommands: ['pnpm test src/shared/jaws-types.test.ts']
          }
        ]
      }).tasks[0]
    ).toMatchObject({
      key: 'research',
      execution: 'read-only',
      fileScopes: ['docs/plan.md'],
      acceptanceCriteria: ['Relevant code paths are identified.'],
      verificationCommands: ['pnpm test src/shared/jaws-types.test.ts']
    })
  })

  it('includes the exact draft review target in the approved plan', () => {
    expect(
      jawsPlanSchema.parse({
        goal: 'Implement the feature',
        verificationCommand: 'pnpm test',
        maxConcurrency: 1,
        tasks: [task('API')],
        review: { provider: 'gitlab', baseBranch: 'main', createDraft: true }
      }).review
    ).toEqual({ provider: 'gitlab', baseBranch: 'main', createDraft: true })
  })

  it.each([[task('A', ['missing'])], [task('A', ['B']), task('B', ['A'])], [task('A'), task('A')]])(
    'rejects an invalid task graph',
    (...tasks) => {
      expect(() =>
        jawsPlanSchema.parse({
          goal: 'Implement the feature',
          verificationCommand: 'pnpm test',
          maxConcurrency: 2,
          tasks
        })
      ).toThrow()
    }
  )

  it.each([{ tasks: [task('bad key')] }, { verificationCommand: 'pnpm test\u202ecod.exe' }])(
    'rejects approval text that cannot be displayed safely',
    (patch) => {
      expect(() =>
        jawsPlanSchema.parse({
          goal: 'Implement the feature',
          verificationCommand: 'pnpm test',
          maxConcurrency: 2,
          tasks: [task('API')],
          ...patch
        })
      ).toThrow()
    }
  )
})
