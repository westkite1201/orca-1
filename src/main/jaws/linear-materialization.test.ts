import { describe, expect, it } from 'vitest'
import type {
  LinearCreateRequest,
  LinearCreateResult,
  LinearIssueContextResult
} from '../../shared/linear/agent-access'
import type {
  LinearIssueRelationWriteRequest,
  LinearIssueRelationWriteResult
} from '../../shared/linear/issue-relation-write'
import { isConfirmedJawsLinearMaterialization, type JawsRun } from '../../shared/jaws-types'
import { LinearAgentAccessError } from '../linear/issue-context-errors'
import {
  materializeJawsLinearRun,
  type JawsLinearClient,
  type JawsLinearStore
} from './linear-materialization'

const WORKSPACE_ID = 'workspace-1'
const ROOT_ID = '11111111-1111-4111-8111-111111111111'

function linearIssue(
  identifier: string,
  title: string,
  id: string,
  parent: LinearCreateResult['issue']['parent'] = null
): LinearCreateResult['issue'] {
  return {
    id,
    identifier,
    title,
    url: `https://linear.app/westkitedev/issue/${identifier}`,
    team: { id: 'team-1', key: 'WES', name: 'Westkitedev' },
    state: { id: 'state-todo', name: 'Todo' },
    parent
  }
}

function jawsRun(): JawsRun {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    repoId: 'repo-1',
    sourceWorktreeId: 'worktree-1',
    sourceWorktreePath: '/repo',
    baseSha: 'b'.repeat(40),
    revision: 1,
    planHash: 'c'.repeat(64),
    plan: {
      goal: 'Build the feature',
      verificationCommand: 'pnpm test',
      maxConcurrency: 2,
      tasks: [
        { key: 'API', title: 'Build API', objective: 'Implement API', dependsOn: [] },
        { key: 'UI', title: 'Build UI', objective: 'Implement UI', dependsOn: ['API'] }
      ],
      linear: {
        workspaceId: WORKSPACE_ID,
        team: 'WES',
        project: null,
        rootIssue: {
          kind: 'existing',
          id: ROOT_ID,
          identifier: 'WES-1',
          title: 'Root',
          url: 'https://linear.app/westkitedev/issue/WES-1',
          stateId: 'state-todo',
          parentId: null,
          relations: []
        }
      }
    },
    linearMaterialization: {
      status: 'planned',
      rootIssue: null,
      items: [
        { key: 'API', issue: null },
        { key: 'UI', issue: null }
      ],
      effects: [
        {
          key: 'root',
          kind: 'root_read',
          writeId: null,
          state: 'planned',
          remoteId: null,
          error: null,
          updatedAt: 1
        },
        {
          key: 'child:API',
          kind: 'child_create',
          writeId: '22222222-2222-4222-8222-222222222222',
          state: 'planned',
          remoteId: null,
          error: null,
          updatedAt: 1
        },
        {
          key: 'child:UI',
          kind: 'child_create',
          writeId: '33333333-3333-4333-8333-333333333333',
          state: 'planned',
          remoteId: null,
          error: null,
          updatedAt: 1
        },
        {
          key: 'relation:API:UI',
          kind: 'relation',
          writeId: null,
          state: 'planned',
          remoteId: null,
          error: null,
          updatedAt: 1
        }
      ],
      error: null,
      updatedAt: 1
    },
    approvalStartedAt: 2,
    harnessRunId: null,
    error: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function linearFixture() {
  let run = jawsRun()
  const root = linearIssue('WES-1', 'Root', ROOT_ID)
  const issues = new Map([[root.identifier, root]])
  const createdByWriteId = new Map<string, LinearCreateResult['issue']>()
  const createWriteIds: string[] = []
  const edges = new Set<string>()
  let loseFirstApiResponse = true

  const store: JawsLinearStore = {
    updateJawsLinearMaterialization: (_runId, materialization) => {
      run = { ...run, linearMaterialization: structuredClone(materialization) }
      return run
    }
  }
  const readIssue = async (input: string): Promise<LinearIssueContextResult> => {
    const issue = issues.get(input)
    if (!issue) {
      throw new Error(`Missing issue: ${input}`)
    }
    const relations: NonNullable<LinearIssueContextResult['relations']> = []
    for (const edge of edges) {
      const [source, target] = edge.split('>')
      if (source === input) {
        const relatedIssue = issues.get(target)
        if (relatedIssue) {
          relations.push({
            id: `relation-${source}-${target}`,
            direction: 'outbound',
            relationship: 'blocks',
            relatedIssue
          })
        }
      }
      if (target === input) {
        const relatedIssue = issues.get(source)
        if (relatedIssue) {
          relations.push({
            id: `relation-${source}-${target}`,
            direction: 'inbound',
            relationship: 'blockedBy',
            relatedIssue
          })
        }
      }
    }
    return {
      issue: { ...issue, labels: [] },
      relations,
      meta: {
        requested: {
          id: input,
          current: false,
          workspaceId: WORKSPACE_ID,
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
          id: issue.id,
          identifier: issue.identifier,
          workspaceId: WORKSPACE_ID,
          workspaceName: 'Westkitedev'
        },
        partial: false,
        includeErrors: [],
        sections: {}
      }
    }
  }
  const createIssue = async (input: LinearCreateRequest): Promise<LinearCreateResult> => {
    const writeId = input.writeId as string
    createWriteIds.push(writeId)
    const existing = createdByWriteId.get(writeId)
    if (existing) {
      return { issue: existing, meta: { workspaceId: WORKSPACE_ID, writeId, deduplicated: true } }
    }
    const number = issues.size + 1
    const issue = linearIssue(
      `WES-${number}`,
      input.title,
      number === 2
        ? '44444444-4444-4444-8444-444444444444'
        : '55555555-5555-4555-8555-555555555555',
      { id: root.id, identifier: root.identifier }
    )
    issues.set(issue.identifier, issue)
    createdByWriteId.set(writeId, issue)
    if (input.title === 'Build API' && loseFirstApiResponse) {
      loseFirstApiResponse = false
      throw new LinearAgentAccessError(
        'linear_write_unconfirmed',
        'The response was lost after creation.'
      )
    }
    return { issue, meta: { workspaceId: WORKSPACE_ID, writeId, deduplicated: false } }
  }
  const writeRelation = async (
    input: LinearIssueRelationWriteRequest
  ): Promise<LinearIssueRelationWriteResult> => {
    const source = issues.get(input.input as string) as LinearCreateResult['issue']
    const target = issues.get(input.relatedInput) as LinearCreateResult['issue']
    const edge = `${source.identifier}>${target.identifier}`
    const alreadySet = edges.has(edge)
    edges.add(edge)
    return {
      issue: source,
      relatedIssue: target,
      relation: {
        id: `relation-${source.identifier}-${target.identifier}`,
        direction: 'outbound',
        relationship: 'blocks',
        relatedIssue: target
      },
      operation: 'add',
      meta: { workspaceId: WORKSPACE_ID, alreadySet }
    }
  }
  const client: JawsLinearClient = { readIssue, createIssue, writeRelation }
  return {
    client,
    store,
    getRun: () => run,
    createWriteIds,
    issues,
    edges
  }
}

describe('Jaws Linear materialization', () => {
  it('recovers a lost create response without duplicating children', async () => {
    const fixture = linearFixture()

    await expect(
      materializeJawsLinearRun({
        run: fixture.getRun(),
        store: fixture.store,
        client: fixture.client
      })
    ).rejects.toMatchObject({ code: 'linear_write_unconfirmed' })
    expect(fixture.getRun().linearMaterialization?.status).toBe('unknown')

    const completed = await materializeJawsLinearRun({
      run: fixture.getRun(),
      store: fixture.store,
      client: fixture.client
    })

    expect(completed.linearMaterialization?.status).toBe('confirmed')
    expect(completed.linearMaterialization?.items.map((item) => item.issue?.identifier)).toEqual([
      'WES-2',
      'WES-3'
    ])
    expect(fixture.createWriteIds.slice(0, 2)).toEqual([
      '22222222-2222-4222-8222-222222222222',
      '22222222-2222-4222-8222-222222222222'
    ])
    expect(fixture.issues.size).toBe(3)
    expect(fixture.edges).toEqual(new Set(['WES-2>WES-3']))
    expect(
      isConfirmedJawsLinearMaterialization(
        completed.plan,
        completed.linearMaterialization as NonNullable<JawsRun['linearMaterialization']>
      )
    ).toBe(true)
  })

  it('requires a decision when confirmed Linear state drifts before Harness starts', async () => {
    const fixture = linearFixture()
    await expect(
      materializeJawsLinearRun({
        run: fixture.getRun(),
        store: fixture.store,
        client: fixture.client
      })
    ).rejects.toBeInstanceOf(LinearAgentAccessError)
    const confirmed = await materializeJawsLinearRun({
      run: fixture.getRun(),
      store: fixture.store,
      client: fixture.client
    })
    const ui = fixture.issues.get('WES-3')
    if (!ui) {
      throw new Error('Missing UI issue.')
    }
    fixture.issues.set('WES-3', {
      ...ui,
      state: { id: 'state-progress', name: 'In Progress' }
    })

    await expect(
      materializeJawsLinearRun({
        run: confirmed,
        store: fixture.store,
        client: fixture.client
      })
    ).rejects.toThrow('changed state or parent')
    expect(fixture.getRun().linearMaterialization?.status).toBe('decision_required')
    expect(fixture.issues.size).toBe(3)
  })
})
