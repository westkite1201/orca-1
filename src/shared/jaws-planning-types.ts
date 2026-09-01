import { z } from 'zod'

const requiredText = (message: string, max: number) =>
  z.string().trim().min(1, message).max(max, message)

export const JAWS_PLANNING_LOG_LIMIT = 160
export const JAWS_PLANNING_LOG_MESSAGE_LIMIT = 2_000

export const jawsPlanningLogEntrySchema = z.object({
  at: z.number().int().nonnegative(),
  stream: z.enum(['system', 'stdout', 'stderr']),
  message: requiredText('A planning log message is required.', JAWS_PLANNING_LOG_MESSAGE_LIMIT)
})

export const jawsPlanningStartSchema = z.object({
  goal: requiredText('A goal is required.', 20_000),
  worktreeSelector: requiredText('A worktree selector is required.', 1_024),
  clientRequestId: z.string().uuid().optional()
})

export const jawsPlanningSelectorSchema = z.object({
  planningId: z.string().trim().uuid()
})

export const jawsPlanningRunSchema = z.object({
  id: z.string().uuid(),
  clientRequestId: z.string().uuid(),
  repoId: requiredText('A repository id is required.', 1_024),
  sourceWorktreeId: requiredText('A source worktree id is required.', 2_048),
  sourceWorktreePath: requiredText('A source worktree path is required.', 32_768),
  baseSha: requiredText('A source SHA is required.', 128),
  goal: requiredText('A goal is required.', 20_000),
  status: z.enum(['queued', 'planning', 'needs_input', 'proposed', 'failed', 'canceled']),
  question: z.string().trim().min(1).max(4_000).nullable(),
  jawsRunId: z.string().uuid().nullable(),
  error: z.string().trim().min(1).max(4_000).nullable(),
  logs: z.array(jawsPlanningLogEntrySchema).max(JAWS_PLANNING_LOG_LIMIT).default([]),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative()
})

export type JawsPlanningStart = z.infer<typeof jawsPlanningStartSchema>
export type JawsPlanningSelector = z.infer<typeof jawsPlanningSelectorSchema>
export type JawsPlanningLogEntry = z.infer<typeof jawsPlanningLogEntrySchema>
export type JawsPlanningRun = z.infer<typeof jawsPlanningRunSchema>
export type JawsPlanningRunCreateInput = Pick<
  JawsPlanningRun,
  'clientRequestId' | 'repoId' | 'sourceWorktreeId' | 'sourceWorktreePath' | 'baseSha' | 'goal'
>

export function normalizeJawsPlanningQuestion(question: string): string {
  const text = question.trim()
  if (
    /linear/i.test(text) &&
    /(runtime|network|조회|식별자|identifier|description|dependency|의존)/i.test(text)
  ) {
    return /[\uac00-\ud7a3]/.test(text)
      ? 'Linear 이슈 정보를 확인할 수 없어요. 이슈 ID를 붙여 넣거나 Linear 연결 후 다시 시도해 주세요.'
      : 'Linear issue context is unavailable. Paste the issue IDs or reconnect Linear and try again.'
  }
  return text
}
