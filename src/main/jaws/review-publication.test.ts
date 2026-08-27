import { describe, expect, it, vi } from 'vitest'
import type { HarnessCandidate } from '../../shared/harness-types'
import type { JawsReviewPublication, JawsRun } from '../../shared/jaws-types'
import {
  publishJawsReview,
  type JawsResultLinearClient,
  type JawsReviewClient,
  type JawsReviewStore
} from './review-publication'

const HEAD_SHA = 'd'.repeat(40)
const COMMIT_SHA = 'c'.repeat(40)

function publication(withLinear = false): JawsReviewPublication {
  const effects: [string, JawsReviewPublication['effects'][number]['kind'], string | null][] = [
    ['push', 'push', null],
    ['create', 'create', null],
    ...(withLinear
      ? ([
          ['linear:root:attachment', 'root_attachment', '11111111-1111-4111-8111-111111111111'],
          ['linear:root:comment', 'root_comment', '22222222-2222-4222-8222-222222222222'],
          ['linear:child:API:state', 'child_state', null]
        ] as [string, JawsReviewPublication['effects'][number]['kind'], string | null][])
      : [])
  ]
  return {
    status: 'planned',
    provider: 'github',
    baseBranch: 'main',
    headBranch: null,
    headSha: null,
    review: null,
    manualUrl: null,
    effects: effects.map(([key, kind, writeId]) => ({
      key,
      kind,
      writeId,
      state: 'planned' as const,
      remoteId: null,
      error: null,
      updatedAt: 1
    })),
    error: null,
    updatedAt: 1
  }
}

function runFixture(withLinear = false): JawsRun {
  const run: JawsRun = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    repoId: 'repo-1',
    sourceWorktreeId: 'source-1',
    sourceWorktreePath: '/repo',
    baseSha: 'b'.repeat(40),
    revision: 1,
    planHash: 'e'.repeat(64),
    plan: {
      goal: 'Implement API',
      verificationCommand: 'pnpm test',
      maxConcurrency: 1,
      tasks: [{ key: 'API', title: 'Build API', objective: 'Build it', dependsOn: [] }],
      review: { provider: 'github', baseBranch: 'main', createDraft: true }
    },
    reviewPublication: publication(withLinear),
    approvalStartedAt: 1,
    harnessRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    error: null,
    createdAt: 1,
    updatedAt: 1
  }
  if (withLinear) {
    run.plan.linear = {
      workspaceId: 'workspace-1',
      team: 'TEAM',
      project: null,
      rootIssue: { kind: 'create', title: 'Root', description: 'Root issue' }
    }
    run.linearMaterialization = {
      status: 'confirmed',
      rootIssue: {
        id: '33333333-3333-4333-8333-333333333333',
        identifier: 'TEAM-1',
        title: 'Root',
        url: 'https://linear.app/team/issue/TEAM-1',
        stateId: 'state-started',
        parentId: null
      },
      items: [
        {
          key: 'API',
          issue: {
            id: '44444444-4444-4444-8444-444444444444',
            identifier: 'TEAM-2',
            title: 'Build API',
            url: 'https://linear.app/team/issue/TEAM-2',
            stateId: 'state-started',
            parentId: '33333333-3333-4333-8333-333333333333'
          }
        }
      ],
      effects: [
        {
          key: 'root',
          kind: 'root_create',
          writeId: '55555555-5555-4555-8555-555555555555',
          state: 'confirmed',
          remoteId: '33333333-3333-4333-8333-333333333333',
          error: null,
          updatedAt: 1
        },
        {
          key: 'child:API',
          kind: 'child_create',
          writeId: '66666666-6666-4666-8666-666666666666',
          state: 'confirmed',
          remoteId: '44444444-4444-4444-8444-444444444444',
          error: null,
          updatedAt: 1
        }
      ],
      error: null,
      updatedAt: 1
    }
  }
  return run
}

function candidateFixture(): HarnessCandidate {
  return {
    id: 'candidate-1',
    agent: 'codex',
    status: 'verified',
    worktreeId: 'integration-1',
    worktreePath: '/repo/integration',
    branch: 'jaws/run-1',
    agentTerminalHandle: null,
    agentTerminalPaneKey: null,
    verificationTerminalHandle: null,
    verificationTerminalPaneKey: null,
    verificationTerminalOwnership: 'stopped',
    orchestrationRunId: 'run-1',
    taskId: 'task-parent',
    dispatchId: 'dispatch-parent',
    workerResult: {
      messageId: 'message-parent',
      subject: 'Done',
      body: 'Integrated',
      payload: null,
      receivedAt: 2
    },
    verification: {
      command: 'pnpm test',
      exitCode: 0,
      timedOut: false,
      durationMs: 100,
      outputTail: 'ok',
      outputTruncated: false,
      error: null,
      startedAt: 4,
      completedAt: 5
    },
    diff: {
      headSha: HEAD_SHA,
      diffStat: '1 file changed',
      changedFiles: [{ path: 'src/api.ts', status: 'modified' }],
      untrackedPaths: [],
      capturedAt: 5,
      error: null
    },
    error: null,
    createdAt: 1,
    updatedAt: 5,
    startedAt: 1,
    recoveryStartedAt: null,
    childLaneDrainStartedAt: null,
    workerCompletedAt: 3,
    completedAt: 5
  }
}

function fixture(withLinear = false) {
  let run = runFixture(withLinear)
  const store: JawsReviewStore = {
    updateJawsReviewPublication: vi.fn((_runId, next) => {
      run = { ...run, reviewPublication: structuredClone(next) }
      return run
    }),
    updateJawsLinearMaterialization: vi.fn((_runId, next) => {
      run = { ...run, linearMaterialization: structuredClone(next) }
      return run
    })
  }
  const reviewClient: JawsReviewClient = {
    getStatus: vi.fn(async () => ({
      entries: [],
      conflictOperation: 'unknown' as const,
      head: HEAD_SHA,
      branch: 'jaws/run-1'
    })),
    compare: vi.fn(async () => ({
      summary: {
        baseRef: COMMIT_SHA,
        baseOid: COMMIT_SHA,
        compareRef: 'HEAD',
        headOid: HEAD_SHA,
        mergeBase: COMMIT_SHA,
        changedFiles: 1,
        status: 'ready' as const
      },
      entries: [{ path: 'src/api.ts', status: 'modified' as const }]
    })),
    listTasks: vi.fn(() => [
      {
        id: 'task-api',
        run_id: 'run-1',
        parent_id: 'task-parent',
        created_by_terminal_handle: null,
        created_by_pane_key: null,
        created_by_process_incarnation: null,
        created_by_run_generation: null,
        task_title: '[Jaws:API] Build API',
        display_name: null,
        verification_required: 1,
        spec: 'Build it',
        status: 'completed' as const,
        deps: '[]',
        result: JSON.stringify({
          provenance: 'worker_report',
          outcome: 'succeeded',
          commitSha: COMMIT_SHA
        }),
        created_at: '2026-01-01',
        completed_at: '2026-01-01'
      }
    ]),
    getUpstreamStatus: vi
      .fn()
      .mockResolvedValueOnce({ hasUpstream: false, ahead: 0, behind: 0 })
      .mockResolvedValue({
        hasUpstream: true,
        upstreamName: 'origin/jaws/run-1',
        ahead: 0,
        behind: 0
      }),
    push: vi.fn(async () => undefined),
    findReview: vi.fn(async () => null),
    createReview: vi.fn(async () => ({
      ok: true as const,
      number: 7,
      url: 'https://example.com/reviews/7'
    })),
    getManualUrl: vi.fn(async () => 'https://example.com/commit/head')
  }
  return { getRun: () => run, store, reviewClient }
}

describe('Jaws review publication', () => {
  it('pushes only after exact verification and commit evidence, then creates one draft review', async () => {
    const { getRun, store, reviewClient } = fixture()

    const result = await publishJawsReview({
      run: getRun(),
      candidate: candidateFixture(),
      store,
      reviewClient,
      linearClient: null
    })

    expect(reviewClient.push).toHaveBeenCalledOnce()
    expect(reviewClient.createReview).toHaveBeenCalledOnce()
    expect(reviewClient.createReview).toHaveBeenCalledWith(
      'repo-1',
      'integration-1',
      expect.objectContaining({ draft: true, base: 'main', head: 'jaws/run-1' })
    )
    expect(result.reviewPublication?.status).toBe('review_ready')
  })

  it('does not push or create a review when verification timed out', async () => {
    const { getRun, store, reviewClient } = fixture()
    const candidate = candidateFixture()
    candidate.verification = { ...candidate.verification!, timedOut: true }

    const result = await publishJawsReview({
      run: getRun(),
      candidate,
      store,
      reviewClient,
      linearClient: null
    })

    expect(reviewClient.push).not.toHaveBeenCalled()
    expect(reviewClient.createReview).not.toHaveBeenCalled()
    expect(result.reviewPublication?.status).toBe('failed')
  })

  it('reads back a review after a lost create response without creating a duplicate', async () => {
    const { getRun, store, reviewClient } = fixture()
    vi.mocked(reviewClient.createReview).mockResolvedValueOnce({
      ok: false,
      code: 'unknown_completion',
      error: 'response lost'
    })
    vi.mocked(reviewClient.findReview).mockResolvedValueOnce(null).mockResolvedValueOnce({
      provider: 'github',
      number: 7,
      title: 'Implement API',
      state: 'draft',
      url: 'https://example.com/reviews/7',
      status: 'neutral',
      updatedAt: '2026-01-01',
      mergeable: 'UNKNOWN'
    })

    const result = await publishJawsReview({
      run: getRun(),
      candidate: candidateFixture(),
      store,
      reviewClient,
      linearClient: null
    })

    expect(reviewClient.createReview).toHaveBeenCalledOnce()
    expect(reviewClient.findReview).toHaveBeenCalledTimes(2)
    expect(result.reviewPublication?.review?.number).toBe(7)
  })

  it('keeps the verified result and exposes a manual action for unsupported providers', async () => {
    const { getRun, store, reviewClient } = fixture()
    getRun().plan.review = { provider: 'unsupported', baseBranch: 'main', createDraft: true }
    getRun().reviewPublication!.provider = 'unsupported'

    const result = await publishJawsReview({
      run: getRun(),
      candidate: candidateFixture(),
      store,
      reviewClient,
      linearClient: null
    })

    expect(reviewClient.createReview).not.toHaveBeenCalled()
    expect(result.reviewPublication).toMatchObject({
      status: 'manual',
      manualUrl: 'https://example.com/commit/head'
    })
  })

  it('publishes Linear evidence and completes a child only with matching task and commit evidence', async () => {
    const { getRun, store, reviewClient } = fixture(true)
    const readIssue = vi.fn(async (input: string) => {
      const issue =
        input === 'TEAM-1'
          ? getRun().linearMaterialization?.rootIssue
          : getRun().linearMaterialization?.items[0].issue
      return {
        issue: {
          ...issue,
          team: { id: 'team-1', key: 'TEAM', name: 'Team' },
          state: issue?.stateId ? { id: issue.stateId, name: 'Started' } : null,
          parent: issue?.parentId ? { id: issue.parentId, identifier: 'TEAM-1' } : null
        },
        relations: [],
        meta: { partial: false }
      }
    })
    const linearClient = {
      readIssue,
      createIssue: vi.fn(),
      writeRelation: vi.fn(),
      attachLink: vi.fn(async () => ({
        attachment: { id: 'attachment-1', title: 'Review', url: 'https://example.com/reviews/7' }
      })),
      addComment: vi.fn(async () => ({
        comment: { id: 'comment-1', url: null, parentId: null }
      })),
      setState: vi.fn(async () => ({
        state: { id: 'state-completed', name: 'Done', type: 'completed' }
      }))
    } as unknown as JawsResultLinearClient

    const result = await publishJawsReview({
      run: getRun(),
      candidate: candidateFixture(),
      store,
      reviewClient,
      linearClient
    })

    expect(linearClient.attachLink).toHaveBeenCalledOnce()
    expect(linearClient.addComment).toHaveBeenCalledOnce()
    expect(linearClient.setState).toHaveBeenCalledWith({
      input: 'TEAM-2',
      workspaceId: 'workspace-1',
      to: 'completed'
    })
    expect(result.linearMaterialization?.items[0].issue?.stateId).toBe('state-completed')
    expect(result.reviewPublication?.status).toBe('review_ready')
  })
})
