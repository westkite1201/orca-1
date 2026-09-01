// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JawsPlanningRun, JawsRunView } from '../../../../shared/jaws-types'

const callRuntimeRpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc }))
vi.mock('@/components/orchestrator/jaws-runtime-capability', () => ({
  assertJawsTargetSupported: vi.fn()
}))
vi.mock('./use-harness-active-run-reconnect', () => ({
  getHarnessRuntimeTarget: () => ({ kind: 'local' })
}))
vi.mock('@/store/selectors', () => ({
  useActiveWorktreeId: () => 'wt-1',
  useAllWorktrees: () => [
    {
      id: 'wt-1',
      repoId: 'repo-1',
      path: '/repo',
      branch: 'main',
      displayName: 'main',
      isBare: false
    }
  ],
  useRepos: () => [{ id: 'repo-1', kind: 'git', path: '/repo', displayName: 'Jaws' }]
}))

import { HarnessRunDialog } from './HarnessRunDialog'

const planning: JawsPlanningRun = {
  id: '33333333-3333-4333-8333-333333333333',
  clientRequestId: '44444444-4444-4444-8444-444444444444',
  repoId: 'repo-1',
  sourceWorktreeId: 'wt-1',
  sourceWorktreePath: '/repo',
  baseSha: 'a'.repeat(40),
  goal: 'Implement recovery',
  status: 'needs_input',
  question: 'Which API owns retries?',
  jawsRunId: null,
  error: null,
  logs: [],
  createdAt: 1,
  updatedAt: 1
}

const run: JawsRunView = {
  id: '11111111-1111-4111-8111-111111111111',
  repoId: 'repo-1',
  sourceWorktreeId: 'wt-1',
  sourceWorktreePath: '/repo',
  baseSha: 'a'.repeat(40),
  revision: 1,
  planHash: 'b'.repeat(64),
  plan: {
    goal: 'Durable plan',
    verificationCommand: 'pnpm test',
    maxConcurrency: 1,
    tasks: [{ key: 'task', title: 'Task', objective: 'Implement it', dependsOn: [] }]
  },
  approvalStartedAt: null,
  harnessRunId: null,
  error: null,
  createdAt: 1,
  updatedAt: 1,
  status: 'awaiting_approval',
  harnessStatus: null,
  harnessError: null,
  verification: null
}

afterEach(cleanup)

beforeEach(() => {
  callRuntimeRpc.mockReset()
})

describe('HarnessRunDialog native planning state', () => {
  it('cancels a clarification before showing the editable goal form', async () => {
    callRuntimeRpc.mockImplementation(async (_target, method) => {
      if (method === 'jaws.planningList') {
        return { planning: [planning] }
      }
      if (method === 'jaws.runList') {
        return { runs: [] }
      }
      if (method === 'jaws.planningCancel') {
        return { planning: { ...planning, status: 'canceled' } }
      }
      throw new Error(`Unexpected method: ${method}`)
    })

    render(<HarnessRunDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Revise goal' }))

    expect(await screen.findByLabelText('Issue or goal')).toBeTruthy()
    expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'jaws.planningCancel', {
      planningId: planning.id
    })
  })

  it('restores durable history again after New plan is closed and reopened', async () => {
    callRuntimeRpc.mockImplementation(async (_target, method) => {
      if (method === 'jaws.planningList') {
        return { planning: [] }
      }
      if (method === 'jaws.runList') {
        return { runs: [run] }
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    function Wrapper(): React.JSX.Element {
      const [open, setOpen] = useState(true)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Reopen
          </button>
          <HarnessRunDialog open={open} onOpenChange={setOpen} />
        </>
      )
    }

    render(<Wrapper />)
    expect(await screen.findByText('Durable plan')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'New plan' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))

    await waitFor(() => expect(screen.getByText('Durable plan')).toBeTruthy())
    expect(callRuntimeRpc.mock.calls.filter((call) => call[1] === 'jaws.runList')).toHaveLength(2)
  })
})
