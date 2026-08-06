import type { HarnessCandidate } from '../../shared/harness-types'
import type { JawsReviewEffect, JawsReviewPublication, JawsRun } from '../../shared/jaws-types'
import type { Store } from '../persistence'

export type JawsReviewStore = Pick<
  Store,
  'updateJawsReviewPublication' | 'updateJawsLinearMaterialization'
>

export type JawsPublicationStateContext = {
  run: JawsRun
  candidate: HarnessCandidate
  publication: JawsReviewPublication
  store: JawsReviewStore
  activeEffectKey: string | null
}

export function persistJawsPublication(
  context: JawsPublicationStateContext,
  publication: JawsReviewPublication
): void {
  context.run = context.store.updateJawsReviewPublication(context.run.id, publication)
  context.publication = context.run.reviewPublication as JawsReviewPublication
}

export function updateJawsReviewEffect(
  context: JawsPublicationStateContext,
  key: string,
  patch: Partial<Pick<JawsReviewEffect, 'state' | 'remoteId' | 'error'>>
): void {
  const now = Date.now()
  persistJawsPublication(context, {
    ...context.publication,
    effects: context.publication.effects.map((effect) =>
      effect.key === key ? { ...effect, ...patch, updatedAt: now } : effect
    ),
    updatedAt: now
  })
}

export function startJawsReviewEffect(
  context: JawsPublicationStateContext,
  key: string
): JawsReviewEffect {
  const effect = context.publication.effects.find((entry) => entry.key === key)
  if (!effect) {
    throw new Error(`Missing Jaws review effect: ${key}`)
  }
  if (effect.state !== 'confirmed') {
    context.activeEffectKey = key
    updateJawsReviewEffect(context, key, { state: 'started', error: null })
  }
  return context.publication.effects.find((entry) => entry.key === key) as JawsReviewEffect
}

export function confirmJawsReviewEffect(
  context: JawsPublicationStateContext,
  key: string,
  remoteId: string
): void {
  updateJawsReviewEffect(context, key, {
    state: 'confirmed',
    remoteId,
    error: null
  })
  context.activeEffectKey = null
}
