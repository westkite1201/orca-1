import { z } from 'zod'
import { parseLinearIssueInput } from '../../../../shared/linear/links'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

export const OptionalWorkerLaunchPreference = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim(), 'Surrounding whitespace is invalid')
  .optional()

const OptionalLinearIssue = OptionalString.refine(
  (value) => value === undefined || parseLinearIssueInput(value) !== null,
  'Invalid Linear issue identifier or URL.'
)

export const WorkerStartParams = z.object({
  task: requiredString('Missing --task'),
  on: OptionalString,
  run: OptionalString,
  from: requiredString('Missing --from'),
  worktree: OptionalString,
  name: OptionalString,
  repo: OptionalString,
  baseBranch: OptionalString,
  displayName: OptionalString,
  comment: OptionalString,
  linearIssue: OptionalLinearIssue,
  linearWorkspace: OptionalString,
  setup: z.enum(['run', 'skip', 'inherit']).optional(),
  terminal: OptionalString,
  agent: OptionalString,
  model: OptionalWorkerLaunchPreference,
  effort: OptionalWorkerLaunchPreference,
  retryOf: OptionalString,
  timeoutMs: OptionalFiniteNumber,
  devMode: z.boolean().optional()
})

export type WorkerStartInput = z.infer<typeof WorkerStartParams>

export function workerLinearFields<T extends null | undefined>(params: WorkerStartInput, empty: T) {
  return {
    linearIssue: params.linearIssue ?? empty,
    linearWorkspace: params.linearWorkspace ?? empty
  }
}
