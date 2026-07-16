import type { GitStatusResult } from '../../shared/git-status-types'
import type { HarnessChangedFile, HarnessDiffSummary } from '../../shared/harness-types'
import type { GitBranchCompareResult } from '../../shared/types'
import { isSameHarnessBranch } from './candidate-recovery'

type DiffSummaryInput = {
  status: GitStatusResult
  branchCompare: GitBranchCompareResult
  expectedBaseSha: string
  expectedBranch: string
  capturedAt?: number
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function addCounts(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0)
}

function mergeChangedFile(
  filesByPath: Map<string, HarnessChangedFile>,
  incoming: HarnessChangedFile
): void {
  const current = filesByPath.get(incoming.path)
  if (!current) {
    filesByPath.set(incoming.path, { ...incoming })
    return
  }

  // Why: staged and unstaged rows can repeat one path; a plain modification
  // must not erase the more informative added/renamed/deleted status.
  const added = addCounts(current.added, incoming.added)
  const removed = addCounts(current.removed, incoming.removed)
  filesByPath.set(incoming.path, {
    path: incoming.path,
    status: incoming.status === 'modified' ? current.status : incoming.status,
    ...((incoming.oldPath ?? current.oldPath)
      ? { oldPath: incoming.oldPath ?? current.oldPath }
      : {}),
    ...(added === undefined ? {} : { added }),
    ...(removed === undefined ? {} : { removed })
  })
}

function buildDiffStat(
  changedFiles: readonly HarnessChangedFile[],
  untrackedPaths: readonly string[]
): string {
  const counts = new Map<string, number>()
  for (const file of changedFiles) {
    counts.set(file.status, (counts.get(file.status) ?? 0) + 1)
  }
  if (untrackedPaths.length > 0) {
    counts.set('untracked', untrackedPaths.length)
  }

  const total = changedFiles.length + untrackedPaths.length
  const details = ['added', 'modified', 'deleted', 'renamed', 'copied', 'untracked']
    .flatMap((status) => {
      const count = counts.get(status)
      return count ? [`${count} ${status}`] : []
    })
    .join(' · ')
  const files = `${total} ${total === 1 ? 'file' : 'files'}`
  return details ? `${files} · ${details}` : files
}

export function buildHarnessDiffSummary({
  status,
  branchCompare,
  expectedBaseSha,
  expectedBranch,
  capturedAt = Date.now()
}: DiffSummaryInput): HarnessDiffSummary {
  const filesByPath = new Map<string, HarnessChangedFile>()
  for (const entry of branchCompare.entries) {
    mergeChangedFile(filesByPath, entry)
  }

  const untrackedPaths = new Set<string>()
  for (const entry of status.entries) {
    if (entry.status === 'untracked' || entry.area === 'untracked') {
      untrackedPaths.add(entry.path)
      continue
    }
    mergeChangedFile(filesByPath, {
      path: entry.path,
      status: entry.status,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      ...(entry.added === undefined ? {} : { added: entry.added }),
      ...(entry.removed === undefined ? {} : { removed: entry.removed })
    })
  }

  const changedFiles = [...filesByPath.values()].sort((left, right) =>
    comparePaths(left.path, right.path)
  )
  const sortedUntrackedPaths = [...untrackedPaths].sort(comparePaths)
  const errors: string[] = []
  if (status.didHitLimit) {
    errors.push('Git status was truncated; diff evidence is incomplete.')
  }
  if (status.conflictOperation !== 'unknown') {
    errors.push(
      `Git ${status.conflictOperation} operation is in progress; diff evidence is incomplete.`
    )
  }
  if (status.entries.some((entry) => entry.conflictStatus === 'unresolved')) {
    errors.push('Git has unresolved conflicts; diff evidence is incomplete.')
  }
  if (branchCompare.summary.status !== 'ready') {
    errors.push(
      branchCompare.summary.errorMessage ??
        `Branch comparison is ${branchCompare.summary.status}; diff evidence is incomplete.`
    )
  } else if (
    !branchCompare.summary.baseOid ||
    !branchCompare.summary.headOid ||
    !branchCompare.summary.mergeBase
  ) {
    errors.push('Branch comparison is missing commit ancestry; diff evidence is incomplete.')
  } else if (branchCompare.summary.baseOid !== expectedBaseSha) {
    errors.push('Branch comparison resolved a different base; diff evidence is incomplete.')
  } else if (branchCompare.summary.mergeBase !== branchCompare.summary.baseOid) {
    // Why: the candidate must still descend from the immutable shared start SHA;
    // otherwise a reset-behind branch can make valid worker changes disappear.
    errors.push(
      'Candidate HEAD does not descend from the requested base; diff evidence is incomplete.'
    )
  }
  const statusHead = status.head?.trim()
  if (!statusHead) {
    errors.push('Git status is missing HEAD evidence; diff evidence is incomplete.')
  } else if (branchCompare.summary.headOid && statusHead !== branchCompare.summary.headOid) {
    errors.push('Git status HEAD does not match branch comparison; diff evidence is incomplete.')
  }
  const statusBranch = status.branch?.trim()
  if (!statusBranch) {
    errors.push('Git status is missing branch evidence; diff evidence is incomplete.')
  } else if (!isSameHarnessBranch(statusBranch, expectedBranch)) {
    errors.push(`Candidate is on branch ${statusBranch}, expected ${expectedBranch}.`)
  }

  return {
    headSha: branchCompare.summary.headOid ?? (status.head?.trim() || null),
    diffStat: buildDiffStat(changedFiles, sortedUntrackedPaths),
    changedFiles,
    untrackedPaths: sortedUntrackedPaths,
    capturedAt,
    error: errors.length > 0 ? errors.join(' ') : null
  }
}
