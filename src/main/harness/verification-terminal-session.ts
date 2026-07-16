import { randomUUID } from 'node:crypto'
import { MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS } from '../../shared/automation-precheck'
import type { AutomationPrecheckResult } from '../../shared/automations-types'
import type { RuntimeTerminalRead } from '../../shared/runtime-types'
import {
  buildHarnessVerificationTerminalCommand,
  findHarnessVerificationCompletion
} from './verification-terminal-command'
import {
  isUnverifiedVerificationStopError,
  unverifiedVerificationStopError
} from './verification-terminal-error'

type VerificationTerminalIdentity = { handle: string; paneKey: string }

type VerificationTerminalSession = {
  create(args: {
    command: string
    onHandleAllocated: (identity: VerificationTerminalIdentity) => void
  }): Promise<{ handle: string }>
  read(handle: string): Promise<RuntimeTerminalRead>
  stop(handle: string): Promise<boolean>
}

function precheckResult(args: {
  command: string
  startedAt: number
  exitCode: number | null
  timedOut: boolean
  output: string
  outputTruncated: boolean
  error: string | null
}): AutomationPrecheckResult {
  const completedAt = Date.now()
  const stdoutTruncated =
    args.outputTruncated || args.output.length > MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS
  return {
    command: args.command,
    exitCode: args.exitCode,
    timedOut: args.timedOut,
    durationMs: Math.max(0, completedAt - args.startedAt),
    stdout: args.output.slice(-MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS),
    stderr: '',
    stdoutTruncated,
    stderrTruncated: false,
    error: args.error,
    startedAt: args.startedAt,
    completedAt
  }
}

async function requireStopped(
  session: VerificationTerminalSession,
  handle: string,
  onStopped: () => void,
  cause?: unknown
): Promise<void> {
  try {
    if (await session.stop(handle)) {
      onStopped()
      return
    }
  } catch (error) {
    throw unverifiedVerificationStopError(error)
  }
  throw unverifiedVerificationStopError(cause)
}

export async function runHarnessVerificationTerminal(args: {
  command: string
  timeoutSeconds: number
  windows: boolean
  session: VerificationTerminalSession
  onHandleAllocated: (identity: VerificationTerminalIdentity) => void
  onStopped: () => void
}): Promise<AutomationPrecheckResult> {
  const startedAt = Date.now()
  const completionToken = `__JAWS_VERIFY_${randomUUID().replaceAll('-', '')}__`
  let terminalHandle: string | null = null
  let stopProven = false
  const stopTerminal = async (cause?: unknown): Promise<void> => {
    if (!terminalHandle || stopProven) {
      return
    }
    await requireStopped(
      args.session,
      terminalHandle,
      () => {
        stopProven = true
        // Why: persist stop proof before final Git/result work so a restart
        // never needs to resolve a verification pane that is already gone.
        args.onStopped()
      },
      cause
    )
  }

  try {
    const created = await args.session.create({
      command: buildHarnessVerificationTerminalCommand({
        command: args.command,
        completionToken,
        windows: args.windows
      }),
      onHandleAllocated: (identity) => {
        // Why: persistence must succeed before this function considers the PTY
        // launchable; a callback failure aborts createTerminal before spawn.
        args.onHandleAllocated(identity)
        terminalHandle = identity.handle
      }
    })
    terminalHandle = created.handle
  } catch (error) {
    if (isUnverifiedVerificationStopError(error)) {
      throw error
    }
    await stopTerminal(error)
    throw error
  }

  const deadline = startedAt + args.timeoutSeconds * 1_000
  let output = ''
  let outputTruncated = false
  try {
    while (Date.now() < deadline) {
      const read = await args.session.read(terminalHandle)
      output = read.tail.join('\n')
      outputTruncated ||= read.truncated || read.limited === true
      const completion = findHarnessVerificationCompletion(output, completionToken)
      if (completion) {
        await stopTerminal()
        return precheckResult({
          command: args.command,
          startedAt,
          exitCode: completion.exitCode,
          timedOut: false,
          output: completion.output,
          outputTruncated,
          error: null
        })
      }
      if (read.status !== 'running') {
        await stopTerminal()
        return precheckResult({
          command: args.command,
          startedAt,
          exitCode: null,
          timedOut: false,
          output,
          outputTruncated,
          error: 'Verification terminal exited before reporting completion.'
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    await stopTerminal()
    return precheckResult({
      command: args.command,
      startedAt,
      exitCode: null,
      timedOut: true,
      output,
      outputTruncated,
      error: `Verification timed out after ${args.timeoutSeconds}s.`
    })
  } catch (error) {
    if (isUnverifiedVerificationStopError(error)) {
      throw error
    }
    await stopTerminal(error)
    throw error
  }
}
