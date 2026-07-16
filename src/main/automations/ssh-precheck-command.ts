import type { SshRemotePlatform } from '../../shared/ssh-types'
import { buildWslLoginShellCommand, quotePosixShell } from '../../shared/wsl-login-shell-command'
import { powerShellCommand, powerShellLiteral } from '../ssh/ssh-remote-powershell'

export type SshPrecheckCommand = {
  command: string
  wrapCommand: boolean
}

export function resolveSshPrecheckCommand(args: {
  cwd: string
  command: string
  remotePlatform?: SshRemotePlatform
}): SshPrecheckCommand {
  if (args.remotePlatform === 'win32') {
    // Why: Set-Location errors are non-terminating by default and must not let
    // verification continue in the SSH account's fallback directory.
    const script = [
      'try {',
      `  Set-Location -LiteralPath ${powerShellLiteral(args.cwd)} -ErrorAction Stop`,
      '} catch {',
      '  Write-Error $_',
      '  exit 1',
      '}',
      '$global:LASTEXITCODE = 0',
      `& { ${args.command} }`,
      '$orcaSucceeded = $?',
      '$orcaExitCode = $LASTEXITCODE',
      'if ($orcaExitCode -ne 0) { exit $orcaExitCode }',
      'if (-not $orcaSucceeded) { exit 1 }',
      'exit 0'
    ].join('\n')
    return { command: powerShellCommand(script), wrapCommand: false }
  }

  // Why: verification must see the same profile-derived toolchain PATH as
  // the remote agent PTY, including nvm, pnpm, pyenv, and custom shells.
  const scopedCommand = `cd ${quotePosixShell(args.cwd)} && ${args.command}`
  return { command: buildWslLoginShellCommand(scopedCommand), wrapCommand: true }
}
