import type { LinearCreateResult, LinearIssueContextResult } from '../../shared/linear/agent-access'
import type {
  JawsLinearEffect,
  JawsLinearIssueRef,
  JawsLinearMaterialization,
  JawsRun
} from '../../shared/jaws-types'
import { LinearAgentAccessError } from '../linear/issue-context-errors'
import type { Store } from '../persistence'
import {
  assertExistingRootSnapshot,
  assertMaterializedLinearState,
  LinearDriftError,
  readCompleteLinearIssue,
  type JawsLinearClient
} from './linear-materialization-drift'

export type { JawsLinearClient } from './linear-materialization-drift'

export type JawsLinearStore = Pick<Store, 'updateJawsLinearMaterialization'>

type MaterializationContext = {
  run: JawsRun
  materialization: JawsLinearMaterialization
  store: JawsLinearStore
  client: JawsLinearClient
  activeEffectKey: string | null
}

const UNKNOWN_LINEAR_CODES = new Set([
  'linear_write_unconfirmed',
  'linear_network_error',
  'linear_timeout',
  'linear_rate_limited',
  'linear_auth_expired'
])

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000)
}

function persist(
  context: MaterializationContext,
  materialization: JawsLinearMaterialization
): void {
  context.run = context.store.updateJawsLinearMaterialization(context.run.id, materialization)
  context.materialization = context.run.linearMaterialization as JawsLinearMaterialization
}

function updateEffect(
  context: MaterializationContext,
  key: string,
  patch: Partial<Pick<JawsLinearEffect, 'state' | 'remoteId' | 'error'>>
): void {
  const now = Date.now()
  persist(context, {
    ...context.materialization,
    effects: context.materialization.effects.map((effect) =>
      effect.key === key ? { ...effect, ...patch, updatedAt: now } : effect
    ),
    updatedAt: now
  })
}

function startEffect(context: MaterializationContext, key: string): JawsLinearEffect {
  const effect = context.materialization.effects.find((entry) => entry.key === key)
  if (!effect) {
    throw new Error(`Missing Linear effect: ${key}`)
  }
  if (effect.state !== 'confirmed') {
    context.activeEffectKey = key
    updateEffect(context, key, { state: 'started', error: null })
  }
  return context.materialization.effects.find((entry) => entry.key === key) as JawsLinearEffect
}

function confirmEffect(context: MaterializationContext, key: string, remoteId: string): void {
  updateEffect(context, key, {
    state: 'confirmed',
    remoteId,
    error: null
  })
  context.activeEffectKey = null
}

function issueRef(result: LinearCreateResult['issue']): JawsLinearIssueRef {
  return {
    id: result.id,
    identifier: result.identifier,
    title: result.title,
    url: result.url,
    stateId: result.state?.id ?? null,
    parentId: result.parent?.id ?? null
  }
}

function contextIssueRef(result: LinearIssueContextResult): JawsLinearIssueRef {
  return {
    id: result.issue.id,
    identifier: result.issue.identifier,
    title: result.issue.title,
    url: result.issue.url,
    stateId: result.issue.state?.id ?? null,
    parentId: result.issue.parent?.id ?? null
  }
}

function childBody(run: JawsRun, key: string): string {
  const task = run.plan.tasks.find((entry) => entry.key === key)
  if (!task) {
    throw new Error(`Missing approved task: ${key}`)
  }
  return `Jaws task: ${task.key}\n\n${task.objective}\n\nDepends on: ${
    task.dependsOn.length > 0 ? task.dependsOn.join(', ') : 'none'
  }`
}

async function materializeRoot(context: MaterializationContext): Promise<void> {
  const linear = context.run.plan.linear
  if (!linear) {
    return
  }
  const effect = startEffect(context, 'root')
  if (linear.rootIssue.kind === 'existing') {
    const result = await readCompleteLinearIssue(
      context.client,
      linear.rootIssue.identifier,
      linear.workspaceId
    )
    assertExistingRootSnapshot(result, linear.rootIssue)
    const rootIssue = contextIssueRef(result)
    persist(context, { ...context.materialization, rootIssue, updatedAt: Date.now() })
    confirmEffect(context, 'root', rootIssue.id)
    return
  }
  if (effect.state === 'confirmed' && context.materialization.rootIssue) {
    return
  }
  if (!effect.writeId) {
    throw new Error('Linear root creation is missing its write id.')
  }
  const result = await context.client.createIssue({
    title: linear.rootIssue.title,
    body: linear.rootIssue.description,
    teamInput: linear.team,
    projectInput: linear.project ?? undefined,
    workspaceId: linear.workspaceId,
    writeId: effect.writeId
  })
  const rootIssue = issueRef(result.issue)
  persist(context, { ...context.materialization, rootIssue, updatedAt: Date.now() })
  confirmEffect(context, 'root', rootIssue.id)
}

async function materializeChildren(context: MaterializationContext): Promise<void> {
  const linear = context.run.plan.linear
  const root = context.materialization.rootIssue
  if (!linear || !root) {
    throw new Error('Linear root issue is not confirmed.')
  }
  for (const task of context.run.plan.tasks) {
    const effectKey = `child:${task.key}`
    const existing = context.materialization.items.find((item) => item.key === task.key)?.issue
    const effect = context.materialization.effects.find((entry) => entry.key === effectKey)
    if (effect?.state === 'confirmed' && existing) {
      continue
    }
    await assertMaterializedLinearState(context)
    const started = startEffect(context, effectKey)
    if (!started.writeId) {
      throw new Error(`Linear child ${task.key} is missing its write id.`)
    }
    const result = await context.client.createIssue({
      title: task.title,
      body: childBody(context.run, task.key),
      teamInput: linear.team,
      projectInput: linear.project ?? undefined,
      parentInput: root.identifier,
      workspaceId: linear.workspaceId,
      writeId: started.writeId
    })
    const issue = issueRef(result.issue)
    persist(context, {
      ...context.materialization,
      items: context.materialization.items.map((item) =>
        item.key === task.key ? { ...item, issue } : item
      ),
      updatedAt: Date.now()
    })
    confirmEffect(context, effectKey, issue.id)
  }
}

async function materializeRelations(context: MaterializationContext): Promise<void> {
  const linear = context.run.plan.linear
  if (!linear) {
    return
  }
  const issues = new Map(
    context.materialization.items.flatMap((item) =>
      item.issue ? [[item.key, item.issue] as const] : []
    )
  )
  for (const task of context.run.plan.tasks) {
    for (const dependency of task.dependsOn) {
      const effectKey = `relation:${dependency}:${task.key}`
      const effect = context.materialization.effects.find((entry) => entry.key === effectKey)
      if (effect?.state === 'confirmed') {
        continue
      }
      await assertMaterializedLinearState(context)
      startEffect(context, effectKey)
      const source = issues.get(dependency)
      const target = issues.get(task.key)
      if (!source || !target) {
        throw new Error(`Linear relation ${dependency} -> ${task.key} is missing an issue.`)
      }
      const result = await context.client.writeRelation({
        input: source.identifier,
        relatedInput: target.identifier,
        relationship: 'blocks',
        operation: 'add',
        workspaceId: linear.workspaceId
      })
      confirmEffect(context, effectKey, result.relation.id)
    }
  }
}

function failureStatus(error: unknown): 'decision_required' | 'unknown' | 'failed' {
  if (error instanceof LinearDriftError) {
    return 'decision_required'
  }
  if (error instanceof LinearAgentAccessError && UNKNOWN_LINEAR_CODES.has(error.code)) {
    return 'unknown'
  }
  return 'failed'
}

export async function materializeJawsLinearRun(args: {
  run: JawsRun
  store: JawsLinearStore
  client: JawsLinearClient
}): Promise<JawsRun> {
  if (!args.run.plan.linear) {
    return args.run
  }
  if (!args.run.linearMaterialization) {
    throw new Error('Jaws Linear materialization is missing.')
  }
  const context: MaterializationContext = {
    ...args,
    materialization: args.run.linearMaterialization,
    activeEffectKey: null
  }
  persist(context, {
    ...context.materialization,
    status: 'materializing',
    error: null,
    updatedAt: Date.now()
  })
  try {
    await materializeRoot(context)
    await materializeChildren(context)
    await materializeRelations(context)
    await assertMaterializedLinearState(context)
    persist(context, {
      ...context.materialization,
      status: 'confirmed',
      error: null,
      updatedAt: Date.now()
    })
    return context.run
  } catch (error) {
    const state = failureStatus(error)
    if (context.activeEffectKey) {
      updateEffect(context, context.activeEffectKey, {
        state: state === 'unknown' ? 'unknown' : 'failed',
        error: errorMessage(error)
      })
    }
    persist(context, {
      ...context.materialization,
      status: state,
      error: errorMessage(error),
      updatedAt: Date.now()
    })
    throw error
  }
}
