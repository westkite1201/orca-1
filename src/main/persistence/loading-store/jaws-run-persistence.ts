import { randomUUID } from 'node:crypto'
import type {
  JawsLinearMaterialization,
  JawsPlanningRun,
  JawsPlanningRunCreateInput,
  JawsReviewPublication,
  JawsRun,
  JawsRunCreateInput
} from '../../../shared/jaws-types'
import {
  jawsLinearMaterializationSchema,
  jawsReviewPublicationSchema
} from '../../../shared/jaws-types'
import {
  createJawsLinearMaterialization,
  createJawsReviewPublication,
  pruneJawsRuns
} from './harness-jaws-run-state'
import { pruneJawsPlanningRuns } from './jaws-planning-run-state'
import type { StoreRuntimeState } from './store-runtime-state'

type JawsRunRuntime = Pick<StoreRuntimeState, 'state' | 'flushOrThrow'>
const jawsRunPersistenceContext = Symbol('JawsRunPersistence')

function stateOf(owner: JawsRunPersistence) {
  return owner[jawsRunPersistenceContext].state
}

function requireJawsRun(owner: JawsRunPersistence, runId: string): JawsRun {
  const run = owner.getJawsRun(runId)
  if (!run) {
    throw new Error('Jaws run not found.')
  }
  return run
}

function replaceJawsRun(owner: JawsRunPersistence, run: JawsRun): JawsRun {
  const state = stateOf(owner)
  const before = [...state.jawsRuns]
  state.jawsRuns = pruneJawsRuns(
    state.jawsRuns.map((entry) => (entry.id === run.id ? run : entry)),
    state.harnessRuns
  )
  try {
    owner[jawsRunPersistenceContext].flushOrThrow()
  } catch (error) {
    state.jawsRuns = before
    throw error
  }
  return run
}

function replaceJawsPlanningRun(owner: JawsRunPersistence, run: JawsPlanningRun): JawsPlanningRun {
  const state = stateOf(owner)
  const before = [...state.jawsPlanningRuns]
  state.jawsPlanningRuns = pruneJawsPlanningRuns(
    state.jawsPlanningRuns.map((entry) => (entry.id === run.id ? run : entry))
  )
  try {
    owner[jawsRunPersistenceContext].flushOrThrow()
  } catch (error) {
    state.jawsPlanningRuns = before
    throw error
  }
  return run
}

export class JawsRunPersistence {
  readonly [jawsRunPersistenceContext]: JawsRunRuntime

  constructor(runtime: JawsRunRuntime) {
    this[jawsRunPersistenceContext] = runtime
  }

  listJawsPlanningRuns(filters: { sourceWorktreeId?: string } = {}): JawsPlanningRun[] {
    return stateOf(this)
      .jawsPlanningRuns.filter(
        (run) => !filters.sourceWorktreeId || run.sourceWorktreeId === filters.sourceWorktreeId
      )
      .sort((left, right) => right.createdAt - left.createdAt)
  }

  getJawsPlanningRun(runId: string): JawsPlanningRun | null {
    return stateOf(this).jawsPlanningRuns.find((run) => run.id === runId) ?? null
  }

  createJawsPlanningRun(input: JawsPlanningRunCreateInput): JawsPlanningRun {
    const state = stateOf(this)
    const before = [...state.jawsPlanningRuns]
    const now = Date.now()
    const run: JawsPlanningRun = {
      id: randomUUID(),
      ...input,
      status: 'queued',
      question: null,
      jawsRunId: null,
      error: null,
      logs: [],
      createdAt: now,
      updatedAt: now
    }
    state.jawsPlanningRuns = pruneJawsPlanningRuns([...state.jawsPlanningRuns, run])
    try {
      this[jawsRunPersistenceContext].flushOrThrow()
    } catch (error) {
      state.jawsPlanningRuns = before
      throw error
    }
    return run
  }

  updateJawsPlanningRun(
    runId: string,
    patch: Partial<Pick<JawsPlanningRun, 'status' | 'question' | 'jawsRunId' | 'error' | 'logs'>>
  ): JawsPlanningRun {
    const run = this.getJawsPlanningRun(runId)
    if (!run) {
      throw new Error('Jaws planning run not found.')
    }
    return replaceJawsPlanningRun(this, { ...run, ...patch, updatedAt: Date.now() })
  }

  listJawsRuns(filters: { repoId?: string; sourceWorktreeId?: string } = {}): JawsRun[] {
    return stateOf(this)
      .jawsRuns.filter(
        (run) =>
          (!filters.repoId || run.repoId === filters.repoId) &&
          (!filters.sourceWorktreeId || run.sourceWorktreeId === filters.sourceWorktreeId)
      )
      .sort((left, right) => right.createdAt - left.createdAt)
  }

  getJawsRun(runId: string): JawsRun | null {
    return stateOf(this).jawsRuns.find((run) => run.id === runId) ?? null
  }

  saveJawsPlan(input: JawsRunCreateInput): JawsRun {
    const state = stateOf(this)
    const before = [...state.jawsRuns]
    const existing = this.listJawsRuns({ sourceWorktreeId: input.sourceWorktreeId }).find(
      (run) => run.approvalStartedAt === null
    )
    const now = Date.now()
    const run: JawsRun = existing
      ? {
          ...existing,
          repoId: input.repoId,
          sourceWorktreePath: input.sourceWorktreePath,
          baseSha: input.baseSha,
          revision: existing.revision + 1,
          planHash: input.planHash,
          plan: structuredClone(input.plan),
          linearMaterialization: createJawsLinearMaterialization(input.plan, now),
          reviewPublication: createJawsReviewPublication(input.plan, now),
          error: null,
          updatedAt: now
        }
      : {
          id: randomUUID(),
          repoId: input.repoId,
          sourceWorktreeId: input.sourceWorktreeId,
          sourceWorktreePath: input.sourceWorktreePath,
          baseSha: input.baseSha,
          revision: 1,
          planHash: input.planHash,
          plan: structuredClone(input.plan),
          linearMaterialization: createJawsLinearMaterialization(input.plan, now),
          reviewPublication: createJawsReviewPublication(input.plan, now),
          approvalStartedAt: null,
          harnessRunId: null,
          error: null,
          createdAt: now,
          updatedAt: now
        }
    state.jawsRuns = pruneJawsRuns(
      existing
        ? state.jawsRuns.map((entry) => (entry.id === run.id ? run : entry))
        : [...state.jawsRuns, run],
      state.harnessRuns
    )
    try {
      this[jawsRunPersistenceContext].flushOrThrow()
    } catch (error) {
      state.jawsRuns = before
      throw error
    }
    return run
  }

  markJawsApprovalStarted(runId: string): JawsRun {
    const run = requireJawsRun(this, runId)
    if (run.harnessRunId) {
      return run
    }
    return replaceJawsRun(this, {
      ...run,
      approvalStartedAt: run.approvalStartedAt ?? Date.now(),
      error: null,
      updatedAt: Date.now()
    })
  }

  attachJawsHarnessRun(runId: string, harnessRunId: string): JawsRun {
    const run = requireJawsRun(this, runId)
    const harnessRun = stateOf(this).harnessRuns.find((entry) => entry.id === harnessRunId)
    if (!harnessRun || harnessRun.jawsRunId !== runId) {
      throw new Error('The Harness run is not correlated with this Jaws run.')
    }
    return replaceJawsRun(this, { ...run, harnessRunId, error: null, updatedAt: Date.now() })
  }

  failJawsApproval(runId: string, error: string): JawsRun {
    const run = requireJawsRun(this, runId)
    return replaceJawsRun(this, { ...run, error: error.trim(), updatedAt: Date.now() })
  }

  updateJawsLinearMaterialization(
    runId: string,
    materialization: JawsLinearMaterialization
  ): JawsRun {
    const run = requireJawsRun(this, runId)
    if (!run.plan.linear) {
      throw new Error('This Jaws run has no Linear plan.')
    }
    return replaceJawsRun(this, {
      ...run,
      linearMaterialization: structuredClone(
        jawsLinearMaterializationSchema.parse(materialization)
      ),
      updatedAt: Date.now()
    })
  }

  updateJawsReviewPublication(runId: string, publication: JawsReviewPublication): JawsRun {
    const run = requireJawsRun(this, runId)
    if (!run.plan.review) {
      throw new Error('This Jaws run has no review plan.')
    }
    return replaceJawsRun(this, {
      ...run,
      reviewPublication: structuredClone(jawsReviewPublicationSchema.parse(publication)),
      updatedAt: Date.now()
    })
  }
}

export function installJawsRunPersistenceContext(target: object, source: JawsRunPersistence): void {
  Object.defineProperty(target, jawsRunPersistenceContext, {
    value: source[jawsRunPersistenceContext]
  })
}
