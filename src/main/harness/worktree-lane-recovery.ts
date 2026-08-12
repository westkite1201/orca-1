import { makePaneKey } from '../../shared/stable-pane-id'
import type { GitStatusResult } from '../../shared/git-status-types'
import type {
  RuntimeTerminalCreate,
  RuntimeTerminalListResult,
  RuntimeWorktreeListResult,
  RuntimeWorktreeRecord
} from '../../shared/runtime-types'
import type { HarnessExecutionItemV1 } from '../../shared/harness-allocation-types'
import type { HarnessCandidate, HarnessRun } from '../../shared/harness-types'
import type { TaskRow } from '../runtime/orchestration/types'
import { isSameHarnessBranch } from './candidate-recovery'
import type { HarnessRuntimeCaller } from './runtime-caller'
import {
  createHarnessLane,
  finishHarnessLaneMaterialization,
  harnessLaneBranch,
  harnessLaneTerminalTitle
} from './worktree-lane-materialization-effects'
import {
  allocationItem,
  type AllocationStore,
  updateAllocation
} from './worktree-lane-receipt-state'

type TerminalIsRunningAgentResult = { isRunningAgent: boolean }

class LaneRecoveryRejectedError extends Error {}

function updateLaneRecovery(
  store: AllocationStore,
  runId: string,
  itemKey: string,
  materialization: 'creating' | 'failed',
  error: string
): void {
  updateAllocation(store, runId, { item: { itemKey, materialization, error } }, 'required')
}

async function runningTerminals(args: {
  runtime: HarnessRuntimeCaller
  worktreeId: string
  title?: string
}): Promise<RuntimeTerminalListResult['terminals']> {
  const listed = await args.runtime.call<RuntimeTerminalListResult>('terminal.list', {
    worktree: `id:${args.worktreeId}`,
    requireFreshPtyLiveness: true
  })
  if (listed.truncated) {
    throw new Error('Lane terminal recovery requires a complete terminal listing.')
  }
  const candidates = args.title
    ? listed.terminals.filter((terminal) => terminal.title === args.title)
    : listed.terminals
  const probes = await Promise.all(
    candidates.map(async (terminal) => ({
      terminal,
      running: (
        await args.runtime.call<TerminalIsRunningAgentResult>('terminal.isRunningAgent', {
          terminal: terminal.handle
        })
      ).isRunningAgent
    }))
  )
  return probes.filter((probe) => probe.running).map((probe) => probe.terminal)
}

async function createRecoveryTerminal(args: {
  runtime: HarnessRuntimeCaller
  worktreeId: string
  title: string
}): Promise<{ handle: string; paneKey: string }> {
  const result = await args.runtime.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
    worktree: `id:${args.worktreeId}`,
    launchAgent: 'codex',
    title: args.title,
    activate: false,
    presentation: 'background'
  })
  const paneKey = result.terminal.paneKey
  if (!paneKey) {
    throw new Error('Recovered lane terminal has no stable pane identity.')
  }
  return { handle: result.terminal.handle, paneKey }
}

async function finishRecoveredLane(args: {
  runtime: HarnessRuntimeCaller
  store: AllocationStore
  run: HarnessRun
  root: HarnessCandidate
  item: HarnessExecutionItemV1
  worktreeId: string | null
  terminal: { handle: string; tabId?: string; leafId?: string; paneKey?: string | null }
}): Promise<void> {
  const receipt = allocationItem(args.run, args.item.key)
  const paneKey =
    args.terminal.paneKey ??
    (args.terminal.tabId && args.terminal.leafId
      ? makePaneKey(args.terminal.tabId, args.terminal.leafId)
      : null)
  if (!receipt.baseSha || !paneKey) {
    throw new Error('Recovered lane is missing its base or stable pane identity.')
  }
  await finishHarnessLaneMaterialization({
    runtime: args.runtime,
    store: args.store,
    run: args.run,
    root: args.root,
    item: args.item,
    baseSha: receipt.baseSha,
    worktreeId: args.worktreeId,
    targetHandle: args.terminal.handle,
    paneKey
  })
}

async function recoverReadOnlyLane(args: {
  runtime: HarnessRuntimeCaller
  store: AllocationStore
  run: HarnessRun
  root: HarnessCandidate
  item: HarnessExecutionItemV1
}): Promise<void> {
  const receipt = allocationItem(args.run, args.item.key)
  if (receipt.baseSha !== args.run.allocation?.integrationHeadSha) {
    throw new LaneRecoveryRejectedError('Read-only lane snapshot changed before recovery.')
  }
  const title = harnessLaneTerminalTitle(args.run, args.item, receipt.attempt)
  const matches = await runningTerminals({
    runtime: args.runtime,
    worktreeId: args.root.worktreeId!,
    title
  })
  if (matches.length > 1) {
    throw new LaneRecoveryRejectedError(
      `Read-only lane ${args.item.key} has multiple matching terminals.`
    )
  }
  const terminal =
    matches[0] ??
    (await createRecoveryTerminal({
      runtime: args.runtime,
      worktreeId: args.root.worktreeId!,
      title
    }))
  await finishRecoveredLane({ ...args, worktreeId: null, terminal })
}

function validateRecoveredWorktree(args: {
  run: HarnessRun
  root: HarnessCandidate
  item: HarnessExecutionItemV1
  worktree: RuntimeWorktreeRecord
}): string | null {
  const receipt = allocationItem(args.run, args.item.key)
  return args.worktree.repoId !== args.run.repoId
    ? 'repository does not match'
    : args.worktree.parentWorktreeId !== args.root.worktreeId
      ? 'integration parent does not match'
      : args.worktree.lineage?.origin !== 'orchestration' ||
          args.worktree.lineage.taskId !== receipt.taskId
        ? 'task lineage does not match'
        : args.worktree.createdWithAgent !== 'codex'
          ? 'agent slot does not match'
          : args.worktree.git.head !== receipt.baseSha
            ? 'base SHA does not match'
            : null
}

async function recoverWorktreeLane(args: {
  runtime: HarnessRuntimeCaller
  store: AllocationStore
  run: HarnessRun
  root: HarnessCandidate
  item: HarnessExecutionItemV1
  worktrees: RuntimeWorktreeRecord[]
}): Promise<void> {
  const receipt = allocationItem(args.run, args.item.key)
  const branch = harnessLaneBranch(args.run, args.item.key, receipt.attempt)
  const matches = args.worktrees.filter((worktree) =>
    isSameHarnessBranch(worktree.git.branch, branch)
  )
  if (matches.length > 1) {
    throw new LaneRecoveryRejectedError(`Lane recovery found multiple worktrees for ${branch}.`)
  }
  const worktree = matches[0]
  if (!worktree) {
    await createHarnessLane({
      ...args,
      baseSha: receipt.baseSha!,
      attempt: receipt.attempt
    })
    return
  }
  const mismatch = validateRecoveredWorktree({ ...args, worktree })
  if (mismatch) {
    throw new LaneRecoveryRejectedError(`Recovered lane ${args.item.key} ${mismatch}.`)
  }
  const status = await args.runtime.call<GitStatusResult>('git.status', {
    worktree: `id:${worktree.id}`
  })
  if (
    status.didHitLimit ||
    status.head?.trim() !== receipt.baseSha ||
    status.entries.length > 0 ||
    status.conflictOperation !== 'unknown'
  ) {
    throw new LaneRecoveryRejectedError(
      `Recovered lane ${args.item.key} is not a clean approved-base worktree.`
    )
  }
  const terminals = await runningTerminals({ runtime: args.runtime, worktreeId: worktree.id })
  if (terminals.length > 1) {
    throw new LaneRecoveryRejectedError(
      `Recovered lane ${args.item.key} has multiple running agent terminals.`
    )
  }
  const terminal =
    terminals[0] ??
    (await createRecoveryTerminal({
      runtime: args.runtime,
      worktreeId: worktree.id,
      title: harnessLaneTerminalTitle(args.run, args.item, receipt.attempt)
    }))
  await finishRecoveredLane({ ...args, worktreeId: worktree.id, terminal })
}

export async function recoverCreatingHarnessLanes(args: {
  runtime: HarnessRuntimeCaller
  store: AllocationStore
  run: HarnessRun
  root: HarnessCandidate
  tasks: readonly TaskRow[]
}): Promise<void> {
  const creating =
    args.run.allocation?.items.filter(
      (receipt) =>
        receipt.materialization === 'creating' &&
        args.tasks.some((task) => task.id === receipt.taskId && task.status === 'ready')
    ) ?? []
  if (creating.length === 0) {
    return
  }
  let worktrees: RuntimeWorktreeRecord[] = []
  if (
    creating.some(
      (receipt) =>
        args.run.executionPlan?.items.find((item) => item.key === receipt.itemKey)?.execution ===
        'worktree'
    )
  ) {
    try {
      const listed = await args.runtime.call<RuntimeWorktreeListResult>('worktree.list', {
        repo: `id:${args.run.repoId}`
      })
      if (listed.truncated) {
        throw new Error('Lane recovery requires a complete worktree listing.')
      }
      worktrees = listed.worktrees
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      for (const receipt of creating) {
        updateLaneRecovery(args.store, args.run.id, receipt.itemKey, 'creating', message)
      }
      return
    }
  }
  for (const receipt of creating) {
    const item = args.run.executionPlan?.items.find((entry) => entry.key === receipt.itemKey)
    if (!item || !receipt.taskId || !receipt.baseSha || receipt.attempt < 1) {
      updateLaneRecovery(
        args.store,
        args.run.id,
        receipt.itemKey,
        'failed',
        'Lane recovery receipt is incomplete.'
      )
      continue
    }
    try {
      if (item.execution === 'read-only') {
        await recoverReadOnlyLane({ ...args, item })
        continue
      }
      await recoverWorktreeLane({ ...args, item, worktrees })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const latest = args.store.getHarnessRun(args.run.id) ?? args.run
      if (allocationItem(latest, item.key).materialization === 'created') {
        updateAllocation(args.store, args.run.id, { item: { itemKey: item.key, error: message } })
      } else if (error instanceof LaneRecoveryRejectedError) {
        updateLaneRecovery(args.store, args.run.id, item.key, 'failed', message)
      } else {
        updateLaneRecovery(args.store, args.run.id, item.key, 'creating', message)
      }
    }
  }
}
