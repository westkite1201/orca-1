import { describe, expect, it, vi } from 'vitest'
import type { HarnessRun } from '../../shared/harness-types'
import type { JawsPlanningRun, JawsRun } from '../../shared/jaws-types'
import type { HarnessService } from '../harness/service'
import { LinearAgentAccessError } from '../linear/issue-context-errors'
import type { JawsResultLinearClient, JawsReviewClient } from './review-publication'
import { jawsPlannerReplySchema } from './planner-contract'
import { JawsService, type JawsPlanner, type JawsStore } from './service'

const RUN_ID = '11111111-1111-4111-8111-111111111111'
const HARNESS_RUN_ID = '22222222-2222-4222-8222-222222222222'
const PLAN_HASH = 'a'.repeat(64)
const PLANNING_ID = '33333333-3333-4333-8333-333333333333'
const CLIENT_REQUEST_ID = '44444444-4444-4444-8444-444444444444'

function jawsRun(): JawsRun {
  return {
    id: RUN_ID,
    repoId: 'repo-1',
    sourceWorktreeId: 'repo-1::/repo',
    sourceWorktreePath: '/repo',
    baseSha: 'b'.repeat(40),
    revision: 1,
    planHash: PLAN_HASH,
    plan: {
      goal: 'Implement the feature',
      verificationCommand: 'pnpm test',
      maxConcurrency: 2,
      tasks: [
        {
          key: 'API',
          title: 'Build API',
          objective: 'Implement API',
          dependsOn: [],
          execution: 'worktree',
          fileScopes: ['src/main/api'],
          acceptanceCriteria: ['API behavior is implemented.'],
          verificationCommands: ['pnpm test src/main/api']
        },
        {
          key: 'UI',
          title: 'Build UI',
          objective: 'Implement UI',
          dependsOn: ['API'],
          execution: 'worktree',
          fileScopes: ['src/renderer/src'],
          acceptanceCriteria: ['UI behavior is implemented.'],
          verificationCommands: ['pnpm test src/renderer/src']
        }
      ]
    },
    approvalStartedAt: null,
    harnessRunId: null,
    error: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function harnessRun(run: JawsRun): HarnessRun {
  return {
    id: HARNESS_RUN_ID,
    mode: 'orchestrator',
    repoId: run.repoId,
    sourceWorktreeId: run.sourceWorktreeId,
    sourceWorktreePath: run.sourceWorktreePath,
    goal: run.plan.goal,
    verificationCommand: run.plan.verificationCommand,
    baseSha: run.baseSha,
    jawsRunId: run.id,
    approvedPlan: run.plan,
    candidates: [],
    fatalError: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null
  }
}

function serviceFixture(
  initialRun: JawsRun = jawsRun(),
  linearClient: JawsResultLinearClient | null = null,
  reviewClient: JawsReviewClient | null = null,
  planner: JawsPlanner | null = null
) {
  let run = initialRun
  let planningRun: JawsPlanningRun | null = null
  let createdHarness: HarnessRun | null = null
  const store = {
    listJawsPlanningRuns: vi.fn((filters?: { sourceWorktreeId?: string }) =>
      planningRun &&
      (!filters?.sourceWorktreeId || filters.sourceWorktreeId === planningRun.sourceWorktreeId)
        ? [planningRun]
        : []
    ),
    getJawsPlanningRun: vi.fn(() => planningRun),
    createJawsPlanningRun: vi.fn((input) => {
      planningRun = {
        id: PLANNING_ID,
        ...input,
        status: 'queued',
        question: null,
        jawsRunId: null,
        error: null,
        logs: [],
        createdAt: 1,
        updatedAt: 1
      }
      return planningRun
    }),
    updateJawsPlanningRun: vi.fn((_runId, patch) => {
      planningRun = { ...planningRun!, ...patch, updatedAt: planningRun!.updatedAt + 1 }
      return planningRun
    }),
    listJawsRuns: vi.fn(() => [run]),
    getJawsRun: vi.fn(() => run),
    saveJawsPlan: vi.fn((input) => {
      run = { ...run, ...input, revision: run.revision + 1, updatedAt: run.updatedAt + 1 }
      return run
    }),
    markJawsApprovalStarted: vi.fn(() => {
      run = { ...run, approvalStartedAt: 2 }
      return run
    }),
    updateJawsLinearMaterialization: vi.fn((_runId, materialization) => {
      run = { ...run, linearMaterialization: materialization }
      return run
    }),
    attachJawsHarnessRun: vi.fn((_runId: string, harnessRunId: string) => {
      run = { ...run, harnessRunId, error: null }
      return run
    }),
    failJawsApproval: vi.fn()
  } as unknown as JawsStore
  const harness = {
    preflight: vi.fn(async () => ({
      source: {
        id: run.sourceWorktreeId,
        repoId: run.repoId,
        git: { path: run.sourceWorktreePath }
      },
      baseSha: run.baseSha
    })),
    list: vi.fn(() => (createdHarness ? [createdHarness] : [])),
    show: vi.fn(() => {
      if (!createdHarness) {
        throw new Error('missing')
      }
      return createdHarness
    }),
    start: vi.fn(async (_input: unknown) => {
      createdHarness = harnessRun(run)
      return createdHarness
    })
  }
  return {
    service: new JawsService(
      store,
      harness as unknown as HarnessService,
      linearClient,
      reviewClient,
      planner
    ),
    harness,
    store
  }
}

describe('Jaws native planning', () => {
  it('persists a structured planner result as an approval-ready run', async () => {
    const planner: JawsPlanner = async (input) => {
      input.onLog?.({ stream: 'stdout', message: 'Inspecting: git status --short' })
      input.onLog?.({ stream: 'stderr', message: 'refresh_token=secret-value' })
      return {
        success: true,
        reply: jawsPlannerReplySchema.parse({ kind: 'plan', plan: jawsRun().plan }),
        lastMessage: '{}',
        stdout: '',
        stderr: ''
      }
    }
    const { service } = serviceFixture(jawsRun(), null, null, planner)

    const started = await service.startPlanning({
      goal: 'Implement the feature',
      worktreeSelector: `id:${jawsRun().sourceWorktreeId}`,
      clientRequestId: CLIENT_REQUEST_ID
    })

    expect(started.status).toBe('planning')
    await vi.waitFor(() =>
      expect(service.showPlanning({ planningId: PLANNING_ID }).status).toBe('proposed')
    )
    expect(service.showPlanning({ planningId: PLANNING_ID })).toMatchObject({
      jawsRunId: RUN_ID,
      logs: expect.arrayContaining([
        expect.objectContaining({ stream: 'stdout', message: 'Inspecting: git status --short' }),
        expect.objectContaining({ stream: 'stderr', message: 'refresh_token=[redacted]' }),
        expect.objectContaining({ stream: 'system', message: 'Plan ready for review.' })
      ])
    })
  })

  it('keeps a planner clarification typed and side-effect free', async () => {
    const planner: JawsPlanner = async () => ({
      success: true,
      reply: { kind: 'question', question: 'Which API should own retries?' },
      lastMessage: '{}',
      stdout: '',
      stderr: ''
    })
    const { service, store } = serviceFixture(jawsRun(), null, null, planner)

    await service.startPlanning({
      goal: 'Add retries',
      worktreeSelector: `id:${jawsRun().sourceWorktreeId}`,
      clientRequestId: CLIENT_REQUEST_ID
    })

    await vi.waitFor(() =>
      expect(service.showPlanning({ planningId: PLANNING_ID })).toMatchObject({
        status: 'needs_input',
        question: 'Which API should own retries?'
      })
    )
    expect(store.saveJawsPlan).not.toHaveBeenCalled()
    await expect(
      service.startPlanning({
        goal: 'Add retries with the API owner clarified',
        worktreeSelector: `id:${jawsRun().sourceWorktreeId}`,
        clientRequestId: '55555555-5555-4555-8555-555555555555'
      })
    ).rejects.toThrow('already being prepared')
    expect(service.cancelPlanning({ planningId: PLANNING_ID })).toMatchObject({
      status: 'canceled'
    })
  })

  it('removes internal runtime details from Linear clarification questions', async () => {
    const planner: JawsPlanner = async () => ({
      success: true,
      reply: {
        kind: 'question',
        question:
          '현재 Linear 이슈의 식별자·제목·설명·의존관계를 붙여주시겠어요? Orca 런타임이 꺼져 있고 네트워크도 차단되어 이슈를 조회할 수 없습니다.'
      },
      lastMessage: '{}',
      stdout: '',
      stderr: ''
    })
    const { service } = serviceFixture(jawsRun(), null, null, planner)

    await service.startPlanning({
      goal: '현재 있는 Linear 이슈를 병렬 레인으로 구성해줘',
      worktreeSelector: `id:${jawsRun().sourceWorktreeId}`,
      clientRequestId: CLIENT_REQUEST_ID
    })

    await vi.waitFor(() =>
      expect(service.showPlanning({ planningId: PLANNING_ID })).toMatchObject({
        status: 'needs_input',
        question:
          'Linear 이슈 정보를 확인할 수 없어요. 이슈 ID를 붙여 넣거나 Linear 연결 후 다시 시도해 주세요.'
      })
    )
  })

  it('does not persist a proposal when cancel wins during source revalidation', async () => {
    const planner: JawsPlanner = async () => ({
      success: true,
      reply: jawsPlannerReplySchema.parse({ kind: 'plan', plan: jawsRun().plan }),
      lastMessage: '{}',
      stdout: '',
      stderr: ''
    })
    const { service, store, harness } = serviceFixture(jawsRun(), null, null, planner)
    let preflightCalls = 0
    let releaseRevalidation!: () => void
    const revalidation = new Promise<void>((resolve) => {
      releaseRevalidation = resolve
    })
    vi.mocked(harness.preflight).mockImplementation(async () => {
      preflightCalls += 1
      if (preflightCalls === 2) {
        await revalidation
      }
      return {
        source: {
          id: jawsRun().sourceWorktreeId,
          repoId: jawsRun().repoId,
          git: { path: jawsRun().sourceWorktreePath }
        },
        baseSha: jawsRun().baseSha
      }
    })

    await service.startPlanning({
      goal: 'Implement the feature',
      worktreeSelector: `id:${jawsRun().sourceWorktreeId}`,
      clientRequestId: CLIENT_REQUEST_ID
    })
    await vi.waitFor(() => expect(preflightCalls).toBe(2))
    await service.cancelPlanning({ planningId: PLANNING_ID })
    releaseRevalidation()

    await vi.waitFor(() =>
      expect(service.showPlanning({ planningId: PLANNING_ID }).status).toBe('canceled')
    )
    expect(store.saveJawsPlan).not.toHaveBeenCalled()
  })
})

describe('Jaws approval', () => {
  it('starts one correlated Harness run for duplicate approval clicks', async () => {
    const { service, harness, store } = serviceFixture()
    const approval = { runId: RUN_ID, revision: 1, planHash: PLAN_HASH }

    const [first, second] = await Promise.all([
      service.approve(approval),
      service.approve(approval)
    ])

    expect(harness.start).toHaveBeenCalledTimes(1)
    expect(harness.start).toHaveBeenCalledWith(
      expect.objectContaining({
        worktree: 'id:repo-1::/repo',
        mode: 'orchestrator',
        expectedBaseSha: 'b'.repeat(40),
        jawsRunId: RUN_ID,
        executionPlan: expect.objectContaining({ planHash: PLAN_HASH })
      })
    )
    expect(vi.mocked(store.markJawsApprovalStarted).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(store.attachJawsHarnessRun).mock.invocationCallOrder[0]
    )
    expect(first.harnessRunId).toBe(HARNESS_RUN_ID)
    expect(second.harnessRunId).toBe(HARNESS_RUN_ID)
  })

  it('keeps legacy plans on the coordinator-owned path', async () => {
    const legacy = jawsRun()
    legacy.plan.tasks = legacy.plan.tasks.map(({ key, title, objective, dependsOn }) => ({
      key,
      title,
      objective,
      dependsOn
    }))
    const { service, harness } = serviceFixture(legacy)

    await service.approve({ runId: RUN_ID, revision: 1, planHash: PLAN_HASH })

    expect(harness.start).toHaveBeenCalledOnce()
    expect(vi.mocked(harness.start).mock.calls[0]?.[0]).not.toHaveProperty('executionPlan')
  })

  it('rejects a stale card before starting Harness', async () => {
    const { service, harness } = serviceFixture()

    await expect(
      service.approve({ runId: RUN_ID, revision: 2, planHash: PLAN_HASH })
    ).rejects.toThrow('plan changed')
    expect(harness.start).not.toHaveBeenCalled()
  })

  it('rejects a stale card while the current approval is starting', async () => {
    const { service, harness } = serviceFixture()
    let releaseStart: ((run: HarnessRun) => void) | undefined
    vi.mocked(harness.start).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseStart = resolve
        })
    )

    const current = service.approve({ runId: RUN_ID, revision: 1, planHash: PLAN_HASH })
    await expect(
      service.approve({ runId: RUN_ID, revision: 2, planHash: PLAN_HASH })
    ).rejects.toThrow('plan changed')
    const resolved = harnessRun(jawsRun())
    vi.mocked(harness.list).mockReturnValue([resolved])
    releaseStart?.(resolved)
    await current

    expect(harness.start).toHaveBeenCalledTimes(1)
  })

  it('durably reconnects a Harness run created before a restart', async () => {
    const { service, harness, store } = serviceFixture()
    vi.mocked(harness.list).mockReturnValue([harnessRun(jawsRun())])

    const view = await service.show(RUN_ID)

    expect(store.attachJawsHarnessRun).toHaveBeenCalledWith(RUN_ID, HARNESS_RUN_ID)
    expect(view.harnessRunId).toBe(HARNESS_RUN_ID)
    expect(view.status).toBe('verified')
  })

  it('does not replace an approval interrupted before Harness creation', async () => {
    const { service, harness, store } = serviceFixture()
    const starting = { ...jawsRun(), approvalStartedAt: 2 }
    vi.mocked(store.listJawsRuns).mockReturnValue([starting])
    vi.mocked(store.getJawsRun).mockReturnValue(starting)

    await expect(
      service.propose({ worktree: 'id:repo-1::/repo', plan: starting.plan })
    ).rejects.toThrow('still starting')

    expect(harness.preflight).toHaveBeenCalled()
    expect(store.saveJawsPlan).not.toHaveBeenCalled()
  })

  it('keeps run list and show read-only when review publication is pending', async () => {
    const run = jawsRun()
    run.plan.review = { provider: 'github', baseBranch: 'main', createDraft: true }
    run.reviewPublication = {
      status: 'planned',
      provider: 'github',
      baseBranch: 'main',
      headBranch: null,
      headSha: null,
      review: null,
      manualUrl: null,
      effects: [],
      error: null,
      updatedAt: 1
    }
    const reviewClient = { push: vi.fn() } as unknown as JawsReviewClient
    const { service } = serviceFixture(run, null, reviewClient)

    service.list()
    await service.show(RUN_ID)

    expect(reviewClient.push).not.toHaveBeenCalled()
  })

  it('does not re-execute an approval whose Harness history is gone', async () => {
    const { service, harness, store } = serviceFixture()
    const consumed = {
      ...jawsRun(),
      approvalStartedAt: 2,
      harnessRunId: HARNESS_RUN_ID
    }
    vi.mocked(store.getJawsRun).mockReturnValue(consumed)

    await expect(
      service.approve({ runId: RUN_ID, revision: 1, planHash: PLAN_HASH })
    ).rejects.toThrow('no longer available')

    expect(store.failJawsApproval).toHaveBeenCalled()
    expect(harness.start).not.toHaveBeenCalled()
  })

  it('does not start Harness when Linear creation is unconfirmed', async () => {
    const run = jawsRun()
    run.plan.linear = {
      workspaceId: 'workspace-1',
      team: 'WES',
      project: null,
      rootIssue: {
        kind: 'create',
        title: 'Root',
        description: 'Approved root'
      }
    }
    run.linearMaterialization = {
      status: 'planned',
      rootIssue: null,
      items: run.plan.tasks.map((task) => ({ key: task.key, issue: null })),
      effects: [
        {
          key: 'root',
          kind: 'root_create',
          writeId: '33333333-3333-4333-8333-333333333333',
          state: 'planned',
          remoteId: null,
          error: null,
          updatedAt: 1
        },
        ...run.plan.tasks.map((task) => ({
          key: `child:${task.key}`,
          kind: 'child_create' as const,
          writeId:
            task.key === 'API'
              ? '44444444-4444-4444-8444-444444444444'
              : '55555555-5555-4555-8555-555555555555',
          state: 'planned' as const,
          remoteId: null,
          error: null,
          updatedAt: 1
        })),
        {
          key: 'relation:API:UI',
          kind: 'relation',
          writeId: null,
          state: 'planned',
          remoteId: null,
          error: null,
          updatedAt: 1
        }
      ],
      error: null,
      updatedAt: 1
    }
    const linearClient = {
      createIssue: vi.fn(async () => {
        throw new LinearAgentAccessError(
          'linear_write_unconfirmed',
          'Linear may have created the root issue.'
        )
      }),
      readIssue: vi.fn(),
      writeRelation: vi.fn()
    } as unknown as JawsResultLinearClient
    const { service, harness, store } = serviceFixture(run, linearClient)

    await expect(
      service.approve({ runId: RUN_ID, revision: 1, planHash: PLAN_HASH })
    ).rejects.toMatchObject({ code: 'linear_write_unconfirmed' })

    expect(harness.start).not.toHaveBeenCalled()
    expect(vi.mocked(store.updateJawsLinearMaterialization)).toHaveBeenLastCalledWith(
      RUN_ID,
      expect.objectContaining({ status: 'unknown' })
    )
  })
})
