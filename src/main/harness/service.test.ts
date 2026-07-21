import { describe, expect, it, vi } from 'vitest'
import type { GitStatusResult } from '../../shared/git-status-types'
import { HarnessService, type HarnessStore } from './service'
import { HARNESS_DISPATCH_CONFIRMATION_PENDING } from '../../shared/harness-candidate-notice'
import {
  BASE_SHA,
  CLEAN_STATUS,
  REPO,
  branchRef,
  callsFor,
  createHarnessScenario,
  createMemoryStore,
  createPersistedRun,
  createRuntime,
  startHarness
} from './harness-service-test-scenario'

describe('HarnessService', () => {
  it('launches equal candidates and dispatches one byte-identical task spec', async () => {
    const { call, service } = createHarnessScenario()

    const started = await startHarness(service, 'Add a focused comparison view.')
    await service.waitForExecution(started.id)

    expect(service.show(started.id).candidates).toMatchObject([
      { status: 'running', branch: branchRef('codex') },
      { status: 'running', branch: branchRef('claude') }
    ])
    const creates = callsFor(call, 'worktree.create')
    expect(creates).toHaveLength(2)
    expect(new Set(creates.map((params) => params.baseBranch))).toEqual(new Set([BASE_SHA]))
    expect(creates.every((params) => params.noParent === true)).toBe(true)
    expect(creates.every((params) => params.setupDecision === 'skip')).toBe(true)
    expect(creates.every((params) => params.branchNameOverride === params.name)).toBe(true)
    expect(creates.every((params) => params.activate === false)).toBe(true)
    expect(creates.every((params) => !('startupPrompt' in params))).toBe(true)
    expect(new Set(creates.map((params) => params.startupAgent))).toEqual(
      new Set(['codex', 'claude'])
    )

    const tasks = callsFor(call, 'orchestration.taskCreate')
    const expectedSpec =
      'Implement this goal in the current worktree:\n\nAdd a focused comparison view.\n\n' +
      `Start SHA: ${BASE_SHA}\n` +
      'Do not push, merge, cherry-pick, delete branches or worktrees, or modify another worktree.'
    expect(tasks).toHaveLength(2)
    expect(tasks.map((params) => params.spec)).toEqual([expectedSpec, expectedSpec])
    expect(new Set(tasks.map((params) => params.taskTitle)).size).toBe(2)

    const dispatches = callsFor(call, 'orchestration.dispatch')
    expect(dispatches).toHaveLength(2)
    expect(dispatches.every((params) => params.inject === true)).toBe(true)
    expect(new Set(dispatches.map((params) => params.from))).toEqual(
      new Set([`jaws-harness:${started.id}`])
    )
  })

  it.each([
    [
      'dirty status',
      { ...CLEAN_STATUS, entries: [{ path: 'dirty.ts', status: 'modified', area: 'unstaged' }] },
      'must be clean'
    ],
    ['truncated status', { ...CLEAN_STATUS, didHitLimit: true }, 'status was truncated'],
    ['merge in progress', { ...CLEAN_STATUS, conflictOperation: 'merge' }, 'merge operation'],
    ['missing HEAD', { ...CLEAN_STATUS, head: undefined }, 'resolve the source HEAD']
  ])('rejects %s before persisting or creating candidates', async (_label, status, message) => {
    const { runs, call, service } = createHarnessScenario({ status: status as GitStatusResult })

    await expect(startHarness(service)).rejects.toThrow(message)

    expect(runs.size).toBe(0)
    expect(callsFor(call, 'worktree.create')).toHaveLength(0)
  })

  it('fails a rejected creation only after a complete listing proves the branch absent', async () => {
    const { call, service } = createHarnessScenario({ failCreate: 'codex' })

    const run = await startHarness(service)
    await service.waitForExecution(run.id)

    const [codex, claude] = service.show(run.id).candidates
    expect(codex).toMatchObject({ status: 'failed', error: 'codex create failed' })
    expect(claude).toMatchObject({
      status: 'failed',
      worktreeId: 'worktree-claude',
      error: 'Comparison could not start because the peer failed.'
    })
    expect(callsFor(call, 'worktree.create')).toHaveLength(2)
    expect(callsFor(call, 'worktree.list')).toHaveLength(1)
    expect(callsFor(call, 'worktree.rm')).toHaveLength(0)
    expect(callsFor(call, 'orchestration.dispatch')).toHaveLength(0)
  })

  it('recovers a durable candidate when worktree creation rejects after committing it', async () => {
    const { call, service } = createHarnessScenario({
      failCreate: 'codex',
      recoverInterruptedCreate: 'codex'
    })

    const run = await startHarness(service)
    await service.waitForExecution(run.id)

    expect(service.show(run.id).candidates[0]).toMatchObject({
      status: 'running',
      worktreeId: 'worktree-codex',
      branch: branchRef('codex'),
      error: null
    })
    expect(
      callsFor(call, 'worktree.create').filter((params) => params.startupAgent === 'codex')
    ).toHaveLength(1)
    expect(callsFor(call, 'worktree.list')).toHaveLength(1)
  })

  it('persists a rejected creation across a truncated listing until absence is proven', async () => {
    const { call, service } = createHarnessScenario({
      failCreate: 'codex',
      truncateFirstRecoveryList: true
    })

    const run = await startHarness(service)
    await service.waitForExecution(run.id)
    expect(service.show(run.id).candidates[0]).toMatchObject({
      status: 'creating',
      recoveryStartedAt: expect.any(Number),
      error: expect.stringContaining('checking for a durable worktree: codex create failed')
    })

    service.resume(run.id)
    await service.waitForExecution(run.id)

    expect(service.show(run.id).candidates[0]).toMatchObject({
      status: 'failed',
      error: 'codex create failed'
    })
    expect(callsFor(call, 'worktree.list')).toHaveLength(2)
    expect(
      callsFor(call, 'worktree.create').filter((params) => params.startupAgent === 'codex')
    ).toHaveLength(1)
  })

  it('rejects setup changes before either candidate is dispatched', async () => {
    const { call, service } = createHarnessScenario({
      candidateStatus: {
        codex: {
          ...CLEAN_STATUS,
          entries: [{ path: 'generated.txt', status: 'untracked', area: 'untracked' }]
        }
      }
    })

    const run = await startHarness(service)
    await service.waitForExecution(run.id)

    expect(service.show(run.id).candidates).toMatchObject([
      { status: 'failed', error: 'Candidate setup modified the worktree before dispatch.' },
      { status: 'failed', error: 'Comparison could not start because the peer failed.' }
    ])
    expect(callsFor(call, 'orchestration.taskCreate')).toHaveLength(0)
    expect(callsFor(call, 'orchestration.dispatch')).toHaveLength(0)
  })

  it('rejects a setup hook that commits away from the shared base SHA', async () => {
    const { call, service } = createHarnessScenario({
      candidateStatus: { codex: { ...CLEAN_STATUS, head: 'setup-commit' } }
    })

    const run = await startHarness(service)
    await service.waitForExecution(run.id)

    expect(service.show(run.id).candidates[0]).toMatchObject({
      status: 'failed',
      error: `Candidate setup changed HEAD to setup-commit, expected ${BASE_SHA}.`
    })
    expect(callsFor(call, 'orchestration.dispatch')).toHaveLength(0)
  })

  it('rejects a candidate that leaves the deterministic branch before dispatch', async () => {
    const { call, service } = createHarnessScenario({
      candidateBranch: { codex: 'refs/heads/unexpected-branch' }
    })

    const run = await startHarness(service)
    await service.waitForExecution(run.id)

    expect(service.show(run.id).candidates[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('refs/heads/unexpected-branch')
    })
    expect(callsFor(call, 'orchestration.dispatch')).toHaveLength(0)
  })

  it('retries readiness without recreating an existing candidate', async () => {
    const { store } = createMemoryStore()
    const { runtime, call } = createRuntime({
      wait: (agent, attempt) =>
        agent === 'codex' && attempt === 1
          ? {
              handle: 'terminal-codex',
              condition: 'tui-idle',
              satisfied: false,
              status: 'running',
              exitCode: null,
              blockedReason: 'codex-trust-workspace'
            }
          : {
              handle: `terminal-${agent}`,
              condition: 'tui-idle',
              satisfied: true,
              status: 'running',
              exitCode: null
            }
    })
    const service = new HarnessService(store, runtime, { autoMonitor: false })

    const run = await startHarness(service)
    await service.waitForExecution(run.id)
    expect(service.show(run.id).candidates[0]).toMatchObject({
      status: 'creating',
      worktreeId: 'worktree-codex',
      error: 'Candidate agent needs attention: codex-trust-workspace.'
    })

    service.resume(run.id)
    await service.waitForExecution(run.id)

    expect(service.show(run.id).candidates.map((candidate) => candidate.status)).toEqual([
      'running',
      'running'
    ])
    expect(callsFor(call, 'worktree.create')).toHaveLength(2)
    expect(
      callsFor(call, 'terminal.wait').filter((params) => params.terminal === 'terminal-codex')
    ).toHaveLength(2)
  })

  it('waits for an SSH runtime to reconnect before creating persisted candidates', async () => {
    const { store } = createMemoryStore()
    const remoteStore: HarnessStore = {
      ...store,
      getRepo: (repoId) => (repoId === REPO.id ? { ...REPO, connectionId: 'ssh-1' } : undefined)
    }
    const run = createPersistedRun(remoteStore)
    const { runtime, call } = createRuntime({ remoteRuntimeReady: [false, true] })
    const service = new HarnessService(remoteStore, runtime, {
      autoMonitor: true,
      pollIntervalMs: 60_000
    })

    await service.waitForExecution(run.id)
    expect(callsFor(call, 'worktree.create')).toHaveLength(0)
    expect(service.show(run.id).candidates.map((candidate) => candidate.status)).toEqual([
      'pending',
      'pending'
    ])

    service.resume(run.id)
    await service.waitForExecution(run.id)
    expect(callsFor(call, 'worktree.create')).toHaveLength(2)
    expect(service.show(run.id).candidates.map((candidate) => candidate.status)).toEqual([
      'running',
      'running'
    ])
  })

  it('waits for SSH runtime readiness before verifying persisted worker results', async () => {
    const { store } = createMemoryStore()
    const remoteStore: HarnessStore = {
      ...store,
      getRepo: (repoId) => (repoId === REPO.id ? { ...REPO, connectionId: 'ssh-1' } : undefined)
    }
    const run = createPersistedRun(remoteStore)
    const workerCompletedAt = Date.now()
    for (const agent of ['codex', 'claude'] as const) {
      remoteStore.updateHarnessCandidate(run.id, agent, {
        status: 'worker_done',
        worktreeId: `worktree-${agent}`,
        worktreePath: `candidate-${agent}`,
        branch: branchRef(agent),
        agentTerminalHandle: `terminal-${agent}`,
        agentTerminalPaneKey: `pane-${agent}`,
        taskId: `task-${agent}`,
        dispatchId: `dispatch-${agent}`,
        workerResult: {
          messageId: `message-${agent}`,
          subject: `${agent} done`,
          body: 'done',
          payload: null,
          receivedAt: workerCompletedAt - 1
        },
        workerCompletedAt
      })
    }
    const { runtime, call } = createRuntime({
      remoteRuntimeReady: [false, true],
      verifyCandidates: true
    })
    const runPrecheck = vi.fn(async () => {
      const startedAt = Date.now()
      return {
        command: 'pnpm test',
        exitCode: 0,
        timedOut: false,
        durationMs: 1,
        stdout: 'passed',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        error: null,
        startedAt,
        completedAt: startedAt + 1
      }
    })
    const service = new HarnessService(remoteStore, runtime, {
      autoMonitor: true,
      pollIntervalMs: 60_000,
      runPrecheck
    })

    await service.waitForExecution(run.id)
    expect(callsFor(call, 'git.status')).toHaveLength(0)
    expect(runPrecheck).not.toHaveBeenCalled()

    service.resume(run.id)
    await service.waitForExecution(run.id)
    expect(callsFor(call, 'git.status')).toHaveLength(4)
    expect(runPrecheck).toHaveBeenCalledTimes(2)
    expect(service.show(run.id).candidates.map((candidate) => candidate.status)).toEqual([
      'verified',
      'verified'
    ])
  })

  it('recovers a worktree created just before a process interruption', async () => {
    const { store } = createMemoryStore()
    const run = createPersistedRun(store)
    store.updateHarnessCandidate(run.id, 'codex', { status: 'creating' })
    const { runtime, call } = createRuntime({ recoverInterruptedCreate: 'codex' })
    const service = new HarnessService(store, runtime, { autoMonitor: false })

    service.resume(run.id)
    await service.waitForExecution(run.id)

    expect(service.show(run.id).candidates[0]).toMatchObject({
      status: 'running',
      worktreeId: 'worktree-codex',
      agentTerminalHandle: 'terminal-codex',
      branch: branchRef('codex'),
      error: null
    })
    expect(
      callsFor(call, 'worktree.create').filter((params) => params.startupAgent === 'codex')
    ).toHaveLength(0)
    expect(callsFor(call, 'worktree.list')).toHaveLength(1)
  })

  it.each([
    ['a missing startup terminal', 'missing'],
    ['terminal discovery errors', 'error'],
    ['a truncated terminal listing', 'truncated']
  ] as const)('bounds recovery when an existing worktree has %s', async (_label, problem) => {
    const startedAt = 1_789_123_456_789
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(startedAt)
    const { store } = createMemoryStore()
    const run = createPersistedRun(store)
    store.updateHarnessCandidate(run.id, 'codex', { status: 'creating' })
    const { runtime, call } = createRuntime({
      recoverInterruptedCreate: 'codex',
      recoveryTerminalProblem: problem
    })
    const service = new HarnessService(store, runtime, { autoMonitor: false })

    service.resume(run.id)
    await service.waitForExecution(run.id)
    expect(service.show(run.id).candidates[0]).toMatchObject({
      status: 'creating',
      recoveryStartedAt: startedAt
    })

    dateNow.mockReturnValue(startedAt + 10 * 60_000)
    service.resume(run.id)
    await service.waitForExecution(run.id)

    expect(service.show(run.id).candidates[0]).toMatchObject({
      status: 'failed',
      error:
        'Candidate creation recovery timed out before the worktree and agent terminal were recorded.'
    })
    expect(callsFor(call, 'worktree.list')).toHaveLength(1)
    dateNow.mockRestore()
  })

  it('attempts both dispatches from one ready snapshot when one fails', async () => {
    const { call, service } = createHarnessScenario({ failDispatch: 'codex' })

    const run = await startHarness(service)
    await service.waitForExecution(run.id)

    const [codex, claude] = service.show(run.id).candidates
    expect(codex).toMatchObject({ status: 'failed', error: 'codex dispatch failed' })
    expect(claude).toMatchObject({ status: 'running', dispatchId: 'dispatch-claude' })
    expect(callsFor(call, 'orchestration.dispatch')).toHaveLength(2)
  })

  it('reuses a task durably created before its response was interrupted', async () => {
    const expectedSpec =
      'Implement this goal in the current worktree:\n\nGoal\n\n' +
      `Start SHA: ${BASE_SHA}\n` +
      'Do not push, merge, cherry-pick, delete branches or worktrees, or modify another worktree.'
    const { call, service } = createHarnessScenario({
      existingTask: { agent: 'codex', spec: expectedSpec }
    })

    const run = await startHarness(service)
    await service.waitForExecution(run.id)

    expect(service.show(run.id).candidates[0]).toMatchObject({
      status: 'running',
      taskId: 'task-codex',
      dispatchId: 'dispatch-codex'
    })
    expect(
      callsFor(call, 'orchestration.taskCreate').filter((params) =>
        String(params.taskTitle).includes('Codex')
      )
    ).toHaveLength(0)
  })

  it('keeps a transient pane remint resolution failure resumable', async () => {
    const { call, service } = createHarnessScenario({ failResolveOnDispatch: 'codex' })

    const run = await startHarness(service)
    await service.waitForExecution(run.id)
    expect(service.show(run.id).candidates[0]).toMatchObject({
      status: 'ready',
      error: 'Could not resolve candidate terminal: runtime graph is restoring'
    })

    service.resume(run.id)
    await service.waitForExecution(run.id)
    expect(service.show(run.id).candidates[0]).toMatchObject({
      status: 'running',
      error: null,
      dispatchId: 'dispatch-codex'
    })
    expect(
      callsFor(call, 'orchestration.dispatch').filter((params) => params.to === 'terminal-codex')
    ).toHaveLength(1)
  })

  it('retries a ready dispatch after its peer has already completed work', async () => {
    const { store, call, service } = createHarnessScenario({ failResolveOnDispatch: 'codex' })

    const run = await startHarness(service)
    await service.waitForExecution(run.id)
    store.updateHarnessCandidate(run.id, 'claude', {
      status: 'worker_done',
      workerResult: {
        messageId: 'message-claude',
        subject: 'claude done',
        body: 'done',
        payload: null,
        receivedAt: Date.now()
      },
      workerCompletedAt: Date.now()
    })

    service.resume(run.id)
    await service.waitForExecution(run.id)

    expect(service.show(run.id).candidates[0]).toMatchObject({
      status: 'running',
      error: null,
      dispatchId: 'dispatch-codex'
    })
    expect(
      callsFor(call, 'orchestration.dispatch').filter((params) => params.to === 'terminal-codex')
    ).toHaveLength(1)
  })

  it('reconciles a persisted dispatch instead of injecting the same task twice', async () => {
    const { call, service } = createHarnessScenario({ existingDispatch: 'codex' })

    const run = await startHarness(service)
    await service.waitForExecution(run.id)

    expect(service.show(run.id).candidates[0]).toMatchObject({
      status: 'running',
      dispatchId: 'dispatch-codex',
      error: HARNESS_DISPATCH_CONFIRMATION_PENDING
    })
    expect(
      callsFor(call, 'orchestration.dispatch').filter((params) => params.to === 'terminal-codex')
    ).toHaveLength(0)
    expect(callsFor(call, 'orchestration.dispatch')).toHaveLength(1)
  })

  it('reconciles a persisted dispatch after its terminal handle and tab are reminted', async () => {
    const { call, service } = createHarnessScenario({ remintedExistingDispatch: 'codex' })

    const run = await startHarness(service)
    await service.waitForExecution(run.id)

    expect(service.show(run.id).candidates[0]).toMatchObject({
      status: 'running',
      dispatchId: 'dispatch-codex',
      error: HARNESS_DISPATCH_CONFIRMATION_PENDING
    })
    expect(
      callsFor(call, 'orchestration.dispatch').filter((params) => params.to === 'terminal-codex')
    ).toHaveLength(0)
  })

  it('activates later runs when an earlier persisted run failed with a live candidate', async () => {
    const { store, runs } = createMemoryStore()
    const { runtime, call } = createRuntime()
    const first = new HarnessService(store, runtime, { autoMonitor: false })
    const run = await startHarness(first)
    await first.waitForExecution(run.id)

    // Why: a fatal run rejects every candidate write, so activation used to
    // throw on the first one — inside PTY wiring, stranding the IPC handlers
    // registered after it. Order the poisoned run first to prove it recovers.
    const healthy = runs.get(run.id)!
    runs.clear()
    runs.set('run-poisoned', {
      ...healthy,
      id: 'run-poisoned',
      sourceWorktreeId: 'repo-1::/other',
      fatalError: 'Runtime transport died.'
    })
    runs.set(healthy.id, healthy)

    const checksBeforeRecovery = callsFor(call, 'orchestration.check').length
    const recovered = new HarnessService(store, runtime, {
      autoMonitor: true,
      pollIntervalMs: 60_000
    })
    await recovered.waitForExecution(healthy.id)

    expect(callsFor(call, 'orchestration.check').length).toBeGreaterThan(checksBeforeRecovery)
    expect(recovered.show(healthy.id).candidates[0]).toMatchObject({
      status: 'running',
      error: HARNESS_DISPATCH_CONFIRMATION_PENDING
    })
    expect(recovered.show('run-poisoned').candidates[0].recoveryStartedAt).toBeNull()
  })

  it('reschedules persisted active runs when monitoring is recreated', async () => {
    const { store } = createMemoryStore()
    const { runtime, call } = createRuntime()
    const first = new HarnessService(store, runtime, { autoMonitor: false })
    const run = await startHarness(first)
    await first.waitForExecution(run.id)
    const checksBeforeRecovery = callsFor(call, 'orchestration.check').length

    const recovered = new HarnessService(store, runtime, {
      autoMonitor: true,
      pollIntervalMs: 60_000
    })
    await recovered.waitForExecution(run.id)

    expect(callsFor(call, 'orchestration.check').length).toBeGreaterThan(checksBeforeRecovery)
    expect(recovered.show(run.id).candidates[0]).toMatchObject({
      status: 'running',
      recoveryStartedAt: expect.any(Number),
      error: HARNESS_DISPATCH_CONFIRMATION_PENDING
    })
  })
})
