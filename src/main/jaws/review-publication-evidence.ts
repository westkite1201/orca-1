import { isHarnessCandidateVerified, type HarnessCandidate } from '../../shared/harness-types'
import type { JawsRun } from '../../shared/jaws-types'
import type { GitBranchCompareResult } from '../../shared/git-diff-compare-types'
import type { GitStatusResult } from '../../shared/git-status-types'
import type { TaskRow } from '../runtime/orchestration/types'

export type JawsChildCommitEvidence = {
  key: string
  taskId: string
  commitSha: string
}

export type JawsReviewEvidenceClient = {
  getStatus(worktreeId: string): Promise<GitStatusResult>
  compare(worktreeId: string, baseRef: string): Promise<GitBranchCompareResult>
  listTasks(runId: string): TaskRow[]
}

function normalizedBranch(branch: string | undefined): string | null {
  return branch?.replace(/^refs\/heads\//, '') ?? null
}

function commitFromResult(result: string | null): string | null {
  if (!result) {
    return null
  }
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>
    return parsed.provenance === 'worker_report' &&
      parsed.outcome === 'succeeded' &&
      typeof parsed.commitSha === 'string' &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(parsed.commitSha)
      ? parsed.commitSha.toLowerCase()
      : null
  } catch {
    return null
  }
}

export async function requireJawsReviewEvidence(args: {
  run: JawsRun
  candidate: HarnessCandidate
  client: JawsReviewEvidenceClient
}): Promise<JawsChildCommitEvidence[]> {
  const { run, candidate, client } = args
  if (!isHarnessCandidateVerified(candidate, run.plan.verificationCommand)) {
    throw new Error('Harness verification is not successful.')
  }
  const worktreeId = candidate.worktreeId
  const branch = candidate.branch
  const headSha = candidate.diff?.headSha
  if (!worktreeId || !branch || !headSha || headSha === run.baseSha) {
    throw new Error('Verified integration branch evidence is incomplete.')
  }
  if ((candidate.diff?.untrackedPaths.length ?? 0) > 0) {
    throw new Error('Verified integration worktree still contains untracked changes.')
  }

  const status = await client.getStatus(worktreeId)
  if (
    status.didHitLimit ||
    status.entries.length > 0 ||
    status.head !== headSha ||
    normalizedBranch(status.branch) !== normalizedBranch(branch)
  ) {
    throw new Error('Integration worktree changed after verification.')
  }
  if (!candidate.orchestrationRunId || !candidate.taskId) {
    throw new Error('Harness orchestration evidence is incomplete.')
  }

  const children = client
    .listTasks(candidate.orchestrationRunId)
    .filter((task) => task.parent_id === candidate.taskId)
  const expectedTitles = new Map(
    run.plan.tasks.map((task) => [`[Jaws:${task.key}] ${task.title}`, task.key])
  )
  if (
    children.length !== run.plan.tasks.length ||
    children.some((task) => !task.task_title || !expectedTitles.has(task.task_title))
  ) {
    throw new Error('Harness child tasks do not match the approved Jaws plan.')
  }

  const evidence: JawsChildCommitEvidence[] = []
  for (const task of children) {
    const key = expectedTitles.get(task.task_title as string) as string
    const commitSha = task.status === 'completed' ? commitFromResult(task.result) : null
    if (!commitSha) {
      throw new Error(`Jaws task ${key} is missing structured commit evidence.`)
    }
    const comparison = await client.compare(worktreeId, commitSha)
    if (
      comparison.summary.status !== 'ready' ||
      comparison.summary.headOid !== headSha ||
      comparison.summary.mergeBase !== comparison.summary.baseOid ||
      comparison.summary.baseOid?.toLowerCase() !== commitSha
    ) {
      throw new Error(
        `Commit evidence for Jaws task ${key} is not in the verified integration head.`
      )
    }
    evidence.push({ key, taskId: task.id, commitSha })
  }
  return evidence
}
