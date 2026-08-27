import type {
  LinearCreateRequest,
  LinearCreateResult,
  LinearIssueContextResult
} from '../../shared/linear/agent-access'
import type {
  LinearIssueRelationWriteRequest,
  LinearIssueRelationWriteResult
} from '../../shared/linear/issue-relation-write'
import type {
  JawsLinearIssueRef,
  JawsLinearMaterialization,
  JawsRun
} from '../../shared/jaws-types'

export type JawsLinearClient = {
  readIssue(input: string, workspaceId: string): Promise<LinearIssueContextResult>
  createIssue(input: LinearCreateRequest): Promise<LinearCreateResult>
  writeRelation(input: LinearIssueRelationWriteRequest): Promise<LinearIssueRelationWriteResult>
}

export class LinearDriftError extends Error {}

export async function readCompleteLinearIssue(
  client: JawsLinearClient,
  issue: string,
  workspaceId: string
): Promise<LinearIssueContextResult> {
  const result = await client.readIssue(issue, workspaceId)
  if (result.meta.partial) {
    throw new LinearDriftError(`Linear context for ${issue} is partial.`)
  }
  return result
}

function relationSignatures(result: LinearIssueContextResult): Set<string> {
  return new Set(
    (result.relations ?? [])
      .filter(
        (relation) =>
          relation.relatedIssue &&
          (relation.relationship === 'blocks' ||
            relation.relationship === 'blockedBy' ||
            relation.relationship === 'relatedTo' ||
            relation.relationship === 'duplicateOf')
      )
      .map(
        (relation) =>
          `${relation.relationship}:${relation.relatedIssue?.identifier.toUpperCase() ?? ''}`
      )
  )
}

function assertIssueCore(
  actual: LinearIssueContextResult,
  expected: JawsLinearIssueRef,
  label: string
): void {
  if (
    actual.issue.id !== expected.id ||
    (actual.issue.state?.id ?? null) !== expected.stateId ||
    (actual.issue.parent?.id ?? null) !== expected.parentId
  ) {
    throw new LinearDriftError(`${label} changed state or parent after approval.`)
  }
}

export function assertExistingRootSnapshot(
  actual: LinearIssueContextResult,
  expected: NonNullable<JawsRun['plan']['linear']>['rootIssue']
): void {
  if (expected.kind !== 'existing') {
    return
  }
  assertIssueCore(
    actual,
    {
      id: expected.id,
      identifier: expected.identifier,
      title: expected.title,
      url: expected.url,
      stateId: expected.stateId,
      parentId: expected.parentId
    },
    expected.identifier
  )
  const actualRelations = relationSignatures(actual)
  const expectedRelations = new Set(
    expected.relations.map(
      (relation) => `${relation.relationship}:${relation.identifier.toUpperCase()}`
    )
  )
  if (
    actualRelations.size !== expectedRelations.size ||
    Array.from(expectedRelations).some((relation) => !actualRelations.has(relation))
  ) {
    throw new LinearDriftError(`${expected.identifier} blocker relations changed after approval.`)
  }
}

function relationSets(
  run: JawsRun,
  materialization: JawsLinearMaterialization,
  issueKey: string
): { allowed: Set<string>; required: Set<string> } {
  const allowed = new Set<string>()
  const required = new Set<string>()
  for (const task of run.plan.tasks) {
    for (const dependency of task.dependsOn) {
      const effect = materialization.effects.find(
        (entry) => entry.key === `relation:${dependency}:${task.key}`
      )
      if (dependency === issueKey) {
        allowed.add(`blocks:${task.key}`)
        if (effect?.state === 'confirmed') {
          required.add(`blocks:${task.key}`)
        }
      }
      if (task.key === issueKey) {
        allowed.add(`blockedBy:${dependency}`)
        if (effect?.state === 'confirmed') {
          required.add(`blockedBy:${dependency}`)
        }
      }
    }
  }
  return { allowed, required }
}

export async function assertMaterializedLinearState(args: {
  run: JawsRun
  materialization: JawsLinearMaterialization
  client: JawsLinearClient
}): Promise<void> {
  const linear = args.run.plan.linear
  const root = args.materialization.rootIssue
  if (!linear || !root) {
    return
  }
  const rootContext = await readCompleteLinearIssue(
    args.client,
    root.identifier,
    linear.workspaceId
  )
  assertIssueCore(rootContext, root, root.identifier)
  if (linear.rootIssue.kind === 'existing') {
    assertExistingRootSnapshot(rootContext, linear.rootIssue)
  }

  const identifiersByKey = new Map(
    args.materialization.items.flatMap((item) =>
      item.issue ? [[item.key, item.issue.identifier.toUpperCase()] as const] : []
    )
  )
  // ponytail: O(n²) reads are bounded by 8 tasks; batch only if the plan limit grows.
  for (const item of args.materialization.items) {
    if (!item.issue) {
      continue
    }
    const actual = await readCompleteLinearIssue(
      args.client,
      item.issue.identifier,
      linear.workspaceId
    )
    assertIssueCore(actual, item.issue, item.issue.identifier)
    const { allowed, required } = relationSets(args.run, args.materialization, item.key)
    const actualRelations = new Set(
      (actual.relations ?? [])
        .filter(
          (relation) =>
            relation.relatedIssue &&
            (relation.relationship === 'blocks' || relation.relationship === 'blockedBy')
        )
        .map((relation) => {
          const relatedIdentifier = relation.relatedIssue?.identifier.toUpperCase()
          const relatedKey = Array.from(identifiersByKey.entries()).find(
            ([, identifier]) => identifier === relatedIdentifier
          )?.[0]
          return `${relation.relationship}:${relatedKey ?? relatedIdentifier}`
        })
    )
    if (
      Array.from(actualRelations).some((relation) => !allowed.has(relation)) ||
      Array.from(required).some((relation) => !actualRelations.has(relation))
    ) {
      throw new LinearDriftError(`${item.issue.identifier} blocker relations drifted.`)
    }
  }
}
