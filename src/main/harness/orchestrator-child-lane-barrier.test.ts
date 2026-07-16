import { describe, expect, it } from 'vitest'
import type { TaskRow, TaskStatus } from '../runtime/orchestration/types'
import { createHarnessRunFixture } from './verification-test-fixtures'
import { findOrchestratorChildLaneBlocker } from './orchestrator-child-lane-barrier'

function childTask(status: TaskStatus, id = `child-${status}`): TaskRow {
  return {
    id,
    run_id: 'run-1',
    parent_id: 'task-codex',
    created_by_terminal_handle: 'terminal-codex',
    task_title: id,
    display_name: null,
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
