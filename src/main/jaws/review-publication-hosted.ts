import type {
  CreateHostedReviewInput,
  CreateHostedReviewResult,
  HostedReviewInfo
} from '../../shared/hosted-review'
import { supportsHostedReviewCreation } from '../../shared/hosted-review-creation-providers'
import type { HarnessCandidate } from '../../shared/harness-types'
import type { JawsReviewPublication, JawsRun } from '../../shared/jaws-types'

export type JawsHostedReviewClient = {
  findReview(repoId: string, branch: string, headSha: string): Promise<HostedReviewInfo | null>
  createReview(
    repoId: string,
    worktreeId: string,
    input: CreateHostedReviewInput
  ): Promise<CreateHostedReviewResult>
  getManualUrl(worktreeId: string, headSha: string): Promise<string | null>
}

export type JawsHostedReviewResult =
  | {
      url: string
      review: NonNullable<JawsReviewPublication['review']>
      manualUrl: null
    }
  | {
      url: string
      review: null
      manualUrl: string
    }

export class JawsHostedReviewUnknownError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reviewRecord(
  run: JawsRun,
  candidate: HarnessCandidate,
  review: Pick<HostedReviewInfo, 'provider' | 'number' | 'url'>
): NonNullable<JawsReviewPublication['review']> {
  const plan = run.plan.review
  if (!plan || !candidate.branch) {
    throw new Error('Review plan is incomplete.')
  }
  return {
    ...review,
    baseBranch: plan.baseBranch,
    headBranch: candidate.branch,
    draft: true
  }
}

function reviewBody(run: JawsRun, candidate: HarnessCandidate): string {
  const verification = candidate.verification
  return [
    run.plan.goal,
    '',
    `Jaws run: ${run.id}`,
    `Verification: ${verification?.command ?? run.plan.verificationCommand}`,
    `Exit: ${verification?.exitCode ?? 'unknown'} · Duration: ${verification?.durationMs ?? 0} ms`
  ].join('\n')
}

export async function createOrRecoverJawsHostedReview(args: {
  run: JawsRun
  candidate: HarnessCandidate
  client: JawsHostedReviewClient
}): Promise<JawsHostedReviewResult> {
  const { run, candidate, client } = args
  const plan = run.plan.review
  const branch = candidate.branch as string
  const headSha = candidate.diff?.headSha as string
  const creationSupported = Boolean(plan?.provider && supportsHostedReviewCreation(plan.provider))
  let existing: HostedReviewInfo | null
  try {
    existing = await client.findReview(run.repoId, branch, headSha)
  } catch (error) {
    if (creationSupported) {
      throw new JawsHostedReviewUnknownError(
        `Could not confirm whether a review already exists: ${errorMessage(error)}`
      )
    }
    existing = null
  }
  if (existing) {
    if (existing.state !== 'draft') {
      throw new Error('The integration branch already has a non-draft review.')
    }
    return { url: existing.url, review: reviewRecord(run, candidate, existing), manualUrl: null }
  }

  if (!creationSupported || !plan?.provider) {
    const manualUrl = await client.getManualUrl(candidate.worktreeId as string, headSha)
    if (!manualUrl) {
      throw new Error('A manual review URL is unavailable for this provider.')
    }
    return { url: manualUrl, review: null, manualUrl }
  }

  const result = await client.createReview(run.repoId, candidate.worktreeId as string, {
    provider: plan.provider,
    base: plan.baseBranch,
    head: branch,
    title: run.plan.goal.split(/\r?\n/, 1)[0].slice(0, 255),
    body: reviewBody(run, candidate),
    draft: true,
    useTemplate: true
  })
  if (result.ok) {
    return {
      url: result.url,
      review: reviewRecord(run, candidate, {
        provider: plan.provider,
        number: result.number,
        url: result.url
      }),
      manualUrl: null
    }
  }
  if (result.existingReview?.number) {
    const recovered = await client.findReview(run.repoId, branch, headSha).catch(() => null)
    if (recovered?.state === 'draft') {
      return {
        url: recovered.url,
        review: reviewRecord(run, candidate, recovered),
        manualUrl: null
      }
    }
    throw new JawsHostedReviewUnknownError('The existing draft review could not be confirmed.')
  }
  if (result.existingReview) {
    throw new JawsHostedReviewUnknownError(
      'An existing review was reported without a stable review number.'
    )
  }
  if (result.code === 'unsupported_provider') {
    const manualUrl = await client.getManualUrl(candidate.worktreeId as string, headSha)
    if (manualUrl) {
      return { url: manualUrl, review: null, manualUrl }
    }
  }
  if (result.code === 'unknown_completion') {
    const recovered = await client.findReview(run.repoId, branch, headSha).catch(() => null)
    if (recovered) {
      if (recovered.state !== 'draft') {
        throw new Error('The integration branch review is not a draft.')
      }
      return {
        url: recovered.url,
        review: reviewRecord(run, candidate, recovered),
        manualUrl: null
      }
    }
    throw new JawsHostedReviewUnknownError(result.error)
  }
  throw new Error(result.error)
}
