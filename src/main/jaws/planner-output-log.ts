export type JawsPlannerOutput = {
  stream: 'stdout' | 'stderr'
  message: string
}

const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')

function stripTerminalControlCodes(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, '').trim()
}

export function summarizeJawsPlannerOutput(
  stream: JawsPlannerOutput['stream'],
  line: string
): string | null {
  const clean = stripTerminalControlCodes(line)
  if (!clean) {
    return null
  }
  if (stream === 'stderr') {
    return clean
  }
  try {
    const event = JSON.parse(clean) as {
      type?: string
      item?: {
        type?: string
        command?: string
        status?: string
        exit_code?: number | null
        text?: string
      }
      usage?: { output_tokens?: number }
    }
    if (event.type === 'thread.started') {
      return 'Codex session started.'
    }
    if (event.type === 'turn.started') {
      return 'Planning turn started.'
    }
    if (event.type === 'turn.completed') {
      const outputTokens = event.usage?.output_tokens
      return outputTokens
        ? `Planning turn completed (${outputTokens} output tokens).`
        : 'Planning turn completed.'
    }
    if (event.item?.type === 'command_execution') {
      const command = event.item.command?.trim() || 'repository inspection'
      if (event.type === 'item.started') {
        return `Inspecting: ${command}`
      }
      const status = event.item.status ?? (event.item.exit_code === 0 ? 'completed' : 'failed')
      return `Inspection ${status}: ${command}`
    }
    if (event.item?.type === 'agent_message' && event.item.text?.trim()) {
      return event.item.text.trim().startsWith('{')
        ? 'Codex is refining the plan.'
        : `Codex: ${event.item.text.trim()}`
    }
    return null
  } catch {
    return clean
  }
}

export function extractJawsPlannerLastMessage(output: string): string {
  for (const line of output.trim().split(/\r?\n/).toReversed()) {
    try {
      const event = JSON.parse(line) as {
        item?: { type?: string; text?: string }
      }
      if (event.item?.type === 'agent_message' && event.item.text?.trim()) {
        return event.item.text.trim()
      }
    } catch {}
  }
  return output.trim()
}

export type PlannerOutputEmitter = {
  push: (chunk: Buffer | string) => void
  flush: () => void
}

export function createPlannerOutputEmitter(
  stream: JawsPlannerOutput['stream'],
  onOutput: ((entry: JawsPlannerOutput) => void) | undefined
): PlannerOutputEmitter {
  let pending = ''
  const emit = (line: string): void => {
    const message = summarizeJawsPlannerOutput(stream, line)
    if (message) {
      onOutput?.({ stream, message })
    }
  }
  return {
    push: (chunk) => {
      const lines = `${pending}${String(chunk)}`.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        emit(line)
      }
    },
    flush: () => {
      if (pending) {
        emit(pending)
        pending = ''
      }
    }
  }
}
