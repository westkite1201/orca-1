import type {
  HarnessAgent,
  HarnessCandidate,
  HarnessCandidatePatch,
  HarnessRun,
  HarnessRunCreateInput
} from '../../shared/harness-types'
import type { Repo } from '../../shared/types'
import type { HarnessStore } from './service'

function pendingCandidate<TAgent extends HarnessAgent>(
  runId: string,
  agent: TAgent,
  now: number
): HarnessCandidate<TAgent> {
  return {
    id: `${runId}-${agent}`,
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

export function createHarnessRunMemoryStore(repo: Repo): {
  store: HarnessStore
  runs: Map<string, HarnessRun>
} {
  const runs = new Map<string, HarnessRun>()
  let sequence = 0
  const store: HarnessStore = {
    getRepo: (id) => (id === repo.id ? repo : undefined),
    listHarnessRuns: (repoId) =>
      [...runs.values()].filter((run) => repoId === undefined || run.repoId === repoId),
    getHarnessRun: (runId) => runs.get(runId) ?? null,
    createHarnessRun: (input: HarnessRunCreateInput) => {
      const now = Date.now()
      const id = `run-${++sequence}`
      const run: HarnessRun = {
        id,
        ...input,
        mode: input.mode ?? 'comparison',
        candidates:
          input.mode === 'orchestrator'
            ? [pendingCandidate(id, 'codex', now)]
            : [pendingCandidate(id, 'codex', now), pendingCandidate(id, 'claude', now)],
        fatalError: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null
      }
      runs.set(id, run)
      return run
    },
    updateHarnessCandidate: (runId: string, agent: HarnessAgent, patch: HarnessCandidatePatch) => {
      const run = runs.get(runId)
      if (!run) {
        throw new Error('missing run')
      }
      const current = run.candidates.find((candidate) => candidate.agent === agent)
      if (!current) {
        throw new Error('missing candidate')
      }
      const now = Date.now()
      const updated = {
        ...current,
        ...patch,
        updatedAt: now,
        startedAt: patch.startedAt ?? current.startedAt ?? (patch.status === 'running' ? now : null)
      }
      const candidates = run.candidates.map((candidate) =>
        candidate.agent === agent ? updated : candidate
      )
      const next = { ...run, candidates, updatedAt: now }
      runs.set(runId, next)
      return next
    },
    failHarnessRun: (runId, error) => {
      const run = runs.get(runId)
      if (!run) {
        throw new Error('missing run')
      }
      const failed = {
        ...run,
        fatalError: error,
        updatedAt: Date.now(),
        completedAt: Date.now()
      }
      runs.set(runId, failed)
      return failed
    }
  }
  return { store, runs }
}
