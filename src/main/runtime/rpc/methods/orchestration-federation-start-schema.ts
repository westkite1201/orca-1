import { z } from 'zod'
import { parseLinearIssueInput } from '../../../../shared/linear/links'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { OptionalWorkerLaunchPreference } from './orchestration-worker-start-schema'

const OptionalLinearIssue = OptionalString.refine(
  (value) => value === undefined || parseLinearIssueInput(value) !== null,
  'Invalid Linear issue identifier or URL.'
)

export const FederationAttachStartParams = z.object({
  dispatchId: requiredString('Missing Dispatch ID'),
  taskId: requiredString('Missing Task ID'),
  taskSpec: requiredString('Missing Task spec'),
  /** Depth stamped by the Run home; omitted by older clients and defaults to 1. */
  depth: z.number().int().min(1).optional(),
  protocolVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  worktree: requiredString('Missing remote worktree selector'),
  name: OptionalString,
  repo: OptionalString,
  baseBranch: OptionalString,
  displayName: OptionalString,
  comment: OptionalString,
  linearIssue: OptionalLinearIssue,
  linearWorkspace: OptionalString,
  setup: z.enum(['run', 'skip', 'inherit']).optional(),
  setupSource: z.enum(['explicit_request', 'orchestration_default']).optional(),
  terminal: OptionalString,
  agent: OptionalString,
  model: OptionalWorkerLaunchPreference,
  effort: OptionalWorkerLaunchPreference,
  timeoutMs: OptionalFiniteNumber,
  devMode: z.boolean().optional()
})

export type FederationAttachStartInput = z.infer<typeof FederationAttachStartParams>
