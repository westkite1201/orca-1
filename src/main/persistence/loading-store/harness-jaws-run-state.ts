import { randomUUID } from 'node:crypto'
import {
  deriveHarnessRunStatus,
  type HarnessAgent,
  type HarnessCandidate,
  type HarnessRun
} from '../../../shared/harness-types'
import {
  isConfirmedJawsLinearMaterialization,
  jawsLinearMaterializationSchema,
  jawsPlanSchema,
  jawsReviewPublicationSchema,
  jawsRunSchema,
  type JawsLinearMaterialization,
  type JawsPlan,
  type JawsReviewPublication,
  type JawsRun
} from '../../../shared/jaws-types'

const MAX_TERMINAL_RUNS = 50

export function createPendingHarnessCandidate<TAgent extends HarnessAgent>(
  agent: TAgent,
  now: number
): HarnessCandidate<TAgent> {
  return {
    id: randomUUID(),
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

function isTerminalHarnessRun(run: HarnessRun): boolean {
  const status = deriveHarnessRunStatus(run)
  return status === 'completed' || status === 'failed'
}

export function pruneHarnessRuns(runs: readonly HarnessRun[]): HarnessRun[] {
  const retained = new Set(
    runs
      .filter(isTerminalHarnessRun)
      .sort(
        (left, right) =>
          (right.completedAt ?? right.updatedAt) - (left.completedAt ?? left.updatedAt) ||
          right.createdAt - left.createdAt ||
          right.id.localeCompare(left.id)
      )
      .slice(0, MAX_TERMINAL_RUNS)
      .map((run) => run.id)
  )
  return runs.filter((run) => !isTerminalHarnessRun(run) || retained.has(run.id))
}

export function pruneJawsRuns(
  runs: readonly JawsRun[],
  harnessRuns: readonly HarnessRun[]
): JawsRun[] {
  const harnessById = new Map(harnessRuns.map((run) => [run.id, run]))
  const isTerminal = (run: JawsRun): boolean => {
    if (run.error !== null) {
      return true
    }
    if (run.harnessRunId === null) {
      return false
    }
    const harnessRun = harnessById.get(run.harnessRunId)
    return !harnessRun || isTerminalHarnessRun(harnessRun)
  }
  const retained = new Set(
    runs
      .filter(isTerminal)
      .sort(
        (left, right) =>
          right.updatedAt - left.updatedAt ||
          right.createdAt - left.createdAt ||
          right.id.localeCompare(left.id)
      )
      .slice(0, MAX_TERMINAL_RUNS)
      .map((run) => run.id)
  )
  return runs.filter((run) => !isTerminal(run) || retained.has(run.id))
}

export function createJawsLinearMaterialization(
  plan: JawsPlan,
  now: number
): JawsLinearMaterialization | null {
  if (!plan.linear) {
    return null
  }
  return {
    status: 'planned',
    rootIssue: null,
    items: plan.tasks.map((task) => ({ key: task.key, issue: null })),
    effects: [
      {
        key: 'root',
        kind: plan.linear.rootIssue.kind === 'create' ? 'root_create' : 'root_read',
        writeId: plan.linear.rootIssue.kind === 'create' ? randomUUID() : null,
        state: 'planned',
        remoteId: null,
        error: null,
        updatedAt: now
      },
      ...plan.tasks.map((task) => ({
        key: `child:${task.key}`,
        kind: 'child_create' as const,
        writeId: randomUUID(),
        state: 'planned' as const,
        remoteId: null,
        error: null,
        updatedAt: now
      })),
      ...plan.tasks.flatMap((task) =>
        task.dependsOn.map((dependency) => ({
          key: `relation:${dependency}:${task.key}`,
          kind: 'relation' as const,
          writeId: null,
          state: 'planned' as const,
          remoteId: null,
          error: null,
          updatedAt: now
        }))
      )
    ],
    error: null,
    updatedAt: now
  }
}

export function createJawsReviewPublication(
  plan: JawsPlan,
  now: number
): JawsReviewPublication | null {
  if (!plan.review) {
    return null
  }
  return {
    status: 'planned',
    provider: plan.review.provider,
    baseBranch: plan.review.baseBranch,
    headBranch: null,
    headSha: null,
    review: null,
    manualUrl: null,
    effects: [
      ...(['push', 'create'] as const).map((kind) => ({
        key: kind,
        kind,
        writeId: null,
        state: 'planned' as const,
        remoteId: null,
        error: null,
        updatedAt: now
      })),
      ...(plan.linear
        ? [
            ...(['attachment', 'comment'] as const).map((suffix) => ({
              key: `linear:root:${suffix}`,
              kind:
                suffix === 'attachment' ? ('root_attachment' as const) : ('root_comment' as const),
              writeId: randomUUID(),
              state: 'planned' as const,
              remoteId: null,
              error: null,
              updatedAt: now
            })),
            ...plan.tasks.map((task) => ({
              key: `linear:child:${task.key}:state`,
              kind: 'child_state' as const,
              writeId: null,
              state: 'planned' as const,
              remoteId: null,
              error: null,
              updatedAt: now
            }))
          ]
        : [])
    ],
    error: null,
    updatedAt: now
  }
}

export function normalizeHarnessRuns(value: unknown, markNeedsSave: () => void): HarnessRun[] {
  if (!Array.isArray(value)) {
    return []
  }
  const normalized: HarnessRun[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || !Array.isArray((entry as HarnessRun).candidates)) {
      markNeedsSave()
      continue
    }
    const run = entry as HarnessRun
    const approvedPlan = jawsPlanSchema.safeParse(run.approvedPlan)
    const approvedLinear = jawsLinearMaterializationSchema.safeParse(
      run.approvedLinearMaterialization
    )
    const invalidLinear =
      approvedPlan.success && approvedPlan.data.linear
        ? !approvedLinear.success ||
          !isConfirmedJawsLinearMaterialization(approvedPlan.data, approvedLinear.data)
        : run.approvedLinearMaterialization !== undefined
    const invalidPlan =
      ((run.approvedPlan !== undefined || Boolean(run.jawsRunId)) && !approvedPlan.success) ||
      invalidLinear
    if (invalidPlan || (run.mode !== 'comparison' && run.mode !== 'orchestrator')) {
      markNeedsSave()
    }
    normalized.push({
      ...run,
      mode: run.mode === 'orchestrator' ? 'orchestrator' : 'comparison',
      ...(approvedPlan.success ? { approvedPlan: approvedPlan.data } : { approvedPlan: undefined }),
      ...(approvedLinear.success && !invalidLinear
        ? { approvedLinearMaterialization: approvedLinear.data }
        : { approvedLinearMaterialization: undefined }),
      fatalError: invalidPlan
        ? (run.fatalError ?? 'Persisted approved Jaws plan failed validation.')
        : run.fatalError,
      completedAt: invalidPlan
        ? (run.completedAt ?? run.updatedAt ?? run.createdAt)
        : run.completedAt,
      candidates: run.candidates.map((candidate) => ({
        ...candidate,
        agentTerminalPaneKey: candidate.agentTerminalPaneKey ?? null,
        verificationTerminalHandle: candidate.verificationTerminalHandle ?? null,
        verificationTerminalPaneKey: candidate.verificationTerminalPaneKey ?? null,
        verificationTerminalOwnership:
          candidate.verificationTerminalOwnership === 'pending' ||
          candidate.verificationTerminalOwnership === 'owned' ||
          candidate.verificationTerminalOwnership === 'stopped'
            ? candidate.verificationTerminalOwnership
            : null,
        workerResult: candidate.workerResult ?? null,
        recoveryStartedAt: candidate.recoveryStartedAt ?? null,
        childLaneDrainStartedAt: candidate.childLaneDrainStartedAt ?? null
      })) as HarnessRun['candidates']
    })
  }
  const pruned = pruneHarnessRuns(normalized)
  if (pruned.length !== normalized.length) {
    markNeedsSave()
  }
  return pruned
}

export function normalizeJawsRuns(
  value: unknown,
  harnessRuns: readonly HarnessRun[],
  markNeedsSave: () => void
): JawsRun[] {
  if (!Array.isArray(value)) {
    return []
  }
  const normalized = value.flatMap((entry) => {
    const parsed = jawsRunSchema.safeParse(entry)
    if (parsed.success) {
      return [parsed.data]
    }
    markNeedsSave()
    return []
  })
  const pruned = pruneJawsRuns(normalized, harnessRuns)
  if (pruned.length !== normalized.length) {
    markNeedsSave()
  }
  return pruned
}

export { jawsLinearMaterializationSchema, jawsReviewPublicationSchema }
