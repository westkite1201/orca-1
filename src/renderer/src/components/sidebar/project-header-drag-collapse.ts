/**
 * Collapse set used while a project header drag is in flight. The dragged
 * project folds to a single row so the gap that opens matches what will move.
 * Derived only — the stored collapse state is never written.
 */
export function withDraggedProjectCollapsed(
  collapsedGroups: ReadonlySet<string>,
  draggedGroupKey: string | null
): ReadonlySet<string> {
  if (draggedGroupKey === null || collapsedGroups.has(draggedGroupKey)) {
    return collapsedGroups
  }
  const next = new Set(collapsedGroups)
  next.add(draggedGroupKey)
  return next
}
