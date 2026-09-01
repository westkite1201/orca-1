// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { JawsPlanInputForm } from './JawsPlanInputForm'

describe('JawsPlanInputForm', () => {
  it('starts native planning from a goal without asking for a verification command', async () => {
    const user = userEvent.setup()
    const onGoalChange = vi.fn()
    const onSubmit = vi.fn()

    render(
      <JawsPlanInputForm
        options={[{ id: 'wt-1', label: 'Jaws / main', path: '/repo', branch: 'main' }]}
        selectedOption={{ id: 'wt-1', label: 'Jaws / main', path: '/repo', branch: 'main' }}
        selectedWorktreeId="wt-1"
        goal="Implement recovery"
        submitting={false}
        error={null}
        onSelectedWorktreeChange={vi.fn()}
        onGoalChange={onGoalChange}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />
    )

    expect(screen.queryByLabelText(/verification command/i)).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Create plan' }))
    expect(onSubmit).toHaveBeenCalledOnce()
  })
})
