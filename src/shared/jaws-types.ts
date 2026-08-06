import { z } from 'zod'
import type { HarnessRunStatus, HarnessVerificationSummary } from './harness-types'
import { jawsReviewPlanSchema, jawsReviewPublicationSchema } from './jaws-review-types'
export {
  jawsReviewEffectSchema,
  jawsReviewPublicationSchema,
  jawsReviewRetrySchema
} from './jaws-review-types'
export type { JawsReviewEffect, JawsReviewPublication, JawsReviewRetry } from './jaws-review-types'

const trimmedString = (message: string, max: number) =>
  z.string().trim().min(1, message).max(max, message)

function hasUnsafeApprovalCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
  })
}

const approvalText = (message: string, max: number) =>
  trimmedString(message, max).refine(
    (value) => !hasUnsafeApprovalCharacters(value),
    'Plan text contains unsafe control characters.'
  )
const taskKey = trimmedString('Each task needs a key.', 64).regex(
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
  'Task keys may only contain letters, numbers, underscores, and hyphens.'
)
const linearIdentifier = trimmedString('A Linear issue identifier is required.', 64).regex(
  /^[A-Za-z][A-Za-z0-9_]*-\d+$/,
  'Invalid Linear issue identifier.'
)
const linearRelationSchema = z.object({
  relationship: z.enum(['blocks', 'blockedBy', 'relatedTo', 'duplicateOf']),
  identifier: linearIdentifier
})
const linearIssueSnapshotSchema = z.object({
  id: z.string().uuid(),
  identifier: linearIdentifier,
  title: approvalText('A Linear issue title is required.', 255),
  url: z.string().url().max(2_048),
  stateId: z.string().nullable(),
  parentId: z.string().nullable(),
  relations: z.array(linearRelationSchema).max(100)
})
const jawsLinearPlanSchema = z.object({
  workspaceId: approvalText('A Linear workspace id is required.', 1_024),
  team: approvalText('A Linear team id or key is required.', 255),
  project: approvalText('A Linear project id or name is required.', 1_024).nullable().default(null),
  rootIssue: z.discriminatedUnion('kind', [
    linearIssueSnapshotSchema.extend({ kind: z.literal('existing') }),
    z.object({
      kind: z.literal('create'),
      title: approvalText('A Linear root issue title is required.', 255),
      description: approvalText('A Linear root issue description is required.', 65_000)
    })
  ])
})

export const jawsPlanTaskSchema = z.object({
  key: taskKey,
  title: approvalText('Each task needs a title.', 160),
  objective: approvalText('Each task needs an objective.', 4_000),
  dependsOn: z.array(taskKey).max(32).default([])
})

export const jawsPlanSchema = z
  .object({
    goal: approvalText('A goal is required.', 20_000),
    verificationCommand: approvalText('A verification command is required.', 4_000),
    maxConcurrency: z.number().int().min(1).max(3),
    tasks: z.array(jawsPlanTaskSchema).min(1).max(8),
    linear: jawsLinearPlanSchema.nullable().optional(),
    review: jawsReviewPlanSchema.nullable().optional()
  })
  .superRefine((plan, context) => {
    const tasksByKey = new Map<string, (typeof plan.tasks)[number]>()
    for (const [index, task] of plan.tasks.entries()) {
      if (tasksByKey.has(task.key)) {
        context.addIssue({
          code: 'custom',
          path: ['tasks', index, 'key'],
          message: `Duplicate task key: ${task.key}`
        })
      }
      tasksByKey.set(task.key, task)
    }
    for (const [index, task] of plan.tasks.entries()) {
      for (const dependency of task.dependsOn) {
        if (!tasksByKey.has(dependency)) {
          context.addIssue({
            code: 'custom',
            path: ['tasks', index, 'dependsOn'],
            message: `Unknown task dependency: ${dependency}`
          })
        } else if (dependency === task.key) {
          context.addIssue({
            code: 'custom',
            path: ['tasks', index, 'dependsOn'],
            message: `Task ${task.key} cannot depend on itself.`
          })
        }
      }
    }

    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (key: string): boolean => {
      if (visiting.has(key)) {
        return false
      }
      if (visited.has(key)) {
        return true
      }
      visiting.add(key)
      for (const dependency of tasksByKey.get(key)?.dependsOn ?? []) {
        if (tasksByKey.has(dependency) && !visit(dependency)) {
          return false
        }
      }
      visiting.delete(key)
      visited.add(key)
      return true
    }
    if (plan.tasks.some((task) => !visit(task.key))) {
      context.addIssue({
        code: 'custom',
        path: ['tasks'],
        message: 'Task dependencies must not contain a cycle.'
      })
    }
  })

export type JawsPlan = z.infer<typeof jawsPlanSchema>

export const jawsLinearIssueRefSchema = linearIssueSnapshotSchema.omit({ relations: true })
export type JawsLinearIssueRef = z.infer<typeof jawsLinearIssueRefSchema>

export const jawsLinearEffectSchema = z.object({
  key: trimmedString('A Linear effect key is required.', 255),
  kind: z.enum(['root_read', 'root_create', 'child_create', 'relation']),
  writeId: z.string().uuid().nullable(),
  state: z.enum(['planned', 'started', 'confirmed', 'unknown', 'failed']),
  remoteId: z.string().nullable(),
  error: z.string().max(4_000).nullable(),
  updatedAt: z.number().int().nonnegative()
})
export type JawsLinearEffect = z.infer<typeof jawsLinearEffectSchema>

export const jawsLinearMaterializationSchema = z.object({
  status: z.enum([
    'planned',
    'materializing',
    'confirmed',
    'decision_required',
    'unknown',
    'failed'
  ]),
  rootIssue: jawsLinearIssueRefSchema.nullable(),
  items: z
    .array(
      z.object({
        key: taskKey,
        issue: jawsLinearIssueRefSchema.nullable()
      })
    )
    .max(8),
  effects: z.array(jawsLinearEffectSchema).max(80),
  error: z.string().max(4_000).nullable(),
  updatedAt: z.number().int().nonnegative()
})
export type JawsLinearMaterialization = z.infer<typeof jawsLinearMaterializationSchema>

export function isConfirmedJawsLinearMaterialization(
  plan: JawsPlan,
  materialization: JawsLinearMaterialization
): boolean {
  const root = materialization.rootIssue
  if (
    !plan.linear ||
    materialization.status !== 'confirmed' ||
    !root ||
    materialization.effects.some(
      (effect) => effect.state !== 'confirmed' || effect.remoteId === null
    )
  ) {
    return false
  }
  const plannedRoot = plan.linear.rootIssue
  if (
    (plannedRoot.kind === 'create' && root.title !== plannedRoot.title) ||
    (plannedRoot.kind === 'existing' &&
      (root.id !== plannedRoot.id ||
        root.identifier !== plannedRoot.identifier ||
        root.url !== plannedRoot.url ||
        root.stateId !== plannedRoot.stateId ||
        root.parentId !== plannedRoot.parentId))
  ) {
    return false
  }
  const items = new Map(materialization.items.map((item) => [item.key, item.issue]))
  if (items.size !== plan.tasks.length || materialization.items.length !== plan.tasks.length) {
    return false
  }
  const expectedEffects = new Map<string, string | null>([['root', root.id]])
  for (const task of plan.tasks) {
    const issue = items.get(task.key)
    if (!issue || issue.parentId !== root.id) {
      return false
    }
    expectedEffects.set(`child:${task.key}`, issue.id)
    for (const dependency of task.dependsOn) {
      expectedEffects.set(`relation:${dependency}:${task.key}`, null)
    }
  }
  const effects = new Map(materialization.effects.map((effect) => [effect.key, effect]))
  return (
    effects.size === expectedEffects.size &&
    materialization.effects.length === expectedEffects.size &&
    Array.from(expectedEffects).every(([key, remoteId]) => {
      const effect = effects.get(key)
      return effect?.state === 'confirmed' && (remoteId === null || effect.remoteId === remoteId)
    })
  )
}

export const jawsPlanProposalSchema = z.object({
  worktree: trimmedString('A worktree selector is required.', 1_024),
  plan: jawsPlanSchema
})

export type JawsPlanProposal = z.infer<typeof jawsPlanProposalSchema>

export const jawsPlanApprovalSchema = z.object({
  runId: z.string().uuid(),
  revision: z.number().int().positive(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/, 'Invalid plan hash.')
})

export type JawsPlanApproval = z.infer<typeof jawsPlanApprovalSchema>

export const jawsRunSchema = z.object({
  id: z.string().uuid(),
  repoId: trimmedString('A repository id is required.', 1_024),
  sourceWorktreeId: trimmedString('A source worktree id is required.', 2_048),
  sourceWorktreePath: trimmedString('A source worktree path is required.', 32_768),
  baseSha: trimmedString('A source SHA is required.', 128),
  revision: z.number().int().positive(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  plan: jawsPlanSchema,
  linearMaterialization: jawsLinearMaterializationSchema.nullable().optional(),
  reviewPublication: jawsReviewPublicationSchema.nullable().optional(),
  approvalStartedAt: z.number().int().nonnegative().nullable(),
  harnessRunId: z.string().uuid().nullable(),
  error: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative()
})

export type JawsRun = z.infer<typeof jawsRunSchema>

export type JawsRunStatus =
  | 'awaiting_approval'
  | 'materializing_linear'
  | 'decision_required'
  | 'starting'
  | 'running'
  | 'publishing_review'
  | 'review_ready'
  | 'verified'
  | 'failed'

export type JawsRunView = JawsRun & {
  status: JawsRunStatus
  harnessStatus: HarnessRunStatus | null
  harnessError: string | null
  verification: HarnessVerificationSummary | null
}

export type JawsRunCreateInput = Pick<
  JawsRun,
  'repoId' | 'sourceWorktreeId' | 'sourceWorktreePath' | 'baseSha' | 'planHash' | 'plan'
>
