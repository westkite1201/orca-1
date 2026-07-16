import type { HarnessCandidate, HarnessRun } from '../../shared/harness-types'
import type { Store } from '../persistence'
import type { TaskRow } from '../runtime/orchestration/types'
import type { HarnessRuntimeCaller } from './runtime-caller'

type CandidateStore = Pick<Store, 'updateHarnessCandidate'>
type TaskCreateResult = { task: { id: string } }
type TaskListResult = { tasks: TaskRow[] }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function harnessTaskTitle(run: HarnessRun, candidate: HarnessCandidate): string {
  if (run.mode === 'orchestrator') {
    return 'Jaws Orchestrator: Codex coordinator'
  }
  return `Jaws Harness: ${candidate.agent === 'codex' ? 'Codex' : 'Claude'}`
}

export function buildHarnessTaskSpec(run: HarnessRun): string {
  if (run.mode === 'orchestrator') {
    return `Coordinate this goal from the current integration worktree:\n\n${run.goal}\n\nStart SHA: ${run.baseSha}\nFinal verification command: ${run.verificationCommand}\n\nYou own planning, supervised execution, integration, and the final report. First read the repository instructions and trace the real code path. Then:\n\n1. Decompose the goal into the smallest dependency-aware task DAG that can finish it. Do not manufacture parallel work when one direct change is enough.\n2. You are the live coordinator: do not invoke or delegate \`orca orchestration run\`. Manually track lanes with task-create, \`dispatch --inject\`, check --wait, and explicit dependencies. Set every delegated task's parent to your assigned top-level task ID from the dispatch preamble, pass \`--execution-kind read-only|worktree --agent-slot codex\`, and inspect only that lane set with \`orca orchestration task-list --parent <top-level-task-id>\`.\n3. Before dispatching each mutating lane, create a fresh isolated worktree with \`--base-branch ${run.baseSha} --agent codex --comment "Created via orchestration task <child-task-id>"\`. Read-only investigation must use another Codex terminal in this integration worktree and must not edit files.\n4. Supervise every dispatch until worker_done or escalation. Require mutating workers to commit their changes and report the commit SHA. Do not report successful worker_done while a child task is pending, ready, dispatched, failed, or blocked. If a failed or blocked child cannot be recovered, report your own worker_done with a Failed: subject and the reason.\n5. Integrate successful worker commits into this integration worktree in dependency order and resolve conflicts deliberately. Do not run or delegate the final verification command: after your worker_done, the owning runtime runs it exactly once.\n6. Report the final changed files, narrower checks already run, failed or blocked lanes, and anything that still needs human approval.\n\nDo not push, modify the user's source worktree, land to its branch, or delete worktrees. Never bypass repository safety instructions or verification to make the run appear successful.`
  }
  return `Implement this goal in the current worktree:\n\n${run.goal}\n\nStart SHA: ${run.baseSha}\nDo not push, merge, cherry-pick, delete branches or worktrees, or modify another worktree.`
}

export async function createHarnessTask(args: {
  store: CandidateStore
  runtime: HarnessRuntimeCaller
  run: HarnessRun
  candidate: HarnessCandidate
  spec: string
}): Promise<void> {
  const { store, runtime, run, candidate, spec } = args
  try {
    const title = harnessTaskTitle(run, candidate)
    const existing = await runtime.call<TaskListResult>('orchestration.taskList', {})
    const matches = existing.tasks.filter(
      (task) =>
        task.created_by_terminal_handle === `jaws-harness:${run.id}` &&
        task.task_title === title &&
        task.spec === spec
    )
    if (matches.length > 1) {
      store.updateHarnessCandidate(run.id, candidate.agent, {
        status: 'failed',
        error: 'Candidate task recovery found multiple matching tasks.'
      })
      return
    }
    if (matches[0]) {
      store.updateHarnessCandidate(run.id, candidate.agent, {
        taskId: matches[0].id,
        error: null
      })
      return
    }
    const result = await runtime.call<TaskCreateResult>('orchestration.taskCreate', {
      spec,
      taskTitle: title,
      executionKind: 'worktree',
      agentSlot: candidate.agent,
      callerTerminalHandle: `jaws-harness:${run.id}`
    })
    if (!result.task.id) {
      throw new Error('Task creation returned no task ID.')
    }
    store.updateHarnessCandidate(run.id, candidate.agent, {
      taskId: result.task.id,
      error: null
    })
  } catch (error) {
    store.updateHarnessCandidate(run.id, candidate.agent, { error: errorMessage(error) })
  }
}
