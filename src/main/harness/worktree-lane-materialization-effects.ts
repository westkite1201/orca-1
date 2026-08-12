import type {
  RuntimeTerminalCreate,
  RuntimeTerminalResolvePane,
  RuntimeTerminalWait,
  RuntimeWorktreeCreateResult
} from '../../shared/runtime-types'
import type { HarnessExecutionItemV1 } from '../../shared/harness-allocation-types'
import type { HarnessCandidate, HarnessRun } from '../../shared/harness-types'
import type { HarnessRuntimeCaller } from './runtime-caller'
import {
  allocationItem,
  type AllocationStore,
  updateAllocation
} from './worktree-lane-receipt-state'

type GitStatusResult = {
  head?: string | null
  entries: unknown[]
  didHitLimit?: boolean
  conflictOperation: string
}
type TerminalResolvePaneResult = { terminal: RuntimeTerminalResolvePane }
type TerminalWaitResult = { wait: RuntimeTerminalWait }

export function harnessLaneBranch(run: HarnessRun, itemKey: string, attempt: number): string {
  return `jaws/${run.id.slice(0, 8)}/${itemKey}/a${attempt}`
}

export function harnessLaneTerminalTitle(
  run: HarnessRun,
  item: HarnessExecutionItemV1,
  attempt: number
): string {
  return `Jaws ${run.id.slice(0, 8)} · ${item.key} · a${attempt}`
}

function harnessLaneMutationId(run: HarnessRun, itemKey: string, attempt: number): string {
  return `jaws-lane:${run.id}:${itemKey}:${attempt}`
}

async function dispatchLane(args: {
  runtime: HarnessRuntimeCaller
  root: HarnessCandidate
  taskId: string
  targetHandle: string
}): Promise<void> {
  const ready = await args.runtime.call<TerminalWaitResult>('terminal.wait', {
    terminal: args.targetHandle,
    for: 'tui-idle',
    timeoutMs: 120_000
  })
  if (!ready.wait.satisfied) {
    throw new Error(
      `Lane terminal did not become ready: ${ready.wait.blockedReason ?? ready.wait.status}`
    )
  }
  await args.runtime.call('orchestration.dispatch', {
    task: args.taskId,
    to: args.targetHandle,
    from: args.root.agentTerminalHandle,
    run: args.root.orchestrationRunId,
    inject: true,
    returnPreamble: true
  })
}

export async function finishHarnessLaneMaterialization(args: {
  runtime: HarnessRuntimeCaller
  store: AllocationStore
  run: HarnessRun
  root: HarnessCandidate
  item: HarnessExecutionItemV1
  baseSha: string
  worktreeId: string | null
  targetHandle: string
  paneKey: string
}): Promise<void> {
  updateAllocation(
    args.store,
    args.run.id,
    {
      item: {
        itemKey: args.item.key,
        materialization: 'created',
        baseSha: args.baseSha,
        worktreeId: args.worktreeId,
        terminalPaneKey: args.paneKey,
        error: null
      }
    },
    'required'
  )
  await dispatchLane({
    runtime: args.runtime,
    root: args.root,
    taskId: allocationItem(args.run, args.item.key).taskId!,
    targetHandle: args.targetHandle
  })
}

export async function createHarnessLane(args: {
  runtime: HarnessRuntimeCaller
  store: AllocationStore
  run: HarnessRun
  root: HarnessCandidate
  item: HarnessExecutionItemV1
  baseSha: string
  attempt: number
}): Promise<void> {
  const { item, run, root } = args
  let targetHandle: string
  let worktreeId: string | null = null
  let paneKey: string | null = null
  if (item.execution === 'read-only') {
    const result = await args.runtime.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
      worktree: `id:${root.worktreeId}`,
      launchAgent: 'codex',
      title: harnessLaneTerminalTitle(run, item, args.attempt),
      activate: false,
      presentation: 'background'
    })
    targetHandle = result.terminal.handle
    paneKey = result.terminal.paneKey ?? null
  } else {
    const branch = harnessLaneBranch(run, item.key, args.attempt)
    const result = await args.runtime.call<RuntimeWorktreeCreateResult>('worktree.create', {
      repo: `id:${run.repoId}`,
      name: branch,
      baseBranch: args.baseSha,
      branchNameOverride: branch,
      parentWorktree: `id:${root.worktreeId}`,
      comment: `Created via orchestration task ${allocationItem(run, item.key).taskId}`,
      setupDecision: 'skip',
      startupAgent: 'codex',
      activate: false,
      clientMutationId: harnessLaneMutationId(run, item.key, args.attempt),
      orchestrationContext: {
        parentWorktreeId: root.worktreeId,
        orchestrationRunId: run.id,
        taskId: allocationItem(run, item.key).taskId ?? undefined,
        coordinatorHandle: root.agentTerminalHandle
      }
    })
    const worktree = result.worktree
    worktreeId = worktree.id
    targetHandle = result.agentTerminalHandle ?? result.startupTerminal?.handle ?? ''
    paneKey = result.startupTerminal?.paneKey ?? null
    const status = await args.runtime.call<GitStatusResult>('git.status', {
      worktree: `id:${worktree.id}`
    })
    const lineageMatches =
      worktree.repoId === run.repoId &&
      worktree.parentWorktreeId === root.worktreeId &&
      worktree.lineage?.taskId === allocationItem(run, item.key).taskId &&
      worktree.createdWithAgent === 'codex'
    if (
      !lineageMatches ||
      status.didHitLimit ||
      status.entries.length > 0 ||
      status.conflictOperation !== 'unknown' ||
      status.head?.trim() !== args.baseSha
    ) {
      throw new Error(`Lane ${item.key} did not start from its approved clean base.`)
    }
  }
  if (!targetHandle || !paneKey) {
    throw new Error(`Lane ${item.key} has no stable terminal identity.`)
  }
  await finishHarnessLaneMaterialization({
    runtime: args.runtime,
    store: args.store,
    run,
    root,
    item,
    baseSha: args.baseSha,
    worktreeId,
    targetHandle,
    paneKey
  })
}

export async function dispatchExistingHarnessLane(args: {
  runtime: HarnessRuntimeCaller
  run: HarnessRun
  root: HarnessCandidate
  item: HarnessExecutionItemV1
}): Promise<void> {
  const receipt = allocationItem(args.run, args.item.key)
  if (!receipt.taskId || !receipt.terminalPaneKey) {
    throw new Error(`Lane ${args.item.key} is missing its persisted terminal receipt.`)
  }
  const resolved = await args.runtime.call<TerminalResolvePaneResult>('terminal.resolvePane', {
    paneKey: receipt.terminalPaneKey
  })
  await dispatchLane({
    runtime: args.runtime,
    root: args.root,
    taskId: receipt.taskId,
    targetHandle: resolved.terminal.handle
  })
}
