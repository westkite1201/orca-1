import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

describe('orchestration task execution contract', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('persists task execution metadata', () => {
    const d = createDb()
    const task = d.createTask({
      spec: 'inspect only',
      executionKind: 'read-only',
      agentSlot: 'codex'
    })

    expect(d.getTask(task.id)).toMatchObject({
      execution_kind: 'read-only',
      agent_slot: 'codex'
    })
  })

  it('lists tasks and preserves parent decomposition', () => {
    const d = createDb()
    const parent = d.createTask({ spec: 'parent' })
    const child = d.createTask({ spec: 'child', parentId: parent.id })

    expect(d.listTasks()).toHaveLength(2)
    expect(child.parent_id).toBe(parent.id)
  })

  it('rejects missing, duplicate, or cyclic dependency graphs', () => {
    const d = createDb()
    const first = d.createTask({ spec: 'first' })
    const second = d.createTask({ spec: 'second' })

    expect(() => d.createTask({ spec: 'missing', deps: ['task_missing'] })).toThrow(
      'Dependency task not found'
    )
    expect(() => d.createTask({ spec: 'duplicate', deps: [first.id, first.id] })).toThrow(
      'must be unique'
    )

    const sqlite = (d as unknown as { db: Database.Database }).db
    sqlite
      .prepare('UPDATE tasks SET deps = ? WHERE id = ?')
      .run(JSON.stringify([second.id]), first.id)
    sqlite
      .prepare('UPDATE tasks SET deps = ? WHERE id = ?')
      .run(JSON.stringify([first.id]), second.id)
    expect(() => d.createTask({ spec: 'cycle witness', deps: [first.id] })).toThrow(
      'dependency graph contains a cycle'
    )
    expect(d.listTasks()).toHaveLength(2)
  })

  it('derives initial state from dependencies that already finished', () => {
    const d = createDb()
    const completed = d.createTask({ spec: 'completed dependency' })
    d.updateTaskStatus(completed.id, 'completed')
    const ready = d.createTask({ spec: 'late dependent', deps: [completed.id] })

    const failed = d.createTask({ spec: 'failed dependency' })
    d.updateTaskStatus(failed.id, 'failed', 'verification failed')
    const rejected = d.createTask({ spec: 'late rejected dependent', deps: [failed.id] })

    expect(ready.status).toBe('ready')
    expect(rejected).toMatchObject({
      status: 'failed',
      result: expect.stringContaining(`failed dependency ${failed.id}: verification failed`),
      completed_at: expect.any(String)
    })
  })

  it('records and propagates a circuit-broken dispatch failure', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'flaky' })
    const dependent = d.createTask({ spec: 'after flaky', deps: [task.id] })

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const dispatch = d.createDispatchContext(task.id, 'term-worker')
      d.failDispatch(dispatch.id, 'timeout')
    }

    expect(d.getTask(task.id)).toMatchObject({
      status: 'failed',
      result: 'timeout',
      completed_at: expect.any(String)
    })
    expect(d.getTask(dependent.id)).toMatchObject({
      status: 'failed',
      result: expect.stringContaining(`failed dependency ${task.id}: timeout`)
    })
  })

  it('ignores duplicate failure callbacks from a closed dispatch attempt', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'retry safely' })
    const first = d.createDispatchContext(task.id, 'term-first')
    d.failDispatch(first.id, 'first timeout')
    const retry = d.createDispatchContext(task.id, 'term-retry')

    d.failDispatch(first.id, 'late duplicate timeout')
    d.failDispatch(first.id, 'another duplicate timeout')

    expect(d.getDispatchContextById(first.id)).toMatchObject({
      status: 'failed',
      failure_count: 1,
      last_failure: 'first timeout'
    })
    expect(d.getDispatchContextById(retry.id)?.status).toBe('dispatched')
    expect(d.getTask(task.id)?.status).toBe('dispatched')
  })

  it('persists the assignee worktree and atomically caps Harness sibling lanes', () => {
    const d = createDb()
    const root = d.createTask({ spec: 'root' })
    const first = d.createTask({ spec: 'first', parentId: root.id })
    const second = d.createTask({ spec: 'second', parentId: root.id })
    const third = d.createTask({ spec: 'third', parentId: root.id })
    const options = {
      assigneeWorktreeId: 'wt-integration',
      harnessConcurrency: { rootTaskId: root.id, maxConcurrent: 2 }
    }

    const firstDispatch = d.createDispatchContext(first.id, 'term-first', undefined, options)
    d.createDispatchContext(second.id, 'term-second', undefined, options)

    expect(firstDispatch.assignee_worktree_id).toBe('wt-integration')
    expect(() => d.createDispatchContext(third.id, 'term-third', undefined, options)).toThrow(
      'maximum is 2'
    )
    expect(d.getTask(third.id)?.status).toBe('ready')
    expect(d.getDispatchContext(third.id)).toBeUndefined()
  })

  it('counts Harness concurrency independently per root', () => {
    const d = createDb()
    const firstRoot = d.createTask({ spec: 'first root' })
    const secondRoot = d.createTask({ spec: 'second root' })
    const first = d.createTask({ spec: 'first', parentId: firstRoot.id })
    const second = d.createTask({ spec: 'second', parentId: secondRoot.id })

    d.createDispatchContext(first.id, 'term-first', undefined, {
      harnessConcurrency: { rootTaskId: firstRoot.id, maxConcurrent: 1 }
    })
    expect(() =>
      d.createDispatchContext(second.id, 'term-second', undefined, {
        harnessConcurrency: { rootTaskId: secondRoot.id, maxConcurrent: 1 }
      })
    ).not.toThrow()
  })
})
