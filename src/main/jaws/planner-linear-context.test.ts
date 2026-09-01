import { describe, expect, it, vi } from 'vitest'
import type {
  LinearIssueContextResult,
  LinearIssueListResult
} from '../../shared/linear/agent-access'
import {
  extractJawsLinearIssueIdentifiers,
  loadJawsPlannerLinearContext,
  shouldLoadJawsPlannerLinearContext
} from './planner-linear-context'

function issueList(overrides: Partial<LinearIssueListResult> = {}): LinearIssueListResult {
  return {
    issues: [
      {
        id: 'issue-1',
        identifier: 'ENG-123',
        title: 'Make planning useful',
        url: 'https://linear.app/example/issue/ENG-123',
        state: { name: 'In Progress' },
        team: { key: 'ENG', name: 'Engineering' },
        project: { name: 'Orca' },
        assignee: { displayName: 'Seoyeon' },
        priority: 1,
        priorityLabel: 'urgent',
        estimate: 3,
        dueDate: null,
        updatedAt: '2026-09-01T00:00:00.000Z',
        workspace: { id: 'workspace-1', name: 'Example' }
      }
    ],
    meta: {
      filter: 'open',
      workspaceId: 'workspace-1',
      limit: 20,
      returned: 1,
      hasMore: false,
      partial: false,
      workspaceErrors: []
    },
    ...overrides
  }
}

function issueContext(): LinearIssueContextResult {
  return {
    issue: {
      id: 'issue-1',
      identifier: 'ENG-123',
      title: 'Make planning useful',
      url: 'https://linear.app/example/issue/ENG-123',
      description: 'The planner should use the issue context.',
      state: { name: 'In Progress' },
      team: { key: 'ENG', name: 'Engineering' },
      labels: []
    },
    relations: [
      {
        id: 'relation-1',
        direction: 'outbound',
        relationship: 'blocks',
        relatedIssue: {
          id: 'issue-2',
          identifier: 'ENG-124',
          title: 'Add issue lookup',
          url: 'https://linear.app/example/issue/ENG-124'
        }
      }
    ],
    meta: {
      requested: {
        id: 'ENG-123',
        current: false,
        include: {
          comments: false,
          children: false,
          attachments: false,
          relations: true,
          activity: false
        },
        depth: 0
      },
      resolved: {
        id: 'issue-1',
        identifier: 'ENG-123',
        workspaceId: 'workspace-1',
        workspaceName: 'Example'
      },
      partial: false,
      includeErrors: [],
      sections: {}
    }
  }
}

describe('planner-linear-context', () => {
  it('extracts explicit issue identifiers and detects Linear goals', () => {
    expect(extractJawsLinearIssueIdentifiers('Plan ENG-123 and eng-123, then OPS_2-9')).toEqual([
      'ENG-123',
      'OPS_2-9'
    ])
    expect(shouldLoadJawsPlannerLinearContext('현재 Linear 이슈를 병렬로 처리')).toBe(true)
    expect(shouldLoadJawsPlannerLinearContext('Refactor the parser')).toBe(false)
  })

  it('loads exact issue context when identifiers are present', async () => {
    const readIssue = vi.fn(async () => issueContext())
    const listIssues = vi.fn(async () => issueList())
    const result = await loadJawsPlannerLinearContext(
      'Implement ENG-123',
      { readIssue, listIssues },
      'workspace-1'
    )

    expect(readIssue).toHaveBeenCalledWith('ENG-123')
    expect(listIssues).not.toHaveBeenCalled()
    expect(result).toMatchObject({ requested: true, issueCount: 1 })
    expect(result.text).toContain('ENG-124')
    expect(result.text).toContain('The planner should use the issue context.')
  })

  it('lists open issues for a broad Linear goal', async () => {
    const listIssues = vi.fn(async () => issueList())
    const result = await loadJawsPlannerLinearContext(
      'Clear all current Linear issues in parallel',
      {
        readIssue: vi.fn(),
        listIssues
      },
      'workspace-1'
    )

    expect(listIssues).toHaveBeenCalledWith({
      filter: 'open',
      limit: 20,
      workspaceId: 'workspace-1'
    })
    expect(result).toMatchObject({ requested: true, issueCount: 1 })
    expect(result.text).toContain('ENG-123: Make planning useful')
  })

  it('does not call Linear for unrelated goals', async () => {
    const readIssue = vi.fn()
    const listIssues = vi.fn()
    const result = await loadJawsPlannerLinearContext('Refactor the parser', {
      readIssue,
      listIssues
    })

    expect(result).toEqual({ issueCount: 0, requested: false })
    expect(readIssue).not.toHaveBeenCalled()
    expect(listIssues).not.toHaveBeenCalled()
  })
})
