import { estimateRenderRowSize } from './worktree-list/viewport/virtual-rows'
import type { RenderRow } from './worktree-list/listing/render-row'

function getEstimatedRenderRowStarts(
  rows: readonly RenderRow[],
  firstHeaderIndex: number
): number[] {
  const starts: number[] = []
  let offset = 0
  for (let index = 0; index < rows.length; index++) {
    starts[index] = offset
    offset += estimateRenderRowSize(rows, index, firstHeaderIndex, null)
  }
  starts[rows.length] = offset
  return starts
}

function findRepoHeaderRenderRowIndex(rows: readonly RenderRow[], repoId: string): number {
  return rows.findIndex((row) => row.type === 'header' && row.repo?.id === repoId)
}

function findProjectGroupHeaderRenderRowIndex(rows: readonly RenderRow[], groupId: string): number {
  return rows.findIndex(
    (row) =>
      row.type === 'header' &&
      !row.repo &&
      typeof row.projectGroup?.id === 'string' &&
      row.projectGroup.id === groupId
  )
}

function findNextHeaderRenderRowIndex(rows: readonly RenderRow[], startIndex: number): number {
  for (let index = startIndex; index < rows.length; index++) {
    const row = rows[index]
    if (row?.type === 'header' || row?.type === 'host-header') {
      return index
    }
  }
  return rows.length
}

function findProjectGroupSectionEndIndex(
  rows: readonly RenderRow[],
  startIndex: number,
  depth: number
): number {
  for (let index = startIndex; index < rows.length; index++) {
    const row = rows[index]
    if (!row) {
      continue
    }
    if (row.type === 'host-header') {
      return index
    }
    if (row.type !== 'header') {
      continue
    }
    const rowDepth = row.projectGroupDepth ?? 0
    if (rowDepth <= depth || (!row.repo && !row.projectGroup)) {
      return index
    }
  }
  return rows.length
}

export function getRepoSectionRepoIdByRowIndex(rows: readonly RenderRow[]): (string | undefined)[] {
  const result: (string | undefined)[] = []
  let sectionRepoId: string | undefined
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    if (row?.type === 'header' || row?.type === 'host-header') {
      sectionRepoId = row.type === 'header' ? row.repo?.id : undefined
    }
    result[index] = sectionRepoId
  }
  return result
}

export function getRepoSectionPreviewOffsetY(args: {
  repoSectionRepoIdByRowIndex: readonly (string | undefined)[]
  rowIndex: number
  previewOffsetsByRepoId: ReadonlyMap<string, number>
  draggingRepoId?: string | null
  draggedSectionOffsetY?: number | null
}): number {
  const repoId = args.repoSectionRepoIdByRowIndex[args.rowIndex]
  if (repoId !== undefined && repoId === args.draggingRepoId) {
    return args.draggedSectionOffsetY ?? 0
  }
  return repoId === undefined ? 0 : (args.previewOffsetsByRepoId.get(repoId) ?? 0)
}

export function getRepoHeaderSectionEndByRepoId(args: {
  rows: readonly RenderRow[]
  firstHeaderIndex: number
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<string, readonly string[]>
  repoHeaderBucketByRepoId: ReadonlyMap<string, string>
}): Map<string, number> {
  const starts = getEstimatedRenderRowStarts(args.rows, args.firstHeaderIndex)
  const result = new Map<string, number>()
  for (let index = 0; index < args.rows.length; index++) {
    const row = args.rows[index]
    const repoId = row?.type === 'header' ? row.repo?.id : undefined
    if (!repoId) {
      continue
    }
    const bucket = args.repoHeaderBucketByRepoId.get(repoId)
    const ids = bucket ? args.sidebarRepoHeaderIdsByBucket.get(bucket) : undefined
    const bucketIndex = ids?.indexOf(repoId) ?? -1
    const nextRepoId = bucketIndex >= 0 ? ids?.[bucketIndex + 1] : undefined
    const endIndex = nextRepoId
      ? findRepoHeaderRenderRowIndex(args.rows, nextRepoId)
      : findNextHeaderRenderRowIndex(args.rows, index + 1)
    result.set(
      repoId,
      starts[endIndex >= 0 ? endIndex : args.rows.length] ?? starts[args.rows.length] ?? 0
    )
  }
  return result
}

export function getProjectGroupHeaderSectionEndByGroupId(args: {
  rows: readonly RenderRow[]
  firstHeaderIndex: number
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<string, readonly string[]>
  projectGroupHeaderBucketByGroupId: ReadonlyMap<string, string>
}): Map<string, number> {
  const starts = getEstimatedRenderRowStarts(args.rows, args.firstHeaderIndex)
  const result = new Map<string, number>()
  for (let index = 0; index < args.rows.length; index++) {
    const row = args.rows[index]
    const groupId =
      row?.type === 'header' && !row.repo && typeof row.projectGroup?.id === 'string'
        ? row.projectGroup.id
        : undefined
    if (!groupId || row?.type !== 'header') {
      continue
    }
    const bucket = args.projectGroupHeaderBucketByGroupId.get(groupId)
    const ids = bucket ? args.sidebarProjectGroupHeaderIdsByBucket.get(bucket) : undefined
    const bucketIndex = ids?.indexOf(groupId) ?? -1
    const nextGroupId = bucketIndex >= 0 ? ids?.[bucketIndex + 1] : undefined
    const endIndex = nextGroupId
      ? findProjectGroupHeaderRenderRowIndex(args.rows, nextGroupId)
      : findProjectGroupSectionEndIndex(args.rows, index + 1, row.projectGroupDepth ?? 0)
    result.set(
      groupId,
      starts[endIndex >= 0 ? endIndex : args.rows.length] ?? starts[args.rows.length] ?? 0
    )
  }
  return result
}
