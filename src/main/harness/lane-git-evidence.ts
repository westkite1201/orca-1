import { isDeepStrictEqual } from 'node:util'
import type {
  GitBranchChangeEntry,
  GitBranchCompareResult,
  GitDiffResult
} from '../../shared/types'
import type { HarnessRuntimeCaller } from './runtime-caller'

export const MAX_VERIFIED_FILES = 200
const FULL_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i

type GitStatusResult = {
  head?: string | null
  entries: unknown[]
  didHitLimit?: boolean
  conflictOperation: string
}

export type VerifiedRange = {
  worktreeId: string
  baseSha: string
  headSha: string
  entries: GitBranchChangeEntry[]
}

export class LaneVerificationError extends Error {
  constructor(
    message: string,
    readonly integrationState: 'conflict' | 'failed' = 'failed'
  ) {
    super(message)
  }
}

export function normalizedOid(value: string): string {
  return value.trim().toLowerCase()
}

export function isFullOid(value: string): boolean {
  return FULL_OID.test(value)
}

export async function readCleanHead(args: {
  runtime: HarnessRuntimeCaller
  worktreeId: string
  label: string
  integration: boolean
}): Promise<string> {
  const status = await args.runtime.call<GitStatusResult>('git.status', {
    worktree: `id:${args.worktreeId}`
  })
  if (status.didHitLimit) {
    throw new LaneVerificationError(`${args.label} Git status exceeded its evidence limit.`)
  }
  if (status.entries.length > 0 || status.conflictOperation !== 'unknown') {
    throw new LaneVerificationError(
      `${args.label} must be clean and free of Git conflict operations.`,
      args.integration ? 'conflict' : 'failed'
    )
  }
  const head = status.head?.trim()
  if (!head || !isFullOid(head)) {
    throw new LaneVerificationError(`${args.label} has no verifiable HEAD.`)
  }
  return normalizedOid(head)
}

export async function readVerifiedRange(args: {
  runtime: HarnessRuntimeCaller
  worktreeId: string
  baseSha: string
  headSha: string
  label: string
}): Promise<VerifiedRange> {
  const baseSha = normalizedOid(args.baseSha)
  const headSha = normalizedOid(args.headSha)
  const result = await args.runtime.call<GitBranchCompareResult>('git.branchCompare', {
    worktree: `id:${args.worktreeId}`,
    baseRef: baseSha
  })
  const { summary, entries } = result
  if (
    summary.status !== 'ready' ||
    normalizedOid(summary.baseOid ?? '') !== baseSha ||
    normalizedOid(summary.headOid ?? '') !== headSha ||
    normalizedOid(summary.mergeBase ?? '') !== baseSha
  ) {
    throw new LaneVerificationError(`${args.label} does not descend from its recorded base.`)
  }
  if (entries.length === 0) {
    throw new LaneVerificationError(`${args.label} contains no committed changes.`)
  }
  if (entries.length > MAX_VERIFIED_FILES) {
    throw new LaneVerificationError(`${args.label} exceeds the verified file limit.`)
  }
  return { worktreeId: args.worktreeId, baseSha, headSha, entries }
}

function entryKey(entry: GitBranchChangeEntry): string {
  return `${entry.status}\u0000${entry.oldPath ?? ''}\u0000${entry.path}`
}

function sortedEntries(entries: readonly GitBranchChangeEntry[]): GitBranchChangeEntry[] {
  return [...entries].sort((left, right) => entryKey(left).localeCompare(entryKey(right)))
}

async function readRangeDiff(
  runtime: HarnessRuntimeCaller,
  range: VerifiedRange,
  entry: GitBranchChangeEntry
): Promise<GitDiffResult> {
  return await runtime.call<GitDiffResult>('git.branchDiff', {
    worktree: `id:${range.worktreeId}`,
    compare: {
      baseOid: range.baseSha,
      headOid: range.headSha,
      mergeBase: range.baseSha
    },
    filePath: entry.path,
    ...(entry.oldPath ? { oldPath: entry.oldPath } : {})
  })
}

function requireReadableDiff(entry: GitBranchChangeEntry, diff: GitDiffResult): void {
  const contentMatches =
    diff.originalContent === diff.modifiedContent &&
    (diff.kind === 'text' || (diff.originalIsBinary && diff.modifiedIsBinary))
  if (contentMatches && entry.status === 'modified') {
    // Why: branchDiff falls back to empty content on read failure; modified files must prove a blob change.
    throw new LaneVerificationError(`Git content evidence is unavailable for ${entry.path}.`)
  }
}

export async function requireMatchingRanges(
  runtime: HarnessRuntimeCaller,
  worker: VerifiedRange,
  integration: VerifiedRange
): Promise<void> {
  const workerEntries = sortedEntries(worker.entries)
  const integrationEntries = sortedEntries(integration.entries)
  if (
    workerEntries.length !== integrationEntries.length ||
    workerEntries.some((entry, index) => entryKey(entry) !== entryKey(integrationEntries[index]))
  ) {
    throw new LaneVerificationError('Integrated paths do not match the worker commit.')
  }
  for (let index = 0; index < workerEntries.length; index += 1) {
    const [workerDiff, integrationDiff] = await Promise.all([
      readRangeDiff(runtime, worker, workerEntries[index]),
      readRangeDiff(runtime, integration, integrationEntries[index])
    ])
    requireReadableDiff(workerEntries[index], workerDiff)
    requireReadableDiff(integrationEntries[index], integrationDiff)
    if (!isDeepStrictEqual(workerDiff, integrationDiff)) {
      throw new LaneVerificationError(
        `Integrated content does not match the worker commit for ${workerEntries[index].path}.`
      )
    }
  }
}

export function changedPaths(entries: readonly GitBranchChangeEntry[]): string[] {
  return [
    ...new Set(
      entries
        .flatMap((entry) => [entry.oldPath, entry.path])
        .filter((path): path is string => Boolean(path))
    )
  ].sort()
}

export function withinScope(path: string, scopes: readonly string[]): boolean {
  return (
    scopes.length === 0 ||
    scopes.includes('*') ||
    scopes.some((scope) => path === scope || path.startsWith(`${scope}/`))
  )
}
