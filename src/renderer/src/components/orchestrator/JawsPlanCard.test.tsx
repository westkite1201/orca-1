// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JawsRunView } from '../../../../shared/jaws-types'
import { JawsPlanCard } from './JawsPlanCard'

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

afterEach(cleanup)

describe('JawsPlanCard', () => {
  it('renders the exact approved plan and delegates approval', () => {
    const onApprove = vi.fn()
    render(<JawsPlanCard run={run} onApprove={onApprove} />)

    expect(screen.getByText('Implement the feature')).toBeTruthy()
    expect(screen.getByText(/1 integration \+ 2 worker worktrees/)).toBeTruthy()
    expect(screen.getByText('pnpm test')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan and run' }))
    expect(onApprove).toHaveBeenCalledOnce()
  })

  it('keeps multiline verification text exact', () => {
    render(
      <JawsPlanCard
        run={{
          ...run,
          plan: { ...run.plan, verificationCommand: 'pnpm test\n  pnpm lint' }
        }}
      />
    )

    expect(screen.getByText(/pnpm test/).textContent).toBe('pnpm test\n  pnpm lint')
  })

  it('shows confirmed Linear mappings and delegates trusted links', () => {
    const onOpenUrl = vi.fn()
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

    render(<JawsPlanCard run={linearRun} onOpenUrl={onOpenUrl} />)
    expect(screen.getByText('Team WES · Project Jaws')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'WES-2' }))
    expect(onOpenUrl).toHaveBeenCalledWith('https://linear.app/westkitedev/issue/WES-2')
  })
})
