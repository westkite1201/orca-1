import { describe, expect, it, vi } from 'vitest'
import type { HarnessRun } from '../../shared/harness-types'
import type { HarnessRuntimeCaller } from './runtime-caller'
import { buildHarnessTaskSpec, createHarnessTask } from './candidate-task'
import { createHarnessRunFixture } from './verification-test-fixtures'

function orchestratorRun(): HarnessRun {
  const run = createHarnessRunFixture()
  return {
    ...run,
    mode: 'orchestrator',
    candidates: [run.candidates[0]]
  }
}

describe('orchestrator candidate task', () => {
  it('executes an approved DAG without asking the coordinator to re-plan it', () => {
    const run = {
      ...orchestratorRun(),
      approvedPlan: {
        goal: 'Implement the feature',
        verificationCommand: 'pnpm test',
        maxConcurrency: 2,
        tasks: [
          { key: 'API', title: 'Build API', objective: 'Implement API', dependsOn: [] },
          { key: 'UI', title: 'Build UI', objective: 'Implement UI', dependsOn: ['API'] }
        ]
      }
    }

    const spec = buildHarnessTaskSpec(run)

    expect(spec).not.toContain('Decompose the goal')
    expect(spec).toContain('Maximum concurrent mutating lanes: 2')
    expect(spec).toContain('UI: Build UI')
    expect(spec).toContain('Depends on: API')
    expect(spec).toContain('orchestration worker-start')
    expect(spec).toContain('git rev-parse HEAD')
    expect(spec).toContain('--base-branch <exact-sha>')
  })

  it('binds each approved task to its confirmed Linear issue', () => {
    const base = orchestratorRun()
    const run: HarnessRun = {
      ...base,
      approvedPlan: {
        goal: 'Implement the feature',
        verificationCommand: 'pnpm test',
        maxConcurrency: 1,
        tasks: [{ key: 'API', title: 'Build API', objective: 'Implement API', dependsOn: [] }],
        linear: {
          workspaceId: 'workspace-1',
          team: 'WES',
          project: null,
          rootIssue: {
            kind: 'existing',
            id: '11111111-1111-4111-8111-111111111111',
            identifier: 'WES-1',
            title: 'Root',
            url: 'https://linear.app/westkitedev/issue/WES-1',
            stateId: 'state-todo',
            parentId: null,
            relations: []
          }
        }
      },
      approvedLinearMaterialization: {
        status: 'confirmed',
        rootIssue: {
          id: '11111111-1111-4111-8111-111111111111',
          identifier: 'WES-1',
          title: 'Root',
          url: 'https://linear.app/westkitedev/issue/WES-1',
          stateId: 'state-todo',
          parentId: null
        },
        items: [
          {
            key: 'API',
            issue: {
              id: '22222222-2222-4222-8222-222222222222',
              identifier: 'WES-2',
              title: 'Build API',
              url: 'https://linear.app/westkitedev/issue/WES-2',
              stateId: 'state-todo',
              parentId: '11111111-1111-4111-8111-111111111111'
            }
          }
        ],
        effects: [],
        error: null,
        updatedAt: 1
      }
    }

    const spec = buildHarnessTaskSpec(run)

    expect(spec).toContain('Linear root: WES-1')
    expect(spec).toContain('Linear: WES-2')
    expect(spec).toContain('--linear-issue <approved-linear-identifier>')
    expect(spec).toContain('--linear-workspace <approved-workspace-id>')
  })

  it('instructs one coordinator to plan isolated lanes and verify the integration', async () => {
    const run = orchestratorRun()
    const spec = buildHarnessTaskSpec(run)
    const updateHarnessCandidate = vi.fn().mockReturnValue(run)
    const call = vi
      .fn()
      .mockResolvedValueOnce({ tasks: [] })
      .mockResolvedValueOnce({ task: { id: 'task-1' } })

    await createHarnessTask({
      store: { updateHarnessCandidate },
      runtime: { call } as unknown as HarnessRuntimeCaller,
      run,
      candidate: run.candidates[0],
      spec
    })

    expect(spec).toContain('smallest dependency-aware task DAG')
    expect(spec).toContain("Set every delegated task's parent to your assigned top-level task ID")
    expect(spec).toContain('a fresh isolated worktree')
    expect(spec).toContain('`dispatch --inject`')
    expect(spec).toContain(`--base-branch ${run.baseSha} --agent codex`)
    expect(spec).toContain('do not invoke or delegate `orca orchestration run`')
    expect(spec).toContain(`Final verification command: ${run.verificationCommand}`)
    expect(spec).toContain('Do not run or delegate the final verification command')
    expect(call).toHaveBeenLastCalledWith('orchestration.taskCreate', {
      spec,
      taskTitle: 'Jaws Orchestrator: Codex coordinator',
      callerTerminalHandle: 'terminal-codex',
      run: 'run-1'
    })
    expect(updateHarnessCandidate).toHaveBeenCalledWith(run.id, 'codex', {
      taskId: 'task-1',
      error: null
    })
  })
})
