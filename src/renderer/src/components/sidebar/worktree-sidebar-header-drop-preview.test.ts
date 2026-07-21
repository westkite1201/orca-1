import { describe, expect, it } from 'vitest'
import { buildSidebarHeaderPreviewOffsets } from './worktree-sidebar-header-drop-preview'

const IDS = ['a', 'b', 'c', 'd']
const H = 28

function offsets(draggedId: string, dropIndex: number): Record<string, number> {
  return Object.fromEntries(
    buildSidebarHeaderPreviewOffsets({
      orderedIds: IDS,
      draggedId,
      dropIndex,
      collapsedHeaderHeight: H
    })
  )
}

describe('buildSidebarHeaderPreviewOffsets', () => {
  it('shifts passed headers up when dragging down', () => {
    // 'a' (index 0) dropped at slot 3 passes 'b' and 'c'.
    expect(offsets('a', 3)).toEqual({ b: -H, c: -H })
  })

  it('shifts passed headers down when dragging up', () => {
    // 'd' (index 3) dropped at slot 1 passes 'b' and 'c'.
    expect(offsets('d', 1)).toEqual({ b: H, c: H })
  })

  it('returns an empty map for a no-op drop', () => {
    // Both the own index and one past it leave the order unchanged.
    expect(offsets('b', 1)).toEqual({})
    expect(offsets('b', 2)).toEqual({})
  })

  it('handles drops clamped at both ends', () => {
    expect(offsets('d', 0)).toEqual({ a: H, b: H, c: H })
    expect(offsets('a', IDS.length)).toEqual({ b: -H, c: -H, d: -H })
  })

  it('returns an empty map when the dragged id is not in the list', () => {
    expect(offsets('missing', 2)).toEqual({})
  })

  it('never includes the dragged header itself', () => {
    expect(offsets('a', 3)).not.toHaveProperty('a')
  })
})
