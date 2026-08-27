import { randomUUID } from 'node:crypto'
import {
  canTransitionHarnessCandidateStatus,
  deriveHarnessRunStatus,
  isHarnessCandidateVerified,
  type HarnessAgent,
  type HarnessCandidate,
  type HarnessCandidatePatch,
  type HarnessRun,
  type HarnessRunCreateInput
} from '../../../shared/harness-types'
import {
  createHarnessAllocationState,
  type HarnessAllocationPatchV1
} from '../../../shared/harness-allocation-types'
import {
  isConfirmedJawsLinearMaterialization,
  jawsLinearMaterializationSchema,
  jawsPlanSchema
} from '../../../shared/jaws-types'
import { normalizeHarnessExecutionPlan } from '../../harness/allocation-validation'
import {
  createPendingHarnessCandidate,
  pruneHarnessRuns,
  pruneJawsRuns
} from './harness-jaws-run-state'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteFlushBarrierOperations } from './write-flush-barriers'

type HarnessRunRuntime = Pick<StoreRuntimeState, 'state' | 'flushOrThrow'>
const harnessRunPersistenceContext = Symbol('HarnessRunPersistence')

function stateOf(owner: HarnessRunPersistence) {
  return owner[harnessRunPersistenceContext].runtime.state
}

function flushRequired(owner: HarnessRunPersistence): void {
  owner[harnessRunPersistenceContext].runtime.flushOrThrow()
}

function flushBestEffort(owner: HarnessRunPersistence): void {
  owner[harnessRunPersistenceContext].flushBarriers.flush()
}

export class HarnessRunPersistence {
  readonly [harnessRunPersistenceContext]: {
    runtime: HarnessRunRuntime
    flushBarriers: WriteFlushBarrierOperations
  }

  constructor(runtime: HarnessRunRuntime, flushBarriers: WriteFlushBarrierOperations) {
    this[harnessRunPersistenceContext] = { runtime, flushBarriers }
  }

  listHarnessRuns(repoId?: string): HarnessRun[] {
    const runs = repoId
      ? stateOf(this).harnessRuns.filter((run) => run.repoId === repoId)
      : stateOf(this).harnessRuns
    return [...runs].sort((left, right) => right.createdAt - left.createdAt)
  }

  getHarnessRun(runId: string): HarnessRun | null {
    return stateOf(this).harnessRuns.find((run) => run.id === runId) ?? null
  }

  createHarnessRun(input: HarnessRunCreateInput): HarnessRun {
    const repoId = input.repoId.trim()
    const sourceWorktreeId = input.sourceWorktreeId.trim()
    const sourceWorktreePath = input.sourceWorktreePath.trim()
    const goal = input.goal.trim()
    const verificationCommand = input.verificationCommand.trim()
    const baseSha = input.baseSha.trim()
    const mode = input.mode ?? 'comparison'
    const approvedPlan = input.approvedPlan ? jawsPlanSchema.parse(input.approvedPlan) : undefined
    const approvedLinearMaterialization = input.approvedLinearMaterialization
      ? jawsLinearMaterializationSchema.parse(input.approvedLinearMaterialization)
      : undefined
    const executionPlan = input.executionPlan
      ? normalizeHarnessExecutionPlan(input.executionPlan)
      : undefined
    if (
      !repoId ||
      !sourceWorktreeId ||
      !sourceWorktreePath ||
      !goal ||
      !verificationCommand ||
      !baseSha
    ) {
      throw new Error('Harness runs require a repository, source worktree, goal, command, and SHA.')
    }
    if (approvedPlan && mode !== 'orchestrator') {
      throw new Error('Approved plans require orchestrator mode.')
    }
    if (executionPlan && mode !== 'orchestrator') {
      throw new Error('Harness execution plans require orchestrator mode.')
    }
    if (
      approvedPlan?.linear &&
      (!approvedLinearMaterialization ||
        !isConfirmedJawsLinearMaterialization(approvedPlan, approvedLinearMaterialization))
    ) {
      throw new Error('Linear materialization must be confirmed before Harness starts.')
    }
    if (approvedLinearMaterialization && !approvedPlan?.linear) {
      throw new Error('Linear materialization requires an approved Linear plan.')
    }

    const harnessBefore = [...stateOf(this).harnessRuns]
    const jawsBefore = [...stateOf(this).jawsRuns]
    const now = Date.now()
    const run: HarnessRun = {
      id: randomUUID(),
      repoId,
      sourceWorktreeId,
      sourceWorktreePath,
      goal,
      verificationCommand,
      baseSha,
      ...(executionPlan
        ? { executionPlan, allocation: createHarnessAllocationState(executionPlan) }
        : {}),
      mode,
      ...(input.jawsRunId ? { jawsRunId: input.jawsRunId.trim() } : {}),
      ...(approvedPlan ? { approvedPlan: structuredClone(approvedPlan) } : {}),
      ...(approvedLinearMaterialization
        ? { approvedLinearMaterialization: structuredClone(approvedLinearMaterialization) }
        : {}),
      candidates:
        mode === 'orchestrator'
          ? [createPendingHarnessCandidate('codex', now)]
          : [
              createPendingHarnessCandidate('codex', now),
              createPendingHarnessCandidate('claude', now)
            ],
      fatalError: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    }
    stateOf(this).harnessRuns = pruneHarnessRuns([...stateOf(this).harnessRuns, run])
    stateOf(this).jawsRuns = pruneJawsRuns(stateOf(this).jawsRuns, stateOf(this).harnessRuns)
    try {
      flushRequired(this)
    } catch (error) {
      stateOf(this).harnessRuns = harnessBefore
      stateOf(this).jawsRuns = jawsBefore
      throw error
    }
    return run
  }

  updateHarnessCandidate(
    runId: string,
    agent: HarnessAgent,
    patch: HarnessCandidatePatch,
    options: { durability?: 'best-effort' | 'required' } = {}
  ): HarnessRun {
    const harnessBefore = [...stateOf(this).harnessRuns]
    const jawsBefore = [...stateOf(this).jawsRuns]
    const index = stateOf(this).harnessRuns.findIndex((run) => run.id === runId)
    if (index === -1) {
      throw new Error('Harness run not found.')
    }
    const currentRun = stateOf(this).harnessRuns[index]
    if (currentRun.fatalError !== null) {
      throw new Error('Harness run has already failed.')
    }
    const current = currentRun.candidates.find((candidate) => candidate.agent === agent)
    if (!current) {
      throw new Error('Harness candidate not found.')
    }
    if (current.status === 'verified' || current.status === 'failed') {
      throw new Error('Harness candidate evidence is immutable after completion.')
    }
    const status = patch.status ?? current.status
    if (status !== current.status && !canTransitionHarnessCandidateStatus(current.status, status)) {
      throw new Error(`Invalid Harness candidate transition: ${current.status} -> ${status}.`)
    }
    const now = Date.now()
    const terminal = status === 'verified' || status === 'failed'
    const candidate: HarnessCandidate = {
      ...current,
      ...patch,
      id: current.id,
      agent: current.agent,
      status,
      updatedAt: now,
      startedAt: patch.startedAt ?? current.startedAt ?? (status === 'running' ? now : null),
      workerCompletedAt:
        patch.workerCompletedAt ??
        current.workerCompletedAt ??
        (status === 'worker_done' ? now : null),
      completedAt: patch.completedAt ?? current.completedAt ?? (terminal ? now : null)
    }
    if (
      candidate.status === 'verified' &&
      !isHarnessCandidateVerified(candidate, currentRun.verificationCommand)
    ) {
      throw new Error(
        'Verified Harness candidates require worker, command, test, and Git evidence.'
      )
    }
    const next: HarnessRun = {
      ...currentRun,
      candidates: currentRun.candidates.map((entry) => (entry.agent === agent ? candidate : entry)),
      updatedAt: now
    }
    const runStatus = deriveHarnessRunStatus(next)
    next.completedAt =
      runStatus === 'completed' || runStatus === 'failed' ? (currentRun.completedAt ?? now) : null
    stateOf(this).harnessRuns[index] = next
    if (next.completedAt !== null) {
      stateOf(this).harnessRuns = pruneHarnessRuns(stateOf(this).harnessRuns)
      stateOf(this).jawsRuns = pruneJawsRuns(stateOf(this).jawsRuns, stateOf(this).harnessRuns)
    }
    try {
      if (options.durability === 'required') {
        flushRequired(this)
      } else {
        flushBestEffort(this)
      }
    } catch (error) {
      stateOf(this).harnessRuns = harnessBefore
      stateOf(this).jawsRuns = jawsBefore
      throw error
    }
    return next
  }

  updateHarnessAllocation(
    runId: string,
    patch: HarnessAllocationPatchV1,
    options: { durability?: 'best-effort' | 'required' } = {}
  ): HarnessRun {
    const before = [...stateOf(this).harnessRuns]
    const index = stateOf(this).harnessRuns.findIndex((run) => run.id === runId)
    if (index === -1) {
      throw new Error('Harness run not found.')
    }
    const current = stateOf(this).harnessRuns[index]
    if (!current.allocation) {
      throw new Error('Harness run has no allocation state.')
    }
    if (current.fatalError !== null) {
      throw new Error('Harness run has already failed.')
    }
    if (
      patch.item &&
      !current.allocation.items.some((item) => item.itemKey === patch.item?.itemKey)
    ) {
      throw new Error('Harness allocation item not found.')
    }
    const allocation = {
      ...current.allocation,
      ...(patch.integrationWorktreeId !== undefined
        ? { integrationWorktreeId: patch.integrationWorktreeId }
        : {}),
      ...(patch.integrationHeadSha !== undefined
        ? { integrationHeadSha: patch.integrationHeadSha }
        : {}),
      items: patch.item
        ? current.allocation.items.map((item) =>
            item.itemKey === patch.item?.itemKey ? { ...item, ...patch.item } : item
          )
        : current.allocation.items
    }
    const next = { ...current, allocation, updatedAt: Date.now() }
    stateOf(this).harnessRuns[index] = next
    try {
      if (options.durability === 'required') {
        flushRequired(this)
      } else {
        flushBestEffort(this)
      }
    } catch (error) {
      stateOf(this).harnessRuns = before
      throw error
    }
    return next
  }

  failHarnessRun(runId: string, error: string): HarnessRun {
    const index = stateOf(this).harnessRuns.findIndex((run) => run.id === runId)
    if (index === -1) {
      throw new Error('Harness run not found.')
    }
    const fatalError = error.trim()
    if (!fatalError) {
      throw new Error('Harness run failures require an error message.')
    }
    const now = Date.now()
    const failed = {
      ...stateOf(this).harnessRuns[index],
      fatalError,
      updatedAt: now,
      completedAt: now
    }
    stateOf(this).harnessRuns[index] = failed
    stateOf(this).harnessRuns = pruneHarnessRuns(stateOf(this).harnessRuns)
    stateOf(this).jawsRuns = pruneJawsRuns(stateOf(this).jawsRuns, stateOf(this).harnessRuns)
    flushBestEffort(this)
    return failed
  }
}

export function installHarnessRunPersistenceContext(
  target: object,
  source: HarnessRunPersistence
): void {
  Object.defineProperty(target, harnessRunPersistenceContext, {
    value: source[harnessRunPersistenceContext]
  })
}
