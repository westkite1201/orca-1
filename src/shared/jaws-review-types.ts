import { z } from 'zod'

const reviewString = (message: string, max: number) =>
  z.string().trim().min(1, message).max(max, message)

export const hostedReviewProviderSchema = z.enum([
  'github',
  'gitlab',
  'bitbucket',
  'azure-devops',
  'gitea',
  'unsupported'
])

export const jawsReviewPlanSchema = z.object({
  provider: hostedReviewProviderSchema.nullable(),
  baseBranch: reviewString('A review base branch is required.', 1_024),
  createDraft: z.literal(true)
})

export const jawsReviewEffectSchema = z.object({
  key: reviewString('A review effect key is required.', 255),
  kind: z.enum(['push', 'create', 'root_attachment', 'root_comment', 'child_state']),
  writeId: z.string().uuid().nullable(),
  state: z.enum(['planned', 'started', 'confirmed', 'unknown', 'failed']),
  remoteId: z.string().nullable(),
  error: z.string().max(4_000).nullable(),
  updatedAt: z.number().int().nonnegative()
})
export type JawsReviewEffect = z.infer<typeof jawsReviewEffectSchema>

export const jawsReviewPublicationSchema = z.object({
  status: z.enum(['planned', 'publishing', 'review_ready', 'manual', 'unknown', 'failed']),
  provider: hostedReviewProviderSchema.nullable(),
  baseBranch: reviewString('A review base branch is required.', 1_024),
  headBranch: z.string().max(1_024).nullable(),
  headSha: z.string().max(128).nullable(),
  review: z
    .object({
      provider: hostedReviewProviderSchema,
      number: z.number().int().positive(),
      url: z.string().url().max(2_048),
      baseBranch: reviewString('A review base branch is required.', 1_024),
      headBranch: reviewString('A review head branch is required.', 1_024),
      draft: z.literal(true)
    })
    .nullable(),
  manualUrl: z.string().url().max(2_048).nullable(),
  effects: z.array(jawsReviewEffectSchema).max(20),
  error: z.string().max(4_000).nullable(),
  updatedAt: z.number().int().nonnegative()
})
export type JawsReviewPublication = z.infer<typeof jawsReviewPublicationSchema>

export const jawsReviewRetrySchema = z.object({
  runId: z.string().uuid()
})
export type JawsReviewRetry = z.infer<typeof jawsReviewRetrySchema>
