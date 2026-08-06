import type { HarnessCandidate } from '../../shared/harness-types'
import type { JawsLinearMaterialization, JawsRun } from '../../shared/jaws-types'
import type { GitUpstreamStatus } from '../../shared/git-status-types'
import { LinearAgentAccessError } from '../linear/issue-context-errors'
import { LinearDriftError } from './linear-materialization-drift'
import {
  requireJawsReviewEvidence,
  type JawsReviewEvidenceClient
} from './review-publication-evidence'
import {
  createOrRecoverJawsHostedReview,
  JawsHostedReviewUnknownError,
  type JawsHostedReviewClient
} from './review-publication-hosted'
import {
  assertJawsLinearResultState,
  publishJawsLinearResults,
  type JawsResultLinearClient
} from './review-publication-linear'
import {
  confirmJawsReviewEffect,
  persistJawsPublication,
  startJawsReviewEffect,
  updateJawsReviewEffect,
  type JawsPublicationStateContext,
  type JawsReviewStore
} from './review-publication-state'

export type { JawsResultLinearClient } from './review-publication-linear'
export type { JawsReviewStore } from './review-publication-state'

export type JawsReviewClient = JawsReviewEvidenceClient &
  JawsHostedReviewClient & {
    getUpstreamStatus(worktreeId: string): Promise<GitUpstreamStatus>
    push(worktreeId: string): Promise<void>
  }

type PublicationContext = JawsPublicationStateContext & {
  reviewClient: JawsReviewClient
  linearClient: JawsResultLinearClient | null
}

const UNKNOWN_LINEAR_CODES = new Set([
  'linear_write_unconfirmed',
  'linear_network_error',
  'linear_timeout',
  'linear_rate_limited',
  'linear_auth_expired'
])

class JawsPublicationUnknownError extends Error {}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000)
}

function upstreamIsPublished(status: GitUpstreamStatus): boolean {
  return status.hasUpstream && status.ahead === 0 && status.behind === 0
}

async function publishBranch(context: PublicationContext): Promise<void> {
  const effect = startJawsReviewEffect(context, 'push')
  if (effect.state === 'confirmed') {
    context.activeEffectKey = null
    return
  }
  const worktreeId = context.candidate.worktreeId as string
  const before = await context.reviewClient.getUpstreamStatus(worktreeId)
  if (upstreamIsPublished(before)) {
    confirmJawsReviewEffect(
      context,
      'push',
      before.upstreamName ?? context.candidate.branch ?? 'upstream'
    )
    return
  }
  if (before.behind > 0) {
    throw new Error('Integration branch is behind its push target.')
  }
  try {
    await context.reviewClient.push(worktreeId)
  } catch (error) {
    const recovered = await context.reviewClient.getUpstreamStatus(worktreeId).catch(() => null)
    if (recovered && upstreamIsPublished(recovered)) {
      confirmJawsReviewEffect(
        context,
        'push',
        recovered.upstreamName ?? context.candidate.branch ?? 'upstream'
      )
      return
    }
    throw new JawsPublicationUnknownError(errorMessage(error))
  }
  const after = await context.reviewClient.getUpstreamStatus(worktreeId)
  if (!upstreamIsPublished(after)) {
    throw new JawsPublicationUnknownError('Push completed without a confirmed upstream result.')
  }
  confirmJawsReviewEffect(
    context,
    'push',
    after.upstreamName ?? context.candidate.branch ?? 'upstream'
  )
}

async function createOrRecoverReview(context: PublicationContext): Promise<string> {
  const effect = startJawsReviewEffect(context, 'create')
  if (effect.state === 'confirmed') {
    context.activeEffectKey = null
    return context.publication.review?.url ?? context.publication.manualUrl ?? effect.remoteId ?? ''
  }
  const result = await createOrRecoverJawsHostedReview({
    run: context.run,
    candidate: context.candidate,
    client: context.reviewClient
  })
  persistJawsPublication(context, {
    ...context.publication,
    review: result.review,
    manualUrl: result.manualUrl,
    updatedAt: Date.now()
  })
  confirmJawsReviewEffect(context, 'create', result.url)
  return result.url
}

function failureStatus(error: unknown): 'unknown' | 'failed' {
  if (
    error instanceof JawsPublicationUnknownError ||
    error instanceof JawsHostedReviewUnknownError ||
    (error instanceof LinearAgentAccessError && UNKNOWN_LINEAR_CODES.has(error.code))
  ) {
    return 'unknown'
  }
  return 'failed'
}

export async function publishJawsReview(args: {
  run: JawsRun
  candidate: HarnessCandidate
  store: JawsReviewStore
  reviewClient: JawsReviewClient
  linearClient: JawsResultLinearClient | null
}): Promise<JawsRun> {
  if (!args.run.plan.review || !args.run.reviewPublication) {
    return args.run
  }
  const context: PublicationContext = {
    ...args,
    publication: args.run.reviewPublication,
    activeEffectKey: null
  }
  persistJawsPublication(context, {
    ...context.publication,
    status: 'publishing',
    headBranch: args.candidate.branch,
    headSha: args.candidate.diff?.headSha ?? null,
    error: null,
    updatedAt: Date.now()
  })
  try {
    const evidence = await requireJawsReviewEvidence({
      run: context.run,
      candidate: context.candidate,
      client: context.reviewClient
    })
    await assertJawsLinearResultState(context)
    await publishBranch(context)
    const url = await createOrRecoverReview(context)
    await publishJawsLinearResults(context, url, evidence)
    persistJawsPublication(context, {
      ...context.publication,
      status: context.publication.review ? 'review_ready' : 'manual',
      error: null,
      updatedAt: Date.now()
    })
  } catch (error) {
    const state = failureStatus(error)
    if (context.activeEffectKey) {
      updateJawsReviewEffect(context, context.activeEffectKey, {
        state,
        error: errorMessage(error)
      })
    }
    if (error instanceof LinearDriftError && context.run.linearMaterialization) {
      const materialization: JawsLinearMaterialization = context.run.linearMaterialization
      context.run = context.store.updateJawsLinearMaterialization(context.run.id, {
        ...materialization,
        status: 'decision_required',
        error: errorMessage(error),
        updatedAt: Date.now()
      })
    }
    persistJawsPublication(context, {
      ...context.publication,
      status: state,
      error: errorMessage(error),
      updatedAt: Date.now()
    })
  }
  return context.run
}
