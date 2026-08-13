import type {
  HarnessExecutionItemV1,
  HarnessExecutionPlanV1
} from '../../shared/harness-allocation-types'
import type { HarnessCandidate, HarnessRun } from '../../shared/harness-types'
import type { TaskRow } from '../runtime/orchestration/types'
import type { HarnessRuntimeCaller } from './runtime-caller'
import { compileHarnessAllocationPlan } from './worktree-allocation-compiler'
import { selectHarnessReadyLanes } from './worktree-lane-scheduler'
import {
  createHarnessLane,
  dispatchExistingHarnessLane
} from './worktree-lane-materialization-effects'
import {
  allocationItem,
  type AllocationStore,
  updateAllocation
} from './worktree-lane-receipt-state'
import { recoverCreatingHarnessLanes } from './worktree-lane-recovery'

type TaskCreateResult = { task: TaskRow }
type TaskListResult = { tasks: TaskRow[] }
type GitStatusResult = {
  head?: string | null
  entries: unknown[]
  didHitLimit?: boolean
  conflictOperation: string
}

function taskSpec(item: HarnessExecutionItemV1): string {
  return [
    `Approved Jaws lane: ${item.title}`,
    `Objective: ${item.objective}`,
    `File scope: ${item.fileScopes.length > 0 ? item.fileScopes.join(', ') : 'global/unknown'}`,
    'Acceptance criteria:',
    ...item.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    'Verification commands:',
    ...item.verificationCommands.map((command) => `- ${command}`),
    item.execution === 'worktree'
      ? 'Commit the final changes and report the full commit SHA plus files-modified in worker_done.'
      : 'Do not modify the repository; report worker_done without a commit or files-modified.',
    'Do not create another task or worktree. Report evidence to the assigned coordinator.'
  ].join('\n')
}

function taskFor(tasks: readonly TaskRow[], itemKey: string, run: HarnessRun): TaskRow | null {
  const allocation = allocationItem(run, itemKey)
  return allocation.taskId ? (tasks.find((task) => task.id === allocation.taskId) ?? null) : null
}

async function listChildTasks(
  runtime: HarnessRuntimeCaller,
  root: HarnessCandidate
): Promise<TaskRow[]> {
  const result = await runtime.call<TaskListResult>('orchestration.taskList', {
    parent: root.taskId,
    run: root.orchestrationRunId,
    callerTerminalHandle: root.agentTerminalHandle
  })
  return result.tasks
}

async function ensurePlanTasks(args: {
  runtime: HarnessRuntimeCaller
  store: AllocationStore
  run: HarnessRun
  root: HarnessCandidate
  plan: HarnessExecutionPlanV1
  order: readonly string[]
}): Promise<TaskRow[]> {
  let tasks = await listChildTasks(args.runtime, args.root)
  let run = args.store.getHarnessRun(args.run.id) ?? args.run
  for (const itemKey of args.order) {
    const item = args.plan.items.find((entry) => entry.key === itemKey)
    if (!item) {
      continue
    }
    const receipt = allocationItem(run, item.key)
    if (receipt.taskId) {
      continue
    }
    const dependencyIds = item.dependencies.map(
      (dependency) => allocationItem(run, dependency).taskId
    )
    if (dependencyIds.some((dependencyId) => !dependencyId)) {
      throw new Error(`Harness lane dependencies are not materialized: ${item.key}`)
    }
    const existing = tasks.find(
      (task) =>
        task.parent_id === args.root.taskId &&
        task.spec === taskSpec(item) &&
        task.created_by_terminal_handle === args.root.agentTerminalHandle
    )
    const task =
      existing ??
      (
        await args.runtime.call<TaskCreateResult>('orchestration.taskCreate', {
          spec: taskSpec(item),
          taskTitle: item.title,
          deps: JSON.stringify(dependencyIds),
          parent: args.root.taskId,
          callerTerminalHandle: args.root.agentTerminalHandle,
          run: args.root.orchestrationRunId
        })
      ).task
    updateAllocation(
      args.store,
      args.run.id,
      {
        item: { itemKey: item.key, taskId: task.id, error: null }
      },
      'required'
    )
    run = args.store.getHarnessRun(args.run.id) ?? run
    tasks = [...tasks.filter((entry) => entry.id !== task.id), task]
  }
  return tasks
}

async function verifyIntegrationSnapshot(
  runtime: HarnessRuntimeCaller,
  worktreeId: string
): Promise<string | null> {
  const status = await runtime.call<GitStatusResult>('git.status', { worktree: `id:${worktreeId}` })
  if (status.didHitLimit || status.entries.length > 0 || status.conflictOperation !== 'unknown') {
    return null
  }
  const head = status.head?.trim()
  if (!head) {
    throw new Error('Integration worktree has no HEAD.')
  }
  return head
}

export async function materializeHarnessPlan(args: {
  runtime: HarnessRuntimeCaller
  store: AllocationStore
  run: HarnessRun
}): Promise<void> {
  const { run } = args
  if (!run.executionPlan || !run.allocation || run.mode !== 'orchestrator') {
    return
  }
  const root = run.candidates.find((candidate) => candidate.agent === 'codex')
  if (
    !root?.taskId ||
    !root.worktreeId ||
    !root.agentTerminalHandle ||
    !root.agentTerminalPaneKey
  ) {
    return
  }
  const compilation = compileHarnessAllocationPlan(run.executionPlan)
  const integrationHeadSha = await verifyIntegrationSnapshot(args.runtime, root.worktreeId)
  if (!integrationHeadSha) {
    return
  }
  const persisted = args.store.getHarnessRun(run.id) ?? run
  if (
    persisted.allocation?.integrationWorktreeId &&
    persisted.allocation.integrationWorktreeId !== root.worktreeId
  ) {
    throw new Error('Harness integration worktree identity changed.')
  }
  if (
    persisted.allocation?.integrationHeadSha &&
    persisted.allocation.integrationHeadSha !== integrationHeadSha
  ) {
    // Why: only task verification may advance the durable integration boundary.
    return
  }
  updateAllocation(
    args.store,
    run.id,
    {
      integrationWorktreeId: root.worktreeId,
      ...(persisted.allocation?.integrationHeadSha ? {} : { integrationHeadSha })
    },
    'required'
  )
  let tasks = await ensurePlanTasks({
    runtime: args.runtime,
    store: args.store,
    run,
    root,
    plan: compilation.plan,
    order: compilation.topologicalOrder
  })
  const recoveryRun = args.store.getHarnessRun(run.id) ?? run
  await recoverCreatingHarnessLanes({
    runtime: args.runtime,
    store: args.store,
    run: recoveryRun,
    root,
    tasks
  })
  tasks = await listChildTasks(args.runtime, root)
  const current = args.store.getHarnessRun(run.id) ?? run
  const readyKeys = tasks
    .filter((task) => task.status === 'ready')
    .map((task) => current.allocation?.items.find((item) => item.taskId === task.id)?.itemKey)
    .filter((key): key is string => key !== undefined)
    .filter((key) => {
      const materialization = allocationItem(current, key).materialization
      // A creating intent has an unknown side-effect outcome after a crash;
      // never create a second worktree until reconciliation adopts or fails it.
      return materialization === 'planned' || materialization === 'created'
    })
  const activeKeys = tasks
    .filter((task) => task.status === 'dispatched' || task.status === 'reported')
    .map((task) => current.allocation?.items.find((item) => item.taskId === task.id)?.itemKey)
    .filter((key): key is string => key !== undefined)
  const selected = selectHarnessReadyLanes({
    compilation,
    readyKeys,
    activeKeys,
    maxConcurrent: compilation.plan.maxConcurrency
  })
  for (const itemKey of selected.selectedKeys) {
    const item = compilation.plan.items.find((entry) => entry.key === itemKey)
    const task = taskFor(tasks, itemKey, current)
    if (!item || !task) {
      continue
    }
    const receipt = allocationItem(current, itemKey)
    if (receipt.materialization === 'created') {
      await dispatchExistingHarnessLane({ runtime: args.runtime, run: current, root, item })
      continue
    }
    const baseSha =
      compilation.items.find((entry) => entry.itemKey === itemKey)?.basePolicy === 'run-base'
        ? current.baseSha
        : current.allocation?.integrationHeadSha
    if (!baseSha) {
      continue
    }
    const attempt = receipt.attempt + 1
    updateAllocation(
      args.store,
      current.id,
      {
        item: { itemKey, materialization: 'creating', attempt, baseSha, error: null }
      },
      'required'
    )
    try {
      await createHarnessLane({
        runtime: args.runtime,
        store: args.store,
        run: current,
        root,
        item,
        baseSha,
        attempt
      })
    } catch (error) {
      const latest = args.store.getHarnessRun(current.id) ?? current
      const latestReceipt = allocationItem(latest, itemKey)
      updateAllocation(
        args.store,
        current.id,
        {
          item: {
            itemKey,
            // Why: an RPC error cannot prove the remote side effect did not
            // happen. Preserve the receipt so recovery can adopt before retrying.
            materialization: latestReceipt.materialization,
            error: error instanceof Error ? error.message : String(error)
          }
        },
        'required'
      )
    }
  }
}
