import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import { powerShellCommand } from '../ssh/ssh-remote-powershell'

export function buildHarnessVerificationTerminalCommand(args: {
  command: string
  completionToken: string
  windows: boolean
}): string {
  if (args.windows) {
    const verificationCommand = powerShellCommand(args.command)
    const script = [
      '$global:LASTEXITCODE = 0',
      `& ${verificationCommand}`,
      '$orcaSucceeded = $?',
      '$orcaExitCode = $LASTEXITCODE',
      'if ($orcaExitCode -eq 0 -and -not $orcaSucceeded) { $orcaExitCode = 1 }',
      `Write-Output "${args.completionToken}$orcaExitCode"`,
      'while ($true) { Start-Sleep -Seconds 3600 }'
    ].join('\n')
    return powerShellCommand(script)
  }

  const script = [
    `sh -lc ${quotePosixShell(args.command)}`,
    '_orca_exit_code=$?',
    `printf '\\n${args.completionToken}%s\\n' "$_orca_exit_code"`,
    'while :; do sleep 3600; done'
  ].join('\n')
  return `sh -lc ${quotePosixShell(script)}`
}

export function findHarnessVerificationCompletion(
  output: string,
  completionToken: string
): { exitCode: number; output: string } | null {
  const markerIndex = output.lastIndexOf(completionToken)
  if (markerIndex === -1) {
    return null
  }
  const suffix = output.slice(markerIndex + completionToken.length)
  const match = /^(-?\d+)/.exec(suffix)
  if (!match) {
    return null
  }
  return {
    exitCode: Number(match[1]),
    output: output.slice(0, markerIndex).replace(/\r?\n$/, '')
  }
}
