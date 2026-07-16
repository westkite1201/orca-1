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
