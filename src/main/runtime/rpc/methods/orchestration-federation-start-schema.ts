import { z } from 'zod'
import { parseLinearIssueInput } from '../../../../shared/linear-links'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

const OptionalLinearIssue = OptionalString.refine(
  (value) => value === undefined || parseLinearIssueInput(value) !== null,
  'Invalid Linear issue identifier or URL.'
)

export const FederationAttachStartParams = z.object({
  dispatchId: requiredString('Missing Dispatch ID'),
  taskId: requiredString('Missing Task ID'),
  taskSpec: requiredString('Missing Task spec'),
  protocolVersion: z.union([z.literal(1), z.literal(2)]),
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
  timeoutMs: OptionalFiniteNumber,
  devMode: z.boolean().optional()
})
