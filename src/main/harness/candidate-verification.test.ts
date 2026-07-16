import { describe, expect, it, vi } from 'vitest'
import type { HarnessCandidate } from '../../shared/harness-types'
import type { HarnessRuntimeCaller } from './runtime-caller'
import { verifyHarnessCandidate } from './verification'
import {
  createHarnessBranchCompareFixture,
  createHarnessPrecheckResult,
  createHarnessRunFixture
} from './verification-test-fixtures'

function completedCandidate(): HarnessCandidate {
  const candidate = createHarnessRunFixture().candidates[0]
  return {
    ...candidate,
    status: 'worker_done',
    workerResult: {
      messageId: 'message-codex',
      subject: 'codex done',
      body: 'done',
      payload: null,
      receivedAt: 2
    },
    workerCompletedAt: 2
  }
}

function runtimeWithGitCall(
  call: ReturnType<typeof vi.fn>,
  runVerification: ReturnType<typeof vi.fn>
) {
  return {
    call,
    abandonDispatch: vi.fn(async () => true),
    stopChildDispatch: vi.fn(async () => true),
    stopVerificationTerminal: vi.fn(async () => true),
    runVerification
  } as HarnessRuntimeCaller
}

const repo = {
  id: 'repo-1',
  path: 'repo-root',
  displayName: 'Repo',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'git' as const
}

describe('Harness candidate verification', () => {
  it('persists the command-start barrier between owner-runtime Git snapshots', async () => {
    const call = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'git.status') {
        return {
          entries: [],
          conflictOperation: 'unknown',
          head: 'head-codex',
          branch: 'harness-codex'
        }
      }
      if (method === 'git.branchCompare') {
        return createHarnessBranchCompareFixture('codex')
      }
      throw new Error(`Unexpected runtime call: ${method}`)
    })
    const runVerification = vi.fn(async () => createHarnessPrecheckResult(0))
    const onCommandStart = vi.fn(() => {
      expect(runVerification).not.toHaveBeenCalled()
    })

    const evidence = await verifyHarnessCandidate({
      run: createHarnessRunFixture(),
      candidate: completedCandidate(),
      repo,
      runtime: runtimeWithGitCall(call, runVerification),
      timeoutSeconds: 900,
      onCommandStart
    })

    expect(call.mock.calls.map(([method]) => method)).toEqual([
      'git.status',
      'git.branchCompare',
      'git.status',
      'git.branchCompare'
    ])
    expect(runVerification).toHaveBeenCalledWith({
      runId: 'run-1',
      agent: 'codex',
      worktree: 'id:worktree-codex',
      command: 'pnpm test',
      timeoutSeconds: 900
    })
    expect(onCommandStart).toHaveBeenCalledWith({
      diff: expect.objectContaining({
        changedFiles: [{ path: 'src/codex.ts', status: 'modified', added: 2, removed: 1 }]
      }),
      startedAt: expect.any(Number)
    })
    expect(evidence.error).toBeNull()
    expect(evidence.diff.changedFiles).toHaveLength(1)
  })

  it('does not start verification until pre-command Git evidence is durable', async () => {
    const call = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'git.status') {
        throw new Error('runtime reconnecting')
      }
      if (method === 'git.branchCompare') {
        return createHarnessBranchCompareFixture('codex')
      }
      throw new Error(`Unexpected runtime call: ${method}`)
    })
    const runVerification = vi.fn(async () => createHarnessPrecheckResult(0))

    const evidence = await verifyHarnessCandidate({
      run: createHarnessRunFixture(),
      candidate: completedCandidate(),
      repo,
      runtime: runtimeWithGitCall(call, runVerification),
      timeoutSeconds: 900
    })

    expect(evidence).toMatchObject({
      retryable: true,
      error: 'Pre-verification Git evidence failed: runtime reconnecting'
    })
    expect(runVerification).not.toHaveBeenCalled()
  })
})
