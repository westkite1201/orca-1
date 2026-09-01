import { randomUUID } from 'node:crypto'

import {
  jawsPlanningSelectorSchema,
  jawsPlanningStartSchema,
  JAWS_PLANNING_LOG_LIMIT,
  JAWS_PLANNING_LOG_MESSAGE_LIMIT,
  normalizeJawsPlanningQuestion,
  type JawsPlanningLogEntry,
  type JawsPlanningRun,
  type JawsPlanningSelector,
  type JawsPlanningStart,
  type JawsPlanProposal,
  type JawsRunView
} from '../../shared/jaws-types'
import type { Store } from '../persistence'
import type { HarnessService } from '../harness/service'
import type { JawsPlannerResult } from './planner-runner'

type JawsPlanningStore = Pick<
  Store,
  'listJawsPlanningRuns' | 'getJawsPlanningRun' | 'createJawsPlanningRun' | 'updateJawsPlanningRun'
>

type JawsPlannerLog = Pick<JawsPlanningLogEntry, 'stream' | 'message'>

export type JawsPlanner = (input: {
  goal: string
  worktreeSelector: string
  signal: AbortSignal
  onLog?: (entry: JawsPlannerLog) => void
}) => Promise<JawsPlannerResult>

function boundedError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const trimmed = text.trim() || 'Planning failed.'
  return trimmed.length <= 4_000 ? trimmed : `${trimmed.slice(0, 3_999)}…`
}

function planningLog(
  logs: readonly JawsPlanningLogEntry[],
  stream: JawsPlanningLogEntry['stream'],
  message: string
): JawsPlanningLogEntry[] {
  const text = message
    .replace(
      /(access[_ -]?token|refresh[_ -]?token|openai[_ -]?api[_ -]?key)\s*[:=]\s*\S+/gi,
      '$1=[redacted]'
    )
    .trim()
    .slice(0, JAWS_PLANNING_LOG_MESSAGE_LIMIT)
  if (!text) {
    return [...logs]
  }
  return [
    ...logs,
    {
      at: Date.now(),
      stream,
      message: text
    }
  ].slice(-JAWS_PLANNING_LOG_LIMIT)
}

export class JawsPlanningService {
  private readonly inFlight = new Map<
    string,
    { controller: AbortController; execution: Promise<void> }
  >()

  constructor(
    private readonly store: JawsPlanningStore,
    private readonly harness: HarnessService,
    private readonly planner: JawsPlanner | null,
    private readonly propose: (input: JawsPlanProposal, signal: AbortSignal) => Promise<JawsRunView>
  ) {}

  async start(input: JawsPlanningStart): Promise<JawsPlanningRun> {
    const request = jawsPlanningStartSchema.parse(input)
    const clientRequestId = request.clientRequestId ?? randomUUID()
    const existing = this.store
      .listJawsPlanningRuns()
      .find((run) => run.clientRequestId === clientRequestId)
    if (existing) {
      return existing
    }
    const { source, baseSha } = await this.harness.preflight(request.worktreeSelector)
    const active = this.store
      .listJawsPlanningRuns({ sourceWorktreeId: source.id })
      .find(
        (run) =>
          run.status === 'queued' || run.status === 'planning' || run.status === 'needs_input'
      )
    if (active) {
      throw new Error('A Jaws plan is already being prepared for this worktree.')
    }
    const run = this.store.createJawsPlanningRun({
      clientRequestId,
      repoId: source.repoId,
      sourceWorktreeId: source.id,
      sourceWorktreePath: source.git.path,
      baseSha,
      goal: request.goal
    })
    const controller = new AbortController()
    const started = this.store.updateJawsPlanningRun(run.id, {
      status: 'planning',
      question: null,
      error: null,
      logs: planningLog(run.logs, 'system', 'Planning started.')
    })
    const execution = this.execute(started, controller.signal).finally(() => {
      if (this.inFlight.get(run.id)?.execution === execution) {
        this.inFlight.delete(run.id)
      }
    })
    this.inFlight.set(run.id, { controller, execution })
    return started
  }

  list(filters: { sourceWorktreeId?: string } = {}): JawsPlanningRun[] {
    return this.store.listJawsPlanningRuns(filters)
  }

  show(input: JawsPlanningSelector): JawsPlanningRun {
    const { planningId } = jawsPlanningSelectorSchema.parse(input)
    const run = this.store.getJawsPlanningRun(planningId)
    if (!run) {
      throw new Error('Jaws planning run not found.')
    }
    return run
  }

  cancel(input: JawsPlanningSelector): JawsPlanningRun {
    const run = this.show(input)
    if (run.status !== 'queued' && run.status !== 'planning' && run.status !== 'needs_input') {
      return run
    }
    this.inFlight.get(run.id)?.controller.abort()
    return this.store.updateJawsPlanningRun(run.id, {
      status: 'canceled',
      question: null,
      error: null,
      logs: planningLog(run.logs, 'system', 'Planning canceled.')
    })
  }

  private async execute(run: JawsPlanningRun, signal: AbortSignal): Promise<void> {
    if (!this.planner) {
      this.store.updateJawsPlanningRun(run.id, {
        status: 'failed',
        error: 'The Jaws planner is unavailable.',
        logs: planningLog(run.logs, 'system', 'Planner is unavailable.')
      })
      return
    }
    try {
      const result = await this.planner({
        goal: run.goal,
        worktreeSelector: `id:${run.sourceWorktreeId}`,
        signal,
        onLog: (entry) => {
          this.appendLog(run.id, entry)
        }
      })
      if (signal.aborted || this.store.getJawsPlanningRun(run.id)?.status === 'canceled') {
        return
      }
      if (!result.success) {
        this.store.updateJawsPlanningRun(run.id, {
          status: result.canceled ? 'canceled' : 'failed',
          error: result.canceled ? null : boundedError(result.error),
          logs: planningLog(
            this.store.getJawsPlanningRun(run.id)?.logs ?? [],
            'system',
            result.canceled ? 'Planning canceled.' : `Planning failed: ${result.error}`
          )
        })
        return
      }
      if (result.reply.kind === 'question') {
        this.store.updateJawsPlanningRun(run.id, {
          status: 'needs_input',
          question: normalizeJawsPlanningQuestion(result.reply.question),
          error: null,
          logs: planningLog(
            this.store.getJawsPlanningRun(run.id)?.logs ?? [],
            'system',
            'Clarification is required before planning can continue.'
          )
        })
        return
      }
      const currentSource = await this.harness.preflight(`id:${run.sourceWorktreeId}`)
      if (currentSource.baseSha !== run.baseSha) {
        throw new Error('The source HEAD changed while Jaws was preparing the plan.')
      }
      if (signal.aborted || this.store.getJawsPlanningRun(run.id)?.status === 'canceled') {
        return
      }
      const proposal = await this.propose(
        {
          worktree: `id:${run.sourceWorktreeId}`,
          plan: result.reply.plan
        },
        signal
      )
      this.store.updateJawsPlanningRun(run.id, {
        status: 'proposed',
        jawsRunId: proposal.id,
        question: null,
        error: null,
        logs: planningLog(
          this.store.getJawsPlanningRun(run.id)?.logs ?? [],
          'system',
          'Plan ready for review.'
        )
      })
    } catch (error) {
      if (signal.aborted || this.store.getJawsPlanningRun(run.id)?.status === 'canceled') {
        return
      }
      this.store.updateJawsPlanningRun(run.id, {
        status: 'failed',
        error: boundedError(error),
        logs: planningLog(
          this.store.getJawsPlanningRun(run.id)?.logs ?? [],
          'system',
          `Planning failed: ${boundedError(error)}`
        )
      })
    }
  }

  private appendLog(runId: string, entry: JawsPlannerLog): void {
    const run = this.store.getJawsPlanningRun(runId)
    if (!run || run.status === 'canceled') {
      return
    }
    this.store.updateJawsPlanningRun(runId, {
      logs: planningLog(run.logs, entry.stream, entry.message)
    })
  }
}
