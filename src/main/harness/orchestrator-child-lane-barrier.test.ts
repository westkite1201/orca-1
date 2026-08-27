import { describe, expect, it } from 'vitest'
import type { TaskRow, TaskStatus } from '../runtime/orchestration/types'
import { createHarnessRunFixture } from './verification-test-fixtures'
import { findOrchestratorChildLaneBlocker } from './orchestrator-child-lane-barrier'
import {
  createHarnessAllocationState,
  type HarnessExecutionPlanV1
} from '../../shared/harness-allocation-types'

function childTask(status: TaskStatus, id = `child-${status}`): TaskRow {
  return {
    id,
    run_id: 'run-1',
    parent_id: 'task-codex',
    created_by_terminal_handle: 'terminal-codex',
    created_by_pane_key: null,
    created_by_process_incarnation: null,
    created_by_run_generation: null,
    task_title: id,
    display_name: null,
    verification_required: 0,
    spec: 'Do work.',
    status,
    deps: '[]',
    result: null,
    created_at: '2026-07-15 00:00:00',
    completed_at: null
  }
}

describe('orchestrator child lane barrier', () => {
  it('blocks premature or unsuccessful coordinator completion', () => {
    const run = createHarnessRunFixture()
    run.mode = 'orchestrator'
    run.candidates = [run.candidates[0]]
    const candidate = run.candidates[0]

    expect(
      findOrchestratorChildLaneBlocker({ run, candidate, tasks: [childTask('dispatched')] })
    ).toMatchObject({ kind: 'active', message: expect.stringContaining('still active') })
    expect(
      findOrchestratorChildLaneBlocker({ run, candidate, tasks: [childTask('blocked')] })
    ).toMatchObject({
      kind: 'unsuccessful',
      message: expect.stringContaining('failed or were blocked')
    })
    expect(
      findOrchestratorChildLaneBlocker({ run, candidate, tasks: [childTask('completed')] })
    ).toBeNull()
  })

  it('does not require fabricated child lanes for a direct task', () => {
    const run = createHarnessRunFixture()
    run.mode = 'orchestrator'
    run.candidates = [run.candidates[0]]

    expect(
      findOrchestratorChildLaneBlocker({ run, candidate: run.candidates[0], tasks: [] })
    ).toBeNull()
  })

  it('requires durable integration evidence for approved mutating lanes', () => {
    const run = createHarnessRunFixture()
    const plan: HarnessExecutionPlanV1 = {
      version: 1,
      revision: 1,
      planHash: 'plan',
      maxConcurrency: 1,
      items: [
        {
          key: 'patch',
          title: 'Patch',
          objective: 'Patch code.',
          execution: 'worktree',
          dependencies: [],
          fileScopes: ['src'],
          acceptanceCriteria: ['Done.'],
          verificationCommands: ['pnpm test']
        }
      ]
    }
    run.mode = 'orchestrator'
    run.candidates = [run.candidates[0]]
    run.executionPlan = plan
    run.allocation = createHarnessAllocationState(plan)
    run.allocation.items[0].taskId = 'child-completed'

    expect(
      findOrchestratorChildLaneBlocker({
        run,
        candidate: run.candidates[0],
        tasks: [childTask('completed')]
      })
    ).toMatchObject({
      kind: 'unsuccessful',
      message: expect.stringContaining('lack verified integration evidence')
    })
  })

  it('caps lane names in blocker details', () => {
    const run = createHarnessRunFixture()
    run.mode = 'orchestrator'
    run.candidates = [run.candidates[0]]

    const blocker = findOrchestratorChildLaneBlocker({
      run,
      candidate: run.candidates[0],
      tasks: Array.from({ length: 5 }, (_, index) => childTask('dispatched', `lane-${index + 1}`))
    })

    expect(blocker?.message).toContain('lane-1, lane-2, lane-3, and 2 more')
    expect(blocker?.message).not.toContain('lane-4')
  })
})
