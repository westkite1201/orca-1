import type { HarnessCandidate, HarnessRun } from '../../shared/harness-types'
import type { Store } from '../persistence'
import type { TaskRow } from '../runtime/orchestration/types'
import type { HarnessRuntimeCaller } from './runtime-caller'

type CandidateStore = Pick<Store, 'updateHarnessCandidate'>
type TaskCreateResult = { task: { id: string } }
type TaskListResult = { tasks: TaskRow[] }
type RunCreateResult = { run: { id: string } }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function harnessTaskTitle(run: HarnessRun, candidate: HarnessCandidate): string {
  if (run.mode === 'orchestrator') {
    return 'Jaws Orchestrator: Codex coordinator'
  }
  return `Jaws Harness: ${candidate.agent === 'codex' ? 'Codex' : 'Claude'}`
}

function buildApprovedHarnessTaskSpec(
  plan: NonNullable<HarnessRun['approvedPlan']>,
  baseSha: string,
  linear: HarnessRun['approvedLinearMaterialization']
): string {
  const linearByTask = new Map(linear?.items.map((item) => [item.key, item.issue]) ?? [])
  const tasks = plan.tasks
    .map((task) => {
      const issue = linearByTask.get(task.key)
      return `- ${task.key}: ${task.title}\n  Objective: ${task.objective}\n  Depends on: ${
        task.dependsOn.length > 0 ? task.dependsOn.join(', ') : 'none'
      }${
        issue
          ? `\n  Linear: ${issue.identifier} ${issue.url}\n  Linear workspace: ${plan.linear?.workspaceId}`
          : ''
      }`
    })
    .join('\n')
  const linearRoot = linear?.rootIssue
    ? `\nLinear root: ${linear.rootIssue.identifier} ${linear.rootIssue.url}`
    : ''
  const linearWorkerFlags = plan.linear
    ? ' --linear-issue <approved-linear-identifier> --linear-workspace <approved-workspace-id>'
    : ''
  return `Execute this approved plan from the current integration worktree without changing its task set:\n\nGoal: ${plan.goal}\nStart SHA: ${baseSha}\nMaximum concurrent mutating lanes: ${plan.maxConcurrency}\nFinal verification command: ${plan.verificationCommand}${linearRoot}\n\nApproved tasks:\n${tasks}\n\nYou own supervised execution, integration, and the final report. First read the repository instructions and trace the real code path. Then:\n\n1. Treat the approved tasks and dependencies above as authoritative. Create exactly one child Task per approved task, titled \`[Jaws:<key>] <title>\`, with dependency keys translated to Task IDs. Do not add, remove, merge, split, or re-plan tasks. If the plan cannot be executed safely, stop and report the blocker.\n2. You are the live coordinator: do not invoke or delegate \`orca orchestration run\`. Use task-create, \`worker-start\`, check --wait, and explicit dependencies. Set every child Task's parent to your assigned top-level task ID from the dispatch preamble, and inspect only that lane set with \`orca orchestration task-list --parent <top-level-task-id>\`.\n3. Start a worker only when fewer than ${plan.maxConcurrency} mutating lanes are active. Use another Codex terminal in this integration worktree for read-only investigation; it must not edit files.\n4. For every ready task, first integrate all dependency commits and verify this integration checkout is clean. Resolve its exact base with \`git rev-parse HEAD\`, then run \`orca orchestration worker-start --task <task-id> --worktree new-child --name <task-key> --agent codex --setup run --base-branch <exact-sha>${linearWorkerFlags} --json\`. Never pass the word HEAD as the base ref.${plan.linear ? ' Use only that task’s approved Linear identifier and workspace shown above.' : ''}\n5. Supervise every Dispatch until worker_done or escalation. Require workers to commit their changes and report the commit SHA. Do not report successful worker_done while an approved child Task is pending, ready, dispatched, failed, or blocked. If a failed or blocked Task cannot be recovered, report your own worker_done with a Failed: subject and the reason.\n6. Integrate successful worker commits into this integration worktree in dependency order and resolve conflicts deliberately. A completed dependency is not enough: its commit must be integrated before a downstream worktree starts. Do not run or delegate the final verification command; after your worker_done, the owning runtime runs it exactly once.\n7. Report the final changed files, narrower checks already run, failed or blocked Tasks, and anything that still needs human approval.\n\nDo not push, modify the user's source worktree, land to its branch, or delete worktrees. Never bypass repository safety instructions or verification to make the run appear successful.`
}

function approvedPlanInstructions(run: HarnessRun): string {
  const plan = run.executionPlan
  if (!plan) {
    return ''
  }
  const lanes = plan.items
    .map(
      (item) =>
        `- ${item.key}: ${item.execution}; deps=[${item.dependencies.join(', ') || 'none'}]; scope=${item.fileScopes.join(', ') || 'global/unknown'}`
    )
    .join('\n')
  return `\n\nThe runtime owns this approved execution plan (revision ${plan.revision}, hash ${plan.planHash}, max concurrency ${plan.maxConcurrency}). Do not invent child tasks or create worktrees. Supervise only the runtime-created lanes below, independently inspect their evidence, integrate and verify them in dependency order, and report blockers without bypassing the plan:\n${lanes}`
}

export function buildHarnessTaskSpec(run: HarnessRun): string {
  if (run.mode === 'orchestrator') {
    if (run.executionPlan) {
      return `Coordinate this goal from the current integration worktree:\n\n${run.goal}\n\nStart SHA: ${run.baseSha}\nFinal verification command: ${run.verificationCommand}\n\nThe runtime owns task and worktree creation. Supervise only its approved lanes. A worker report is not completion: inspect its evidence independently, integrate mutating commits in dependency order, then run \`orca orchestration task-verify --id <task-id> --evidence "<direct observation>"\`. Report blockers, and do not create child tasks or worktrees yourself.${approvedPlanInstructions(run)}`
    }
    if (run.approvedPlan) {
      return buildApprovedHarnessTaskSpec(
        run.approvedPlan,
        run.baseSha,
        run.approvedLinearMaterialization
      )
    }
    return `Coordinate this goal from the current integration worktree:\n\n${run.goal}\n\nStart SHA: ${run.baseSha}\nFinal verification command: ${run.verificationCommand}\n\nYou own planning, supervised execution, integration, and the final report. First read the repository instructions and trace the real code path. Then:\n\n1. Decompose the goal into the smallest dependency-aware task DAG that can finish it. Do not manufacture parallel work when one direct change is enough.\n2. You are the live coordinator: do not invoke or delegate \`orca orchestration run\`. Manually track lanes with task-create, \`dispatch --inject\`, check --wait, and explicit dependencies. Set every delegated task's parent to your assigned top-level task ID from the dispatch preamble, and inspect only that lane set with \`orca orchestration task-list --parent <top-level-task-id>\`.\n3. Before dispatching each mutating lane, create a fresh isolated worktree with \`--base-branch ${run.baseSha} --agent codex --comment "Created via orchestration task <child-task-id>"\`. Read-only investigation must use another Codex terminal in this integration worktree and must not edit files.\n4. Supervise every dispatch until worker_done or escalation. Require mutating workers to commit their changes and report the commit SHA. Do not report successful worker_done while a child task is pending, ready, dispatched, failed, or blocked. If a failed or blocked child cannot be recovered, report your own worker_done with a Failed: subject and the reason.\n5. Integrate successful worker commits into this integration worktree in dependency order and resolve conflicts deliberately. Do not run or delegate the final verification command: after your worker_done, the owning runtime runs it exactly once.\n6. Report the final changed files, narrower checks already run, failed or blocked lanes, and anything that still needs human approval.\n\nDo not push, modify the user's source worktree, land to its branch, or delete worktrees. Never bypass repository safety instructions or verification to make the run appear successful.`
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
    if (!candidate.agentTerminalHandle) {
      throw new Error('Candidate terminal is missing.')
    }
    const title = harnessTaskTitle(run, candidate)
    let orchestrationRunId = candidate.orchestrationRunId
    if (!orchestrationRunId) {
      const created = await runtime.call<RunCreateResult>('orchestration.runCreate', {
        objective: title,
        from: candidate.agentTerminalHandle
      })
      orchestrationRunId = created.run.id
      store.updateHarnessCandidate(run.id, candidate.agent, { orchestrationRunId })
    }
    const existing = await runtime.call<TaskListResult>('orchestration.taskList', {
      run: orchestrationRunId,
      callerTerminalHandle: candidate.agentTerminalHandle
    })
    const matches = existing.tasks.filter(
      (task) =>
        task.created_by_terminal_handle === candidate.agentTerminalHandle &&
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
      callerTerminalHandle: candidate.agentTerminalHandle,
      run: orchestrationRunId
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
