import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  buildHarnessVerificationTerminalCommand,
  findHarnessVerificationCompletion
} from './verification-terminal-command'

function decodePowerShellCommand(command: string): string {
  const encoded = command.split(' ').at(-1) ?? ''
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('Harness verification terminal command', () => {
  it('isolates a POSIX command and keeps the wrapper alive after its completion marker', () => {
    const command = buildHarnessVerificationTerminalCommand({
      command: "printf '%s' \"it's done\"; exit 7",
      completionToken: '__DONE__',
      windows: false
    })

    expect(command).toContain('sh -lc')
    expect(command).toContain('__DONE__%s')
    expect(command).toContain('while :; do sleep 3600; done')
  })

  it('isolates a Windows command in an encoded child PowerShell', () => {
    const command = buildHarnessVerificationTerminalCommand({
      command: 'Write-Output ok; exit 9',
      completionToken: '__DONE__',
      windows: true
    })
    const wrapper = decodePowerShellCommand(command)

    expect(wrapper).toContain('& powershell.exe')
    expect(wrapper).toContain('Write-Output "__DONE__$orcaExitCode"')
    expect(wrapper).toContain('while ($true) { Start-Sleep -Seconds 3600 }')
    expect(wrapper).not.toContain('Write-Output ok; exit 9')
  })

  it('parses only a marker followed by an exit code and removes the marker line', () => {
    expect(findHarnessVerificationCompletion('hello\n__DONE__12\n', '__DONE__')).toEqual({
      exitCode: 12,
      output: 'hello'
    })
    expect(findHarnessVerificationCompletion('__DONE__%s', '__DONE__')).toBeNull()
  })
})
