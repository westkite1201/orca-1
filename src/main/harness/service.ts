import type { Store } from '../persistence'
import {
  deriveHarnessRunStatus,
  type HarnessAllocationUpdateInput,
  type HarnessRun,
  type HarnessStartInput
} from '../../shared/harness-types'
import { assertNoActiveHarnessRun } from './active-run-guard'
import { normalizeHarnessExecutionPlan } from './allocation-validation'
import { executeHarnessCandidates } from './candidate-execution'
import { HARNESS_DISPATCH_CONFIRMATION_PENDING } from './candidate-launch'
import { harnessRecoveryStartedAt } from './candidate-recovery'
import type { HarnessRuntimeCaller } from './runtime-caller'
import { advanceHarnessCompletion, type HarnessVerificationRunner } from './verification'
import { VERIFICATION_INTERRUPTED_ERROR } from './candidate-verification-persistence'
import { materializeHarnessPlan } from './worktree-lane-materialization'
import { preflightHarnessSource, type HarnessSourcePreflight } from './harness-source-preflight'

export type { HarnessSourcePreflight } from './harness-source-preflight'

export type HarnessStore = Pick<
  Store,
  | 'getRepo'
  | 'listHarnessRuns'
  | 'getHarnessRun'
  | 'createHarnessRun'
  | 'updateHarnessCandidate'
  | 'failHarnessRun'
> & {
  updateHarnessAllocation?: (
    runId: string,
    patch: HarnessAllocationUpdateInput,
    options?: { durability?: 'best-effort' | 'required' }
  ) => HarnessRun
}

const DEFAULT_POLL_INTERVAL_MS = 2_000
const DEFAULT_VERIFICATION_TIMEOUT_SECONDS = 15 * 60

export type HarnessServiceOptions = {
  autoMonitor?: boolean
  deferExecutionUntilMonitoring?: boolean
  pollIntervalMs?: number
  verificationTimeoutSeconds?: number
  runPrecheck?: HarnessVerificationRunner
  onRunTerminal?: (run: HarnessRun) => Promise<void> | void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class HarnessService {
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly queuedRuns = new Map<string, 'full' | 'monitor'>()
  private readonly pollTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private monitoringActive = false
  private readonly pollIntervalMs: number
  private readonly verificationTimeoutSeconds: number
  private readonly runPrecheck: HarnessVerificationRunner | undefined
  private readonly deferExecutionUntilMonitoring: boolean
  private readonly onRunTerminal: HarnessServiceOptions['onRunTerminal']

  constructor(
    private readonly store: HarnessStore,
    private readonly runtime: HarnessRuntimeCaller,
    options: HarnessServiceOptions = {}
  ) {
    this.pollIntervalMs = Math.max(
      1,
      Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    )
    this.verificationTimeoutSeconds = Math.max(
      1,
      Math.floor(options.verificationTimeoutSeconds ?? DEFAULT_VERIFICATION_TIMEOUT_SECONDS)
    )
    this.runPrecheck = options.runPrecheck
    this.onRunTerminal = options.onRunTerminal
    this.deferExecutionUntilMonitoring = options.deferExecutionUntilMonitoring === true
    if (options.autoMonitor !== false) {
      this.activateMonitoring()
    }
  }

  activateMonitoring(): void {
    if (this.monitoringActive) {
      return
    }
    this.monitoringActive = true
    for (const persistedRun of this.store.listHarnessRuns()) {
      let run = persistedRun
      for (const candidate of run.candidates) {
        if (candidate.status === 'running') {
          run = this.store.updateHarnessCandidate(run.id, candidate.agent, {
            recoveryStartedAt: harnessRecoveryStartedAt(),
            error: HARNESS_DISPATCH_CONFIRMATION_PENDING
          })
        }
      }
      if (
        !run.fatalError &&
        run.candidates.some((candidate) => !['verified', 'failed'].includes(candidate.status))
      ) {
        this.schedule(run.id)
      }
    }
  }

  async start(input: HarnessStartInput): Promise<HarnessRun> {
    const worktree = input.worktree.trim()
    const goal = input.goal.trim()
    const verificationCommand = input.verificationCommand.trim()
    if (!worktree || !goal || !verificationCommand) {
      throw new Error('A worktree, goal, and verification command are required.')
    }
    const executionPlan =
      input.executionPlan === undefined
        ? undefined
        : normalizeHarnessExecutionPlan(input.executionPlan)
    if (executionPlan && input.mode !== 'orchestrator') {
      throw new Error('Harness execution plans require orchestrator mode.')
    }

    const jawsRunId = input.jawsRunId?.trim() || null
    const existingRun = jawsRunId
      ? this.store.listHarnessRuns().find((run) => run.jawsRunId === jawsRunId)
      : null
    if (existingRun) {
      return existingRun
    }

    const { source, baseSha } = await this.preflight(worktree)
    const expectedBaseSha = input.expectedBaseSha?.trim()
    if (expectedBaseSha && baseSha !== expectedBaseSha) {
      throw new Error('The source HEAD changed after this plan was proposed.')
    }
    // Why: status is asynchronous, so another start may have persisted a run
    // while this request was checking cleanliness.
    assertNoActiveHarnessRun(this.store.listHarnessRuns(source.repoId), source.id)
    const run = this.store.createHarnessRun({
      repoId: source.repoId,
      sourceWorktreeId: source.id,
      sourceWorktreePath: source.git.path,
      goal,
      verificationCommand,
      baseSha,
      mode: input.mode,
      ...(jawsRunId ? { jawsRunId } : {}),
      ...(input.approvedPlan ? { approvedPlan: input.approvedPlan } : {}),
      ...(input.approvedLinearMaterialization
        ? { approvedLinearMaterialization: input.approvedLinearMaterialization }
        : {}),
      ...(executionPlan ? { executionPlan } : {})
    })
    if (this.monitoringActive || !this.deferExecutionUntilMonitoring) {
      this.schedule(run.id)
    }
    return run
  }

  async preflight(worktreeSelector: string): Promise<HarnessSourcePreflight> {
    return preflightHarnessSource(this.store, this.runtime, worktreeSelector)
  }

  list(repoId?: string): HarnessRun[] {
    return this.store.listHarnessRuns(repoId)
  }

  show(runId: string): HarnessRun {
    const run = this.store.getHarnessRun(runId)
    if (!run) {
      throw new Error('Run not found.')
    }
    return run
  }

  resume(runId: string): HarnessRun {
    let run = this.show(runId)
    for (const candidate of run.candidates) {
      if (
        candidate.status === 'verifying' &&
        candidate.error &&
        candidate.verification?.error !== VERIFICATION_INTERRUPTED_ERROR
      ) {
        run = this.store.updateHarnessCandidate(run.id, candidate.agent, {
          diff: null,
          verification: null,
          error: null
        })
      }
    }
    if (
      !run.fatalError &&
      run.candidates.some((candidate) => !['verified', 'failed'].includes(candidate.status))
    ) {
      this.schedule(run.id)
    }
    return run
  }

  async advance(runId: string): Promise<HarnessRun> {
    this.show(runId)
    await this.inFlight.get(runId)
    this.schedule(runId, 'monitor')
    await this.waitForExecution(runId)
    return this.show(runId)
  }

  async waitForExecution(runId: string): Promise<void> {
    let current = this.inFlight.get(runId)
    while (current) {
      await current
      current = this.inFlight.get(runId)
    }
  }

  private schedule(runId: string, mode: 'full' | 'monitor' = 'full'): void {
    if (this.inFlight.has(runId)) {
      const queued = this.queuedRuns.get(runId)
      this.queuedRuns.set(runId, queued === 'full' || mode === 'full' ? 'full' : 'monitor')
      return
    }
    this.clearPoll(runId)
    const execution = (mode === 'full' ? this.execute(runId) : this.advanceCompletion(runId))
      .catch((error) => {
        this.store.failHarnessRun(runId, errorMessage(error))
      })
      .finally(() => {
        if (this.inFlight.get(runId) === execution) {
          this.inFlight.delete(runId)
          const queued = this.queuedRuns.get(runId)
          if (queued) {
            this.queuedRuns.delete(runId)
            this.schedule(runId, queued)
          } else {
            this.armPoll(runId)
          }
        }
      })
    this.inFlight.set(runId, execution)
  }

  private clearPoll(runId: string): void {
    const timer = this.pollTimers.get(runId)
    if (timer) {
      clearTimeout(timer)
      this.pollTimers.delete(runId)
    }
  }

  private armPoll(runId: string): void {
    const run = this.show(runId)
    if (
      !this.monitoringActive ||
      run.fatalError ||
      !run.candidates.some((entry) => !['verified', 'failed'].includes(entry.status))
    ) {
      return
    }
    // Why: completion monitoring is best-effort background work and must not
    // keep the desktop/runtime process alive after every candidate is terminal.
    const timer = setTimeout(() => {
      this.pollTimers.delete(runId)
      this.schedule(runId)
    }, this.pollIntervalMs)
    timer.unref?.()
    this.pollTimers.set(runId, timer)
  }

  private async execute(runId: string): Promise<void> {
    const hostReady = await executeHarnessCandidates({
      store: this.store,
      runtime: this.runtime,
      runId
    })
    if (hostReady) {
      const run = this.store.getHarnessRun(runId)
      if (run?.executionPlan) {
        await materializeHarnessPlan({ runtime: this.runtime, store: this.store, run })
      }
      await this.advanceCompletion(runId)
    }
  }

  private async advanceCompletion(runId: string): Promise<void> {
    await advanceHarnessCompletion({
      store: this.store,
      runtime: this.runtime,
      runId,
      timeoutSeconds: this.verificationTimeoutSeconds,
      runPrecheck: this.runPrecheck
    })
    const run = this.show(runId)
    if (deriveHarnessRunStatus(run) === 'completed') {
      await this.onRunTerminal?.(run)
    }
  }
}
