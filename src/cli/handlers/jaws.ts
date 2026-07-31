import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { JawsPlan, JawsRunView } from '../../shared/jaws-types'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { getOptionalWorktreeSelector, getRequiredWorktreeSelector } from '../selectors'
import { RuntimeClientError } from '../runtime-client'

const MAX_PLAN_BYTES = 256 * 1024

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new RuntimeClientError('invalid_argument', 'stdin plan requested but stdin is a TTY')
  }
  let value = ''
  for await (const chunk of process.stdin) {
    value += String(chunk)
    if (Buffer.byteLength(value) > MAX_PLAN_BYTES) {
      throw new RuntimeClientError('invalid_argument', 'Jaws plan exceeds 256 KiB')
    }
  }
  return value
}

async function readPlan(path: string, cwd: string): Promise<JawsPlan> {
  const text =
    path === '-'
      ? await readStdin()
      : await readFile(isAbsolute(path) ? path : join(cwd, path), 'utf8')
  if (Buffer.byteLength(text) > MAX_PLAN_BYTES) {
    throw new RuntimeClientError('invalid_argument', 'Jaws plan exceeds 256 KiB')
  }
  try {
    return JSON.parse(text) as JawsPlan
  } catch {
    throw new RuntimeClientError('invalid_argument', 'Jaws plan file must contain valid JSON')
  }
}

function formatRun({ run }: { run: JawsRunView }): string {
  return `${run.status}: ${run.plan.goal} (${run.id}, revision ${run.revision})`
}

export const JAWS_HANDLERS: Record<string, CommandHandler> = {
  'jaws plan propose': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{ run: JawsRunView }>('jaws.planPropose', {
      worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client),
      plan: await readPlan(getRequiredStringFlag(flags, 'plan-file'), cwd)
    })
    printResult(result, json, formatRun)
  },
  'jaws run list': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{ runs: JawsRunView[] }>('jaws.runList', {
      repo: getOptionalStringFlag(flags, 'repo'),
      worktree: await getOptionalWorktreeSelector(flags, 'worktree', cwd, client)
    })
    printResult(result, json, ({ runs }) =>
      runs.length === 0 ? 'No Jaws runs.' : runs.map((run) => formatRun({ run })).join('\n')
    )
  },
  'jaws run show': async ({ flags, client, json }) => {
    const result = await client.call<{ run: JawsRunView }>('jaws.runShow', {
      run: getRequiredStringFlag(flags, 'id')
    })
    printResult(result, json, formatRun)
  }
}
