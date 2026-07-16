/* eslint-disable max-lines -- Why: RPC method definitions co-locate param schemas with handlers; splitting by method would scatter the shared enums and Zod transforms without reducing complexity. */
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, OptionalBoolean, requiredString } from '../schemas'
import type {
  MessageType,
  MessagePriority,
  OrchestrationDb,
  TaskRow,
  TaskExecutionKind,
  TaskStatus
} from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import { formatMessageBanner } from '../../orchestration/formatter'
import { isGroupAddress, resolveGroupAddress } from '../../orchestration/groups'
import { reconcileLifecycleMessage } from '../../orchestration/lifecycle-reconciliation'
import {
  assertHarnessTaskTreeOpen,
  findHarnessTaskRoot,
  hasActiveHarnessTaskTree,
  isHarnessTaskCoordinator
} from '../../orchestration/harness-task-scope'
import { abbreviateOrchestrationTasks } from '../../../../shared/orchestration-task-summary'
import { ORCHESTRATION_GATE_METHODS } from './orchestration-gates'

const MESSAGE_TYPES: MessageType[] = [
  'status',
  'dispatch',
  'worker_done',
  'merge_ready',
  'escalation',
  'handoff',
  'decision_gate',
  'heartbeat'
]

const TASK_STATUSES: TaskStatus[] = [
  'pending',
  'ready',
  'dispatched',
  'completed',
  'failed',
  'blocked'
]

const HARNESS_OWNER_PREFIX = 'jaws-harness:'
const HARNESS_MAX_CONCURRENT_LANES = 4

function assertHarnessResetSafe(db: OrchestrationDb): void {
  if (hasActiveHarnessTaskTree(db)) {
    // Why: deleting task ownership cannot stop its local or remote PTY, so
    // Harness cleanup must retain these rows until termination is proven.
    throw new Error('Cannot reset orchestration tasks while a Harness lane is active.')
  }
}

function getLifecycleGroupRecipientError(type: 'worker_done' | 'heartbeat'): string {
  return `${type} messages must be sent to a concrete coordinator terminal handle, not a group address.`
}

const SendParams = z
  .object({
    to: requiredString('Missing --to'),
    subject: requiredString('Missing --subject'),
    from: OptionalString,
    body: OptionalString,
    type: z
      .enum([
        'status',
        'dispatch',
        'worker_done',
        'merge_ready',
        'escalation',
        'handoff',
        'decision_gate',
        'heartbeat'
      ])
      .optional(),
    priority: z.enum(['normal', 'high', 'urgent']).optional(),
    threadId: OptionalString,
    payload: OptionalString,
    // Why: the sender's pane key is the remint-stable identity used to verify
    // worker_done/heartbeat ownership; the from handle stays routing metadata.
    senderPaneKey: OptionalString,
    devMode: OptionalBoolean
  })
  .superRefine((params, ctx) => {
    if (
      (params.type !== 'worker_done' && params.type !== 'heartbeat') ||
      !isGroupAddress(params.to)
    ) {
      return
    }
    // Why: dispatch lifecycle messages are authority/liveness signals for one
    // coordinator. Fanout creates lifecycle mail in unrelated terminals.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: getLifecycleGroupRecipientError(params.type),
      path: ['to']
    })
  })

const CheckParams = z
  .object({
    terminal: OptionalString,
    unread: OptionalBoolean,
    peek: OptionalBoolean,
    // Why: `all` surfaces every message for the handle and skips mark-read.
    // Previously the only way to ask for "all" was the hidden RPC trick
    // `{unread: false}`. See design doc §3.2 / §3.3.
    all: OptionalBoolean,
    types: OptionalString,
    inject: OptionalBoolean,
    wait: OptionalBoolean,
    timeoutMs: OptionalFiniteNumber
  })
  .superRefine((params, ctx) => {
    // Why: the CLI encodes --peek as {peek:true, unread:false} so pre-peek
    // runtimes degrade to the non-consuming all mode; that pair is one mode,
    // not a conflict.
    const modes = [
      params.unread === true,
      params.peek === true,
      params.all === true || (params.unread === false && params.peek !== true)
    ].filter(Boolean)
    if (modes.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose at most one message read mode: --unread, --peek, or --all.'
      })
    }
  })

const ReplyParams = z.object({
  id: requiredString('Missing --id'),
  body: requiredString('Missing --body'),
  from: OptionalString
})

const InboxParams = z.object({
  limit: OptionalFiniteNumber,
  // Why: filters the inbox listing to a specific handle so coordinators can
  // ask "everything for this handle" with either `inbox` or `check --all`
  // and get agreeing results. See design doc §3.3.
  terminal: OptionalString
})

const TaskCreateParams = z.object({
  spec: requiredString('Missing --spec'),
  taskTitle: OptionalString,
  displayName: OptionalString,
  executionKind: z.enum(['read-only', 'worktree']).optional(),
  agentSlot: z.string().trim().min(1).max(64).optional(),
  deps: OptionalString,
  parent: OptionalString,
  callerTerminalHandle: OptionalString,
  callerPaneKey: OptionalString
})

const TaskListParams = z.object({
  status: z.enum(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked']).optional(),
  ready: OptionalBoolean,
  parent: OptionalString,
  // Why: truncating specs server-side keeps `--brief` cheap over SSH/relay
  // transports instead of shipping full specs the CLI then throws away.
  brief: OptionalBoolean
})

const TaskUpdateParams = z.object({
  id: requiredString('Missing --id'),
  status: z
    .unknown()
    .transform((v) => {
      if (typeof v === 'string' && TASK_STATUSES.includes(v as TaskStatus)) {
        return v as TaskStatus
      }
      return ''
    })
    .pipe(
      z.enum(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked'], {
        message: 'Missing --status'
      })
    ),
  result: OptionalString
})

const DispatchParams = z.object({
  task: requiredString('Missing --task'),
  // Why: --to is only required for real dispatches. When --dry-run is set the
  // caller is previewing the preamble and no terminal is targeted, so allow it
  // to be absent. The handler enforces presence before any side-effecting work.
  to: OptionalString,
  from: OptionalString,
  senderPaneKey: OptionalString,
  inject: OptionalBoolean,
  dryRun: OptionalBoolean,
  returnPreamble: OptionalBoolean,
  devMode: OptionalBoolean
})

const DispatchShowParams = z.object({
  task: OptionalString,
  preamble: OptionalBoolean,
  from: OptionalString,
  devMode: OptionalBoolean
})

function preambleInteractionMode(
  from: string | undefined,
  taskOwner: string | null
): 'coordinated' | 'report-only' {
  return from?.startsWith('jaws-harness:') || taskOwner?.startsWith('jaws-harness:')
    ? 'report-only'
    : 'coordinated'
}

function assertHarnessTaskCoordinator(args: {
  db: OrchestrationDb
  task: TaskRow
  callerHandle: string | undefined
  callerPaneKey: string | null
}): void {
  const root = findHarnessTaskRoot(args.db, args.task)
  assertHarnessTaskTreeOpen(args.db, args.task)
  if (
    root &&
    !isHarnessTaskCoordinator({
      db: args.db,
      root,
      callerHandle: args.callerHandle,
      callerPaneKey: args.callerPaneKey
    })
  ) {
    throw new Error('Only the assigned Orchestrator coordinator can manage child tasks.')
  }
}

function taskSpecForDispatch(task: TaskRow): string {
  if (!task.execution_kind) {
    return task.spec
  }
  const executionRule =
    task.execution_kind === 'read-only'
      ? 'This is a read-only lane. Do not modify files or run mutating commands.'
      : 'Modify only this assigned isolated worktree and commit the completed changes.'
  return `${task.spec}\n\nExecution contract (${task.execution_kind}, agent slot ${task.agent_slot ?? 'unassigned'}): ${executionRule}`
}

async function resolveHarnessIntegrationWorktreeId(args: {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  root: TaskRow
}): Promise<string> {
  const dispatch = args.db.getDispatchContext(args.root.id)
  if (!dispatch) {
    throw new Error('Orchestrator root has no dispatch context.')
  }
  if (dispatch.assignee_worktree_id) {
    return dispatch.assignee_worktree_id
  }
  let handle = dispatch.assignee_handle
  if (dispatch.assignee_pane_key) {
    handle = args.runtime.resolveTerminalPane(dispatch.assignee_pane_key).handle
  }
  if (!handle) {
    throw new Error('Orchestrator root has no resolvable coordinator terminal.')
  }
  const terminal = await args.runtime.showTerminal(handle)
  // Why: upgraded databases may have an active v6 root dispatch; backfill its
  // live worktree before applying the v7 child isolation contract.
  args.db.recordDispatchAssigneeWorktree(dispatch.id, terminal.worktreeId)
  return terminal.worktreeId
}

async function resolveHarnessAssigneeWorktreeId(args: {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  root: TaskRow
  task: TaskRow
  targetHandle: string
}): Promise<string> {
  const targetTerminal = await args.runtime.showTerminal(args.targetHandle)
  if (args.root.id === args.task.id) {
    return targetTerminal.worktreeId
  }
  if (!args.task.execution_kind || !args.task.agent_slot) {
    throw new Error('Orchestrator child task is missing execution-kind or agent-slot metadata.')
  }
  const targetAgent = await args.runtime.getTerminalAgentType(args.targetHandle)
  if (targetAgent !== args.task.agent_slot) {
    throw new Error(`Orchestrator lane target must be the ${args.task.agent_slot} agent.`)
  }
  const integrationWorktreeId = await resolveHarnessIntegrationWorktreeId(args)
  if (args.task.execution_kind === 'read-only') {
    if (targetTerminal.worktreeId !== integrationWorktreeId) {
      throw new Error('Read-only Orchestrator lanes must use the integration worktree.')
    }
    return targetTerminal.worktreeId
  }
  if (targetTerminal.worktreeId === integrationWorktreeId) {
    throw new Error('Mutating Orchestrator lanes require a separate isolated worktree.')
  }

  const worktree = await args.runtime.showManagedWorktree(`id:${targetTerminal.worktreeId}`)
  if (
    worktree.lineage?.origin !== 'orchestration' ||
    worktree.lineage.taskId !== args.task.id ||
    worktree.lineage.parentWorktreeId !== integrationWorktreeId
  ) {
    throw new Error(
      'Mutating Orchestrator lane worktree must be created for this task from the integration worktree.'
    )
  }
  if (worktree.createdWithAgent !== args.task.agent_slot) {
    throw new Error(`Mutating Orchestrator lane must use agent slot ${args.task.agent_slot}.`)
  }
  const runId = args.root.created_by_terminal_handle?.startsWith(HARNESS_OWNER_PREFIX)
    ? args.root.created_by_terminal_handle.slice(HARNESS_OWNER_PREFIX.length)
    : ''
  if (!runId) {
    throw new Error('Orchestrator root is missing its Harness run identity.')
  }
  const run = args.runtime.getHarnessService().show(runId)
  if (worktree.repoId !== run.repoId) {
    throw new Error('Mutating Orchestrator lane worktree belongs to a different repository.')
  }
  const status = await args.runtime.getRuntimeGitStatus(`id:${targetTerminal.worktreeId}`)
  const statusFailure = status.didHitLimit
    ? 'status was truncated'
    : status.head?.trim() !== run.baseSha
      ? `HEAD is ${status.head?.trim() || 'unknown'}, expected ${run.baseSha}`
      : status.conflictOperation !== 'unknown'
        ? `${status.conflictOperation} is in progress`
        : status.entries.length > 0
          ? 'worktree is dirty'
          : null
  if (statusFailure) {
    throw new Error(
      `Mutating Orchestrator lane is not a clean start-SHA worktree: ${statusFailure}.`
    )
  }
  return targetTerminal.worktreeId
}

const AskParams = z.object({
  to: requiredString('Missing --to'),
  question: requiredString('Missing --question'),
  options: OptionalString,
  timeoutMs: OptionalFiniteNumber,
  from: OptionalString
})

const ResetParams = z
  .object({
    all: OptionalBoolean,
    tasks: OptionalBoolean,
    messages: OptionalBoolean
  })
  .superRefine((params, ctx) => {
    const selectedScopeCount = [params.all, params.tasks, params.messages].filter(
      (scope) => scope === true
    ).length
    if (selectedScopeCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose exactly one reset scope: --all, --tasks, or --messages.'
      })
    }
  })

export const ORCHESTRATION_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.send',
    params: SendParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const from = params.from ?? 'unknown'
      // Why: older live shells may lack ORCA_PANE_KEY, but the runtime still
      // knows the pane behind their resolved handle; persist that authority.
      const senderPaneKey = params.senderPaneKey ?? runtime.getTerminalPaneKey(from) ?? undefined

      if (!isGroupAddress(params.to)) {
        // Point-to-point — existing single-recipient behavior
        const msg = db.insertMessage({
          from,
          to: params.to,
          subject: params.subject,
          body: params.body,
          type: params.type as MessageType,
          priority: params.priority as MessagePriority,
          threadId: params.threadId,
          payload: params.payload,
          senderPaneKey
        })
        // Why: worker_done/heartbeat sent via `send` must release the dispatch
        // lock before waking recipients — a coordinator woken by delivery may
        // immediately dispatch to the same terminal, which fails if the lock
        // is still held.
        if (msg.type === 'worker_done' || msg.type === 'heartbeat') {
          const reconciled = reconcileLifecycleMessage(db, msg)
          // Why: a suppressed message is already read; waking a `check --wait`
          // waiter for it would return an empty result before the deadline.
          if (reconciled.action === 'suppressed') {
            return { message: msg }
          }
          if (reconciled.action === 'rejected') {
            const rejection = db.getMessageById(msg.id) ?? msg
            runtime.deliverPendingMessagesForHandle(params.to)
            runtime.notifyMessageArrived(params.to, rejection.type)
            return { message: rejection, lifecycle: reconciled }
          }
        }
        runtime.deliverPendingMessagesForHandle(params.to)
        runtime.notifyMessageArrived(params.to, msg.type)
        return { message: msg }
      }

      // Why: group addresses fan out to one message per recipient so each gets
      // independent read-tracking, but they share a thread_id so the conversation
      // can be correlated (Section 4.5).
      const { terminals } = await runtime.listTerminals()
      const handles = resolveGroupAddress(params.to, from, terminals, (handle: string) =>
        runtime.getAgentStatusForHandle(handle)
      )

      if (handles.length === 0) {
        throw new Error(`No recipients resolved for group address: ${params.to}`)
      }

      const threadId = params.threadId ?? `thread_${Date.now()}`
      const messages = handles.map((handle) =>
        db.insertMessage({
          from,
          to: handle,
          subject: params.subject,
          body: params.body,
          type: params.type as MessageType,
          priority: params.priority as MessagePriority,
          threadId,
          payload: params.payload,
          senderPaneKey
        })
      )
      for (const message of messages) {
        runtime.deliverPendingMessagesForHandle(message.to_handle)
        runtime.notifyMessageArrived(message.to_handle, message.type)
      }

      return { messages, recipients: handles.length }
    }
  }),

  defineMethod({
    name: 'orchestration.check',
    params: CheckParams,
    handler: async (params, { runtime, signal }) => {
      const db = runtime.getOrchestrationDb()
      const handle = params.terminal ?? 'unknown'
      const typeFilter = params.types
        ? (params.types
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean) as MessageType[])
        : undefined
      const invalidTypes = typeFilter?.filter((t) => !MESSAGE_TYPES.includes(t))
      if (invalidTypes && invalidTypes.length > 0) {
        throw new Error(`Invalid --types: ${invalidTypes.join(',')}`)
      }

      // Why: `all` short-circuits to "everything for the handle, no marking."
      // Explicit `unread: false` is also honored for one release as a compat
      // shim so in-flight callers don't break (see design doc §5). Otherwise
      // today's behavior is preserved: default is unread-only + mark-read.
      const showAll = params.all === true || (params.unread === false && params.peek !== true)
      const consumeUnread = !showAll && params.peek !== true

      const readAndReturn = () => {
        const messages = showAll
          ? db.getAllMessagesForHandle(handle, null, typeFilter)
          : db.getUnreadMessages(handle, typeFilter)

        // Why: message insertion and lifecycle reconciliation are separate
        // durable writes. Every read mode repairs a crash between them, while
        // only consuming mode changes the message's read flag.
        // Why: history reads are newest-first, but lifecycle writes must replay
        // oldest-first so an older heartbeat cannot roll liveness backward.
        const reconciliation = new Map(
          [...messages]
            .sort((left, right) => left.sequence - right.sequence)
            .map((message) => [
              message.id,
              reconcileLifecycleMessage(db, message, undefined, {
                consumeInactive: consumeUnread
              })
            ])
        )
        const visibleMessages = messages.map((message) => {
          const reconciled = reconciliation.get(message.id)
          return reconciled?.action === 'rejected'
            ? (db.getMessageById(message.id) ?? message)
            : message
        })
        if (consumeUnread && messages.length > 0) {
          db.markAsRead(messages.map((m) => m.id))
        }

        if (params.inject) {
          const formatted = visibleMessages.map(formatMessageBanner).join('\n\n')
          return { messages: visibleMessages, formatted, count: visibleMessages.length }
        }

        return { messages: visibleMessages, count: visibleMessages.length }
      }

      if (signal?.aborted) {
        return { messages: [], count: 0 }
      }
      const result = readAndReturn()
      if (result.count > 0 || !params.wait) {
        return result
      }

      // Why: blocking wait lets coordinators replace sleep+poll loops with a
      // single call that resolves when a message arrives or the timeout
      // expires. The `signal` plumbed from the RPC transport aborts this
      // waiter the moment the client socket closes, so a killed client
      // releases its long-poll slot immediately rather than after the full
      // timeoutMs. See design doc §3.1 counter-lifecycle.
      await runtime.waitForMessage(handle, {
        typeFilter: typeFilter as string[] | undefined,
        timeoutMs: params.timeoutMs ?? undefined,
        signal
      })
      if (signal?.aborted) {
        return { messages: [], count: 0 }
      }
      return readAndReturn()
    }
  }),

  defineMethod({
    name: 'orchestration.reply',
    params: ReplyParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const original = db.getMessageById(params.id)
      if (!original) {
        throw new Error(`Message not found: ${params.id}`)
      }

      db.markAsRead([original.id])

      const reply = db.insertMessage({
        from: params.from ?? original.to_handle,
        to: original.from_handle,
        subject: `Re: ${original.subject}`,
        body: params.body,
        threadId: original.thread_id ?? original.id
      })

      runtime.notifyMessageArrived(original.from_handle, reply.type)
      return { message: reply }
    }
  }),

  defineMethod({
    name: 'orchestration.inbox',
    params: InboxParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      // Why: when `terminal` is provided, mirror `check --all` output for that
      // handle (same rows in the same sequence order). Stale/unknown handles
      // return an empty list instead of erroring, matching the "historical
      // rows survive handle deletion" rule in design doc §3.3.
      const messages = params.terminal
        ? db.getAllMessagesForHandle(params.terminal, params.limit)
        : db.getInbox(params.limit)
      return { messages, count: messages.length }
    }
  }),

  defineMethod({
    name: 'orchestration.taskCreate',
    params: TaskCreateParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      let deps: string[] | undefined
      if (params.deps) {
        try {
          const parsed = JSON.parse(params.deps)
          if (!Array.isArray(parsed) || !parsed.every((d) => typeof d === 'string')) {
            throw new Error('not an array of strings')
          }
          deps = parsed
        } catch {
          throw new Error('Invalid --deps: must be a JSON array of task IDs')
        }
      }
      const callerPaneKey =
        params.callerPaneKey ??
        (params.callerTerminalHandle
          ? runtime.getTerminalPaneKey(params.callerTerminalHandle)
          : null)
      const callerDispatch = params.callerTerminalHandle
        ? db.getActiveDispatchForTerminal(params.callerTerminalHandle, callerPaneKey ?? undefined)
        : undefined
      const callerTask = callerDispatch ? db.getTask(callerDispatch.task_id) : undefined
      const callerHarnessRoot = callerTask ? findHarnessTaskRoot(db, callerTask) : null
      if (callerHarnessRoot && params.parent !== callerHarnessRoot.id) {
        // Why: a Harness coordinator must not hide work under an unrelated
        // generic parent outside the root-owned completion barrier.
        throw new Error(
          params.parent
            ? 'Orchestrator child tasks must use the assigned top-level task as parent.'
            : 'Orchestrator child tasks must specify the assigned parent task.'
        )
      }
      if (params.parent) {
        const parent = db.getTask(params.parent)
        if (!parent) {
          throw new Error(`Task parent not found: ${params.parent}`)
        }
        const harnessRoot = findHarnessTaskRoot(db, parent)
        if (harnessRoot && harnessRoot.id !== parent.id) {
          // Why: the completion barrier scans one root-owned lane set; allowing
          // nested descendants would let hidden work outlive final verification.
          throw new Error(
            'Orchestrator child tasks must use the assigned top-level task as parent.'
          )
        }
        assertHarnessTaskCoordinator({
          db,
          task: parent,
          callerHandle: params.callerTerminalHandle,
          callerPaneKey
        })
      }
      let agentSlot = params.agentSlot
      if (callerHarnessRoot) {
        if (!params.executionKind) {
          throw new Error('Orchestrator child tasks must specify --execution-kind.')
        }
        agentSlot = agentSlot ?? 'codex'
        if (agentSlot !== 'codex') {
          throw new Error('Orchestrator child tasks currently support only the codex agent slot.')
        }
        for (const dependencyId of deps ?? []) {
          const dependency = db.getTask(dependencyId)
          if (
            !dependency ||
            dependency.parent_id !== callerHarnessRoot.id ||
            findHarnessTaskRoot(db, dependency)?.id !== callerHarnessRoot.id
          ) {
            throw new Error('Orchestrator child dependencies must be direct lanes in the same run.')
          }
        }
      }
      const task = db.createTask({
        spec: params.spec,
        taskTitle: params.taskTitle,
        displayName: params.displayName,
        executionKind: params.executionKind as TaskExecutionKind | undefined,
        agentSlot,
        deps,
        parentId: params.parent,
        createdByTerminalHandle: params.callerTerminalHandle
      })
      return { task }
    }
  }),

  defineMethod({
    name: 'orchestration.taskList',
    params: TaskListParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      // Why: listTasksWithDispatch returns the same rows as listTasks plus
      // assignee_handle + dispatch_id joined in for tasks that currently have an
      // active dispatch. Non-dispatched tasks get NULL for those fields, so
      // consumers reading the legacy shape are unaffected.
      const joined = db.listTasksWithDispatch({
        status: params.status as TaskStatus,
        ready: params.ready
      })
      const scoped = params.parent
        ? joined.filter((task) => task.parent_id === params.parent)
        : joined
      const tasks = scoped.map((row) => {
        const { assignee_handle, dispatch_id, ...base } = row
        if (base.status === 'dispatched') {
          return { ...base, assignee_handle, dispatch_id }
        }
        return base
      })
      return {
        tasks: params.brief ? abbreviateOrchestrationTasks(tasks) : tasks,
        count: tasks.length
      }
    }
  }),

  defineMethod({
    name: 'orchestration.taskUpdate',
    params: TaskUpdateParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const existing = db.getTask(params.id)
      if (!existing) {
        throw new Error(`Task not found: ${params.id}`)
      }
      const harnessRoot = findHarnessTaskRoot(db, existing)
      assertHarnessTaskTreeOpen(db, existing)
      if (harnessRoot) {
        // Why: every Harness lifecycle transition must also close or update its
        // dispatch; direct edits can release verification while a worker lives.
        throw new Error('Orchestrator task lifecycle is owned by worker_done and terminal exit.')
      }
      const task = db.updateTaskStatus(params.id, params.status, params.result)
      // The existence check above makes this unreachable unless the row is
      // concurrently removed, which this single-process store does not do.
      if (!task) {
        throw new Error(`Task not found: ${params.id}`)
      }
      return { task }
    }
  }),

  defineMethod({
    name: 'orchestration.dispatch',
    params: DispatchParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const task = db.getTask(params.task)
      if (!task) {
        throw new Error(`Task not found: ${params.task}`)
      }
      const harnessRoot = findHarnessTaskRoot(db, task)
      const senderPaneKey =
        params.senderPaneKey ?? (params.from ? runtime.getTerminalPaneKey(params.from) : null)
      const callerDispatch = params.from
        ? db.getActiveDispatchForTerminal(params.from, senderPaneKey ?? undefined)
        : undefined
      const callerTask = callerDispatch ? db.getTask(callerDispatch.task_id) : undefined
      const callerHarnessRoot = callerTask ? findHarnessTaskRoot(db, callerTask) : null
      if (
        callerHarnessRoot &&
        (!harnessRoot ||
          harnessRoot.id !== callerHarnessRoot.id ||
          task.parent_id !== callerHarnessRoot.id)
      ) {
        // Why: dispatching an existing generic task would create a live lane
        // outside the Harness root's completion and shutdown barrier.
        throw new Error('Orchestrator coordinators may dispatch only their direct child lanes.')
      }
      if (harnessRoot && harnessRoot.id !== task.id) {
        if (!task.created_by_terminal_handle || params.from !== task.created_by_terminal_handle) {
          // Why: a reminted live handle may identify the same pane, but child
          // replies must keep using the stable inbox captured at task creation.
          throw new Error('Orchestrator child dispatch must use its task creator as --from.')
        }
        assertHarnessTaskCoordinator({
          db,
          task,
          callerHandle: params.from,
          callerPaneKey: senderPaneKey
        })
      }
      const coordinatorHandle =
        harnessRoot && harnessRoot.id !== task.id
          ? task.created_by_terminal_handle!
          : (params.from ?? 'coordinator')

      // Why: --inject --dry-run lets a coordinator preview the exact preamble
      // text that would be injected without mutating task state or touching the
      // target terminal. Skips the ready-status check so coordinators can inspect
      // the preamble for already-dispatched or blocked tasks too. No dispatch
      // context exists yet (that happens after the ready-status check), so
      // dispatchId is a placeholder — the real injected preamble gets a real
      // ctx.id below.
      if (params.dryRun) {
        const preamble = buildDispatchPreamble({
          taskId: task.id,
          dispatchId: 'ctx_dryrun',
          taskSpec: taskSpecForDispatch(task),
          coordinatorHandle,
          workerHandle: params.to ?? 'worker',
          interactionMode: preambleInteractionMode(
            coordinatorHandle,
            task.created_by_terminal_handle
          ),
          devMode: params.devMode,
          ...(params.to
            ? { cliCommand: runtime.getTerminalOrchestrationCliCommand(params.to) }
            : {})
        })
        return { dispatch: null, injected: false, dryRun: true, preamble }
      }

      if (!params.to) {
        throw new Error('Missing --to')
      }
      const to = params.to

      if (task.status !== 'ready') {
        throw new Error(`Task ${params.task} is ${task.status}; only ready tasks can be dispatched`)
      }

      // Why: dispatching with --inject to a bare shell (zsh/bash) dumps the
      // preamble as shell commands, producing gibberish. Check both OSC title
      // status and foreground process — Claude Code doesn't emit recognized OSC
      // titles on startup, so title-only detection misses freshly spawned agents.
      if (params.inject) {
        const hasAgent = await runtime.isTerminalRunningAgent(to)
        if (!hasAgent) {
          throw new Error(
            `Cannot dispatch --inject to terminal ${to}: no recognized agent detected. ` +
              'Start an agent CLI (e.g. claude, codex, gemini, droid, cursor) in the terminal first, ' +
              'or dispatch without --inject and send the prompt manually.'
          )
        }
      }

      const targetPaneKey = runtime.getTerminalPaneKey(to)
      if (harnessRoot && harnessRoot.id !== task.id && !targetPaneKey) {
        // Why: Harness must be able to find and stop a reminted child lane
        // before releasing its completion barrier.
        throw new Error('Orchestrator child dispatch requires a stable target pane identity.')
      }
      if (harnessRoot && harnessRoot.id !== task.id && params.inject !== true) {
        throw new Error('Orchestrator child dispatch requires --inject.')
      }
      const assigneeWorktreeId = harnessRoot
        ? await resolveHarnessAssigneeWorktreeId({
            db,
            runtime,
            root: harnessRoot,
            task,
            targetHandle: to
          })
        : undefined
      const ctx = db.createDispatchContext(params.task, to, targetPaneKey ?? undefined, {
        assigneeWorktreeId,
        ...(harnessRoot && harnessRoot.id !== task.id
          ? {
              harnessConcurrency: {
                rootTaskId: harnessRoot.id,
                maxConcurrent: HARNESS_MAX_CONCURRENT_LANES
              }
            }
          : {})
      })

      // Why: preamble is built here (not before ctx) so `dispatchId` can be
      // the real ctx.id — the preamble-hardening PR made dispatchId required
      // so heartbeats can attribute liveness to a specific dispatch context,
      // not just a task.
      const preamble = buildDispatchPreamble({
        taskId: task.id,
        dispatchId: ctx.id,
        taskSpec: taskSpecForDispatch(task),
        coordinatorHandle,
        workerHandle: to,
        interactionMode: preambleInteractionMode(
          coordinatorHandle,
          task.created_by_terminal_handle
        ),
        devMode: params.devMode,
        cliCommand: runtime.getTerminalOrchestrationCliCommand(to)
      })

      let injected = false
      if (params.inject) {
        try {
          await runtime.sendTerminalAgentPrompt(to, preamble)
          injected = true
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          db.failDispatch(ctx.id, error)
          // Why: Harness comparisons cannot safely retry only one candidate after its peer starts.
          if (
            params.from?.startsWith('jaws-harness:') &&
            task.created_by_terminal_handle === params.from
          ) {
            db.updateTaskStatus(task.id, 'failed', error)
          }
          throw err
        }
      }

      // Why: returnPreamble is opt-in because the preamble is several hundred
      // bytes and most callers don't need it in the response. Exposing it
      // supports coordinators that want to log what was injected for auditing.
      if (params.returnPreamble) {
        return { dispatch: ctx, injected, preamble }
      }
      return { dispatch: ctx, injected }
    }
  }),

  defineMethod({
    name: 'orchestration.dispatchShow',
    params: DispatchShowParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      if (!params.task) {
        throw new Error('Missing --task')
      }
      const ctx = db.getDispatchContext(params.task)
      const task = db.getTask(params.task) ?? null

      // Why: --preamble lets callers inspect the exact preamble text that was
      // (or would be) injected for this task. The preamble is derived from the
      // current task spec, so even after dispatch completes the text can be
      // regenerated deterministically.
      if (params.preamble) {
        if (!task) {
          throw new Error(`Task not found: ${params.task}`)
        }
        const workerHandle = ctx?.assignee_handle ?? 'worker'
        const preamble = buildDispatchPreamble({
          taskId: task.id,
          // Why: prefer the existing dispatch context's id if we have one
          // (so the preview matches what was actually injected); fall back
          // to a placeholder when no dispatch has occurred yet.
          dispatchId: ctx?.id ?? 'ctx_preview',
          taskSpec: taskSpecForDispatch(task),
          coordinatorHandle: params.from ?? 'coordinator',
          workerHandle,
          interactionMode: preambleInteractionMode(params.from, task.created_by_terminal_handle),
          devMode: params.devMode,
          ...(ctx ? { cliCommand: runtime.getTerminalOrchestrationCliCommand(workerHandle) } : {})
        })
        return { dispatch: ctx ?? null, task, preamble }
      }

      return { dispatch: ctx ?? null, task }
    }
  }),

  defineMethod({
    name: 'orchestration.ask',
    params: AskParams,
    handler: async (params, { runtime, signal }) => {
      // Why: group addresses have no unambiguous answer semantics (whose
      // reply wins? first? consensus?) and the ~60-LOC scope is not the
      // place to design that. Rejecting here closes the silent-timeout
      // footgun where a worker passing `--to @reviewers` would have the
      // decision_gate inserted against a literal string no one subscribes
      // to. Workers that need fan-out fall back to `send --type decision_gate`.
      if (isGroupAddress(params.to)) {
        throw new Error(
          'ask does not support group addresses; use send --type decision_gate for fan-out questions'
        )
      }

      const db = runtime.getOrchestrationDb()
      const from = params.from ?? 'unknown'
      const timeoutMs = params.timeoutMs ?? 600_000
      const options =
        params.options
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) ?? []

      const payload = JSON.stringify({ question: params.question, options })
      const outbound = db.insertMessage({
        from,
        to: params.to,
        subject: 'Question',
        body: params.question,
        type: 'decision_gate',
        payload
      })
      runtime.deliverPendingMessagesForHandle(params.to)
      runtime.notifyMessageArrived(params.to, outbound.type)

      const threadId = outbound.id
      const deadline = Date.now() + timeoutMs
      const afterSequence = outbound.sequence

      // Why: loop with a remaining-budget guard so an unrelated distractor
      // message that wakes waitForMessage does not cause indefinite iteration.
      // waitForMessage is handle-scoped, so we re-query by thread on every
      // wake-up to separate "reply in my thread arrived" from "something
      // else was delivered to this handle."
      while (true) {
        const replies = db.getThreadMessagesFor(threadId, from, afterSequence)
        if (replies.length > 0) {
          const reply = replies[0]
          db.markAsRead([reply.id])
          return {
            answer: reply.body,
            messageId: reply.id,
            threadId,
            timedOut: false
          }
        }
        if (signal?.aborted) {
          return { answer: null, messageId: null, threadId, timedOut: true }
        }
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) {
          return { answer: null, messageId: null, threadId, timedOut: true }
        }
        // Why: if the asking client disconnects, release the waiter immediately
        // while leaving the already-sent decision gate visible to the recipient.
        await runtime.waitForMessage(from, { timeoutMs: remainingMs, signal })
      }
    }
  }),

  ...ORCHESTRATION_GATE_METHODS,

  defineMethod({
    name: 'orchestration.reset',
    params: ResetParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      if (params.all) {
        assertHarnessResetSafe(db)
        db.resetAll()
        return { reset: 'all' }
      }
      if (params.tasks) {
        assertHarnessResetSafe(db)
        db.resetTasks()
        return { reset: 'tasks' }
      }
      if (params.messages) {
        db.resetMessages()
        return { reset: 'messages' }
      }
      throw new Error('Invalid reset scope')
    }
  })
]
