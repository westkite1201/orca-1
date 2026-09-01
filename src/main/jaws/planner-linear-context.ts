import type {
  LinearIssueContextResult,
  LinearIssueListResult,
  LinearIssueSummary
} from '../../shared/linear/agent-access'
import type { LinearWorkspaceSelection } from '../../shared/linear/workspace-types'

const LINEAR_IDENTIFIER_PATTERN = /\b[A-Z][A-Z0-9_]{0,19}-\d+\b/gi
const LINEAR_CONTEXT_ISSUE_LIMIT = 20
const LINEAR_CONTEXT_MAX_CHARS = 32_000
const LINEAR_CONTEXT_DESCRIPTION_LIMIT = 2_000
const LINEAR_CONTEXT_TITLE_LIMIT = 255

export type JawsPlannerLinearReader = {
  readIssue: (identifier: string) => Promise<LinearIssueContextResult>
  listIssues: (input: {
    filter: 'open'
    limit: number
    workspaceId?: LinearWorkspaceSelection
  }) => Promise<LinearIssueListResult>
}

export type JawsPlannerLinearContext = {
  text?: string
  issueCount: number
  requested: boolean
}

export function extractJawsLinearIssueIdentifiers(goal: string): string[] {
  return [
    ...new Set(
      goal.match(LINEAR_IDENTIFIER_PATTERN)?.map((identifier) => identifier.toUpperCase()) ?? []
    )
  ]
}

export function shouldLoadJawsPlannerLinearContext(goal: string): boolean {
  return extractJawsLinearIssueIdentifiers(goal).length > 0 || /(?:\blinear\b|리니어)/i.test(goal)
}

export async function loadJawsPlannerLinearContext(
  goal: string,
  reader: JawsPlannerLinearReader,
  workspaceId?: LinearWorkspaceSelection
): Promise<JawsPlannerLinearContext> {
  const identifiers = extractJawsLinearIssueIdentifiers(goal)
  if (identifiers.length > 0) {
    const results = await Promise.allSettled(
      identifiers.slice(0, 8).map((identifier) => reader.readIssue(identifier))
    )
    const contexts = results
      .filter(
        (result): result is PromiseFulfilledResult<LinearIssueContextResult> =>
          result.status === 'fulfilled'
      )
      .map((result) => formatIssueContext(result.value))
    const failedCount = results.length - contexts.length
    if (failedCount > 0) {
      contexts.push(
        `- ${failedCount} requested issue${failedCount === 1 ? '' : 's'} could not be read; do not infer their details.`
      )
    }
    return {
      ...(contexts.length > failedCount ? { text: boundContext(contexts.join('\n\n')) } : {}),
      issueCount: results.length - failedCount,
      requested: true
    }
  }

  if (!shouldLoadJawsPlannerLinearContext(goal)) {
    return { issueCount: 0, requested: false }
  }

  const result = await reader.listIssues({
    filter: 'open',
    limit: LINEAR_CONTEXT_ISSUE_LIMIT,
    ...(workspaceId ? { workspaceId } : {})
  })
  return {
    text: boundContext(formatIssueList(result)),
    issueCount: result.issues.length,
    requested: true
  }
}

function formatIssueList(result: LinearIssueListResult): string {
  const lines = [`Open Linear issues (${result.meta.returned}${result.meta.hasMore ? '+' : ''}):`]
  if (result.issues.length === 0) {
    lines.push('- No open issues were returned.')
  } else {
    lines.push(...result.issues.map((issue) => formatIssueSummary(issue)))
  }
  if (result.meta.partial) {
    lines.push('- Some workspaces could not be read; treat this list as partial.')
  }
  if (result.meta.hasMore) {
    lines.push('- The list is truncated; do not claim that unlisted issues were inspected.')
  }
  return lines.join('\n')
}

function formatIssueContext(result: LinearIssueContextResult): string {
  const issue = result.issue
  const lines = [formatIssueSummary(issue)]
  const description = cleanLinearText(issue.description, LINEAR_CONTEXT_DESCRIPTION_LIMIT)
  if (description) {
    lines.push(`  description: ${description}`)
  }
  if (issue.parent?.identifier) {
    lines.push(`  parent: ${issue.parent.identifier}`)
  }
  const relations = result.relations ?? []
  if (relations.length > 0) {
    lines.push(
      `  relations: ${relations
        .map((relation) => {
          const related = relation.relatedIssue
          return `${relation.direction} ${relation.relationship} ${related?.identifier ?? 'unknown'}`
        })
        .join(', ')}`
    )
  }
  if (result.meta.partial) {
    lines.push('  context is partial; verify missing sections before relying on them.')
  }
  return lines.join('\n')
}

function formatIssueSummary(
  issue: Pick<
    LinearIssueSummary,
    | 'identifier'
    | 'title'
    | 'url'
    | 'state'
    | 'team'
    | 'project'
    | 'assignee'
    | 'priorityLabel'
    | 'estimate'
    | 'dueDate'
  >
): string {
  const details = [
    issue.state?.name ? `state=${cleanLinearText(issue.state.name, 80)}` : null,
    issue.team?.key || issue.team?.name
      ? `team=${cleanLinearText(issue.team.key ?? issue.team.name ?? '', 80)}`
      : null,
    issue.project?.name ? `project=${cleanLinearText(issue.project.name, 120)}` : null,
    issue.assignee?.displayName
      ? `assignee=${cleanLinearText(issue.assignee.displayName, 120)}`
      : null,
    issue.priorityLabel ? `priority=${issue.priorityLabel}` : null,
    issue.estimate !== undefined && issue.estimate !== null ? `estimate=${issue.estimate}` : null,
    issue.dueDate ? `due=${cleanLinearText(issue.dueDate, 40)}` : null
  ].filter((detail): detail is string => detail !== null)
  return `- ${issue.identifier}: ${cleanLinearText(issue.title, LINEAR_CONTEXT_TITLE_LIMIT)}${details.length > 0 ? ` (${details.join('; ')})` : ''}\n  url: ${cleanLinearText(issue.url, 2_048)}`
}

function cleanLinearText(value: string | null | undefined, limit: number): string {
  const clean = removeLinearControlCharacters(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`
}

function removeLinearControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
      ? ' '
      : character
  }).join('')
}

function boundContext(value: string): string {
  const clean = value.trim()
  return clean.length <= LINEAR_CONTEXT_MAX_CHARS
    ? clean
    : `${clean.slice(0, LINEAR_CONTEXT_MAX_CHARS - 1)}…`
}
