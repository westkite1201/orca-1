// @vitest-environment happy-dom

import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HarnessRun } from '../../../../shared/harness-types'
import { HARNESS_ORCHESTRATOR_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  isHarnessRunActive,
  useHarnessActiveRunReconnect
} from './use-harness-active-run-reconnect'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  runtimeEnvironmentSupportsCapability: vi.fn()
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: vi.fn(() => null)
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: vi.fn(() => ({})) }
}))

const activeRun = {
  id: 'run-1',
  sourceWorktreeId: 'worktree-1',
  createdAt: 1,
  fatalError: null,
  candidates: [{ status: 'running' }, { status: 'running' }]
} as HarnessRun

const completedRun = {
  ...activeRun,
  id: 'run-completed',
  createdAt: 2,
  candidates: [{ status: 'verified' }, { status: 'failed' }]
} as HarnessRun

function ReconnectHarness({
  formDirty,
  includeTerminalRuns = true,
  open = true
}: {
  formDirty: boolean
  includeTerminalRuns?: boolean
  open?: boolean
}): React.JSX.Element {
  const [run, setRun] = useState<HarnessRun | null>(null)
  const [target, setTarget] = useState<RuntimeClientTarget | null>(null)

  const discovery = useHarnessActiveRunReconnect({
    open,
    hasInMemoryActiveRun: run ? isHarnessRunActive(run) : false,
    submitting: false,
    formDirty,
    includeTerminalRuns,
    sourceWorktreeId: 'worktree-1',
    repoId: 'repo-1',
    setRun,
    setRunTarget: setTarget
  })

  return (
    <>
      <button type="button" onClick={discovery.retry}>
        Retry discovery
      </button>
      <output>
        {run ? `${run.id}:${target?.kind ?? 'none'}` : 'empty'}:{discovery.status}
      </output>
    </>
  )
}

describe('useHarnessActiveRunReconnect', () => {
  const runtimeRpc = vi.mocked(callRuntimeRpc)
  const runtimeCapability = vi.mocked(runtimeEnvironmentSupportsCapability)
  const runtimeOwner = vi.mocked(getRuntimeEnvironmentIdForWorktree)

  beforeEach(() => {
    runtimeRpc.mockReset()
    runtimeCapability.mockReset()
    runtimeCapability.mockResolvedValue(true)
    runtimeOwner.mockReset()
    runtimeOwner.mockReturnValue(null)
  })
  afterEach(cleanup)

  it('does not replace a dirty form with completed history', async () => {
    runtimeRpc.mockResolvedValue({ runs: [completedRun] })
    render(<ReconnectHarness formDirty />)

    await waitFor(() => expect(screen.getByText('empty:ready')).toBeTruthy())

    expect(runtimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'harness.list', {
      repo: 'id:repo-1'
    })
  })

  it('shows the persisted run without waiting for a slow resume', async () => {
    let resolveResume: ((value: { run: HarnessRun }) => void) | undefined
    runtimeRpc.mockImplementation((_target, method) => {
      if (method === 'harness.list') {
        return Promise.resolve({ runs: [activeRun] })
      }
      return new Promise((resolve) => {
        resolveResume = resolve
      })
    })

    render(<ReconnectHarness formDirty={false} />)

    await waitFor(() => expect(screen.getByText('run-1:local:ready')).toBeTruthy())
    expect(runtimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'harness.resume', { run: 'run-1' })
    await act(async () => resolveResume?.({ run: activeRun }))
  })

  it('restores the latest terminal run without trying to resume it', async () => {
    runtimeRpc.mockResolvedValue({ runs: [completedRun] })

    render(<ReconnectHarness formDirty={false} />)

    await waitFor(() => expect(screen.getByText('run-completed:local:ready')).toBeTruthy())
    expect(runtimeRpc).not.toHaveBeenCalledWith(
      expect.anything(),
      'harness.resume',
      expect.anything()
    )
  })

  it('refreshes terminal history after close and restores a newer external run', async () => {
    let listedRuns: HarnessRun[] = [completedRun]
    runtimeRpc.mockImplementation(async (_target, method) =>
      method === 'harness.list' ? { runs: listedRuns } : { run: listedRuns[0] }
    )
    const view = render(<ReconnectHarness formDirty={false} />)
    await waitFor(() => expect(screen.getByText('run-completed:local:ready')).toBeTruthy())

    view.rerender(<ReconnectHarness formDirty={false} open={false} />)
    listedRuns = [{ ...activeRun, id: 'run-external', createdAt: 3 } as HarnessRun]
    view.rerender(<ReconnectHarness formDirty={false} />)

    await waitFor(() => expect(screen.getByText('run-external:local:ready')).toBeTruthy())
  })

  it('blocks a dirty form when discovery finds an active run', async () => {
    runtimeRpc.mockResolvedValue({ runs: [activeRun] })

    render(<ReconnectHarness formDirty />)

    await waitFor(() => expect(screen.getByText('empty:active-conflict')).toBeTruthy())
  })

  it('ignores discovery that finishes after the user starts editing', async () => {
    const listResolvers: ((value: { runs: HarnessRun[] }) => void)[] = []
    runtimeRpc.mockImplementation(async (_target, method) => {
      if (method === 'harness.list') {
        return new Promise((resolve) => {
          listResolvers.push(resolve)
        })
      }
      return { run: activeRun }
    })

    const view = render(<ReconnectHarness formDirty={false} />)
    await waitFor(() => expect(listResolvers).toHaveLength(1))

    view.rerender(<ReconnectHarness formDirty />)
    await waitFor(() => expect(listResolvers).toHaveLength(2))
    await act(async () => {
      listResolvers[0]?.({ runs: [activeRun] })
      listResolvers[1]?.({ runs: [activeRun] })
    })

    expect(screen.getByText('empty:active-conflict')).toBeTruthy()
    expect(runtimeRpc).not.toHaveBeenCalledWith(
      expect.anything(),
      'harness.resume',
      expect.anything()
    )
  })

  it('retries discovery while the pristine dialog remains open', async () => {
    vi.useFakeTimers()
    runtimeRpc.mockRejectedValueOnce(new Error('owner offline')).mockResolvedValueOnce({ runs: [] })

    render(<ReconnectHarness formDirty={false} />)
    await act(async () => undefined)
    expect(screen.getByText('empty:retrying')).toBeTruthy()

    await act(async () => vi.advanceTimersByTimeAsync(2_000))
    expect(screen.getByText('empty:ready')).toBeTruthy()
    vi.useRealTimers()
  })

  it('preserves an active-conflict notice while its background retry is pending', async () => {
    vi.useFakeTimers()
    let resolveRetry!: (value: { runs: HarnessRun[] }) => void
    runtimeRpc.mockResolvedValueOnce({ runs: [activeRun] }).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRetry = resolve
        })
    )

    render(<ReconnectHarness formDirty />)
    await act(async () => undefined)
    expect(screen.getByText('empty:active-conflict')).toBeTruthy()

    await act(async () => vi.advanceTimersByTimeAsync(2_000))
    expect(screen.getByText('empty:active-conflict')).toBeTruthy()
    await act(async () => resolveRetry({ runs: [activeRun] }))
    vi.useRealTimers()
  })

  it('can skip terminal history after the user chooses a new comparison', async () => {
    runtimeRpc.mockResolvedValue({ runs: [completedRun] })

    render(<ReconnectHarness formDirty={false} includeTerminalRuns={false} />)

    await waitFor(() => expect(screen.getByText('empty:ready')).toBeTruthy())
  })

  it('stops retrying and reports an owner that cannot run Harness', async () => {
    runtimeOwner.mockReturnValue('environment-1')
    runtimeCapability.mockResolvedValue(false)

    render(<ReconnectHarness formDirty={false} />)

    await waitFor(() => expect(screen.getByText('empty:unsupported')).toBeTruthy())
    expect(runtimeCapability).toHaveBeenCalledWith(
      'environment-1',
      HARNESS_ORCHESTRATOR_RUNTIME_CAPABILITY
    )
    expect(runtimeRpc).not.toHaveBeenCalled()
  })

  it('rechecks an unsupported owner after the user retries', async () => {
    runtimeOwner.mockReturnValue('environment-1')
    runtimeCapability.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    runtimeRpc.mockResolvedValue({ runs: [] })

    render(<ReconnectHarness formDirty={false} />)
    await waitFor(() => expect(screen.getByText('empty:unsupported')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Retry discovery' }))

    await waitFor(() => expect(screen.getByText('empty:ready')).toBeTruthy())
    expect(runtimeCapability).toHaveBeenCalledTimes(2)
    expect(runtimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'environment-1' },
      'harness.list',
      {
        repo: 'id:repo-1'
      }
    )
  })

  it('treats protocol incompatibility as terminal instead of retrying forever', async () => {
    vi.useFakeTimers()
    runtimeOwner.mockReturnValue('environment-1')
    runtimeRpc.mockRejectedValue(
      Object.assign(new Error('Update the owner runtime.'), { code: 'runtime_compat_block' })
    )

    render(<ReconnectHarness formDirty={false} />)
    await act(async () => undefined)
    expect(screen.getByText('empty:unsupported')).toBeTruthy()
    const calls = runtimeRpc.mock.calls.length

    await act(async () => vi.advanceTimersByTimeAsync(4_000))
    expect(runtimeRpc).toHaveBeenCalledTimes(calls)
    vi.useRealTimers()
  })

  it('ignores a compatibility rejection after its discovery effect is closed', async () => {
    runtimeOwner.mockReturnValue('environment-1')
    let rejectList!: (error: Error) => void
    runtimeRpc.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectList = reject
        })
    )
    const view = render(<ReconnectHarness formDirty={false} />)
    await waitFor(() => expect(runtimeRpc).toHaveBeenCalledOnce())

    view.rerender(<ReconnectHarness formDirty={false} open={false} />)
    await act(async () => {
      rejectList(Object.assign(new Error('stale owner'), { code: 'runtime_compat_block' }))
    })

    expect(screen.getByText('empty:checking')).toBeTruthy()
  })
})
