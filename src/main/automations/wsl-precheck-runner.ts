import type { AutomationPrecheck, AutomationPrecheckResult } from '../../shared/automations-types'
import { MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS } from '../../shared/automation-precheck'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { toLinuxPath } from '../wsl'
import { runWslProcess } from '../wsl/wsl-runner'

function boundedOutput(value: string): { content: string; truncated: boolean } {
  return value.length <= MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS
    ? { content: value, truncated: false }
    : { content: value.slice(-MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS), truncated: true }
}

export async function runWslAutomationPrecheck(
  precheck: AutomationPrecheck,
  target: { cwd: string; wslDistro: string }
): Promise<AutomationPrecheckResult> {
  const startedAt = Date.now()
  const result = await runWslProcess({
    distro: target.wslDistro,
    loginPath: 'preferred',
    cwd: parseWslUncPath(target.cwd)?.linuxPath ?? toLinuxPath(target.cwd),
    script: precheck.command,
    timeoutMs: precheck.timeoutSeconds * 1000,
    maxOutputBytes: MAX_AUTOMATION_PRECHECK_OUTPUT_CHARS * 2
  })
  const completedAt = Date.now()
  const stdout = boundedOutput(result.stdout)
  const stderr = boundedOutput(result.stderr)
  return {
    command: precheck.command,
    exitCode: result.timedOut ? null : result.code,
    timedOut: result.timedOut,
    durationMs: Math.max(0, completedAt - startedAt),
    stdout: stdout.content,
    stderr: stderr.content,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    error: result.timedOut
      ? `Precheck timed out after ${precheck.timeoutSeconds}s.`
      : result.code === null
        ? 'WSL precheck did not report an exit code.'
        : null,
    startedAt,
    completedAt
  }
}
