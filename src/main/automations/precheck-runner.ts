import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import type { ClientChannel } from 'ssh2'
import type { AutomationPrecheck, AutomationPrecheckResult } from '../../shared/automations-types'
import { MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS } from '../../shared/automation-precheck'
import {
  buildWslLoginShellCommand,
  escapeWslShCommandForWindows,
  quotePosixShell
} from '../../shared/wsl-login-shell-command'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getRegisteredSshState, getSshConnectionManager } from '../ipc/ssh'
import { toLinuxPath } from '../wsl'
import { resolveSshPrecheckCommand } from './ssh-precheck-command'

export type AutomationPrecheckExecutionTarget =
  | {
      type: 'local'
      cwd: string
      wslDistro?: string
    }
  | {
      type: 'ssh'
      cwd: string
      connectionId: string
    }

type TailBuffer = {
  content: string
  truncated: boolean
}

export type AutomationPrecheckSpawn = {
  command: string
  args: string[]
  options: SpawnOptions
}

export function resolveAutomationPrecheckSpawn(
  precheck: AutomationPrecheck,
  target: Extract<AutomationPrecheckExecutionTarget, { type: 'local' }>
): AutomationPrecheckSpawn {
  if (!target.wslDistro) {
    return {
      command: precheck.command,
      args: [],
      options: {
        cwd: target.cwd,
        detached: process.platform !== 'win32',
        env: process.env,
        shell: true,
        windowsHide: true
      }
    }
  }

  const linuxCwd = parseWslUncPath(target.cwd)?.linuxPath ?? toLinuxPath(target.cwd)
  const command = buildWslLoginShellCommand(
    `cd ${quotePosixShell(linuxCwd)} && ${precheck.command}`
  )
  return {
    command: 'wsl.exe',
    args: ['-d', target.wslDistro, '--', 'sh', '-lc', escapeWslShCommandForWindows(command)],
    options: {
      detached: false,
      env: process.env,
      windowsHide: true
    }
  }
}

function appendTail(buffer: TailBuffer, chunk: string): TailBuffer {
  const content = `${buffer.content}${chunk}`
  if (content.length <= MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS) {
    return { ...buffer, content }
  }
  return {
    content: content.slice(-MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS),
    truncated: true
  }
}

function createPrecheckResult(args: {
  precheck: AutomationPrecheck
  startedAt: number
  stdout: TailBuffer
  stderr: TailBuffer
  exitCode: number | null
  timedOut: boolean
  error: string | null
}): AutomationPrecheckResult {
  const completedAt = Date.now()
  return {
    command: args.precheck.command,
    exitCode: args.exitCode,
    timedOut: args.timedOut,
    durationMs: Math.max(0, completedAt - args.startedAt),
    stdout: args.stdout.content,
    stderr: args.stderr.content,
    stdoutTruncated: args.stdout.truncated,
    stderrTruncated: args.stderr.truncated,
    error: args.error,
    startedAt: args.startedAt,
    completedAt
  }
}

function failedPrecheckResult(
  precheck: AutomationPrecheck,
  startedAt: number,
  error: string
): AutomationPrecheckResult {
  return createPrecheckResult({
    precheck,
    startedAt,
    stdout: { content: '', truncated: false },
    stderr: { content: '', truncated: false },
    exitCode: null,
    timedOut: false,
    error
  })
}

function killLocalPrecheckProcessTree(child: ChildProcess): ReturnType<typeof setTimeout> | null {
  const pid = child.pid
  if (!pid) {
    child.kill()
    return null
  }

  if (process.platform === 'win32') {
    try {
      // Why: shell prechecks can launch child processes; taskkill walks the
      // Windows process tree so timeout means the command is actually stopped.
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      killer.on('error', () => child.kill())
      killer.unref()
    } catch {
      child.kill()
    }
    return null
  }

  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    child.kill()
  }

  const forceKillTimer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* process group already exited */
    }
  }, 2000)
  forceKillTimer.unref?.()
  return forceKillTimer
}

function runLocalPrecheck(
  precheck: AutomationPrecheck,
  target: Extract<AutomationPrecheckExecutionTarget, { type: 'local' }>
): Promise<AutomationPrecheckResult> {
  const startedAt = Date.now()
  const timeoutMs = precheck.timeoutSeconds * 1000
  return new Promise((resolve) => {
    let stdout: TailBuffer = { content: '', truncated: false }
    let stderr: TailBuffer = { content: '', truncated: false }
    let timedOut = false
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null

    // Why: verification must use the same project runtime as its worker;
    // spawning on Windows would otherwise test the host instead of WSL.
    const launch = resolveAutomationPrecheckSpawn(precheck, target)
    const child = spawn(launch.command, launch.args, launch.options)

    const settle = (exitCode: number | null, error: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
        forceKillTimer = null
      }
      resolve(
        createPrecheckResult({ precheck, startedAt, stdout, stderr, exitCode, timedOut, error })
      )
    }

    timeout = setTimeout(() => {
      timedOut = true
      forceKillTimer = killLocalPrecheckProcessTree(child)
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout = appendTail(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendTail(stderr, chunk)
    })
    child.on('error', (error) => {
      settle(null, error.message)
    })
    child.on('close', (code) => {
      settle(
        timedOut || typeof code !== 'number' ? null : code,
        timedOut ? `Precheck timed out after ${precheck.timeoutSeconds}s.` : null
      )
    })
  })
}

function runSshChannelPrecheck(args: {
  precheck: AutomationPrecheck
  channel: ClientChannel
  startedAt: number
}): Promise<AutomationPrecheckResult> {
  const { precheck, channel, startedAt } = args
  const timeoutMs = precheck.timeoutSeconds * 1000
  return new Promise((resolve) => {
    let stdout: TailBuffer = { content: '', truncated: false }
    let stderr: TailBuffer = { content: '', truncated: false }
    let exitCode: number | null = null
    let timedOut = false
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null

    const settle = (exitCode: number | null, error: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      resolve(
        createPrecheckResult({ precheck, startedAt, stdout, stderr, exitCode, timedOut, error })
      )
    }

    timeout = setTimeout(() => {
      timedOut = true
      channel.close()
    }, timeoutMs)

    const fail = (error: Error): void => {
      settle(null, error.message)
    }
    channel.on('error', fail)
    channel.stderr.on('error', fail)
    channel.on('data', (data: Buffer | string) => {
      stdout = appendTail(stdout, data.toString())
    })
    channel.stderr.on('data', (data: Buffer | string) => {
      stderr = appendTail(stderr, data.toString())
    })
    channel.on('exit', (code: number | null) => {
      exitCode = typeof code === 'number' ? code : null
    })
    channel.on('close', (code?: number | null) => {
      if (typeof code === 'number') {
        exitCode = code
      }
      settle(exitCode, timedOut ? `Precheck timed out after ${precheck.timeoutSeconds}s.` : null)
    })
  })
}

async function runSshPrecheck(
  precheck: AutomationPrecheck,
  target: Extract<AutomationPrecheckExecutionTarget, { type: 'ssh' }>
): Promise<AutomationPrecheckResult> {
  const startedAt = Date.now()
  const manager = getSshConnectionManager()
  const connection = manager?.getConnection(target.connectionId)
  if (!connection || connection.getState().status !== 'connected') {
    return failedPrecheckResult(precheck, startedAt, 'SSH target is not connected.')
  }
  try {
    // Why: the relay enriches registered state with its detected OS; the raw
    // SSH connection state does not carry that platform reliably.
    const launch = resolveSshPrecheckCommand({
      cwd: target.cwd,
      command: precheck.command,
      remotePlatform: getRegisteredSshState(target.connectionId)?.remotePlatform
    })
    const channel = await connection.exec(launch.command, { wrapCommand: launch.wrapCommand })
    return await runSshChannelPrecheck({ precheck, channel, startedAt })
  } catch (error) {
    return failedPrecheckResult(
      precheck,
      startedAt,
      error instanceof Error ? error.message : String(error)
    )
  }
}

export async function runAutomationPrecheck(args: {
  precheck: AutomationPrecheck
  target: AutomationPrecheckExecutionTarget
}): Promise<AutomationPrecheckResult> {
  if (args.target.type === 'ssh') {
    return await runSshPrecheck(args.precheck, args.target)
  }
  return await runLocalPrecheck(args.precheck, args.target)
}
