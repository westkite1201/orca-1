import type { OrchestrationDb } from './db'
import { hasSamePaneIdentity } from './lifecycle-reconciliation'
import type { TaskRow } from './types'

const HARNESS_OWNER_PREFIX = 'jaws-harness:'

export function findHarnessTaskRoot(db: OrchestrationDb, task: TaskRow): TaskRow | null {
  const visited = new Set<string>()
  let current = task
  while (true) {
    if (visited.has(current.id)) {
      throw new Error('Task ancestry contains a cycle.')
    }
    visited.add(current.id)
    if (current.created_by_terminal_handle?.startsWith(HARNESS_OWNER_PREFIX)) {
      return current
    }
    if (!current.parent_id) {
      return null
    }
    const parent = db.getTask(current.parent_id)
    if (!parent) {
      throw new Error(`Task parent not found: ${current.parent_id}`)
    }
    current = parent
  }
}

export function isHarnessTaskCoordinator(args: {
  db: OrchestrationDb
  root: TaskRow
  callerHandle: string | undefined
  callerPaneKey: string | null
}): boolean {
  const { db, root, callerHandle, callerPaneKey } = args
  if (!callerHandle) {
    return false
  }
  const dispatch = db.getDispatchContext(root.id)
  if (!dispatch) {
    return false
  }
  if (dispatch.assignee_pane_key && callerPaneKey) {
    return hasSamePaneIdentity(dispatch.assignee_pane_key, callerPaneKey)
  }
  return dispatch.assignee_handle === callerHandle
}

export function assertHarnessTaskTreeOpen(db: OrchestrationDb, task: TaskRow): void {
  const root = findHarnessTaskRoot(db, task)
  if (!root) {
    return
  }
  const dispatch = db.getDispatchContext(root.id)
  if (root.status !== 'dispatched' || !dispatch || dispatch.status !== 'dispatched') {
    throw new Error('The Orchestrator task tree is sealed after its coordinator finishes.')
  }
}

export function hasActiveHarnessTaskTree(db: OrchestrationDb): boolean {
  return db
    .listTasksWithDispatch({ status: 'dispatched' })
    .some((task) => Boolean(task.dispatch_id && findHarnessTaskRoot(db, task)))
}
