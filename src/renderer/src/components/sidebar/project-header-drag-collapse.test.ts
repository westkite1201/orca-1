import { describe, expect, it } from 'vitest'
import { withDraggedProjectCollapsed } from './project-header-drag-collapse'

describe('withDraggedProjectCollapsed', () => {
  it('returns the same set instance when nothing is being dragged', () => {
    const collapsed = new Set(['repo:a'])
    expect(withDraggedProjectCollapsed(collapsed, null)).toBe(collapsed)
  })

  it('adds the dragged group key', () => {
    const result = withDraggedProjectCollapsed(new Set(['repo:a']), 'repo:b')
    expect([...result].sort()).toEqual(['repo:a', 'repo:b'])
  })

  it('does not mutate the input set', () => {
    // Why: this is the user's stored collapse state; a drag must never write it.
    const collapsed = new Set(['repo:a'])
    withDraggedProjectCollapsed(collapsed, 'repo:b')
    expect([...collapsed]).toEqual(['repo:a'])
  })

  it('is a no-op when the dragged project is already collapsed', () => {
    const result = withDraggedProjectCollapsed(new Set(['repo:a']), 'repo:a')
    expect([...result]).toEqual(['repo:a'])
  })
})
