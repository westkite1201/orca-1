# Project Header Drag — Lift and Part

## Problem

Dragging a project header in the sidebar feels dated and reads as unfinished.

The sidebar has four pointer-drag surfaces: project headers, project group headers, host headers, and workspace cards. Workspace cards and host headers already use a modern model — neighbours slide aside to open a gap, driven by a per-row preview offset composed into the virtualizer transform (`WorktreeList.tsx:4993-4997`). Project headers are the last surface still on the original model: the dragged row stays where it is, gets a faint tint plus `scale-[1.01]`, and a thin dotted insertion line marks the target (`WorktreeList.tsx:4085`, `WorktreeList.tsx:4317`).

Two consequences:

- **No sense of carrying anything.** Nothing tracks the pointer, so the drag reads as "the list is thinking" rather than "I am holding this project."
- **Inconsistency inside one list.** A user who drags a workspace card and then a project header gets two different interactions two rows apart. That inconsistency is most of why the surface reads as tacky.

The feature also has a long defect history — nine-plus fixes touching these modules (#8919, #8891, #5905, #5867, #5862, #5278, #5237, #4935, #4865) — so any change must avoid disturbing the commit path that those fixes stabilised.

## Goal

Bring project header dragging onto the interaction the rest of the sidebar already uses:

- The dragged header lifts and follows the pointer.
- The project collapses to a single header row for the duration of the drag, so the gap that opens is exactly what will move.
- Neighbouring headers slide aside to open that gap; the insertion line is retired for this surface.

## Non-goals

- Do not change project group header, host header, or workspace card dragging. They keep their current behaviour, including the insertion line where they use it.
- Do not change the commit path. Ungrouped reorder keeps going through `reorderRepos`; in-group reorder keeps going through `moveProjectToGroup`. This change is drag-time presentation only.
- Do not change `projectOrderBy`, the manual/recent ordering model, or when dragging is enabled (`canReorderRepoHeaders`).
- Do not adopt `@dnd-kit` for this surface. It is a dependency used by the tab bar, but the sidebar's virtualized absolute rows are the documented reason this code uses raw pointer events (`project-header-drag.ts:19-22`), and re-platforming a surface with this defect history is disproportionate risk.
- Do not unify the four sidebar drag implementations. The duplication is real and worth addressing later; it is out of scope here.
- Do not persist the drag-time collapse. The user's own collapse state must be untouched.

## Design

### 1. Preview offsets as a separate pure function

`computeWorktreeSidebarHeaderDropPreview` in `worktree-sidebar-header-drop-preview.ts` is shared by project headers and project group headers, and returns `{ dropIndex, dropIndicatorY }`. Adding offsets to it would change group headers too, which is out of scope.

Instead, add a new pure function in the same module:

```ts
export function buildSidebarHeaderPreviewOffsets(args: {
  orderedIds: readonly string[]
  draggedId: string
  dropIndex: number
  collapsedHeaderHeight: number
}): ReadonlyMap<string, number>
```

Every header between the dragged header's origin slot and `dropIndex` shifts by exactly one collapsed header height; everything else is zero. Because the dragged project is collapsed for the duration of the drag (§2), every displaced unit is one header tall, so this is a single multiplication rather than a variable-height accumulation.

`computeProjectHeaderDropPreview` calls both functions and returns `dropIndex` plus `previewOffsetsByRepoId`. Project group headers keep calling only the existing function and are unaffected.

### 2. Drag-time collapse reuses existing state

`WorktreeList` already threads `collapsedGroups: Set<string>` into row building, and `buildRows` honours it (`WorktreeList.tsx:2111`, `:2163`). The drag does not introduce new collapse machinery: while a drag is promoted, row building receives a derived set — `collapsedGroups` plus the dragged project's group key — and the stored set is never written.

The derived set is produced by a pure helper so it can be tested without a component:

```ts
export function withDraggedProjectCollapsed(
  collapsedGroups: ReadonlySet<string>,
  draggedGroupKey: string | null
): ReadonlySet<string>
```

Returns the original set unchanged when `draggedGroupKey` is `null`, so the non-dragging path allocates nothing.

Collapsing changes the row set and total height mid-drag. Two existing mechanisms absorb this:

- `useRepoHeaderDrag` already calls `refreshHeaderRects()` on every `pointermove`, so cached rects cannot go stale.
- `virtualizer.shouldAdjustScrollPositionOnItemSizeChange` is already customised (`WorktreeList.tsx:2078`).

Whether the scroll position actually holds steady at the moment of collapse cannot be proven by unit tests. It is listed as a manual verification item in §6.

### 3. Rendering

The dragged header composes its own pointer-following transform; every other header composes its preview offset. Both build on the existing `getVirtualRowTransform(vItem.start)` choke point, mirroring `getWorktreeVirtualRowTransform(vItem.start, parentPreviewOffset)` used by workspace cards.

While any header drag is active, header rows carry `transition-transform duration-150 ease-out will-change-transform` — the same timing workspace cards use. Two easing speeds inside one sidebar would reintroduce the problem this change is meant to fix.

The dragged header is removed from the transition so it tracks the pointer without lag, and is raised above its neighbours.

### 4. Visual treatment

Retiring the insertion line for this surface removes the dotted-line-with-end-caps motif, and the lift replaces `scale-[1.01]`.

The lifted header uses the **Floating** elevation from `docs/STYLEGUIDE.md:105` — `0 10px 24px rgba(0, 0, 0, 0.18)` — with `bg-worktree-sidebar-accent` and a `ring-worktree-sidebar-ring` outline. No new shadow tier is introduced; the styleguide explicitly forbids a fourth level.

`WorktreeSidebarDropIndicator` stays in the codebase. Project group, host, and workspace-card drags continue to use it.

### 5. Cancellation

Three paths end a drag — `Escape`, `pointercancel`, and window `blur` — and all three already route to `endDrag(false)`.

Releasing the derived collapse is the highest-risk part of this change. If a drag ends without clearing it, the project appears collapsed and the user has no idea why, because they never collapsed it. The clear therefore runs **before** any early return in `endDrag`, and unconditionally, so a missing session cannot strand it.

Commit failure behaviour is unchanged: a rejected permutation refetches repos and the view returns to server state.

### 6. Testing

**Unit — `buildSidebarHeaderPreviewOffsets`:** correct offsets for a downward drag, an upward drag, a no-op drop on the origin slot, and drops clamped at both ends of the list. Untouched headers map to zero.

**Unit — `withDraggedProjectCollapsed`:** adds only the dragged key; returns the input untouched when the argument is `null`; never mutates the input set.

**Component — cancellation:** three separate tests, one per path (`Escape`, `pointercancel`, `blur`), each asserting the derived collapse is released. Written separately rather than parameterised because this is the failure mode with the worst user-visible outcome.

**Component — commit unchanged:** a completed drag still calls the existing commit with the same arguments as today, guarding the stabilised path.

**Rewrite, do not extend:** the `dropIndicatorY` assertions in `project-header-drop.test.ts` encode an indicator this surface no longer renders. They are replaced by offset-map assertions. Group-header indicator tests stay as they are.

**Manual verification in Electron** (cannot be covered by tests, results to be reported):

1. Scroll position holds when a mid-list project collapses on drag start.
2. Edge autoscroll keeps header rect measurement in step while the list is shorter.
3. A drag cancelled by `Escape`, by window blur, and by a lost pointer each restore the project's expanded state.
4. Dragging the last project below the end of the list still lands correctly.

## Rollout

1. Add `buildSidebarHeaderPreviewOffsets` and `withDraggedProjectCollapsed` with their unit tests.
2. Extend `computeProjectHeaderDropPreview` to return `previewOffsetsByRepoId`; leave the group-header path alone.
3. Extend `RepoDragState` and `useRepoHeaderDrag` to carry the offset map and the dragged group key, and release the collapse in `endDrag`.
4. Wire `WorktreeList` to derive the collapsed set, compose header transforms, and drop the project-header insertion line.
5. Apply the Floating elevation to the lifted header.
6. Rewrite the incompatible indicator tests; add the cancellation and commit-unchanged component tests.
7. Run `pnpm test`, `pnpm run typecheck`, `pnpm run lint`.
8. Run the four manual checks in Electron and report the results.

## Open follow-up

Unifying the four sidebar drag implementations behind one primitive remains attractive — threshold, pointer capture, autoscroll, preview offsets, and commit are reimplemented four times. This change makes that easier by giving project headers the same shape as workspace cards, but it is a separate piece of work.
