import { describe, expect, it, vi } from 'vitest'
import {
  createHarnessAllocationState,
  type HarnessAllocationPatchV1,
  type HarnessExecutionPlanV1
} from '../../shared/harness-allocation-types'
import type { HarnessRun } from '../../shared/harness-types'
import type { GitBranchCompareResult, GitDiffResult } from '../../shared/types'
import type { TaskRow } from '../runtime/orchestration/types'
import { verifyHarnessReportedLane } from './lane-integration-evidence'
import type { HarnessRuntimeCaller } from './runtime-caller'
import type { AllocationStore } from './worktree-lane-receipt-state'

const BASE_SHA = 'a'.repeat(40)
const WORKER_SHA = 'b'.repeat(40)
const INTEGRATION_SHA = 'c'.repeat(40)
const PLAN: HarnessExecutionPlanV1 = {
  version: 1,
  revision: 1,
  planHash: 'approved-plan',
  maxConcurrency: 2,
  items: [
    {
      key: 'patch',
      title: 'Patch runtime',
      objective: 'Apply the approved runtime change.',
      execution: 'worktree',
      dependencies: [],
      fileScopes: ['src/main'],
      acceptanceCriteria: ['The runtime is covered.'],
      verificationCommands: ['pnpm test lane']
    }
  ]
}

function createRun(execution: 'read-only' | 'worktree' = 'worktree'): HarnessRun {
  const plan: HarnessExecutionPlanV1 = {
    ...PLAN,
    items: PLAN.items.map((item) => ({ ...item, execution }))
  }
  const allocation = createHarnessAllocationState(plan)
  allocation.integrationWorktreeId = 'integration-worktree'
  allocation.integrationHeadSha = BASE_SHA
  Object.assign(allocation.items[0], {
    taskId: 'task-patch',
    materialization: 'created',
    attempt: 1,
    baseSha: BASE_SHA,
    worktreeId: execution === 'worktree' ? 'worker-worktree' : null,
    terminalPaneKey: 'worker-pane'
  })
  return {
    id: 'harness-run',
    mode: 'orchestrator',
    repoId: 'repo',
    sourceWorktreeId: 'source',
    sourceWorktreePath: 'source-root',
    goal: 'Patch runtime.',
    verificationCommand: 'pnpm test',
    baseSha: BASE_SHA,
    executionPlan: plan,
    allocation,
    candidates: [],
    fatalError: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null
  }
}

function reportedTask(commitSha: string | null = WORKER_SHA): TaskRow {
  return {
    id: 'task-patch',
    run_id: 'orchestration-run',
    parent_id: 'root-task',
    created_by_terminal_handle: 'coordinator',
    task_title: 'Patch runtime',
    display_name: null,
    verification_required: 1,
    spec: 'Patch runtime.',
    status: 'reported',
    deps: '[]',
    result: JSON.stringify({
      provenance: 'worker_report',
      outcome: 'succeeded',
      taskId: 'task-patch',
      ...(commitSha ? { commitSha, filesModified: ['src/main/runtime.ts'] } : {})
    }),
    created_at: '2026-08-13 00:00:00',
    completed_at: null
  }
}

function compare(headOid: string): GitBranchCompareResult {
  return {
    summary: {
      baseRef: BASE_SHA,
      baseOid: BASE_SHA,
      compareRef: 'HEAD',
      headOid,
      mergeBase: BASE_SHA,
      changedFiles: 1,
      commitsAhead: 1,
      status: 'ready'
    },
    entries: [{ path: 'src/main/runtime.ts', status: 'modified', added: 1, removed: 1 }]
  }
}

function createFixture(
  integrationContent = 'new',
  checkExitCode = 0,
  execution: 'read-only' | 'worktree' = 'worktree',
  integrationHead = INTEGRATION_SHA,
  workerContent = 'new',
  postCheckWorkerHead = WORKER_SHA
): {
  runtime: HarnessRuntimeCaller
  store: AllocationStore
  getRun: () => HarnessRun
} {
  let run = createRun(execution)
  let workerStatusReads = 0
  const store = {
    getHarnessRun: () => run,
    updateHarnessAllocation: vi.fn((_runId: string, patch: HarnessAllocationPatchV1) => {
      const allocation = run.allocation!
      run = {
        ...run,
        allocation: {
          ...allocation,
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
      const input = params as { worktree?: string }
      if (method === 'git.status') {
        const workerHead = workerStatusReads++ === 0 ? WORKER_SHA : postCheckWorkerHead
        return {
          head: input.worktree === 'id:worker-worktree' ? workerHead : integrationHead,
          entries: [],
          conflictOperation: 'unknown'
        }
      }
      if (method === 'git.branchCompare') {
        return compare(input.worktree === 'id:worker-worktree' ? WORKER_SHA : integrationHead)
      }
      if (method === 'git.branchDiff') {
        return {
          kind: 'text',
          originalContent: workerContent === '' && integrationContent === '' ? '' : 'old',
          modifiedContent:
            input.worktree === 'id:worker-worktree' ? workerContent : integrationContent,
          originalIsBinary: false,
          modifiedIsBinary: false
        } satisfies GitDiffResult
      }
      throw new Error(`Unexpected RPC: ${method}`)
    }),
    runVerification: vi.fn(async () => ({
      command: 'pnpm test lane',
      exitCode: checkExitCode,
      timedOut: false,
      durationMs: 5,
      stdout: 'passed',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      error: null,
      startedAt: 1,
      completedAt: 6
    }))
  } as unknown as HarnessRuntimeCaller
  return { runtime, store, getRun: () => run }
}

describe('Harness lane integration evidence', () => {
  it('persists verified worker and integration evidence before dependency release', async () => {
    const fixture = createFixture()
    const evidence = await verifyHarnessReportedLane({
      runtime: fixture.runtime,
      store: fixture.store,
      run: fixture.getRun(),
      task: reportedTask(),
      coordinatorEvidence: 'cherry-pick completed',
      timeoutSeconds: 30
    })

    expect(JSON.parse(evidence)).toMatchObject({
      provenance: 'harness_runtime_verification',
      workerBaseSha: BASE_SHA,
      workerHeadSha: WORKER_SHA,
      integrationBaseSha: BASE_SHA,
      integrationHeadSha: INTEGRATION_SHA,
      changedFiles: ['src/main/runtime.ts'],
      checks: [{ command: 'pnpm test lane', exitCode: 0 }]
    })
    expect(fixture.getRun().allocation).toMatchObject({
      integrationHeadSha: INTEGRATION_SHA,
      items: [
        expect.objectContaining({
          integration: 'integrated',
          reportedCommitSha: WORKER_SHA,
          integratedHeadSha: INTEGRATION_SHA,
          integrationEvidence: expect.objectContaining({ workerHeadSha: WORKER_SHA })
        })
      ]
    })
  })

  it('does not release a worker whose integrated content differs', async () => {
    const fixture = createFixture('different')

    await expect(
      verifyHarnessReportedLane({
        runtime: fixture.runtime,
        store: fixture.store,
        run: fixture.getRun(),
        task: reportedTask(),
        coordinatorEvidence: 'looks integrated',
        timeoutSeconds: 30
      })
    ).rejects.toThrow('Integrated content does not match')
    expect(fixture.getRun().allocation?.integrationHeadSha).toBe(BASE_SHA)
    expect(fixture.getRun().allocation?.items[0]).toMatchObject({
      integration: 'failed',
      integrationEvidence: null
    })
  })

  it('does not advance the integration boundary when a narrow check fails', async () => {
    const fixture = createFixture('new', 1)

    await expect(
      verifyHarnessReportedLane({
        runtime: fixture.runtime,
        store: fixture.store,
        run: fixture.getRun(),
        task: reportedTask(),
        coordinatorEvidence: 'integrated',
        timeoutSeconds: 30
      })
    ).rejects.toThrow('Lane verification failed')
    expect(fixture.getRun().allocation?.integrationHeadSha).toBe(BASE_SHA)
    expect(fixture.getRun().allocation?.items[0].integration).toBe('failed')
  })

  it('rejects evidence when the worker HEAD changes during verification', async () => {
    const fixture = createFixture('new', 0, 'worktree', INTEGRATION_SHA, 'new', 'd'.repeat(40))

    await expect(
      verifyHarnessReportedLane({
        runtime: fixture.runtime,
        store: fixture.store,
        run: fixture.getRun(),
        task: reportedTask(),
        coordinatorEvidence: 'integrated',
        timeoutSeconds: 30
      })
    ).rejects.toThrow('Worker HEAD changed during lane verification')
    expect(fixture.getRun().allocation?.integrationHeadSha).toBe(BASE_SHA)
  })

  it('rejects a read-only report after the integration HEAD changes', async () => {
    const fixture = createFixture('new', 0, 'read-only')

    await expect(
      verifyHarnessReportedLane({
        runtime: fixture.runtime,
        store: fixture.store,
        run: fixture.getRun(),
        task: reportedTask(null),
        coordinatorEvidence: 'read-only inspection complete',
        timeoutSeconds: 30
      })
    ).rejects.toThrow('Read-only lane changed the integration HEAD')
    expect(fixture.getRun().allocation?.items[0].integration).toBe('not-required')
  })

  it('fails closed when Git cannot return modified-file content', async () => {
    const fixture = createFixture('', 0, 'worktree', INTEGRATION_SHA, '')

    await expect(
      verifyHarnessReportedLane({
        runtime: fixture.runtime,
        store: fixture.store,
        run: fixture.getRun(),
        task: reportedTask(),
        coordinatorEvidence: 'integrated',
        timeoutSeconds: 30
      })
    ).rejects.toThrow('Git content evidence is unavailable')
    expect(fixture.getRun().allocation?.integrationHeadSha).toBe(BASE_SHA)
  })
})
