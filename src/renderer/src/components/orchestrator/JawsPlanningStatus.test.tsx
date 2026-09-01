// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JawsPlanningRun } from '../../../../shared/jaws-types'
import { JawsPlanningStatus } from './JawsPlanningStatus'

const planning: JawsPlanningRun = {
  id: '33333333-3333-4333-8333-333333333333',
  clientRequestId: '44444444-4444-4444-8444-444444444444',
  repoId: 'repo-1',
  sourceWorktreeId: 'repo-1::/repo',
  sourceWorktreePath: '/repo',
  baseSha: 'a'.repeat(40),
  goal: 'Inspect the repository',
  status: 'planning',
  question: null,
  jawsRunId: null,
  error: null,
  logs: [
    { at: 1, stream: 'system', message: 'Planning started.' },
    { at: 2, stream: 'stdout', message: 'Inspecting: git status --short' }
  ],
  createdAt: 1,
  updatedAt: 2
}

afterEach(cleanup)

describe('JawsPlanningStatus', () => {
  it('renders live planning logs and the cancel action', () => {
    render(<JawsPlanningStatus planning={planning} onCancel={vi.fn()} onRevise={vi.fn()} />)

    expect(screen.getByRole('log').textContent).toContain('Planning started.')
    expect(screen.getByRole('log').textContent).toContain('Inspecting: git status --short')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('renders a user-facing Linear question while retaining the activity log', () => {
    render(
      <JawsPlanningStatus
        planning={{
          ...planning,
          status: 'needs_input',
          question:
            '현재 Linear 이슈의 식별자·제목·설명·의존관계를 붙여주시겠어요? Orca 런타임이 꺼져 있고 네트워크도 차단되어 이슈를 조회할 수 없습니다.'
        }}
        onCancel={vi.fn()}
        onRevise={vi.fn()}
      />
    )

    expect(screen.getByText(/Linear 이슈 정보를 확인할 수 없어요/)).toBeTruthy()
    expect(screen.getByRole('log').textContent).toContain('Planning started.')
  })
})
