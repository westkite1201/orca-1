import { describe, expect, it } from 'vitest'
import { createHarnessExecutionPlanFromJawsPlan } from './jaws-plan-to-harness-execution-plan'
import type { JawsPlan } from '../../shared/jaws-types'

function plan(tasks: JawsPlan['tasks']): JawsPlan {
  return {
    goal: 'Implement the feature',
    verificationCommand: 'pnpm test',
    maxConcurrency: 2,
    tasks
  }
}

describe('Jaws to Harness execution plan conversion', () => {
  it('keeps legacy task fields on the coordinator-owned execution path', () => {
    expect(
      createHarnessExecutionPlanFromJawsPlan({
        revision: 3,
        planHash: 'a'.repeat(64),
        plan: plan([
          {
            key: 'API',
            title: 'Build API',
            objective: 'Implement the API.',
            dependsOn: []
          },
          {
            key: 'UI',
            title: 'Build UI',
            objective: 'Implement the UI.',
            dependsOn: ['API']
          }
        ])
      })
    ).toBeNull()
  })

  it('preserves richer per-task Harness fields when present', () => {
    const result = createHarnessExecutionPlanFromJawsPlan({
      revision: 1,
      planHash: 'b'.repeat(64),
      plan: plan([
        {
          key: 'research',
          title: 'Research',
          objective: 'Inspect the repo.',
          dependsOn: [],
          execution: 'read-only',
          fileScopes: ['src\\main\\jaws'],
          acceptanceCriteria: ['Relevant files are identified.'],
          verificationCommands: ['git status --short']
        },
        {
          key: 'apply_fix',
          title: 'Apply fix',
          objective: 'Patch the issue.',
          dependsOn: ['research'],
          execution: 'worktree',
          fileScopes: ['src/main/jaws/feature.ts'],
          acceptanceCriteria: ['The bug is fixed.'],
          verificationCommands: ['pnpm test src/main/jaws/feature.test.ts']
        }
      ])
    })

    expect(result?.items).toEqual([
      {
        key: 'research',
        title: 'Research',
        objective: 'Inspect the repo.',
        execution: 'read-only',
        dependencies: [],
        fileScopes: ['src/main/jaws'],
        acceptanceCriteria: ['Relevant files are identified.'],
        verificationCommands: ['git status --short']
      },
      {
        key: 'apply-fix',
        title: 'Apply fix',
        objective: 'Patch the issue.',
        execution: 'worktree',
        dependencies: ['research'],
        fileScopes: ['src/main/jaws/feature.ts'],
        acceptanceCriteria: ['The bug is fixed.'],
        verificationCommands: ['pnpm test src/main/jaws/feature.test.ts']
      }
    ])
  })

  it('stabilizes colliding or oversized Jaws task keys into unique Harness item keys', () => {
    const result = createHarnessExecutionPlanFromJawsPlan({
      revision: 1,
      planHash: 'c'.repeat(64),
      plan: plan([
        {
          key: 'API_TESTS',
          title: 'API tests',
          objective: 'Patch tests.',
          dependsOn: [],
          execution: 'worktree',
          fileScopes: ['src/api-tests'],
          acceptanceCriteria: ['Tests are patched.'],
          verificationCommands: ['pnpm test src/api-tests']
        },
        {
          key: 'api-tests',
          title: 'api tests',
          objective: 'Patch api tests.',
          dependsOn: ['API_TESTS'],
          execution: 'worktree',
          fileScopes: ['src/api-tests-two'],
          acceptanceCriteria: ['API tests are patched.'],
          verificationCommands: ['pnpm test src/api-tests-two']
        },
        {
          key: 'VeryLongTaskKeyNameThatExceedsHarnessKeyLengthByDesign1234567890',
          title: 'Long key',
          objective: 'Handle long keys.',
          dependsOn: ['api-tests'],
          execution: 'worktree',
          fileScopes: ['src/long-key'],
          acceptanceCriteria: ['Long keys work.'],
          verificationCommands: ['pnpm test src/long-key']
        }
      ])
    })

    expect(result?.items[0].key).toMatch(/^api-tests-[a-f0-9]{8}$/)
    expect(result?.items[1].key).toMatch(/^api-tests-[a-f0-9]{8}$/)
    expect(result?.items[0].key).not.toBe(result?.items[1].key)
    expect(result?.items[2].key.startsWith('verylongtaskkeynamethatexceedsharness')).toBe(true)
    expect(result?.items[2].key).toMatch(/-[a-f0-9]{8}$/)
    expect(result?.items[2].key.length).toBe(48)
    expect(result?.items[2].dependencies).toEqual([result?.items[1].key])
  })
})
