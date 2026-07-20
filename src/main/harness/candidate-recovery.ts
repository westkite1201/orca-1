import type { HarnessCandidate, HarnessRun } from '../../shared/harness-types'
import type {
  RuntimeTerminalListResult,
  RuntimeWorktreeListResult,
  RuntimeWorktreeRecord
} from '../../shared/runtime-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { Store } from '../persistence'
import type { HarnessRuntimeCaller } from './runtime-caller'

type CandidateStore = Pick<Store, 'updateHarnessCandidate'>
type TerminalIsRunningAgentResult = { isRunningAgent: boolean }

const CANDIDATE_CREATION_RECOVERY_TIMEOUT_MS = 10 * 60_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function harnessRecoveryStartedAt(): number {
  // Why: retaining milliseconds prevents pre-restart evidence from the same
  // SQLite timestamp second from being mistaken for post-restart liveness.
  return Date.now()
}

export function harnessCandidateBranch(run: HarnessRun, candidate: HarnessCandidate): string {
  // Why: an exact branch lets restart recovery rediscover a worktree whose
  // create response was lost before its generated ID could be persisted.
  return `jaws-harness-${run.id}-${candidate.id}`
}

export function normalizeHarnessBranchRef(branch: string): string {
  const trimmed = branch.trim()
  return trimmed.startsWith('refs/heads/') ? trimmed.slice('refs/heads/'.length) : trimmed
}

export function isSameHarnessBranch(left: string, right: string): boolean {
  return normalizeHarnessBranchRef(left) === normalizeHarnessBranchRef(right)
}

function recoveryTimedOut(recoveryStartedAt: number): boolean {
  return Date.now() - recoveryStartedAt >= CANDIDATE_CREATION_RECOVERY_TIMEOUT_MS
}

function createRejectionRecoveryPrefix(candidate: HarnessCandidate): string {
  // Why: candidate identity makes this persisted state marker distinct from
  // arbitrary runtime errors while keeping the pending error readable.
  return `Candidate ${candidate.id} creation returned an error; checking for a durable worktree: `
}

function failTimedOutRecovery(
  store: CandidateStore,
  run: HarnessRun,
  candidate: HarnessCandidate
): null {
  return failCandidate(
    store,
    run,
    candidate,
    'Candidate creation recovery timed out before the worktree and agent terminal were recorded.'
  )
}

function failCandidate(
  store: CandidateStore,
  run: HarnessRun,
  candidate: HarnessCandidate,
  error: string
): null {
  store.updateHarnessCandidate(run.id, candidate.agent, { status: 'failed', error })
  return null
}

async function findRunningAgentTerminal(args: {
  runtime: HarnessRuntimeCaller
  worktree: RuntimeWorktreeRecord
}): Promise<RuntimeTerminalListResult['terminals'][number] | null> {
  const listed = await args.runtime.call<RuntimeTerminalListResult>('terminal.list', {
    worktree: `id:${args.worktree.id}`,
    requireFreshPtyLiveness: true
  })
  if (listed.truncated) {
    throw new Error('Candidate terminal listing is incomplete.')
  }
  const probes = await Promise.all(
    listed.terminals.map(async (terminal) => ({
      terminal,
      result: await args.runtime.call<TerminalIsRunningAgentResult>('terminal.isRunningAgent', {
        terminal: terminal.handle
      })
    }))
  )
  const running = probes.filter((probe) => probe.result.isRunningAgent)
  if (running.length > 1) {
    throw new Error('Candidate worktree has more than one running agent terminal.')
  }
  return running[0]?.terminal ?? null
}

export async function recoverHarnessCandidate(args: {
  store: CandidateStore
  runtime: HarnessRuntimeCaller
  run: HarnessRun
  candidate: HarnessCandidate
  createRejectionError?: string
}): Promise<HarnessCandidate | null> {
  const { store, runtime, run, candidate } = args
  const createRejectionPrefix = createRejectionRecoveryPrefix(candidate)
  const createRejectionError =
    args.createRejectionError ??
    (candidate.recoveryStartedAt !== null && candidate.error?.startsWith(createRejectionPrefix)
      ? candidate.error.slice(createRejectionPrefix.length)
      : null)
  const pendingCreateError =
    createRejectionError === null ? null : `${createRejectionPrefix}${createRejectionError}`
  const recoveryStartedAt = candidate.recoveryStartedAt ?? harnessRecoveryStartedAt()
  if (candidate.recoveryStartedAt === null || candidate.recoveryStartedAt === undefined) {
    store.updateHarnessCandidate(run.id, candidate.agent, { recoveryStartedAt })
  }
  if (recoveryTimedOut(recoveryStartedAt)) {
    return failTimedOutRecovery(store, run, candidate)
  }
  let listed: RuntimeWorktreeListResult
  try {
    listed = await runtime.call<RuntimeWorktreeListResult>('worktree.list', {
      repo: `id:${run.repoId}`
    })
  } catch (error) {
    if (recoveryTimedOut(recoveryStartedAt)) {
      return failTimedOutRecovery(store, run, candidate)
    }
    store.updateHarnessCandidate(run.id, candidate.agent, {
      error: pendingCreateError ?? `Could not recover candidate worktree: ${errorMessage(error)}`
    })
    return null
  }
  if (recoveryTimedOut(recoveryStartedAt)) {
    return failTimedOutRecovery(store, run, candidate)
  }
  if (listed.truncated) {
    store.updateHarnessCandidate(run.id, candidate.agent, {
      error:
        pendingCreateError ??
        'Candidate worktree recovery is waiting for a complete worktree listing.'
    })
    return null
  }

  const expectedBranch = harnessCandidateBranch(run, candidate)
  const matches = listed.worktrees.filter((worktree) =>
    isSameHarnessBranch(worktree.git.branch, expectedBranch)
  )
  if (matches.length > 1) {
    return failCandidate(
      store,
      run,
      candidate,
      `Candidate recovery found multiple worktrees for ${expectedBranch}.`
    )
  }
  const worktree = matches[0]
  if (!worktree) {
    if (createRejectionError !== null) {
      return failCandidate(store, run, candidate, createRejectionError)
    }
    store.updateHarnessCandidate(run.id, candidate.agent, {
      error: 'Candidate worktree recovery is waiting for creation to finish.'
    })
    return null
  }
  if (worktree.git.head !== run.baseSha || worktree.parentWorktreeId !== null) {
    return failCandidate(
      store,
      run,
      candidate,
      'Recovered candidate worktree does not match the requested base snapshot.'
    )
  }

  try {
    const terminal = await findRunningAgentTerminal({ runtime, worktree })
    if (recoveryTimedOut(recoveryStartedAt)) {
      return failTimedOutRecovery(store, run, candidate)
    }
    if (!terminal) {
      store.updateHarnessCandidate(run.id, candidate.agent, {
        error: pendingCreateError ?? 'Candidate recovery is waiting for its agent terminal.'
      })
      return null
    }
    const paneKey = makePaneKey(terminal.tabId, terminal.leafId)
    const persisted = store.updateHarnessCandidate(run.id, candidate.agent, {
      worktreeId: worktree.id,
      worktreePath: worktree.git.path,
      branch: worktree.git.branch,
      agentTerminalHandle: terminal.handle,
      agentTerminalPaneKey: paneKey,
      recoveryStartedAt: null,
      error: null
    })
    return persisted.candidates.find((entry) => entry.agent === candidate.agent) ?? null
  } catch (error) {
    if (recoveryTimedOut(recoveryStartedAt)) {
      return failTimedOutRecovery(store, run, candidate)
    }
    const message = errorMessage(error)
    if (message.includes('more than one running agent terminal')) {
      return failCandidate(store, run, candidate, message)
    }
    store.updateHarnessCandidate(run.id, candidate.agent, {
      error: pendingCreateError ?? `Could not recover candidate terminal: ${message}`
    })
    return null
  }
}
