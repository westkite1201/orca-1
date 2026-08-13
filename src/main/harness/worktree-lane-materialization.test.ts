import { describe, expect, it, vi } from 'vitest'
import {
  createHarnessAllocationState,
  type HarnessExecutionPlanV1
} from '../../shared/harness-allocation-types'
import type { HarnessCandidate, HarnessRun } from '../../shared/harness-types'
import type { RuntimeWorktreeCreateResult } from '../../shared/runtime-types'
import type { TaskRow } from '../runtime/orchestration/types'
import type { HarnessRuntimeCaller } from './runtime-caller'
import { materializeHarnessPlan } from './worktree-lane-materialization'

const BASE_SHA = '0123456789abcdef'
const PLAN: HarnessExecutionPlanV1 = {
  version: 1,
  revision: 1,
  planHash: 'plan-hash',
  maxConcurrency: 2,
  items: [
    {
      key: 'inspect',
      title: 'Inspect logs',
      objective: 'Find the relevant failure evidence.',
      execution: 'read-only',
      dependencies: [],
      fileScopes: ['docs'],
      acceptanceCriteria: ['Evidence is recorded.'],
      verificationCommands: ['git status --short']
    },
    {
      key: 'patch',
      title: 'Patch code',
      objective: 'Apply the isolated fix.',
      execution: 'worktree',
      dependencies: [],
      fileScopes: ['src/app'],
      acceptanceCriteria: ['The fix is covered.'],
      verificationCommands: ['pnpm test']
    }
  ]
}

function rootCandidate(): HarnessCandidate<'codex'> {
  return {
    id: 'root-candidate',
    agent: 'codex',
    status: 'running',
    worktreeId: 'integration-1',
    worktreePath: 'integration-root',
    branch: 'jaws-root',
    agentTerminalHandle: 'root-terminal',
    agentTerminalPaneKey: 'root-pane',
    verificationTerminalHandle: null,
    verificationTerminalPaneKey: null,
    verificationTerminalOwnership: null,
    orchestrationRunId: 'run-orchestration',
    taskId: 'root-task',
    dispatchId: 'root-dispatch',
    workerResult: null,
    verification: null,
    diff: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
    recoveryStartedAt: null,
    childLaneDrainStartedAt: null,
    workerCompletedAt: null,
    completedAt: null
  }
}

function createRun(): HarnessRun {
  return {
    id: 'run-12345678',
    mode: 'orchestrator',
    repoId: 'repo-1',
    sourceWorktreeId: 'source-1',
    sourceWorktreePath: 'source-root',
    goal: 'Implement the goal.',
    verificationCommand: 'pnpm test',
    baseSha: BASE_SHA,
    executionPlan: PLAN,
    allocation: createHarnessAllocationState(PLAN),
    candidates: [rootCandidate()],
    fatalError: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null
  }
}

describe('Harness lane materialization', () => {
  it('does not advance the durable integration boundary before task verification', async () => {
    const run = createRun()
    run.allocation!.integrationWorktreeId = 'integration-1'
    run.allocation!.integrationHeadSha = BASE_SHA
    const store = {
      getHarnessRun: () => run,
      updateHarnessAllocation: vi.fn()
    }
    const runtime = {
      call: vi.fn(async (method: string) => {
        if (method === 'git.status') {
          return { entries: [], conflictOperation: 'unknown', head: 'unverified-head' }
        }
        throw new Error(`unexpected RPC ${method}`)
      })
    } as unknown as HarnessRuntimeCaller

    await materializeHarnessPlan({ runtime, store, run })

    expect(store.updateHarnessAllocation).not.toHaveBeenCalled()
    expect(run.allocation!.integrationHeadSha).toBe(BASE_SHA)
  })

  it('creates approved tasks, allocates lanes, and dispatches each once', async () => {
    let run = createRun()
    const tasks: TaskRow[] = []
    let sequence = 0
    const calls: string[] = []
    const store = {
      getHarnessRun: () => run,
      updateHarnessAllocation: vi.fn((_runId, patch) => {
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
              ? allocation.items.map((item) =>
                  item.itemKey === patch.item?.itemKey ? { ...item, ...patch.item } : item
                )
              : allocation.items
          }
        }
        return run
      })
    }
    const runtime = {
      call: vi.fn(async (method: string, params?: unknown) => {
        calls.push(method)
        const input = params as Record<string, unknown> | undefined
        if (method === 'git.status') {
          return { entries: [], conflictOperation: 'unknown', head: BASE_SHA }
        }
        if (method === 'orchestration.taskList') {
          return { tasks }
        }
        if (method === 'orchestration.taskCreate') {
          const id = `task-${++sequence}`
          const deps = JSON.parse(String(input?.deps ?? '[]')) as string[]
          const task = {
            id,
            parent_id: 'root-task',
            created_by_terminal_handle: 'root-terminal',
            task_title: input?.taskTitle,
            display_name: null,
            execution_kind: input?.executionKind,
            agent_slot: 'codex',
            spec: input?.spec,
            status: deps.length === 0 ? 'ready' : 'pending',
            deps,
            result: null,
            completed_at: null
          } as unknown as TaskRow
          tasks.push(task)
          return { task }
        }
        if (method === 'terminal.create') {
          return { terminal: { handle: 'read-only-terminal', paneKey: 'read-only-pane' } }
        }
        if (method === 'terminal.wait') {
          return { wait: { satisfied: true, status: 'running' } }
        }
        if (method === 'worktree.create') {
          const context = input?.orchestrationContext as Record<string, unknown> | undefined
          const taskId = String(context?.taskId ?? '')
          return {
            worktree: {
              id: 'lane-worktree',
              repoId: 'repo-1',
              parentWorktreeId: 'integration-1',
              lineage: { origin: 'orchestration', taskId },
              createdWithAgent: 'codex'
            },
            agentTerminalHandle: 'worktree-terminal',
            startupTerminal: { handle: 'worktree-terminal', paneKey: 'worktree-pane' }
          } as unknown as RuntimeWorktreeCreateResult
        }
        if (method === 'orchestration.dispatch') {
          return { dispatch: { id: 'dispatch' }, injected: true }
        }
        throw new Error(`unexpected RPC ${method}`)
      })
    } as unknown as HarnessRuntimeCaller

    await materializeHarnessPlan({ runtime, store, run })

    expect(store.updateHarnessAllocation).toHaveBeenCalled()
    expect(tasks).toHaveLength(2)
    expect(calls.filter((method) => method === 'worktree.create')).toHaveLength(1)
    expect(calls.filter((method) => method === 'terminal.create')).toHaveLength(1)
    expect(calls.filter((method) => method === 'orchestration.dispatch')).toHaveLength(2)
    expect(run.allocation?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemKey: 'inspect',
          materialization: 'created',
          worktreeId: null
        }),
        expect.objectContaining({
          itemKey: 'patch',
          materialization: 'created',
          worktreeId: 'lane-worktree'
        })
      ])
    )
  })
})
