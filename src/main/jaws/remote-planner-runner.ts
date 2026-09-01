import { parseJawsPlannerOutput } from './planner-contract'
import { JAWS_PLANNER_TIMEOUT_MS, type JawsPlannerResult } from './planner-runner'
import { extractJawsPlannerLastMessage, summarizeJawsPlannerOutput } from './planner-output-log'

export type JawsRemotePlannerExecutor = (input: {
  binary: string
  args: string[]
  cwd: string
  prompt: string
  timeoutMs: number
  signal?: AbortSignal
}) => Promise<{
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  canceled?: boolean
  spawnError?: string
}>

function remotePlannerArgs(cwd: string, model?: string): string[] {
  return [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--config',
    'model_reasoning_effort="low"',
    '--json',
    '--sandbox',
    'read-only',
    '--cd',
    cwd,
    ...(model ? ['--model', model] : []),
    '-'
  ]
}

export async function runRemoteJawsPlanner(args: {
  prompt: string
  cwd: string
  execute: JawsRemotePlannerExecutor
  binary?: string
  model?: string
  timeoutMs?: number
  signal?: AbortSignal
  onOutput?: (entry: { stream: 'stdout' | 'stderr'; message: string }) => void
}): Promise<JawsPlannerResult> {
  const timeoutMs = args.timeoutMs ?? JAWS_PLANNER_TIMEOUT_MS
  const result = await args.execute({
    binary: args.binary ?? 'codex',
    args: remotePlannerArgs(args.cwd, args.model),
    cwd: args.cwd,
    prompt: args.prompt,
    timeoutMs,
    signal: args.signal
  })
  for (const [stream, output] of [
    ['stdout', result.stdout],
    ['stderr', result.stderr]
  ] as const) {
    for (const line of output.split(/\r?\n/)) {
      const message = summarizeJawsPlannerOutput(stream, line)
      if (message) {
        args.onOutput?.({ stream, message })
      }
    }
  }
  const canceled = result.canceled === true || args.signal?.aborted === true
  if (canceled || result.spawnError || result.exitCode !== 0 || result.timedOut) {
    return {
      success: false,
      error: canceled
        ? 'Planner canceled.'
        : result.timedOut
          ? `Planner timed out after ${timeoutMs / 1000}s.`
          : (result.spawnError ?? `Planner failed with exit code ${result.exitCode ?? 'unknown'}.`),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      canceled,
      stdout: result.stdout,
      stderr: result.stderr
    }
  }
  try {
    return {
      success: true,
      reply: parseJawsPlannerOutput(extractJawsPlannerLastMessage(result.stdout)),
      lastMessage: extractJawsPlannerLastMessage(result.stdout),
      stdout: result.stdout,
      stderr: result.stderr
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      exitCode: result.exitCode,
      timedOut: false,
      canceled: false,
      stdout: result.stdout,
      stderr: result.stderr
    }
  }
}
