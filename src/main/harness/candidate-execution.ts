import type { Store } from '../persistence'
import {
  createHarnessCandidate,
  dispatchHarnessCandidate,
  waitForHarnessCandidate
} from './candidate-launch'
import { buildHarnessTaskSpec, createHarnessTask } from './candidate-task'
import type { HarnessRuntimeCaller } from './runtime-caller'

type CandidateExecutionStore = Pick<Store, 'getRepo' | 'getHarnessRun' | 'updateHarnessCandidate'>
type SshRuntimeReadinessResult = { runtimeReady: boolean }

async function isHarnessRunHostReady(args: {
  store: CandidateExecutionStore
  runtime: HarnessRuntimeCaller
  repoId: string
}): Promise<boolean> {
  const connectionId = args.store.getRepo(args.repoId)?.connectionId
  if (!connectionId) {
    return true
  }
  try {
    const result = await args.runtime.call<SshRuntimeReadinessResult>('ssh.getState', {
      targetId: connectionId
    })
    return result.runtimeReady
  } catch {
    return false
  }
}

export async function executeHarnessCandidates(args: {
  store: CandidateExecutionStore
  runtime: HarnessRuntimeCaller
  runId: string
}): Promise<boolean> {
  const { store, runtime, runId } = args
  let run = store.getHarnessRun(runId)
  if (!run || run.fatalError) {
    return false
  }
  if (!(await isHarnessRunHostReady({ store, runtime, repoId: run.repoId }))) {
    return false
  }

  for (const initialCandidate of run.candidates) {
    const candidate = run.candidates.find((entry) => entry.id === initialCandidate.id)
    if (candidate?.status === 'pending') {
      await createHarnessCandidate({ store, runtime, run, candidate })
    } else if (candidate?.status === 'creating') {
      await waitForHarnessCandidate({ store, runtime, run, candidate })
    }
    run = store.getHarnessRun(runId)
    if (!run) {
      throw new Error('Run not found.')
    }
  }

  // Why: launch failures are terminal; close untouched lanes while retaining
  // any worktree evidence instead of leaving the run permanently active.
  if (
    run.candidates.some(
      (candidate) => candidate.status === 'failed' && candidate.dispatchId === null
    )
  ) {
    for (const candidate of run.candidates) {
      if (['pending', 'creating', 'ready'].includes(candidate.status)) {
        store.updateHarnessCandidate(run.id, candidate.agent, {
          status: 'failed',
          error: 'Comparison could not start because the peer failed.'
        })
      }
    }
    run = store.getHarnessRun(runId)
    if (!run) {
      throw new Error('Run not found.')
    }
  }

  // Why: durable tasks are the barrier before dispatch; a ready lane may still
  // need dispatch after another worker has progressed or completed.
  if (run.candidates.every((candidate) => ['ready', 'running'].includes(candidate.status))) {
    const spec = buildHarnessTaskSpec(run)
    for (const candidate of run.candidates) {
      if (candidate.status === 'ready' && !candidate.taskId) {
        await createHarnessTask({ store, runtime, run, candidate, spec })
      }
      run = store.getHarnessRun(runId)
      if (!run) {
        throw new Error('Run not found.')
      }
    }
  }
  if (
    run.candidates.every((candidate) => candidate.taskId !== null) &&
    run.candidates.some((candidate) => candidate.status === 'ready')
  ) {
    const dispatchRun = run
    // Why: dispatch every ready lane from one snapshot while allowing a
    // transiently blocked lane to retry after its counterparts advance.
    await Promise.all(
      run.candidates
        .filter((candidate) => candidate.status === 'ready')
        .map((candidate) =>
          dispatchHarnessCandidate({ store, runtime, run: dispatchRun, candidate })
        )
    )
  }
  return true
}
