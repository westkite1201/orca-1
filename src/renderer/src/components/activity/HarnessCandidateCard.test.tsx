// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { HarnessCandidate } from '../../../../shared/harness-types'
import { HARNESS_DISPATCH_CONFIRMATION_PENDING } from '../../../../shared/harness-candidate-notice'
import { HarnessCandidateCard } from './HarnessCandidateCard'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function candidate(status: HarnessCandidate['status']): HarnessCandidate {
  return {
    id: 'candidate',
    agent: 'codex',
    status,
    worktreeId: 'worktree',
    worktreePath: '/repo',
    branch: 'jaws-harness-run-codex',
    agentTerminalHandle: 'terminal',
    agentTerminalPaneKey: 'tab:leaf',
    verificationTerminalHandle: 'verification-terminal',
    verificationTerminalPaneKey: 'verification-tab:verification-leaf',
    verificationTerminalOwnership: 'owned',
    taskId: 'task',
    dispatchId: 'dispatch',
    workerResult: null,
    verification: {
      command: 'pnpm test',
      exitCode: 0,
      timedOut: false,
      durationMs: 1_000,
      outputTail: '',
      outputTruncated: false,
      error: null,
      startedAt: 1,
      completedAt: 2
    },
    diff: null,
    error: status === 'failed' ? 'Git evidence could not be captured.' : null,
    createdAt: 1,
    updatedAt: 2,
    startedAt: 1,
    recoveryStartedAt: null,
    childLaneDrainStartedAt: null,
    workerCompletedAt: null,
    completedAt: status === 'failed' ? 2 : null
  }
}

describe('HarnessCandidateCard', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('reports a successful command without hiding a later evidence failure', () => {
    act(() => root.render(<HarnessCandidateCard candidate={candidate('failed')} />))

    expect(container.textContent).toContain('Verification command passed')
    expect(container.textContent).not.toContain('Verification failed')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Git evidence')

    act(() => root.render(<HarnessCandidateCard candidate={candidate('verified')} />))

    expect(container.textContent).toContain('Verification passed')
  })

  it('does not label a durable command-start barrier as a failed verification', () => {
    const verifying = candidate('verifying')
    verifying.verification = {
      ...verifying.verification!,
      exitCode: null,
      error: 'Verification was interrupted before completion evidence was persisted.'
    }

    act(() => root.render(<HarnessCandidateCard candidate={verifying} />))

    expect(container.textContent).not.toContain('Verification failed')
    expect(container.textContent).not.toContain('Verification passed')
  })

  it('shows the coordinator role when supplied', () => {
    act(() =>
      root.render(
        <HarnessCandidateCard candidate={candidate('running')} label="Codex coordinator" />
      )
    )

    expect(container.textContent).toContain('Codex coordinator')
  })

  it('shows restart recovery progress without alerting the user to a failure', () => {
    const recovering = candidate('running')
    recovering.error = HARNESS_DISPATCH_CONFIRMATION_PENDING

    act(() => root.render(<HarnessCandidateCard candidate={recovering} />))

    expect(container.textContent).toContain('waiting for worker confirmation')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    const notice = [...container.querySelectorAll('p')].find((element) =>
      element.textContent?.includes('waiting for worker confirmation')
    )
    expect(notice?.className).toContain('text-muted-foreground')
    expect(notice?.className).not.toContain('text-destructive')
  })

  it('still alerts on a real failure recorded while the candidate is running', () => {
    const stuck = candidate('running')
    stuck.error = 'Dispatch check failed: host unreachable'

    act(() => root.render(<HarnessCandidateCard candidate={stuck} />))

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Dispatch check failed'
    )
  })

  it('shows the durable worker result and bounds long errors', () => {
    const completed = candidate('failed')
    completed.workerResult = {
      messageId: 'message',
      subject: 'Integrated',
      body: 'Implemented search and updated its tests.',
      payload: null,
      receivedAt: 2
    }
    completed.error = 'x'.repeat(2_000)

    act(() => root.render(<HarnessCandidateCard candidate={completed} />))

    expect(container.textContent).toContain('Implemented search and updated its tests.')
    expect(container.querySelector('[role="alert"]')?.className).toContain('max-h-28')
  })
})
