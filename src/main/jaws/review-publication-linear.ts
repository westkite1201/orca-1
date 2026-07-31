import type {
  LinearAttachResult,
  LinearCommentAddResult,
  LinearStatusSetResult
} from '../../shared/linear-agent-access'
import {
  assertMaterializedLinearState,
  type JawsLinearClient
} from './linear-materialization-drift'
import type { JawsChildCommitEvidence } from './review-publication-evidence'
import {
  confirmJawsReviewEffect,
  startJawsReviewEffect,
  type JawsPublicationStateContext
} from './review-publication-state'

type JawsLinearPublicationContext = JawsPublicationStateContext & {
  linearClient: JawsResultLinearClient | null
}

export type JawsResultLinearClient = JawsLinearClient & {
  addComment(input: {
    input: string
    workspaceId: string
    body: string
    writeId: string
  }): Promise<LinearCommentAddResult>
  attachLink(input: {
    input: string
    workspaceId: string
    url: string
    title: string
    writeId: string
  }): Promise<LinearAttachResult>
  setState(input: {
    input: string
    workspaceId: string
    to: string
  }): Promise<LinearStatusSetResult>
}

export async function assertJawsLinearResultState(
  context: JawsLinearPublicationContext
): Promise<void> {
  const materialization = context.run.linearMaterialization
  if (!context.linearClient || !materialization) {
    return
  }
  await assertMaterializedLinearState({
    run: context.run,
    materialization,
    client: context.linearClient
  })
}

function rootComment(context: JawsLinearPublicationContext, url: string): string {
  const verification = context.candidate.verification
  return [
    'Jaws verified the integration result.',
    '',
    `Review: ${url}`,
    `Head: ${context.candidate.diff?.headSha ?? 'unknown'}`,
    `Verification: \`${verification?.command ?? context.run.plan.verificationCommand}\``,
    `Exit: ${verification?.exitCode ?? 'unknown'} · Duration: ${verification?.durationMs ?? 0} ms`
  ].join('\n')
}

function updateChildStateSnapshot(
  context: JawsLinearPublicationContext,
  key: string,
  stateId: string
): void {
  const materialization = context.run.linearMaterialization
  if (!materialization) {
    return
  }
  context.run = context.store.updateJawsLinearMaterialization(context.run.id, {
    ...materialization,
    items: materialization.items.map((item) =>
      item.key === key && item.issue ? { ...item, issue: { ...item.issue, stateId } } : item
    ),
    updatedAt: Date.now()
  })
}

export async function publishJawsLinearResults(
  context: JawsLinearPublicationContext,
  url: string,
  evidence: JawsChildCommitEvidence[]
): Promise<void> {
  const linear = context.run.plan.linear
  const materialization = context.run.linearMaterialization
  const client = context.linearClient
  if (!linear || !materialization || !client) {
    return
  }
  const root = materialization.rootIssue
  if (!root) {
    throw new Error('Confirmed Linear root issue is missing.')
  }

  const attachment = startJawsReviewEffect(context, 'linear:root:attachment')
  if (attachment.state !== 'confirmed') {
    await assertJawsLinearResultState(context)
    if (!attachment.writeId) {
      throw new Error('Linear review attachment is missing its write id.')
    }
    const result = await client.attachLink({
      input: root.identifier,
      workspaceId: linear.workspaceId,
      url,
      title: context.publication.review ? 'Jaws draft review' : 'Jaws verified commit',
      writeId: attachment.writeId
    })
    confirmJawsReviewEffect(context, attachment.key, result.attachment.id)
  } else {
    context.activeEffectKey = null
  }

  const comment = startJawsReviewEffect(context, 'linear:root:comment')
  if (comment.state !== 'confirmed') {
    await assertJawsLinearResultState(context)
    if (!comment.writeId) {
      throw new Error('Linear result comment is missing its write id.')
    }
    const result = await client.addComment({
      input: root.identifier,
      workspaceId: linear.workspaceId,
      body: rootComment(context, url),
      writeId: comment.writeId
    })
    confirmJawsReviewEffect(context, comment.key, result.comment.id)
  } else {
    context.activeEffectKey = null
  }

  const evidenceByKey = new Map(evidence.map((entry) => [entry.key, entry]))
  for (const item of materialization.items) {
    const effect = startJawsReviewEffect(context, `linear:child:${item.key}:state`)
    if (effect.state === 'confirmed') {
      context.activeEffectKey = null
      continue
    }
    const commit = evidenceByKey.get(item.key)
    if (!item.issue || !commit) {
      throw new Error(`Linear child ${item.key} is missing matching task and commit evidence.`)
    }
    await assertJawsLinearResultState(context)
    const result = await client.setState({
      input: item.issue.identifier,
      workspaceId: linear.workspaceId,
      to: 'completed'
    })
    updateChildStateSnapshot(context, item.key, result.state.id)
    confirmJawsReviewEffect(
      context,
      effect.key,
      `${commit.taskId}:${commit.commitSha}:${result.state.id}`
    )
  }
}
