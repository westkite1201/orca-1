import { describe, expect, it } from 'vitest'
import {
  createHarnessAllocationState,
  type HarnessExecutionPlanV1
} from './harness-allocation-types'

const PLAN: HarnessExecutionPlanV1 = {
  version: 1,
  revision: 2,
  planHash: 'hash-2',
  maxConcurrency: 2,
  items: [
    {
      key: 'research',
      title: 'Research',
      objective: 'Inspect the repository.',
      execution: 'read-only',
      dependencies: [],
      fileScopes: [],
      acceptanceCriteria: ['Find the relevant code.'],
      verificationCommands: ['git status']
    },
    {
      key: 'implementation',
      title: 'Implementation',
      objective: 'Implement the change.',
      execution: 'worktree',
      dependencies: [],
      fileScopes: ['src/main'],
      acceptanceCriteria: ['The change works.'],
      verificationCommands: ['pnpm test']
    }
  ]
}

describe('Harness allocation state', () => {
  it('starts every approved item as an unmaterialized attempt', () => {
    expect(createHarnessAllocationState(PLAN)).toEqual({
      version: 1,
      integrationWorktreeId: null,
      integrationHeadSha: null,
      items: [
        {
          itemKey: 'research',
          taskId: null,
          materialization: 'planned',
          attempt: 0,
          baseSha: null,
          worktreeId: null,
          terminalPaneKey: null,
          reportedCommitSha: null,
          integration: 'not-required',
          integratedHeadSha: null,
          error: null
        },
        {
          itemKey: 'implementation',
          taskId: null,
          materialization: 'planned',
          attempt: 0,
          baseSha: null,
          worktreeId: null,
          terminalPaneKey: null,
          reportedCommitSha: null,
          integration: 'pending',
          integratedHeadSha: null,
          error: null
        }
      ]
    })
  })
})
