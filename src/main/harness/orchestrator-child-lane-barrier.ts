import type { HarnessCandidate, HarnessRun } from '../../shared/harness-types'
import type { TaskRow } from '../runtime/orchestration/types'

function laneName(task: TaskRow): string {
  return task.display_name?.trim() || task.task_title?.trim() || task.id
}

const MAX_REPORTED_LANES = 3

function summarizeLaneNames(tasks: readonly TaskRow[]): string {
  const shown = tasks.slice(0, MAX_REPORTED_LANES).map(laneName)
  const remaining = tasks.length - shown.length
  return remaining > 0 ? `${shown.join(', ')}, and ${remaining} more` : shown.join(', ')
}

export type OrchestratorChildLaneBlocker = {
  kind: 'active' | 'unsuccessful'
  message: string
}

export function findOrchestratorChildLaneBlocker(args: {
  run: HarnessRun
  candidate: HarnessCandidate
  tasks: readonly TaskRow[]
}): OrchestratorChildLaneBlocker | null {
  const { run, candidate, tasks } = args
  if (run.mode !== 'orchestrator' || !candidate.taskId) {
    return null
  }

  const lanes = tasks.filter((task) => task.parent_id === candidate.taskId)
  const active = lanes.filter((task) => task.status === 'dispatched')
  if (active.length > 0) {
    return {
      kind: 'active',
      message: `Coordinator reported completion while child lanes were still active: ${summarizeLaneNames(active)}.`
    }
  }

  const unsuccessful = lanes.filter((task) => task.status !== 'completed')
  if (unsuccessful.length > 0) {
    return {
      kind: 'unsuccessful',
      message: `Child lanes failed or were blocked: ${summarizeLaneNames(unsuccessful)}.`
    }
  }
  return null
}
