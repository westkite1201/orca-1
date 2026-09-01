import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  runProcess,
  type ProcessResult,
  type ProcessSpec
} from '../../shared/child-process/run-process'
import {
  buildWslExecArgs,
  buildWslLoginShellCommand,
  quotePosixShell
} from '../../shared/wsl-login-shell-command'
import { toLinuxPath } from '../../shared/wsl-paths'
import { resolveWslExecutablePath } from '../wsl/wsl-executable-path'
import {
  getJawsPlannerOutputJsonSchema,
  parseJawsPlannerOutput,
  type JawsPlannerReply
} from './planner-contract'
import { createPlannerOutputEmitter, type JawsPlannerOutput } from './planner-output-log'

export const JAWS_PLANNER_TIMEOUT_MS = 5 * 60 * 1_000

type RunPlannerProcess = (spec: ProcessSpec) => Promise<ProcessResult>
type MktempDir = (prefix: string) => Promise<string>
type WriteFileText = (path: string, content: string, encoding: BufferEncoding) => Promise<void>
type ReadFileText = (path: string, encoding: BufferEncoding) => Promise<string>
type RemoveDir = (
  path: string,
  options: {
    recursive: boolean
    force: boolean
  }
) => Promise<void>

type JawsPlannerProcessTarget =
  | {
      kind: 'local'
      cwd: string
      env?: NodeJS.ProcessEnv
      binary?: string
    }
  | {
      kind: 'wsl'
      cwd: string
      distro: string
      env?: Readonly<Record<string, string>>
      binary?: string
    }

export type JawsPlannerTarget = JawsPlannerProcessTarget

export type JawsPlannerRunnerArgs = {
  prompt: string
  target: JawsPlannerTarget
  model?: string
  timeoutMs?: number
  signal?: AbortSignal
  onOutput?: (entry: JawsPlannerOutput) => void
}

export type JawsPlannerSuccess = {
  success: true
  reply: JawsPlannerReply
  lastMessage: string
  stdout: string
  stderr: string
}

export type JawsPlannerFailure = {
  success: false
  error: string
  exitCode: number | null
  timedOut: boolean
  canceled: boolean
  stdout: string
  stderr: string
}

export type JawsPlannerResult = JawsPlannerSuccess | JawsPlannerFailure

type JawsPlannerRunnerDeps = {
  mkdtempDir?: MktempDir
  writeFileText?: WriteFileText
  readFileText?: ReadFileText
  removeDir?: RemoveDir
  runPlannerProcess?: RunPlannerProcess
}

function plannerArgs(args: {
  cwd: string
  schemaPath: string
  outputPath: string
  model?: string
}): string[] {
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
    args.cwd,
    '--output-schema',
    args.schemaPath,
    '--output-last-message',
    args.outputPath,
    ...(args.model ? ['--model', args.model] : []),
    '-'
  ]
}

function buildWslEnvPrefix(env: Readonly<Record<string, string>> | undefined): string {
  const exports = Object.entries(env ?? {}).map(
    ([key, value]) => `export ${key}=${quotePosixShell(value)}`
  )
  return exports.length > 0 ? `${exports.join('\n')}\n` : ''
}

function ensureWslAbsolutePath(path: string): string {
  const linuxPath = toLinuxPath(path)
  if (!linuxPath.startsWith('/')) {
    throw new Error(`WSL planner cwd must be absolute, received ${path}`)
  }
  return linuxPath
}

function buildWslCodexCommand(args: {
  cwd: string
  schemaPath: string
  outputPath: string
  model?: string
  env?: Readonly<Record<string, string>>
  binary?: string
}): string {
  const binary = args.binary ?? 'codex'
  const command = [
    buildWslEnvPrefix(args.env),
    `exec ${quotePosixShell(binary)} ${plannerArgs({
      cwd: args.cwd,
      schemaPath: args.schemaPath,
      outputPath: args.outputPath,
      model: args.model
    })
      .map(quotePosixShell)
      .join(' ')}`
  ].join('')
  return buildWslLoginShellCommand(command)
}

async function readPlannerOutput(
  readFileText: ReadFileText,
  outputPath: string
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    return { ok: true, text: await readFileText(outputPath, 'utf8') }
  } catch (error) {
    return {
      ok: false,
      error:
        error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
          ? 'Planner did not produce a final response.'
          : error instanceof Error
            ? error.message
            : String(error)
    }
  }
}

function failureFromProcess(
  result: ProcessResult,
  outputError: string | null = null,
  signal?: AbortSignal,
  timeoutMs: number = JAWS_PLANNER_TIMEOUT_MS
): JawsPlannerFailure {
  if (signal?.aborted) {
    return {
      success: false,
      error: 'Planner canceled.',
      exitCode: result.code,
      timedOut: result.timedOut,
      canceled: true,
      stdout: result.stdout,
      stderr: result.stderr
    }
  }
  if (result.timedOut) {
    return {
      success: false,
      error: `Planner timed out after ${timeoutMs / 1000}s.`,
      exitCode: result.code,
      timedOut: true,
      canceled: false,
      stdout: result.stdout,
      stderr: result.stderr
    }
  }
  return {
    success: false,
    error: outputError ?? `Planner failed with exit code ${result.code ?? 'unknown'}.`,
    exitCode: result.code,
    timedOut: false,
    canceled: false,
    stdout: result.stdout,
    stderr: result.stderr
  }
}

export async function runJawsPlanner(
  args: JawsPlannerRunnerArgs,
  deps: JawsPlannerRunnerDeps = {}
): Promise<JawsPlannerResult> {
  const mkdtempDir = deps.mkdtempDir ?? mkdtemp
  const writeFileText = deps.writeFileText ?? writeFile
  const readFileText = deps.readFileText ?? readFile
  const removeDir = deps.removeDir ?? rm
  const runPlannerProcess = deps.runPlannerProcess ?? runProcess
  const timeoutMs = args.timeoutMs ?? JAWS_PLANNER_TIMEOUT_MS
  const tempDir = await mkdtempDir(join(tmpdir(), 'orca-jaws-planner-'))
  const schemaPath = join(tempDir, 'output-schema.json')
  const outputPath = join(tempDir, `last-message-${randomUUID()}.json`)
  const stdoutEmitter = createPlannerOutputEmitter('stdout', args.onOutput)
  const stderrEmitter = createPlannerOutputEmitter('stderr', args.onOutput)

  try {
    await writeFileText(
      schemaPath,
      `${JSON.stringify(getJawsPlannerOutputJsonSchema(), null, 2)}\n`,
      'utf8'
    )

    const result =
      args.target.kind === 'local'
        ? await runPlannerProcess({
            program: args.target.binary ?? 'codex',
            args: plannerArgs({
              cwd: args.target.cwd,
              schemaPath,
              outputPath,
              model: args.model
            }),
            cwd: args.target.cwd,
            env: args.target.env,
            input: args.prompt,
            timeoutMs,
            signal: args.signal,
            onStdout: stdoutEmitter.push,
            onStderr: stderrEmitter.push
          })
        : await runPlannerProcess({
            program: resolveWslExecutablePath(),
            args: buildWslExecArgs(args.target.distro, [
              'sh',
              '-lc',
              buildWslCodexCommand({
                cwd: ensureWslAbsolutePath(args.target.cwd),
                schemaPath: ensureWslAbsolutePath(schemaPath),
                outputPath: ensureWslAbsolutePath(outputPath),
                model: args.model,
                env: args.target.env,
                binary: args.target.binary
              })
            ]),
            env: process.env,
            input: args.prompt,
            timeoutMs,
            signal: args.signal,
            onStdout: stdoutEmitter.push,
            onStderr: stderrEmitter.push
          })

    stdoutEmitter.flush()
    stderrEmitter.flush()

    if (result.code !== 0) {
      return failureFromProcess(result, null, args.signal, timeoutMs)
    }

    const output = await readPlannerOutput(readFileText, outputPath)
    if (!output.ok) {
      return failureFromProcess(result, output.error, args.signal, timeoutMs)
    }

    try {
      return {
        success: true,
        reply: parseJawsPlannerOutput(output.text),
        lastMessage: output.text,
        stdout: result.stdout,
        stderr: result.stderr
      }
    } catch (error) {
      return failureFromProcess(
        result,
        error instanceof Error ? error.message : String(error),
        args.signal,
        timeoutMs
      )
    }
  } finally {
    await removeDir(tempDir, { recursive: true, force: true })
  }
}
