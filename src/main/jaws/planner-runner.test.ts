import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessSpec } from '../../shared/child-process/run-process'
import { runJawsPlanner, type JawsPlannerTarget } from './planner-runner'
import { runRemoteJawsPlanner } from './remote-planner-runner'

type RecordedSpec = ProcessSpec & { args: readonly string[] }

const recordedSpecs: RecordedSpec[] = []
function recordSpec(spec: ProcessSpec): RecordedSpec {
  return { ...spec, args: spec.args ?? [] }
}

const runPlannerProcess = vi.fn(async (spec: ProcessSpec) => {
  recordedSpecs.push(recordSpec(spec))
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
})

beforeEach(() => {
  recordedSpecs.length = 0
  runPlannerProcess.mockClear()
})

async function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'orca-jaws-planner-test-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function localTarget(cwd = '/repo'): JawsPlannerTarget {
  return { kind: 'local', cwd, env: { CODEX_HOME: '/codex-home' } }
}

describe('runJawsPlanner', () => {
  it('keeps remote planning read-only and validates the returned JSON locally', async () => {
    const execute = vi.fn(async () => ({
      stdout: `${JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: JSON.stringify({ kind: 'question', question: 'Which API should own retries?' })
        }
      })}\n`,
      stderr: '',
      exitCode: 0,
      timedOut: false
    }))

    const result = await runRemoteJawsPlanner({
      prompt: 'Plan retries',
      cwd: '/srv/repo',
      execute
    })

    expect(result).toMatchObject({
      success: true,
      reply: { kind: 'question', question: 'Which API should own retries?' }
    })
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/srv/repo',
        prompt: 'Plan retries',
        args: expect.arrayContaining([
          '--ephemeral',
          '--ignore-user-config',
          '--config',
          'model_reasoning_effort="low"',
          '--json',
          '--sandbox',
          'read-only',
          '--cd',
          '/srv/repo'
        ])
      })
    )
  })

  it('runs local codex exec with stdin, schema, and output-last-message files', async () => {
    await withTempDir(async (root) => {
      let tempDir = ''
      const result = await runJawsPlanner(
        {
          prompt: 'Plan this work',
          target: localTarget('/repo'),
          model: 'gpt-5.4'
        },
        {
          mkdtempDir: async () => {
            tempDir = join(root, 'runner')
            await mkdtemp(join(root, 'runner-')).then(async (dir) => {
              tempDir = dir
            })
            return tempDir
          },
          runPlannerProcess: vi.fn(async (spec: ProcessSpec) => {
            const recorded = recordSpec(spec)
            recordedSpecs.push(recorded)
            const outputPath = String(
              recorded.args[recorded.args.indexOf('--output-last-message') + 1]
            )
            await import('node:fs/promises').then(({ writeFile }) =>
              writeFile(
                outputPath,
                `${JSON.stringify({
                  kind: 'plan',
                  plan: {
                    goal: 'Plan this work',
                    verificationCommand: 'pnpm test',
                    maxConcurrency: 1,
                    tasks: [
                      {
                        key: 'API',
                        title: 'Build API',
                        objective: 'Do it',
                        dependsOn: [],
                        execution: 'worktree',
                        fileScopes: ['src/main/api'],
                        acceptanceCriteria: ['API behavior works.'],
                        verificationCommands: ['pnpm test src/main/api']
                      }
                    ]
                  }
                })}\n`,
                'utf8'
              )
            )
            return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
          })
        }
      )

      expect(result).toMatchObject({
        success: true,
        reply: {
          kind: 'plan',
          plan: {
            goal: 'Plan this work',
            verificationCommand: 'pnpm test',
            maxConcurrency: 1
          }
        }
      })
      expect(recordedSpecs).toHaveLength(1)
      expect(recordedSpecs[0]).toMatchObject({
        program: 'codex',
        cwd: '/repo',
        input: 'Plan this work',
        env: { CODEX_HOME: '/codex-home' }
      })
      expect(recordedSpecs[0]?.args).toContain('--ephemeral')
      expect(recordedSpecs[0]?.args).toContain('--ignore-user-config')
      expect(recordedSpecs[0]?.args).toContain('model_reasoning_effort="low"')
      expect(recordedSpecs[0]?.args).toContain('--json')
      expect(recordedSpecs[0]?.args).toContain('--sandbox')
      expect(recordedSpecs[0]?.args).toContain('read-only')
      expect(recordedSpecs[0]?.args).toContain('--cd')
      expect(recordedSpecs[0]?.args).toContain('/repo')
      expect(recordedSpecs[0]?.args).toContain('--output-schema')
      expect(recordedSpecs[0]?.args).toContain('--output-last-message')
      expect(recordedSpecs[0]?.args.at(-1)).toBe('-')
      await expect(stat(tempDir)).rejects.toThrow()
    })
  })

  it('routes WSL execution through wsl.exe with a login-shell wrapper', async () => {
    await withTempDir(async () => {
      const result = await runJawsPlanner(
        {
          prompt: 'Plan this work',
          target: {
            kind: 'wsl',
            distro: 'Ubuntu-24.04',
            cwd: 'C:\\repo',
            env: { CODEX_HOME: '/home/tester/.codex' }
          }
        },
        {
          runPlannerProcess: vi.fn(async (spec: ProcessSpec) => {
            recordedSpecs.push(recordSpec(spec))
            return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
          }),
          readFileText: vi.fn(
            async () =>
              `${JSON.stringify({ kind: 'question', question: 'Which API should this target?' })}\n`
          )
        }
      )

      expect(result).toMatchObject({
        success: true,
        reply: { kind: 'question', question: 'Which API should this target?' }
      })
      expect(recordedSpecs).toHaveLength(1)
      expect(recordedSpecs[0]?.program).toBe('wsl.exe')
      expect(recordedSpecs[0]?.cwd).toBeUndefined()
      expect(recordedSpecs[0]?.args.slice(0, 5)).toEqual([
        '-d',
        'Ubuntu-24.04',
        '--exec',
        'sh',
        '-lc'
      ])
      const shellCommand = String(recordedSpecs[0]?.args[5])
      expect(shellCommand).toContain('getent passwd')
      expect(shellCommand).toContain("exec '\\''codex'\\'' '\\''exec'\\''")
      expect(shellCommand).toContain("'\\''--sandbox'\\'' '\\''read-only'\\''")
      expect(shellCommand).toContain("'\\''--cd'\\'' '\\''/mnt/c/repo'\\''")
      expect(shellCommand).toContain('CODEX_HOME=')
      expect(shellCommand).toContain('/home/tester/.codex')
    })
  })

  it('reports parse failures from the last-message file', async () => {
    const result = await runJawsPlanner(
      {
        prompt: 'Plan this work',
        target: localTarget()
      },
      {
        runPlannerProcess: vi.fn(async (spec: ProcessSpec) => {
          const recorded = recordSpec(spec)
          recordedSpecs.push(recorded)
          const outputPath = String(
            recorded.args[recorded.args.indexOf('--output-last-message') + 1]
          )
          await import('node:fs/promises').then(({ writeFile }) =>
            writeFile(outputPath, 'not json\n', 'utf8')
          )
          return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
        })
      }
    )

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('Unexpected token')
    })
  })

  it('summarizes streaming Codex progress for the planning surface', async () => {
    const logs: { stream: 'stdout' | 'stderr'; message: string }[] = []
    const result = await runJawsPlanner(
      {
        prompt: 'Plan this work',
        target: localTarget(),
        onOutput: (entry) => logs.push(entry)
      },
      {
        runPlannerProcess: vi.fn(async (spec: ProcessSpec) => {
          const outputPath = String(spec.args?.[spec.args.indexOf('--output-last-message') + 1])
          spec.onStdout?.(
            `${JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' })}\n${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"kind":"plan"}' } })}\n${JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'git status --short' } })}\n`
          )
          spec.onStderr?.('hook: SessionStart\n')
          await import('node:fs/promises').then(({ writeFile }) =>
            writeFile(
              outputPath,
              JSON.stringify({ kind: 'question', question: 'Which scope should I use?' }),
              'utf8'
            )
          )
          return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
        })
      }
    )

    expect(result.success).toBe(true)
    expect(logs).toEqual([
      { stream: 'stdout', message: 'Codex session started.' },
      { stream: 'stdout', message: 'Codex is refining the plan.' },
      { stream: 'stdout', message: 'Inspecting: git status --short' },
      { stream: 'stderr', message: 'hook: SessionStart' }
    ])
  })

  it('reports timeout and preserves the caller timeout override', async () => {
    const result = await runJawsPlanner(
      {
        prompt: 'Plan this work',
        target: localTarget(),
        timeoutMs: 4_321
      },
      {
        runPlannerProcess: vi.fn(async (spec: ProcessSpec) => {
          recordedSpecs.push(recordSpec(spec))
          return { code: null, signal: 'SIGTERM' as const, stdout: '', stderr: '', timedOut: true }
        })
      }
    )

    expect(recordedSpecs[0]?.timeoutMs).toBe(4_321)
    expect(result).toMatchObject({
      success: false,
      timedOut: true,
      error: 'Planner timed out after 4.321s.'
    })
  })

  it('reports cancellation from the caller signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await runJawsPlanner(
      {
        prompt: 'Plan this work',
        target: localTarget(),
        signal: controller.signal
      },
      {
        runPlannerProcess: vi.fn(async (spec: ProcessSpec) => {
          recordedSpecs.push(recordSpec(spec))
          return { code: null, signal: null, stdout: '', stderr: '', timedOut: false }
        })
      }
    )

    expect(recordedSpecs[0]?.signal).toBe(controller.signal)
    expect(result).toMatchObject({
      success: false,
      canceled: true,
      error: 'Planner canceled.'
    })
  })
})
