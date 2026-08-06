import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  HarnessAgent,
  HarnessCandidate,
  HarnessCandidatePatch,
  HarnessRun,
  HarnessRunCreateInput
} from '../../shared/harness-types'
import { OrcaRuntimeService } from './orca-runtime'

const ACTIVE_RUN = {
  id: 'run-1',
  repoId: 'repo-1',
  sourceWorktreeId: 'source-1',
  sourceWorktreePath: '/repo',
  goal: 'Resume persisted work',
  verificationCommand: 'pnpm test',
  baseSha: '0123456789abcdef',
  fatalError: null,
  candidates: [
    { id: 'candidate-codex', agent: 'codex', status: 'pending' },
    { id: 'candidate-claude', agent: 'claude', status: 'pending' }
  ]
} as HarnessRun

function pendingCandidate(runId: string, agent: HarnessAgent, now: number): HarnessCandidate {
  return {
    id: `${runId}-${agent}`,
    agent,
    status: 'pending',
    worktreeId: null,
    worktreePath: null,
    branch: null,
    agentTerminalHandle: null,
    agentTerminalPaneKey: null,
    verificationTerminalHandle: null,
    verificationTerminalPaneKey: null,
    verificationTerminalOwnership: null,
    orchestrationRunId: null,
    taskId: null,
    dispatchId: null,
    workerResult: null,
    verification: null,
    diff: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    recoveryStartedAt: null,
    childLaneDrainStartedAt: null,
    workerCompletedAt: null,
    completedAt: null
  }
}

describe('OrcaRuntimeService Harness startup recovery', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not trust a live local handle without stable pane authority', async () => {
    const worktreeId = 'repo-local::/repo'
    const repo = {
      id: 'repo-local',
      path: '/repo',
      displayName: 'Local repo',
      badgeColor: '#000000',
      addedAt: 1,
      kind: 'git'
    }
    const localProvider = {
      listProcesses: vi.fn(async () => [
        {
          id: 'local-pty-1',
          cwd: repo.path,
          title: 'sh',
          terminalHandle: 'verify-h1'
        }
      ])
    } as never
    const runtime = new OrcaRuntimeService({ getRepo: () => repo } as never, undefined, {
      getLocalProvider: () => localProvider
    })
    vi.spyOn(
      runtime as unknown as {
        resolveWorktreeSelector: (selector: string) => Promise<unknown>
      },
      'resolveWorktreeSelector'
    ).mockResolvedValue({ id: worktreeId, repoId: repo.id, path: repo.path })
    await expect(
      runtime.findFreshHarnessVerificationTerminal({
        handle: 'verify-h1',
        worktreeId
      })
    ).rejects.toThrow('stable pane authority')
  })

  it('uses the target SSH provider to recover a preallocated verification handle', async () => {
    const worktreeId = 'repo-ssh::/remote/repo'
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      displayName: 'Remote repo',
      badgeColor: '#000000',
      addedAt: 1,
      kind: 'git',
      connectionId: 'ssh-verification'
    }
    const sshProvider = {
      listProcesses: vi.fn(async () => [
        {
          id: 'remote-pty-1',
          cwd: repo.path,
          title: 'sh',
          terminalHandle: 'verify-h1'
        }
      ])
    } as never
    const runtime = new OrcaRuntimeService({ getRepo: () => repo } as never, undefined, {
      getSshProvider: (connectionId) =>
        connectionId === 'ssh-verification' ? sshProvider : undefined
    })
    vi.spyOn(
      runtime as unknown as {
        resolveWorktreeSelector: (selector: string) => Promise<unknown>
      },
      'resolveWorktreeSelector'
    ).mockResolvedValue({
      id: worktreeId,
      repoId: repo.id,
      path: repo.path,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: {
        path: repo.path,
        head: 'abc',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      }
    })
    await expect(
      runtime.findFreshHarnessVerificationTerminal({
        handle: 'verify-h1',
        worktreeId
      })
    ).resolves.toBe('verify-h1')
  })

  it('does not treat an unregistered SSH provider as authoritative absence', async () => {
    const worktreeId = 'repo-ssh::/remote/repo'
    const repo = {
      id: 'repo-ssh',
      path: '/remote/repo',
      connectionId: 'ssh-verification'
    }
    const runtime = new OrcaRuntimeService({ getRepo: () => repo } as never)
    vi.spyOn(
      runtime as unknown as {
        resolveWorktreeSelector: (selector: string) => Promise<unknown>
      },
      'resolveWorktreeSelector'
    ).mockResolvedValue({ id: worktreeId, repoId: repo.id, path: repo.path })

    await expect(
      runtime.findFreshHarnessVerificationTerminal({
        handle: 'verify-h1',
        worktreeId
      })
    ).rejects.toThrow('terminal_liveness_unavailable')
  })

  it('keeps early Harness reads dormant until the PTY controller is ready', async () => {
    const createManagedWorktree = vi
      .spyOn(OrcaRuntimeService.prototype, 'createManagedWorktree')
      .mockImplementation(() => new Promise<never>(() => {}))
    vi.spyOn(OrcaRuntimeService.prototype, 'showRepo').mockResolvedValue({
      id: 'repo-1',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: '#000000',
      addedAt: 1,
      kind: 'git'
    })
    const harnessStore = {
      getRepo: vi.fn(() => ({ id: 'repo-1', kind: 'git' })),
      listHarnessRuns: vi.fn(() => [ACTIVE_RUN]),
      getHarnessRun: vi.fn(() => ACTIVE_RUN),
      createHarnessRun: vi.fn(),
      updateHarnessCandidate: vi.fn(
        (_runId: string, agent: HarnessAgent, patch: HarnessCandidatePatch) => ({
          ...ACTIVE_RUN,
          candidates: ACTIVE_RUN.candidates.map((candidate) =>
            candidate.agent === agent ? { ...candidate, ...patch } : candidate
          )
        })
      ),
      failHarnessRun: vi.fn()
    }
    const runtime = new OrcaRuntimeService(harnessStore as never)
    const controller = {
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => null)
    }

    const earlyService = runtime.getHarnessService()
    expect(earlyService.list()).toEqual([ACTIVE_RUN])
    expect(earlyService.show(ACTIVE_RUN.id)).toBe(ACTIVE_RUN)
    await Promise.resolve()
    expect(createManagedWorktree).not.toHaveBeenCalled()

    runtime.setPtyController(controller)
    await vi.waitFor(() => expect(createManagedWorktree).toHaveBeenCalledOnce())
    expect(createManagedWorktree.mock.calls[0][0]).toMatchObject({ startupAgent: 'codex' })

    runtime.setPtyController(null)
    runtime.setPtyController(controller)
    expect(runtime.getHarnessService()).toBe(earlyService)
    expect(createManagedWorktree).toHaveBeenCalledOnce()
  })

  it('persists an early Harness start but defers candidate launch until PTY readiness', async () => {
    let run: HarnessRun | null = null
    const store = {
      getRepo: vi.fn(() => ({ id: 'repo-1', kind: 'git' })),
      listHarnessRuns: vi.fn(() => (run ? [run] : [])),
      getHarnessRun: vi.fn((runId: string) => (run?.id === runId ? run : null)),
      createHarnessRun: vi.fn((input: HarnessRunCreateInput) => {
        const now = Date.now()
        run = {
          id: 'run-new',
          ...input,
          mode: input.mode ?? 'comparison',
          candidates: [
            pendingCandidate('run-new', 'codex', now) as HarnessCandidate<'codex'>,
            pendingCandidate('run-new', 'claude', now) as HarnessCandidate<'claude'>
          ],
          fatalError: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null
        }
        return run
      }),
      updateHarnessCandidate: vi.fn(
        (runId: string, agent: HarnessAgent, patch: HarnessCandidatePatch) => {
          if (!run || run.id !== runId) {
            throw new Error('missing run')
          }
          run = {
            ...run,
            candidates: run.candidates.map((candidate) =>
              candidate.agent === agent ? { ...candidate, ...patch } : candidate
            ) as HarnessRun['candidates']
          }
          return run
        }
      ),
      failHarnessRun: vi.fn()
    }
    const runtime = new OrcaRuntimeService(store as never)
    vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'source-1',
      repoId: 'repo-1',
      git: { path: '/repo', head: '0123456789abcdef', branch: 'main' }
    } as never)
    vi.spyOn(runtime, 'getRuntimeGitStatus').mockResolvedValue({
      entries: [],
      conflictOperation: 'unknown',
      head: '0123456789abcdef',
      branch: 'main'
    })
    vi.spyOn(runtime, 'showRepo').mockResolvedValue({
      id: 'repo-1',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: '#000000',
      addedAt: 1,
      kind: 'git'
    })
    const createManagedWorktree = vi
      .spyOn(runtime, 'createManagedWorktree')
      .mockImplementation(() => new Promise<never>(() => {}))

    const started = await runtime.getHarnessService().start({
      worktree: 'id:source-1',
      goal: 'Start after PTY readiness',
      verificationCommand: 'pnpm test'
    })
    expect(started.id).toBe('run-new')
    expect(createManagedWorktree).not.toHaveBeenCalled()

    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => null)
    })
    await vi.waitFor(() => expect(createManagedWorktree).toHaveBeenCalledOnce())
  })
})
