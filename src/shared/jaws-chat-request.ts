import type { SlashCommandSuggestion } from './native-chat-slash-commands'
import { isTextBlock, type NativeChatMessage } from './native-chat-types'
import type { AgentType } from './agent-status-types'
import { getVerifiedNativeChatCommands } from './native-chat-agent-profiles'

const REQUEST_PREFIX = 'JAWS_PLAN_REQUEST_V1 '

export const JAWS_CHAT_SLASH_COMMAND: SlashCommandSuggestion = {
  name: 'jaws',
  description: 'Plan work across isolated worktrees',
  acceptsArguments: true
}

export type JawsChatRequest = {
  goal: string
  worktreeSelector: string
}

export function parseJawsChatCommand(text: string): { goal: string } | null {
  const match = /^\/jaws(?:\s+([\s\S]*))?$/u.exec(text.trim())
  return match ? { goal: match[1]?.trim() ?? '' } : null
}

export function jawsChatCommands(
  agent: AgentType,
  enabled: boolean
): readonly SlashCommandSuggestion[] {
  const commands = getVerifiedNativeChatCommands(agent)
  return enabled
    ? [JAWS_CHAT_SLASH_COMMAND, ...commands.filter((command) => command.name !== 'jaws')]
    : commands
}

export function buildJawsChatRequestPrompt(goal: string, worktreeId: string): string {
  const request: JawsChatRequest = { goal, worktreeSelector: `id:${worktreeId}` }
  return `${REQUEST_PREFIX}${JSON.stringify(request)}
Prepare a Jaws multi-worktree plan for the user goal in the request header. Do not implement it yet.

1. Read the repository instructions and inspect the relevant code before planning. If the goal is empty or a product choice materially changes the plan, ask one concise question and wait.
2. Build a valid plan with goal, verificationCommand, maxConcurrency (1-3), and 1-8 dependency-aware tasks containing key, title, objective, and dependsOn. Include Linear or draft-review settings only when you can resolve their exact identifiers and capabilities.
3. Resolve the Orca CLI for this host, check the installed \`jaws plan propose --help\`, then submit the JSON with \`jaws plan propose\` for the exact worktreeSelector above. Use stdin or a temporary file outside the repository.
4. Do not approve the plan, start Harness, create worktrees, write to Linear, push, or create a review. Those effects require the user's trusted approval in Jaws.

After submission, tell the user the plan card is ready for review.`
}

export function expandJawsChatCommand(text: string, worktreeId?: string): string {
  const request = worktreeId ? parseJawsChatCommand(text) : null
  return request && worktreeId ? buildJawsChatRequestPrompt(request.goal, worktreeId) : text
}

export function parseJawsChatRequestPrompt(text: string): JawsChatRequest | null {
  if (!text.startsWith(REQUEST_PREFIX)) {
    return null
  }
  const headerEnd = text.indexOf('\n')
  const header = text.slice(REQUEST_PREFIX.length, headerEnd === -1 ? undefined : headerEnd)
  if (header.length > 32_768) {
    return null
  }
  try {
    const request = JSON.parse(header) as Partial<JawsChatRequest>
    return typeof request.goal === 'string' && typeof request.worktreeSelector === 'string'
      ? { goal: request.goal, worktreeSelector: request.worktreeSelector }
      : null
  } catch {
    return null
  }
}

/** Keep the planner instructions agent-visible while rendering the user's short command. */
export function surfaceJawsChatRequestUserTurns(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  let changed = false
  const surfaced = messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    const request = parseJawsChatRequestPrompt(
      message.blocks
        .filter(isTextBlock)
        .map((block) => block.text)
        .join('\n')
    )
    if (!request) {
      return message
    }
    changed = true
    return {
      ...message,
      blocks: [
        { type: 'text' as const, text: request.goal ? `/jaws ${request.goal}` : '/jaws' },
        ...message.blocks.filter((block) => !isTextBlock(block))
      ]
    }
  })
  return changed ? surfaced : (messages as NativeChatMessage[])
}
