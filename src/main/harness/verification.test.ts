import { describe, expect, it, vi } from 'vitest'
import type { AutomationPrecheckResult } from '../../shared/automations-types'
import type { HarnessAgent, HarnessCandidatePatch, HarnessRun } from '../../shared/harness-types'
import type { Repo } from '../../shared/types'
import type { MessageRow } from '../runtime/orchestration/types'
import { HarnessService, type HarnessStore } from './service'
import type { HarnessRuntimeCaller } from './runtime-caller'
import type { HarnessVerificationRunner } from './verification'
import { HARNESS_DISPATCH_CONFIRMATION_PENDING } from '../../shared/harness-candidate-notice'
import { HARNESS_DISPATCH_CONFIRMATION_TIMEOUT_MS } from './candidate-launch'
import {
  createHarnessBranchCompareFixture,
  createHarnessPrecheckResult,
  createHarnessRunFixture,
  HARNESS_TEST_BASE_SHA
} from './verification-test-fixtures'
import { unverifiedVerificationStopError } from './verification-terminal-error'

type PrecheckArgs = Parameters<HarnessVerificationRunner>[0]
const branchCompare = createHarnessBranchCompareFixture
const precheckResult = createHarnessPrecheckResult

function createStore(repoOverride?: Partial<Repo>): {
  store: HarnessStore
  current: () => HarnessRun
} {
  const repo: Repo = {
    id: 'repo-1',
    path: 'repo-root',
    displayName: 'Repo',
    badgeColor: '#000000',
    addedAt: 1,
    kind: 'git',
    ...repoOverride
  }
  let run = createHarnessRunFixture()
  const store: HarnessStore = {
    getRepo: (id) => (id === repo.id ? repo : undefined),
    listHarnessRuns: () => [run],
    getHarnessRun: (id) => (id === run.id ? run : null),
    createHarnessRun: () => {
      throw new Error('not used')
    },
    updateHarnessCandidate: (runId: string, agent: HarnessAgent, patch: HarnessCandidatePatch) => {
      if (runId !== run.id) {
        throw new Error('missing run')
      }
      const current = run.candidates.find((entry) => entry.agent === agent)!
      const updated = { ...current, ...patch, updatedAt: Date.now() }
      run = {
        ...run,
        candidates: run.candidates.map((candidate) =>
          candidate.agent === agent ? updated : candidate
        )
      }
      return run
    },
    failHarnessRun: (_runId, error) => {
      run = { ...run, fatalError: error, completedAt: Date.now() }
      return run
    }
  }
  return { store, current: () => run }
}

function workerDone(
  agent: HarnessAgent,
  payload: Record<string, unknown> = {
    taskId: `task-${agent}`,
    dispatchId: `dispatch-${agent}`
  },
  id = `message-${agent}`
): MessageRow {
  return {
    id,
    from_handle: `terminal-${agent}`,
    to_handle: 'jaws-harness:run-1',
    subject: `${agent} done`,
    body: `${agent} result`,
    type: 'worker_done',
    priority: 'normal',
    thread_id: null,
    payload: JSON.stringify(payload),
    read: 0,
    sequence: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    delivered_at: null,
    sender_pane_key: null
  }
}

function createRuntime(
  messages: MessageRow[],
  failChecks = 0,
  lifecycleOverrides: Partial<
    Record<
      HarnessAgent,
      {
        dispatchStatus: 'dispatched' | 'completed' | 'failed'
        taskStatus: 'ready' | 'dispatched' | 'completed'
        lastFailure?: string
        lastHeartbeatAt?: string
      }
    >
  > = {}
): {
  runtime: HarnessRuntimeCaller
  call: ReturnType<typeof vi.fn>
} {
  let checks = 0
  const call = vi.fn(async (method: string, rawParams?: unknown): Promise<unknown> => {
    const params = rawParams as Record<string, unknown>
    const agent = String(params.worktree).endsWith('codex') ? 'codex' : 'claude'
    if (method === 'orchestration.check') {
      checks += 1
      if (checks <= failChecks) {
        throw new Error('temporary transport error')
      }
      return { messages, count: messages.length }
    }
    if (method === 'orchestration.dispatchShow') {
      const lifecycleAgent = String(params.task).endsWith('codex') ? 'codex' : 'claude'
      const hasAcceptedCompletion = messages.some((message) => {
        try {
          const payload = JSON.parse(message.payload ?? '{}') as Record<string, unknown>
          return (
            payload.taskId === `task-${lifecycleAgent}` &&
            payload.dispatchId === `dispatch-${lifecycleAgent}` &&
            !Object.prototype.hasOwnProperty.call(payload, '_orcaLifecycleRejection')
          )
        } catch {
          return false
        }
      })
      const override = lifecycleOverrides[lifecycleAgent]
      const dispatchStatus =
        override?.dispatchStatus ?? (hasAcceptedCompletion ? 'completed' : 'dispatched')
      const taskStatus =
        override?.taskStatus ?? (hasAcceptedCompletion ? 'completed' : 'dispatched')
      return {
        dispatch: {
          id: `dispatch-${lifecycleAgent}`,
          task_id: `task-${lifecycleAgent}`,
          assignee_handle: `terminal-${lifecycleAgent}`,
          assignee_pane_key: null,
          status: dispatchStatus,
          failure_count: dispatchStatus === 'failed' ? 1 : 0,
          last_failure: override?.lastFailure ?? null,
          dispatched_at: '2026-01-01 00:00:00',
          completed_at: dispatchStatus === 'completed' ? '2026-01-01 00:01:00' : null,
          created_at: '2026-01-01 00:00:00',
          last_heartbeat_at: override?.lastHeartbeatAt ?? null
        },
        task: { id: `task-${lifecycleAgent}`, status: taskStatus }
      }
    }
    if (method === 'git.status') {
      return {
        entries: [],
        conflictOperation: 'unknown',
        head: `head-${agent}`,
        branch: `harness-${agent}`
      }
    }
    if (method === 'git.branchCompare') {
      return createHarnessBranchCompareFixture(agent)
    }
    throw new Error(`Unexpected runtime call: ${method}`)
  })
  const runVerification = vi.fn(async () => {
    throw new Error('Unexpected Harness verification')
  })
  const abandonDispatch = vi.fn(async () => true)
  const stopChildDispatch = vi.fn(async () => true)
  const stopVerificationTerminal = vi.fn(async () => true)
  return {
    runtime: {
      call,
      abandonDispatch,
      stopChildDispatch,
      stopVerificationTerminal,
      runVerification
    } as HarnessRuntimeCaller,
    call
  }
}

function callsFor(call: ReturnType<typeof vi.fn>, method: string): unknown[][] {
  return call.mock.calls.filter(([calledMethod]) => calledMethod === method)
}

describe('Harness completion verification', () => {
  it('accepts only correlated worker_done and waits for both workers before verification', async () => {
    const messages = [
      workerDone('codex', { taskId: 'task-codex', dispatchId: 'stale' }, 'stale'),
      workerDone(
        'claude',
        {
          taskId: 'task-claude',
          dispatchId: 'dispatch-claude',
          _orcaLifecycleRejection: { code: 'sender_not_assignee' }
        },
        'rejected'
      ),
      { ...workerDone('codex', undefined, 'accepted'), from_handle: 'terminal-reminted' }
    ]
    const { store, current } = createStore()
    const { runtime, call } = createRuntime(messages)
    const runPrecheck = vi.fn(async () => createHarnessPrecheckResult(0))
    const service = new HarnessService(store, runtime, {
      autoMonitor: false,
      runPrecheck: runPrecheck as HarnessVerificationRunner
    })

    await service.advance('run-1')

    let [codex, claude] = current().candidates
    expect(codex).toMatchObject({
      status: 'worker_done',
      workerResult: { messageId: 'accepted', subject: 'codex done' }
    })
    expect(codex.diff).toBeNull()
    expect(claude.status).toBe('running')
    expect(runPrecheck).not.toHaveBeenCalled()
    expect(callsFor(call, 'orchestration.check')[0]?.[1]).toEqual({
      terminal: 'jaws-harness:run-1',
      all: true,
      types: 'worker_done'
    })

    messages.push(workerDone('claude', undefined, 'accepted-claude'))
    await service.advance('run-1')

    ;[codex, claude] = current().candidates
    expect(codex).toMatchObject({
      status: 'verified',
      diff: {
        changedFiles: [{ path: 'src/codex.ts', status: 'modified' }],
        untrackedPaths: [],
        error: null
      }
    })
    expect(claude.status).toBe('verified')
    expect(runPrecheck).toHaveBeenCalledWith({
      precheck: { command: 'pnpm test', timeoutSeconds: 900 },
      target: { type: 'local', cwd: 'candidate-codex' }
    })
  })

  it('preserves failed verification evidence while the peer completes over SSH', async () => {
    const { store, current } = createStore({ connectionId: 'ssh-target' })
    const { runtime, call } = createRuntime([workerDone('codex'), workerDone('claude')])
    let activeVerifications = 0
    let maxActiveVerifications = 0
    const runPrecheck = vi.fn(async ({ target }: PrecheckArgs) => {
      activeVerifications += 1
      maxActiveVerifications = Math.max(maxActiveVerifications, activeVerifications)
      await Promise.resolve()
      activeVerifications -= 1
      return precheckResult(target.cwd.endsWith('codex') ? 1 : 0)
    })
    const service = new HarnessService(store, runtime, {
      autoMonitor: false,
      runPrecheck: runPrecheck as HarnessVerificationRunner
    })

    await service.advance('run-1')

    const [codex, claude] = current().candidates
    expect(codex).toMatchObject({
      status: 'failed',
      error: 'Verification exited with code 1.',
      verification: { command: 'pnpm test', exitCode: 1 }
    })
    expect(codex.diff?.changedFiles).toHaveLength(1)
    expect(claude).toMatchObject({ status: 'verified', error: null })
    expect(callsFor(call, 'git.branchCompare').map(([, params]) => params)).toEqual([
      { worktree: 'id:worktree-codex', baseRef: HARNESS_TEST_BASE_SHA },
      { worktree: 'id:worktree-codex', baseRef: HARNESS_TEST_BASE_SHA },
      { worktree: 'id:worktree-claude', baseRef: HARNESS_TEST_BASE_SHA },
      { worktree: 'id:worktree-claude', baseRef: HARNESS_TEST_BASE_SHA }
    ])
    expect(runPrecheck.mock.calls.map(([args]) => args.target)).toEqual(
      expect.arrayContaining([
        { type: 'ssh', cwd: 'candidate-codex', connectionId: 'ssh-target' },
        { type: 'ssh', cwd: 'candidate-claude', connectionId: 'ssh-target' }
      ])
    )
    expect(maxActiveVerifications).toBe(1)
  })

  it.each([
    {
      name: 'manufactures changes',
      beforeChanges: false,
      afterChanges: true,
      expectedError: 'Candidate produced no Git changes before verification.',
      finalChangedFiles: 0,
      beforePath: 'src/codex.ts',
      afterPath: 'src/codex.ts',
      commandRuns: false
    },
    {
      name: 'deletes changes',
      beforeChanges: true,
      afterChanges: false,
      expectedError: 'Verification removed all candidate Git changes.',
      finalChangedFiles: 0,
      beforePath: 'src/codex.ts',
      afterPath: 'src/codex.ts',
      commandRuns: true
    },
    {
      name: 'replaces changes',
      beforeChanges: true,
      afterChanges: true,
      expectedError: 'Verification removed candidate changes: src/codex.ts.',
      finalChangedFiles: 1,
      beforePath: 'src/codex.ts',
      afterPath: 'coverage.json',
      commandRuns: true
    }
  ])(
    'fails and persists final Git evidence when the command $name',
    async ({
      beforeChanges,
      afterChanges,
      expectedError,
      finalChangedFiles,
      beforePath,
      afterPath,
      commandRuns
    }) => {
      const { store, current } = createStore()
      store.updateHarnessCandidate('run-1', 'claude', {
        status: 'failed',
        error: 'peer failed'
      })
      let verificationRan = false
      const call = vi.fn(async (method: string, rawParams?: unknown): Promise<unknown> => {
        if (method === 'orchestration.check') {
          return { messages: [workerDone('codex')], count: 1 }
        }
        if (method === 'orchestration.dispatchShow') {
          const lifecycleAgent = String((rawParams as Record<string, unknown>).task).endsWith(
            'codex'
          )
            ? 'codex'
            : 'claude'
          const completed = lifecycleAgent === 'codex'
          return {
            dispatch: {
              id: `dispatch-${lifecycleAgent}`,
              task_id: `task-${lifecycleAgent}`,
              status: completed ? 'completed' : 'dispatched',
              last_failure: null
            },
            task: {
              id: `task-${lifecycleAgent}`,
              status: completed ? 'completed' : 'dispatched'
            }
          }
        }
        const params = rawParams as Record<string, unknown>
        const agent = String(params.worktree).endsWith('codex') ? 'codex' : 'claude'
        if (method === 'git.status') {
          return {
            entries: [],
            conflictOperation: 'unknown',
            head: `head-${agent}`,
            branch: `harness-${agent}`
          }
        }
        if (method === 'git.branchCompare') {
          return branchCompare(
            agent,
            verificationRan ? afterChanges : beforeChanges,
            verificationRan ? afterPath : beforePath
          )
        }
        throw new Error(`Unexpected runtime call: ${method}`)
      })
      const runPrecheck = vi.fn(async () => {
        verificationRan = true
        return precheckResult(0)
      })
      const runVerification = vi.fn(async () => {
        throw new Error('Unexpected Harness verification')
      })
      const service = new HarnessService(
        store,
        {
          call,
          abandonDispatch: vi.fn(async () => true),
          runVerification
        } as unknown as HarnessRuntimeCaller,
        {
          autoMonitor: false,
          runPrecheck: runPrecheck as HarnessVerificationRunner
        }
      )

      await service.advance('run-1')

      const completed = current().candidates[0]
      expect(completed).toMatchObject({ status: 'failed', error: expectedError })
      expect(completed.diff?.changedFiles).toHaveLength(finalChangedFiles)
      const gitOrders = call.mock.invocationCallOrder.filter((_, index) =>
        ['git.status', 'git.branchCompare'].includes(String(call.mock.calls[index]?.[0]))
      )
      if (commandRuns) {
        const verificationOrder = runPrecheck.mock.invocationCallOrder[0] ?? 0
        expect(verificationOrder).toBeGreaterThan(0)
        expect(gitOrders.slice(0, 2).every((order) => order < verificationOrder)).toBe(true)
        expect(gitOrders.slice(2).every((order) => order > verificationOrder)).toBe(true)
      } else {
        expect(runPrecheck).not.toHaveBeenCalled()
        expect(gitOrders).toHaveLength(2)
      }
    }
  )

  it('keeps transient completion-check failures resumable', async () => {
    const { store, current } = createStore()
    const { runtime } = createRuntime([], 1)
    const service = new HarnessService(store, runtime, { autoMonitor: false })

    await service.advance('run-1')
    expect(current().fatalError).toBeNull()
    expect(current().candidates.map((entry) => entry.error)).toEqual([
      'Completion check failed: temporary transport error',
      'Completion check failed: temporary transport error'
    ])

    await service.advance('run-1')
    expect(current().candidates.map((entry) => entry.error)).toEqual([null, null])
    expect(current().candidates.map((entry) => entry.status)).toEqual(['running', 'running'])
  })

  it('fails a recovered dispatch that never produces worker liveness', async () => {
    const { store, current } = createStore()
    store.updateHarnessCandidate('run-1', 'codex', {
      error: HARNESS_DISPATCH_CONFIRMATION_PENDING,
      recoveryStartedAt: Date.now() - HARNESS_DISPATCH_CONFIRMATION_TIMEOUT_MS
    })
    const { runtime } = createRuntime([])
    const service = new HarnessService(store, runtime, { autoMonitor: false })

    await service.advance('run-1')

    expect(current().candidates[0]).toMatchObject({
      status: 'failed',
      error: 'Candidate dispatch was not confirmed after restart.'
    })
  })

  it('does not accept a heartbeat exactly at the restart boundary', async () => {
    const recoveryStartedAt = Date.parse('2026-07-15T03:00:00.000Z')
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(recoveryStartedAt + 1_000)
    const { store, current } = createStore()
    store.updateHarnessCandidate('run-1', 'codex', {
      error: HARNESS_DISPATCH_CONFIRMATION_PENDING,
      recoveryStartedAt
    })
    const { runtime } = createRuntime([], 0, {
      codex: {
        dispatchStatus: 'dispatched',
        taskStatus: 'dispatched',
        lastHeartbeatAt: '2026-07-15 03:00:00'
      }
    })
    const service = new HarnessService(store, runtime, { autoMonitor: false })

    await service.advance('run-1')

    expect(current().candidates[0]).toMatchObject({
      status: 'running',
      error: HARNESS_DISPATCH_CONFIRMATION_PENDING,
      recoveryStartedAt
    })
    expect(runtime.abandonDispatch).not.toHaveBeenCalled()
    dateNow.mockRestore()
  })

  it('rejects worker_done when the authoritative dispatch failed', async () => {
    const { store, current } = createStore()
    const { runtime } = createRuntime([workerDone('codex')], 0, {
      codex: {
        dispatchStatus: 'failed',
        taskStatus: 'ready',
        lastFailure: 'agent terminal exited'
      }
    })
    const runPrecheck = vi.fn(async () => precheckResult(0))
    const service = new HarnessService(store, runtime, {
      autoMonitor: false,
      runPrecheck: runPrecheck as HarnessVerificationRunner
    })

    await service.advance('run-1')

    expect(current().candidates[0]).toMatchObject({
      status: 'failed',
      error: 'agent terminal exited',
      workerResult: null
    })
    expect(runPrecheck).not.toHaveBeenCalled()
  })

  it('treats the documented Failed worker_done subject as terminal failure', async () => {
    const failedMessage = { ...workerDone('codex'), subject: 'Failed: authentication required' }
    const { store, current } = createStore()
    const { runtime } = createRuntime([failedMessage])
    const runPrecheck = vi.fn(async () => precheckResult(0))
    const service = new HarnessService(store, runtime, {
      autoMonitor: false,
      runPrecheck: runPrecheck as HarnessVerificationRunner
    })

    await service.advance('run-1')

    expect(current().candidates[0]).toMatchObject({
      status: 'failed',
      error: 'Worker reported failure: Failed: authentication required',
      workerResult: { messageId: 'message-codex' }
    })
    expect(runPrecheck).not.toHaveBeenCalled()
  })

  it('does not rerun a verification command after an infrastructure error', async () => {
    const { store, current } = createStore()
    store.updateHarnessCandidate('run-1', 'claude', {
      status: 'failed',
      error: 'peer failed'
    })
    const { runtime } = createRuntime([workerDone('codex')])
    const disconnected = {
      ...precheckResult(0),
      exitCode: null,
      error: 'SSH target is not connected.'
    }
    const runPrecheck = vi
      .fn<() => Promise<AutomationPrecheckResult>>()
      .mockResolvedValueOnce(disconnected)
      .mockResolvedValueOnce(precheckResult(0))
    const service = new HarnessService(store, runtime, {
      autoMonitor: false,
      runPrecheck: runPrecheck as HarnessVerificationRunner
    })

    await service.advance('run-1')
    expect(current().candidates[0]).toMatchObject({
      status: 'failed',
      error: 'Verification failed: SSH target is not connected.'
    })

    service.resume('run-1')
    await service.waitForExecution('run-1')
    expect(current().candidates[0]).toMatchObject({
      status: 'failed',
      error: 'Verification failed: SSH target is not connected.'
    })
    expect(runPrecheck).toHaveBeenCalledTimes(1)
  })

  it('keeps active PTY ownership when live verification shutdown cannot be proven', async () => {
    const { store, current } = createStore()
    store.updateHarnessCandidate('run-1', 'claude', {
      status: 'failed',
      error: 'peer failed'
    })
    const { runtime } = createRuntime([workerDone('codex')])
    vi.mocked(runtime.runVerification).mockImplementation(async () => {
      store.updateHarnessCandidate('run-1', 'codex', {
        verificationTerminalHandle: 'verify-h1',
        verificationTerminalPaneKey: 'tab-1:leaf-1',
        verificationTerminalOwnership: 'owned'
      })
      throw unverifiedVerificationStopError()
    })
    const service = new HarnessService(store, runtime, { autoMonitor: false })

    await service.advance('run-1')

    expect(current().candidates[0]).toMatchObject({
      status: 'verifying',
      verificationTerminalHandle: 'verify-h1',
      verificationTerminalPaneKey: 'tab-1:leaf-1',
      verificationTerminalOwnership: 'owned',
      error: 'Verification terminal stop could not be verified; it may still be running.'
    })
  })

  it('keeps a legacy command-start barrier locked without replaying verification', async () => {
    const { store, current } = createStore()
    const startedAt = Date.now() - 1_000
    store.updateHarnessCandidate('run-1', 'codex', {
      status: 'verifying',
      workerResult: {
        messageId: 'message-codex',
        subject: 'codex done',
        body: 'done',
        payload: null,
        receivedAt: startedAt - 1
      },
      workerCompletedAt: startedAt - 1,
      diff: {
        headSha: 'head-codex',
        diffStat: '1 file · 1 modified',
        changedFiles: [{ path: 'src/codex.ts', status: 'modified' }],
        untrackedPaths: [],
        capturedAt: startedAt,
        error: null
      },
      verification: {
        command: 'pnpm test',
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        outputTail: '',
        outputTruncated: false,
        error: 'Verification was interrupted before completion evidence was persisted.',
        startedAt,
        completedAt: startedAt
      }
    })
    store.updateHarnessCandidate('run-1', 'claude', {
      status: 'failed',
      error: 'worker failed'
    })
    const { runtime, call } = createRuntime([])
    const runPrecheck = vi.fn(async () => precheckResult(0))
    const service = new HarnessService(store, runtime, {
      autoMonitor: false,
      runPrecheck: runPrecheck as HarnessVerificationRunner
    })

    await service.advance('run-1')

    expect(current().candidates[0]).toMatchObject({
      status: 'verifying',
      error: 'Interrupted verification has no durable terminal identity; it may still be running.'
    })
    expect(runPrecheck).not.toHaveBeenCalled()
    expect(callsFor(call, 'git.status')).toHaveLength(0)

    service.resume('run-1')
    await service.waitForExecution('run-1')
    expect(current().candidates[0].status).toBe('verifying')
    expect(runPrecheck).not.toHaveBeenCalled()
  })

  it('fails a pending command-start barrier because no PTY launch callback ran', async () => {
    const { store, current } = createStore()
    const startedAt = Date.now() - 1_000
    store.updateHarnessCandidate('run-1', 'codex', {
      status: 'verifying',
      verificationTerminalOwnership: 'pending',
      verification: {
        command: 'pnpm test',
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        outputTail: '',
        outputTruncated: false,
        error: 'Verification was interrupted before completion evidence was persisted.',
        startedAt,
        completedAt: startedAt
      }
    })
    store.updateHarnessCandidate('run-1', 'claude', { status: 'failed', error: 'worker failed' })
    const { runtime } = createRuntime([])

    await new HarnessService(store, runtime, { autoMonitor: false }).advance('run-1')

    expect(current().candidates[0]).toMatchObject({
      status: 'failed',
      verificationTerminalHandle: null,
      verificationTerminalPaneKey: null,
      verificationTerminalOwnership: null,
      error: 'Verification was interrupted before completion evidence was persisted.'
    })
    expect(runtime.stopVerificationTerminal).not.toHaveBeenCalled()
  })

  it('terminal-fails a durably stopped verification without resolving its gone pane', async () => {
    const { store, current } = createStore()
    const startedAt = Date.now() - 1_000
    store.updateHarnessCandidate('run-1', 'codex', {
      status: 'verifying',
      verificationTerminalHandle: 'verify-h1',
      verificationTerminalPaneKey: 'tab-1:leaf-1',
      verificationTerminalOwnership: 'stopped',
      verification: {
        command: 'pnpm test',
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        outputTail: '',
        outputTruncated: false,
        error: 'Verification was interrupted before completion evidence was persisted.',
        startedAt,
        completedAt: startedAt
      }
    })
    store.updateHarnessCandidate('run-1', 'claude', { status: 'failed', error: 'worker failed' })
    const { runtime } = createRuntime([])

    await new HarnessService(store, runtime, { autoMonitor: false }).advance('run-1')

    expect(current().candidates[0]).toMatchObject({
      status: 'failed',
      verificationTerminalOwnership: null,
      error: 'Verification was interrupted before completion evidence was persisted.'
    })
    expect(runtime.stopVerificationTerminal).not.toHaveBeenCalled()
  })

  it.each([
    { stopped: true, expectedStatus: 'failed', expectedOwnership: null },
    { stopped: false, expectedStatus: 'verifying', expectedOwnership: 'owned' }
  ] as const)(
    'recovers an owned verification terminal only after exact stop proof ($stopped)',
    async ({ stopped, expectedStatus, expectedOwnership }) => {
      const { store, current } = createStore()
      const startedAt = Date.now() - 1_000
      store.updateHarnessCandidate('run-1', 'codex', {
        status: 'verifying',
        verificationTerminalHandle: 'verify-h1',
        verificationTerminalPaneKey: 'tab-1:leaf-1',
        verificationTerminalOwnership: 'owned',
        verification: {
          command: 'pnpm test',
          exitCode: null,
          timedOut: false,
          durationMs: 0,
          outputTail: '',
          outputTruncated: false,
          error: 'Verification was interrupted before completion evidence was persisted.',
          startedAt,
          completedAt: startedAt
        }
      })
      store.updateHarnessCandidate('run-1', 'claude', {
        status: 'failed',
        error: 'worker failed'
      })
      const { runtime } = createRuntime([])
      vi.mocked(runtime.stopVerificationTerminal).mockResolvedValue(stopped)

      await new HarnessService(store, runtime, { autoMonitor: false }).advance('run-1')

      expect(runtime.stopVerificationTerminal).toHaveBeenCalledWith({
        handle: 'verify-h1',
        paneKey: 'tab-1:leaf-1',
        worktreeId: 'worktree-codex'
      })
      expect(current().candidates[0]).toMatchObject({
        status: expectedStatus,
        verificationTerminalOwnership: expectedOwnership,
        error: stopped
          ? 'Verification was interrupted before completion evidence was persisted.'
          : 'Verification terminal stop could not be verified; it may still be running.'
      })
    }
  )

  it('clears pre-command retry evidence before an explicit resume', async () => {
    const { store, current } = createStore()
    const startedAt = Date.now() - 1_000
    store.updateHarnessCandidate('run-1', 'codex', {
      status: 'verifying',
      workerResult: {
        messageId: 'message-codex',
        subject: 'codex done',
        body: 'done',
        payload: null,
        receivedAt: startedAt - 1
      },
      workerCompletedAt: startedAt - 1,
      diff: {
        headSha: null,
        diffStat: '',
        changedFiles: [],
        untrackedPaths: [],
        capturedAt: startedAt,
        error: 'runtime reconnecting'
      },
      verification: {
        command: 'pnpm test',
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        outputTail: '',
        outputTruncated: false,
        error: 'Verification did not start because Git evidence was unavailable.',
        startedAt,
        completedAt: startedAt
      },
      error: 'Pre-verification Git evidence failed: runtime reconnecting'
    })
    store.updateHarnessCandidate('run-1', 'claude', {
      status: 'failed',
      error: 'worker failed'
    })
    const { runtime } = createRuntime([])
    const runPrecheck = vi.fn(async () => precheckResult(0))
    const service = new HarnessService(store, runtime, {
      autoMonitor: false,
      runPrecheck: runPrecheck as HarnessVerificationRunner
    })

    service.resume('run-1')
    await service.waitForExecution('run-1')

    expect(current().candidates[0]).toMatchObject({
      status: 'verified',
      diff: { error: null },
      verification: { exitCode: 0, error: null },
      error: null
    })
    expect(runPrecheck).toHaveBeenCalledTimes(1)
  })
})
