import { jawsPlanningRunSchema, type JawsPlanningRun } from '../../../shared/jaws-planning-types'

const MAX_TERMINAL_PLANNING_RUNS = 50

export function pruneJawsPlanningRuns(runs: readonly JawsPlanningRun[]): JawsPlanningRun[] {
  const active = runs.filter(
    (run) => run.status === 'queued' || run.status === 'planning' || run.status === 'needs_input'
  )
  const terminal = runs
    .filter((run) => !active.includes(run))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_TERMINAL_PLANNING_RUNS)
  return [...active, ...terminal]
}

export function normalizeJawsPlanningRuns(
  value: unknown,
  markNeedsSave: () => void
): JawsPlanningRun[] {
  if (!Array.isArray(value)) {
    return []
  }
  const normalized = value.flatMap((entry) => {
    const parsed = jawsPlanningRunSchema.safeParse(entry)
    if (!parsed.success) {
      markNeedsSave()
      return []
    }
    if (parsed.data.status !== 'queued' && parsed.data.status !== 'planning') {
      return [parsed.data]
    }
    markNeedsSave()
    return [
      {
        ...parsed.data,
        status: 'failed' as const,
        error: 'Planning was interrupted when the runtime stopped.',
        updatedAt: Date.now()
      }
    ]
  })
  const pruned = pruneJawsPlanningRuns(normalized)
  if (pruned.length !== normalized.length) {
    markNeedsSave()
  }
  return pruned
}
