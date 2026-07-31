// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JawsRunView } from '../../../../shared/jaws-types'
import { JawsChatSurface } from './JawsChatSurface'

const run: JawsRunView = {
  id: '11111111-1111-4111-8111-111111111111',
  repoId: 'repo-1',
  sourceWorktreeId: 'repo-1::/repo',
  sourceWorktreePath: '/repo',
  baseSha: 'a'.repeat(40),
  revision: 2,
  planHash: 'b'.repeat(64),
  plan: {
    goal: 'Implement the feature',
    verificationCommand: 'pnpm test',
    maxConcurrency: 2,
    tasks: [
      { key: 'API', title: 'Build API', objective: 'Implement API', dependsOn: [] },
      { key: 'UI', title: 'Build UI', objective: 'Implement UI', dependsOn: ['API'] }
    ]
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('JawsChatSurface', () => {
  it('renders the approved effects and uses the narrow approval API', async () => {
    const approvePlan = vi.fn(async () => ({
      run: { ...run, approvalStartedAt: 2, status: 'starting' as const }
    }))
    const call = vi.fn(async () => ({
      id: 'desktop-ipc',
      ok: true as const,
      result: { runs: [run] },
      _meta: { runtimeId: 'local' }
    }))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtime: { call }, jaws: { approvePlan } }
    })

    render(<JawsChatSurface worktreeId={run.sourceWorktreeId} />)

    expect(await screen.findByText('Implement the feature')).toBeTruthy()
    expect(screen.getByText(/1 integration \+ 2 worker worktrees/)).toBeTruthy()
    expect(screen.getByText('pnpm test')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan and run' }))

    await waitFor(() =>
      expect(approvePlan).toHaveBeenCalledWith({
        runId: run.id,
        revision: run.revision,
        planHash: run.planHash
      })
    )
  })

  it('keeps multiline verification text exact', async () => {
    const multilineRun = {
      ...run,
      plan: { ...run.plan, verificationCommand: 'pnpm test\n  pnpm lint' }
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        runtime: {
          call: vi.fn(async () => ({
            ok: true as const,
            result: { runs: [multilineRun] }
          }))
        }
      }
    })

    render(<JawsChatSurface worktreeId={run.sourceWorktreeId} />)

    expect((await screen.findByText(/pnpm test/)).textContent).toBe('pnpm test\n  pnpm lint')
  })

  it('shows confirmed Linear mappings and opens their trusted links', async () => {
    const linearRun: JawsRunView = {
      ...run,
      plan: {
        ...run.plan,
        linear: {
          workspaceId: 'workspace-1',
          team: 'WES',
          project: 'Jaws',
          rootIssue: {
            kind: 'existing',
            id: '22222222-2222-4222-8222-222222222222',
            identifier: 'WES-1',
            title: 'Root',
            url: 'https://linear.app/westkitedev/issue/WES-1',
            stateId: 'state-todo',
            parentId: null,
            relations: []
          }
        }
      },
      linearMaterialization: {
        status: 'confirmed',
        rootIssue: {
          id: '22222222-2222-4222-8222-222222222222',
          identifier: 'WES-1',
          title: 'Root',
          url: 'https://linear.app/westkitedev/issue/WES-1',
          stateId: 'state-todo',
          parentId: null
        },
        items: [
          {
            key: 'API',
            issue: {
              id: '33333333-3333-4333-8333-333333333333',
              identifier: 'WES-2',
              title: 'Build API',
              url: 'https://linear.app/westkitedev/issue/WES-2',
              stateId: 'state-todo',
              parentId: '22222222-2222-4222-8222-222222222222'
            }
          },
          { key: 'UI', issue: null }
        ],
        effects: [],
        error: null,
        updatedAt: 2
      }
    }
    const openUrl = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        runtime: {
          call: vi.fn(async () => ({
            ok: true as const,
            result: { runs: [linearRun] }
          }))
        },
        shell: { openUrl }
      }
    })

    render(<JawsChatSurface worktreeId={run.sourceWorktreeId} />)

    expect(await screen.findByText('Team WES · Project Jaws')).toBeTruthy()
    expect(screen.getByText('Pending')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'WES-2' }))
    expect(openUrl).toHaveBeenCalledWith('https://linear.app/westkitedev/issue/WES-2')
  })

  it('ignores a previous worktree response after switching worktrees', async () => {
    let releaseOld: ((value: unknown) => void) | undefined
    const newRun = {
      ...run,
      id: '22222222-2222-4222-8222-222222222222',
      sourceWorktreeId: 'repo-1::/new',
      plan: { ...run.plan, goal: 'New worktree plan' }
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        runtime: {
          call: vi.fn(({ params }: { params: { worktree: string } }) =>
            params.worktree.endsWith('/new')
              ? Promise.resolve({ ok: true as const, result: { runs: [newRun] } })
              : new Promise((resolve) => {
                  releaseOld = resolve
                })
          )
        }
      }
    })

    const view = render(<JawsChatSurface worktreeId={run.sourceWorktreeId} />)
    view.rerender(<JawsChatSurface worktreeId={newRun.sourceWorktreeId} />)
    expect(await screen.findByText('New worktree plan')).toBeTruthy()
    releaseOld?.({ ok: true, result: { runs: [run] } })

    await waitFor(() => expect(screen.queryByText('Implement the feature')).toBeNull())
  })
})
