import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAutomationPrecheck } from './precheck-runner'

const runWslProcessMock = vi.hoisted(() => vi.fn())

vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

const sshManagerState = vi.hoisted(() => ({
  manager: null as null | {
    getConnection: ReturnType<typeof vi.fn>
  },
  registeredState: undefined as
    | {
        remotePlatform?: 'linux' | 'darwin' | 'win32'
      }
    | undefined,
  getRegisteredSshState: vi.fn((_targetId: string) => sshManagerState.registeredState)
}))

vi.mock('../ipc/ssh', () => ({
  getRegisteredSshState: sshManagerState.getRegisteredSshState,
  getSshConnectionManager: () => sshManagerState.manager
}))

const node = JSON.stringify(process.execPath)

function nodeCommand(script: string): string {
  return `${node} -e ${JSON.stringify(script)}`
}

describe('runAutomationPrecheck', () => {
  let cwd = ''

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'orca-precheck-test-'))
    sshManagerState.manager = null
    sshManagerState.registeredState = undefined
    sshManagerState.getRegisteredSshState.mockClear()
    runWslProcessMock.mockReset().mockResolvedValue({
      environmentResolved: true,
      code: 0,
      stdout: 'passed',
      stderr: '',
      timedOut: false
    })
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('captures exit code and output for a non-zero local precheck', async () => {
    const result = await runAutomationPrecheck({
      precheck: {
        command: nodeCommand(
          "console.log('stdout text'); console.error('stderr text'); process.exit(7)"
        ),
        timeoutSeconds: 5
      },
      target: { type: 'local', cwd }
    })

    expect(result.exitCode).toBe(7)
    expect(result.timedOut).toBe(false)
    expect(result.stdout).toContain('stdout text')
    expect(result.stderr).toContain('stderr text')
    expect(result.error).toBeNull()
  })

  it('routes a WSL precheck through the centralized runner', async () => {
    const result = await runAutomationPrecheck({
      precheck: { command: 'pnpm test', timeoutSeconds: 5 },
      target: {
        type: 'local',
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo',
        wslDistro: 'Ubuntu'
      }
    })

    expect(runWslProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        distro: 'Ubuntu',
        loginPath: 'preferred',
        cwd: '/home/jin/repo',
        script: 'pnpm test',
        timeoutMs: 5_000
      })
    )
    expect(result).toMatchObject({ exitCode: 0, stdout: 'passed', error: null })
  })

  it('marks a local precheck as timed out', async () => {
    const result = await runAutomationPrecheck({
      precheck: {
        command: nodeCommand('setTimeout(() => {}, 5000)'),
        timeoutSeconds: 1
      },
      target: { type: 'local', cwd }
    })

    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(true)
    expect(result.error).toBe('Precheck timed out after 1s.')
  })

  it('uses the SSH channel exit event as the precheck exit code', async () => {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
      close: vi.fn()
    })
    sshManagerState.manager = {
      getConnection: vi.fn(() => ({
        getState: () => ({ status: 'connected' }),
        exec: vi.fn(async () => channel)
      }))
    }

    const resultPromise = runAutomationPrecheck({
      precheck: {
        command: "printf 'ready'",
        timeoutSeconds: 5
      },
      target: {
        type: 'ssh',
        cwd: '/repo/path',
        connectionId: 'ssh-1'
      }
    })
    await Promise.resolve()
    channel.emit('data', Buffer.from('ready\n'))
    channel.emit('exit', 0)
    channel.emit('close')

    const result = await resultPromise
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('ready')
    expect(result.error).toBeNull()
  })

  it('runs Windows SSH verification through encoded PowerShell without POSIX wrapping', async () => {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
      close: vi.fn()
    })
    const exec = vi.fn(async (_command: string, _options?: { wrapCommand?: boolean }) => channel)
    sshManagerState.registeredState = { remotePlatform: 'win32' }
    sshManagerState.manager = {
      getConnection: vi.fn(() => ({
        getState: () => ({ status: 'connected', remotePlatform: 'linux' }),
        exec
      }))
    }

    const resultPromise = runAutomationPrecheck({
      precheck: { command: 'pnpm test', timeoutSeconds: 5 },
      target: { type: 'ssh', cwd: 'C:\\work\\repo', connectionId: 'ssh-win' }
    })
    await Promise.resolve()
    channel.emit('exit', 0)
    channel.emit('close')
    await resultPromise

    expect(exec).toHaveBeenCalledWith(expect.stringContaining('powershell.exe'), {
      wrapCommand: false
    })
    expect(sshManagerState.getRegisteredSshState).toHaveBeenCalledWith('ssh-win')
    const encoded = (exec.mock.calls[0]?.[0] ?? '').match(/-EncodedCommand\s+(\S+)/)?.[1]
    const script = Buffer.from(encoded ?? '', 'base64').toString('utf16le')
    expect(script).toContain("Set-Location -LiteralPath 'C:\\work\\repo' -ErrorAction Stop")
    expect(script).toContain('} catch {\n  Write-Error $_\n  exit 1\n}')
    expect(script).toContain('pnpm test')
    expect(script.indexOf('exit 1')).toBeLessThan(script.indexOf('pnpm test'))
  })

  it('runs POSIX SSH verification in the user login shell', async () => {
    const channel = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
      close: vi.fn()
    })
    const exec = vi.fn(async (_command: string, _options?: { wrapCommand?: boolean }) => channel)
    sshManagerState.registeredState = { remotePlatform: 'linux' }
    sshManagerState.manager = {
      getConnection: vi.fn(() => ({
        getState: () => ({ status: 'connected' }),
        exec
      }))
    }

    const resultPromise = runAutomationPrecheck({
      precheck: { command: 'pnpm test', timeoutSeconds: 5 },
      target: { type: 'ssh', cwd: '/repo/path', connectionId: 'ssh-linux' }
    })
    await Promise.resolve()
    channel.emit('exit', 0)
    channel.emit('close')
    await resultPromise

    expect(exec).toHaveBeenCalledWith(expect.stringContaining('getent passwd'), {
      wrapCommand: true
    })
    expect(exec.mock.calls[0]?.[0]).toContain('/repo/path')
    expect(exec.mock.calls[0]?.[0]).toContain('pnpm test')
  })
})
