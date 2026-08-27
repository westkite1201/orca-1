import { OrchestrationError } from '../../orchestration-error'
import type { TaskRow, TaskStatus } from '../../types'
import { settleActiveDispatchesForTask } from '../dispatch-context/dispatch-completion'
import type { OrchestrationDb } from '../orchestration-db'

export function updateTaskStatus(
  this: OrchestrationDb,
  id: string,
  status: TaskStatus,
  result?: string
): TaskRow | undefined {
  const terminalStatus = status === 'completed' || status === 'failed'
  const requiresActiveDispatch = status === 'dispatched'
  const permitsActiveDispatch = terminalStatus || requiresActiveDispatch
  this.db.exec('SAVEPOINT update_task_status')
  try {
    const completedAt = terminalStatus ? new Date().toISOString() : null
    const update = this.db
      .prepare(
        `UPDATE tasks
         SET status = ?, result = COALESCE(?, result),
             completed_at = COALESCE(?, completed_at)
         WHERE id = ?
           AND (
             ? = 0 OR EXISTS (
               SELECT 1 FROM dispatch_contexts
               WHERE task_id = tasks.id AND status IN ('pending', 'dispatched')
             )
           )
           AND (
             ? = 1 OR NOT EXISTS (
               SELECT 1 FROM dispatch_contexts
               WHERE task_id = tasks.id AND status IN ('pending', 'dispatched')
             )
           )
           AND (
             ? = 0 OR NOT EXISTS (
               SELECT 1
               FROM dispatch_contexts active
               JOIN worker_dispatches worker ON worker.dispatch_id = active.id
               WHERE active.task_id = tasks.id
                 AND active.status IN ('pending', 'dispatched')
                 AND worker.state NOT IN ('failed', 'succeeded', 'stopped', 'abandoned')
             )
           )`
      )
      .run(
        status,
        result ?? null,
        completedAt,
        id,
        requiresActiveDispatch ? 1 : 0,
        permitsActiveDispatch ? 1 : 0,
        terminalStatus ? 1 : 0
      )
    if (update.changes !== 1) {
      const task = this.getTask(id)
      const active = this.db
        .prepare(
          `SELECT id FROM dispatch_contexts
           WHERE task_id = ? AND status IN ('pending', 'dispatched')
           ORDER BY rowid DESC LIMIT 1`
        )
        .get(id) as { id: string } | undefined
      const activeWorker = terminalStatus
        ? (this.db
            .prepare(
              `SELECT active.id
               FROM dispatch_contexts active
               JOIN worker_dispatches worker ON worker.dispatch_id = active.id
               WHERE active.task_id = ? AND active.status IN ('pending', 'dispatched')
                 AND worker.state NOT IN ('failed', 'succeeded', 'stopped', 'abandoned')
               ORDER BY active.rowid DESC LIMIT 1`
            )
            .get(id) as { id: string } | undefined)
        : undefined
      if (task && activeWorker) {
        throw new OrchestrationError(
          'task_not_startable',
          `Task ${id} cannot move to ${status} while supervised Dispatch ${activeWorker.id} is active; stop or settle its worker first.`,
          { taskId: id, dispatchId: activeWorker.id }
        )
      }
      if (task && requiresActiveDispatch && !active) {
        throw new OrchestrationError(
          'task_not_startable',
          `Task ${id} cannot move to dispatched without an active Dispatch.`,
          { taskId: id }
        )
      }
      if (task && active && !permitsActiveDispatch) {
        throw new OrchestrationError(
          'task_not_startable',
          `Task ${id} cannot move to ${status} while Dispatch ${active.id} is active.`,
          { taskId: id, dispatchId: active.id }
        )
      }
      this.db.exec('RELEASE update_task_status')
      return task
    }
    if (terminalStatus) {
      settleActiveDispatchesForTask(this, id, status, result)
    }
    if (status === 'completed') {
      this.promoteReadyTasks(id)
    }
    const task = this.getTask(id)
    this.db.exec('RELEASE update_task_status')
    return task
  } catch (error) {
    this.db.exec('ROLLBACK TO update_task_status')
    this.db.exec('RELEASE update_task_status')
    throw error
  }
}

export function verifyReportedTask(
  this: OrchestrationDb,
  id: string,
  evidence: string,
  verifiedBy: string
): TaskRow {
  const normalizedEvidence = evidence.trim()
  if (!normalizedEvidence) {
    throw new Error('Verification evidence must not be empty.')
  }
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const task = this.getTask(id)
    if (!task) {
      throw new Error(`Task not found: ${id}`)
    }
    if (task.status !== 'reported') {
      throw new Error(`Task ${id} is ${task.status}; only reported tasks can be verified.`)
    }
    let result: Record<string, unknown> = {}
    try {
      const parsed: unknown = task.result ? JSON.parse(task.result) : {}
      result =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {}
    } catch {
      result = { workerResult: task.result }
    }
    const verifiedAt = new Date().toISOString()
    this.db.prepare('UPDATE tasks SET status = ?, result = ?, completed_at = ? WHERE id = ?').run(
      'completed',
      JSON.stringify({
        ...result,
        verification: { verifiedBy, evidence: normalizedEvidence, verifiedAt }
      }),
      verifiedAt,
      id
    )
    this.promoteReadyTasks(id)
    const verified = this.getTask(id) as TaskRow
    this.db.exec('COMMIT')
    return verified
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type TaskStatusTransitionMethods = {
  updateTaskStatus: typeof updateTaskStatus
  verifyReportedTask: typeof verifyReportedTask
}

export function attachTaskStatusTransition(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { updateTaskStatus, verifyReportedTask })
}
