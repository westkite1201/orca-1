import { describe, expect, it, vi } from 'vitest'
import {
  createHarnessAllocationState,
  type HarnessAllocationPatchV1,
  type HarnessExecutionPlanV1
} from '../../shared/harness-allocation-types'
import type { HarnessCandidate, HarnessRun } from '../../shared/harness-types'
import type { RuntimeWorktreeRecord } from '../../shared/runtime-types'
import type { TaskRow } from '../runtime/orchestration/types'
import type { HarnessRuntimeCaller } from './runtime-caller'
import { harnessLaneBranch } from './worktree-lane-materialization-effects'
import type { AllocationStore } from './worktree-lane-receipt-state'
import { recoverCreatingHarnessLanes } from './worktree-lane-recovery'

const BASE_SHA = '0123456789abcdef'
const ITEM = {
  key: 'patch',
  title: 'Patch code',
  objective: 'Apply the isolated fix.',
  execution: 'worktree',
  dependencies: [],
  fileScopes: ['src/app'],
  acceptanceCriteria: ['The fix is covered.'],
  verificationCommands: ['pnpm test']
} as const
const PLAN: HarnessExecutionPlanV1 = {
  version: 1,
  revision: 1,
  planHash: 'plan-hash',
  maxConcurrency: 2,
  items: [
    {
      ...ITEM,
      dependencies: [],
      fileScopes: [...ITEM.fileScopes],
      acceptanceCriteria: [...ITEM.acceptanceCriteria],
      verificationCommands: [...ITEM.verificationCommands]
    }
  ]
}

function createContext(worktrees: RuntimeWorktreeRecord[]): {
  getRun: () => HarnessRun
  root: HarnessCandidate
  task: TaskRow
  store: AllocationStore
  runtime: HarnessRuntimeCaller
  call: ReturnType<typeof vi.fn>
} {
  const root = {
    agent: 'codex',
    worktreeId: 'integration-1',
    agentTerminalHandle: 'root-terminal',
    agentTerminalPaneKey: 'root-pane',
    taskId: 'root-task'
  } as HarnessCandidate
  let run = {
    id: 'run-12345678',
    mode: 'orchestrator',
    repoId: 'repo-1',
    baseSha: BASE_SHA,
    executionPlan: PLAN,
    allocation: createHarnessAllocationState(PLAN),
    candidates: [root],
    fatalError: null
  } as HarnessRun
  run.allocation!.integrationWorktreeId = root.worktreeId
  run.allocation!.integrationHeadSha = BASE_SHA
  Object.assign(run.allocation!.items[0], {
    taskId: 'task-patch',
    materialization: 'creating',
    attempt: 1,
    baseSha: BASE_SHA
  })
  const task = { id: 'task-patch', status: 'ready' } as TaskRow
  const store: AllocationStore = {
    getHarnessRun: () => run,
    updateHarnessAllocation: vi.fn((_runId: string, patch: HarnessAllocationPatchV1) => {
      const allocation = run.allocation!
      run = {
        ...run,
        allocation: {
          ...allocation,
          ...(patch.integrationWorktreeId !== undefined
            ? { integrationWorktreeId: patch.integrationWorktreeId }
            : {}),
          ...(patch.integrationHeadSha !== undefined
            ? { integrationHeadSha: patch.integrationHeadSha }
            : {}),
          items: patch.item
            ? allocation.items.map((entry) =>
                entry.itemKey === patch.item?.itemKey ? { ...entry, ...patch.item } : entry
              )
            : allocation.items
        }
      }
      return run
    })
  }
  const call = vi.fn(async (method: string, rawParams?: unknown): Promise<unknown> => {
    const params = rawParams as Record<string, unknown> | undefined
    if (method === 'worktree.list') {
      return { worktrees, totalCount: worktrees.length, truncated: false }
    }
    if (method === 'git.status') {
      return { head: BASE_SHA, entries: [], conflictOperation: 'unknown' }
    }
    if (method === 'terminal.list') {
      return {
        terminals:
          worktrees.length === 0
            ? []
            : [
                {
                  handle: 'lane-terminal',
                  worktreeId: worktrees[0].id,
                  tabId: 'lane-tab',
                  leafId: '11111111-1111-4111-8111-111111111111'
                }
              ],
        totalCount: worktrees.length === 0 ? 0 : 1,
        truncated: false
      }
    }
    if (method === 'terminal.isRunningAgent') {
      return { isRunningAgent: true }
    }
    if (method === 'terminal.wait') {
      return { wait: { satisfied: true, status: 'running' } }
    }
    if (method === 'orchestration.dispatch') {
      task.status = 'dispatched'
      return { dispatch: { id: 'dispatch-1' }, injected: true }
    }
    if (method === 'worktree.create') {
      const context = params?.orchestrationContext as Record<string, unknown>
      return {
        worktree: laneWorktree(String(context.taskId)),
        agentTerminalHandle: 'created-terminal',
        startupTerminal: { handle: 'created-terminal', paneKey: 'created-pane' }
      }
    }
    throw new Error(`Unexpected RPC: ${method}`)
  })
  return {
    getRun: () => run,
    root,
    task,
    store,
    call,
    runtime: { call } as unknown as HarnessRuntimeCaller
  }
}

function laneWorktree(taskId = 'task-patch'): RuntimeWorktreeRecord {
  const run = { id: 'run-12345678' } as HarnessRun
  return {
    id: 'lane-worktree',
    repoId: 'repo-1',
    parentWorktreeId: 'integration-1',
    createdWithAgent: 'codex',
    lineage: { origin: 'orchestration', taskId },
    git: { branch: harnessLaneBranch(run, 'patch', 1), head: BASE_SHA }
  } as RuntimeWorktreeRecord
}

describe('Harness lane creation recovery', () => {
  it('adopts the one matching worktree instead of creating a duplicate', async () => {
    const context = createContext([laneWorktree()])

    await recoverCreatingHarnessLanes({
      runtime: context.runtime,
      store: context.store,
      run: context.getRun(),
      root: context.root,
      tasks: [context.task]
    })

    expect(context.call.mock.calls.filter(([method]) => method === 'worktree.create')).toHaveLength(
      0
    )
    expect(context.getRun().allocation?.items[0]).toMatchObject({
      materialization: 'created',
      worktreeId: 'lane-worktree'
    })
    expect(context.task.status).toBe('dispatched')
  })

  it('retries a missing side effect with the same attempt identity', async () => {
    const context = createContext([])

    await recoverCreatingHarnessLanes({
      runtime: context.runtime,
      store: context.store,
      run: context.getRun(),
      root: context.root,
      tasks: [context.task]
    })

    const create = context.call.mock.calls.find(([method]) => method === 'worktree.create')?.[1]
    expect(create).toMatchObject({
      baseBranch: BASE_SHA,
      branchNameOverride: 'jaws/run-1234/patch/a1',
      clientMutationId: 'jaws-lane:run-12345678:patch:1'
    })
    expect(context.getRun().allocation?.items[0]).toMatchObject({
      materialization: 'created',
      attempt: 1
    })
  })

  it('fails closed when more than one worktree claims the same attempt', async () => {
    const duplicate = { ...laneWorktree(), id: 'lane-worktree-2' }
    const context = createContext([laneWorktree(), duplicate])

    await recoverCreatingHarnessLanes({
      runtime: context.runtime,
      store: context.store,
      run: context.getRun(),
      root: context.root,
      tasks: [context.task]
    })

    expect(context.call.mock.calls.filter(([method]) => method === 'worktree.create')).toHaveLength(
      0
    )
    expect(context.getRun().allocation?.items[0]).toMatchObject({
      materialization: 'failed',
      error: expect.stringContaining('multiple worktrees')
    })
  })

  it('keeps an unknown remote outcome recoverable after a listing error', async () => {
    const context = createContext([])
    context.call.mockRejectedValueOnce(new Error('SSH connection unavailable'))

    await recoverCreatingHarnessLanes({
      runtime: context.runtime,
      store: context.store,
      run: context.getRun(),
      root: context.root,
      tasks: [context.task]
    })

    expect(context.getRun().allocation?.items[0]).toMatchObject({
      materialization: 'creating',
      error: 'SSH connection unavailable'
    })
    expect(context.call.mock.calls.filter(([method]) => method === 'worktree.create')).toHaveLength(
      0
    )
  })
})
