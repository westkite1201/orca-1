import type { HarnessCandidate, HarnessRun } from '../../shared/harness-types'
import type { Store } from '../persistence'
import { verifyHarnessCandidate, type HarnessVerificationRunner } from './candidate-verification'
import type { HarnessRuntimeCaller } from './runtime-caller'
import { isUnverifiedVerificationStopError } from './verification-terminal-error'

type VerificationStore = Pick<Store, 'getRepo' | 'updateHarnessCandidate'>
export const VERIFICATION_INTERRUPTED_ERROR =
  'Verification was interrupted before completion evidence was persisted.'
export const VERIFICATION_TERMINAL_MAY_BE_RUNNING_ERROR =
  'Verification terminal stop could not be verified; it may still be running.'
const LEGACY_VERIFICATION_TERMINAL_MAY_BE_RUNNING_ERROR =
  'Interrupted verification has no durable terminal identity; it may still be running.'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function recoverInterruptedVerification(args: {
  store: VerificationStore
  runtime: HarnessRuntimeCaller
  run: HarnessRun
  candidate: HarnessCandidate
}): Promise<void> {
  const { store, runtime, run, candidate } = args
  if (candidate.verificationTerminalOwnership === 'stopped') {
    store.updateHarnessCandidate(run.id, candidate.agent, {
      status: 'failed',
      verificationTerminalHandle: null,
      verificationTerminalPaneKey: null,
      verificationTerminalOwnership: null,
      error: VERIFICATION_INTERRUPTED_ERROR
    })
    return
  }
  if (candidate.verificationTerminalOwnership === 'pending') {
    // Why: createTerminal persists `owned` synchronously before PTY spawn. A
    // durable `pending` barrier therefore proves the launch callback never ran.
    store.updateHarnessCandidate(run.id, candidate.agent, {
      status: 'failed',
      verificationTerminalHandle: null,
      verificationTerminalPaneKey: null,
      verificationTerminalOwnership: null,
      error: VERIFICATION_INTERRUPTED_ERROR
    })
    return
  }

  if (
    candidate.verificationTerminalOwnership !== 'owned' ||
    !candidate.verificationTerminalHandle ||
    !candidate.verificationTerminalPaneKey ||
    !candidate.worktreeId
  ) {
    if (candidate.error !== LEGACY_VERIFICATION_TERMINAL_MAY_BE_RUNNING_ERROR) {
      store.updateHarnessCandidate(run.id, candidate.agent, {
        status: 'verifying',
        error: LEGACY_VERIFICATION_TERMINAL_MAY_BE_RUNNING_ERROR
      })
    }
    return
  }

  let stopped = false
  try {
    stopped = await runtime.stopVerificationTerminal({
      handle: candidate.verificationTerminalHandle,
      paneKey: candidate.verificationTerminalPaneKey,
      worktreeId: candidate.worktreeId
    })
  } catch {
    stopped = false
  }
  if (!stopped) {
    if (candidate.error !== VERIFICATION_TERMINAL_MAY_BE_RUNNING_ERROR) {
      store.updateHarnessCandidate(run.id, candidate.agent, {
        status: 'verifying',
        error: VERIFICATION_TERMINAL_MAY_BE_RUNNING_ERROR
      })
    }
    return
  }

  // Why: make stop proof durable before terminalizing the candidate; a crash
  // between these writes can then recover without resolving an already-gone PTY.
  store.updateHarnessCandidate(
    run.id,
    candidate.agent,
    {
      verificationTerminalOwnership: 'stopped'
    },
    { durability: 'required' }
  )
  store.updateHarnessCandidate(run.id, candidate.agent, {
    status: 'failed',
    verificationTerminalHandle: null,
    verificationTerminalPaneKey: null,
    verificationTerminalOwnership: null,
    error: VERIFICATION_INTERRUPTED_ERROR
  })
}

export async function persistHarnessCandidateVerification(args: {
  store: VerificationStore
  runtime: HarnessRuntimeCaller
  run: HarnessRun
  candidate: HarnessCandidate
  timeoutSeconds: number
  runPrecheck?: HarnessVerificationRunner
}): Promise<void> {
  const { store, runtime, run } = args
  let { candidate } = args
  if (
    candidate.status === 'verifying' &&
    candidate.verification?.error === VERIFICATION_INTERRUPTED_ERROR
  ) {
    await recoverInterruptedVerification({
      store,
      runtime,
      run,
      candidate
    })
    return
  }
  if (candidate.status === 'worker_done') {
    const updated = store.updateHarnessCandidate(run.id, candidate.agent, {
      status: 'verifying',
      error: null
    })
    candidate = updated.candidates.find((entry) => entry.agent === candidate.agent) ?? candidate
  }
  const repo = store.getRepo(run.repoId)
  if (!repo) {
    store.updateHarnessCandidate(run.id, candidate.agent, {
      status: 'failed',
      verificationTerminalHandle: null,
      verificationTerminalPaneKey: null,
      verificationTerminalOwnership: null,
      error: 'The repository is no longer available.'
    })
    return
  }

  try {
    const evidence = await verifyHarnessCandidate({
      run,
      candidate,
      repo,
      runtime,
      timeoutSeconds: args.timeoutSeconds,
      runPrecheck: args.runPrecheck,
      onCommandStart: ({ diff, startedAt }) => {
        store.updateHarnessCandidate(
          run.id,
          candidate.agent,
          {
            diff,
            verification: {
              command: run.verificationCommand,
              exitCode: null,
              timedOut: false,
              durationMs: 0,
              outputTail: '',
              outputTruncated: false,
              error: VERIFICATION_INTERRUPTED_ERROR,
              startedAt,
              completedAt: startedAt
            },
            verificationTerminalHandle: null,
            verificationTerminalPaneKey: null,
            verificationTerminalOwnership: 'pending',
            error: null
          },
          { durability: 'required' }
        )
      }
    })
    store.updateHarnessCandidate(run.id, candidate.agent, {
      status:
        evidence.error && !evidence.retryable
          ? 'failed'
          : evidence.error
            ? 'verifying'
            : 'verified',
      diff: evidence.diff,
      verification: evidence.verification,
      verificationTerminalHandle: null,
      verificationTerminalPaneKey: null,
      verificationTerminalOwnership: null,
      error: evidence.error
    })
  } catch (error) {
    if (isUnverifiedVerificationStopError(error)) {
      store.updateHarnessCandidate(run.id, candidate.agent, {
        status: 'verifying',
        error: VERIFICATION_TERMINAL_MAY_BE_RUNNING_ERROR
      })
      return
    }
    store.updateHarnessCandidate(run.id, candidate.agent, {
      status: 'failed',
      verificationTerminalHandle: null,
      verificationTerminalPaneKey: null,
      verificationTerminalOwnership: null,
      error: errorMessage(error)
    })
  }
}
