import { describe, expect, it, vi } from 'vitest'
import { runHarnessVerificationTerminal } from './verification-terminal-session'

describe('Harness verification terminal session', () => {
  it('persists terminal identity before launch and stops after reading completion', async () => {
    let marker = ''
    const order: string[] = []
    const stop = vi.fn(async () => true)
    const result = await runHarnessVerificationTerminal({
      command: 'pnpm test',
      timeoutSeconds: 60,
      windows: false,
      session: {
        create: async ({ command, onHandleAllocated }) => {
          marker = /(__JAWS_VERIFY_[a-f0-9]+__)/.exec(command)?.[1] ?? ''
          onHandleAllocated({ handle: 'term-1', paneKey: 'tab:leaf' })
          order.push('spawn')
          return { handle: 'term-1' }
        },
        read: async () => ({
          handle: 'term-1',
          status: 'running',
          tail: ['passed', `${marker}0`],
          truncated: false,
          nextCursor: null
        }),
        stop
      },
      onHandleAllocated: () => order.push('persist'),
      onStopped: () => order.push('stopped')
    })

    expect(order).toEqual(['persist', 'spawn', 'stopped'])
    expect(stop).toHaveBeenCalledWith('term-1')
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, stdout: 'passed' })
  })

  it('surfaces an unverified stop instead of releasing terminal ownership', async () => {
    let marker = ''
    await expect(
      runHarnessVerificationTerminal({
        command: 'pnpm test',
        timeoutSeconds: 60,
        windows: false,
        session: {
          create: async ({ command, onHandleAllocated }) => {
            marker = /(__JAWS_VERIFY_[a-f0-9]+__)/.exec(command)?.[1] ?? ''
            onHandleAllocated({ handle: 'term-1', paneKey: 'tab:leaf' })
            return { handle: 'term-1' }
          },
          read: async () => ({
            handle: 'term-1',
            status: 'running',
            tail: [`${marker}0`],
            truncated: false,
            nextCursor: null
          }),
          stop: async () => false
        },
        onHandleAllocated: vi.fn(),
        onStopped: vi.fn()
      })
    ).rejects.toMatchObject({ code: 'HARNESS_VERIFICATION_STOP_UNVERIFIED' })
  })

  it('does not spawn when durable ownership persistence fails', async () => {
    const spawn = vi.fn()
    const stop = vi.fn(async () => true)

    await expect(
      runHarnessVerificationTerminal({
        command: 'pnpm test',
        timeoutSeconds: 60,
        windows: false,
        session: {
          create: async ({ onHandleAllocated }) => {
            onHandleAllocated({ handle: 'term-1', paneKey: 'tab:leaf' })
            spawn()
            return { handle: 'term-1' }
          },
          read: vi.fn(),
          stop
        },
        onHandleAllocated: () => {
          throw new Error('disk full')
        },
        onStopped: vi.fn()
      })
    ).rejects.toThrow('disk full')
    expect(spawn).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })
})
