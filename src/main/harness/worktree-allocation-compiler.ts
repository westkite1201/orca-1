import { normalizeHarnessExecutionPlan } from './allocation-validation'
import type {
  HarnessExecutionItemV1,
  HarnessExecutionPlanV1
} from '../../shared/harness-allocation-types'

export type HarnessAllocationConflictReason =
  | 'dependency'
  | 'global-scope'
  | 'same-scope'
  | 'ancestor-scope'

export type HarnessAllocationBasePolicy =
  | 'integration-head-snapshot'
  | 'run-base'
  | 'verified-integration-head'

export type HarnessAllocationConflict = {
  leftKey: string
  rightKey: string
  reason: HarnessAllocationConflictReason
}

export type HarnessCompiledAllocationItem = {
  itemKey: string
  basePolicy: HarnessAllocationBasePolicy
  conflictsWith: string[]
}

export type HarnessAllocationCompilation = {
  plan: HarnessExecutionPlanV1
  topologicalOrder: string[]
  conflicts: HarnessAllocationConflict[]
  items: HarnessCompiledAllocationItem[]
}

function pairKey(leftKey: string, rightKey: string): string {
  return `${leftKey}\u0000${rightKey}`
}

function scopesOverlap(
  leftScopes: readonly string[],
  rightScopes: readonly string[]
): {
  reason: HarnessAllocationConflictReason
} | null {
  if (leftScopes.length === 0 || rightScopes.length === 0) {
    return { reason: 'global-scope' }
  }
  for (const left of leftScopes) {
    if (left === '*') {
      return { reason: 'global-scope' }
    }
    for (const right of rightScopes) {
      if (right === '*') {
        return { reason: 'global-scope' }
      }
      if (left === right) {
        return { reason: 'same-scope' }
      }
      if (left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
        return { reason: 'ancestor-scope' }
      }
    }
  }
  return null
}

function topologicalOrder(items: readonly HarnessExecutionItemV1[]): string[] {
  const byKey = new Map(items.map((item) => [item.key, item]))
  const visited = new Set<string>()
  const order: string[] = []
  const visit = (item: HarnessExecutionItemV1): void => {
    if (visited.has(item.key)) {
      return
    }
    visited.add(item.key)
    for (const dependency of item.dependencies) {
      const dependencyItem = byKey.get(dependency)
      if (dependencyItem) {
        visit(dependencyItem)
      }
    }
    order.push(item.key)
  }
  for (const item of items) {
    visit(item)
  }
  return order
}

function hasMutatingDependency(
  item: HarnessExecutionItemV1,
  byKey: ReadonlyMap<string, HarnessExecutionItemV1>,
  memo: Map<string, boolean>,
  visiting: Set<string>
): boolean {
  const cached = memo.get(item.key)
  if (cached !== undefined) {
    return cached
  }
  if (visiting.has(item.key)) {
    return false
  }
  visiting.add(item.key)
  const result = item.dependencies.some((dependencyKey) => {
    const dependency = byKey.get(dependencyKey)
    return Boolean(
      dependency &&
      (dependency.execution === 'worktree' ||
        hasMutatingDependency(dependency, byKey, memo, visiting))
    )
  })
  visiting.delete(item.key)
  memo.set(item.key, result)
  return result
}

function basePolicyFor(
  item: HarnessExecutionItemV1,
  byKey: ReadonlyMap<string, HarnessExecutionItemV1>,
  memo: Map<string, boolean>
): HarnessAllocationBasePolicy {
  if (item.execution === 'read-only') {
    return 'integration-head-snapshot'
  }
  return hasMutatingDependency(item, byKey, memo, new Set())
    ? 'verified-integration-head'
    : 'run-base'
}

export function compileHarnessAllocationPlan(
  value: HarnessExecutionPlanV1
): HarnessAllocationCompilation {
  const plan = normalizeHarnessExecutionPlan(value)
  const byKey = new Map(plan.items.map((item) => [item.key, item]))
  const conflicts: HarnessAllocationConflict[] = []
  const conflictKeys = new Set<string>()
  const conflictsByItem = new Map<string, Set<string>>()
  const addConflict = (
    left: HarnessExecutionItemV1,
    right: HarnessExecutionItemV1,
    reason: HarnessAllocationConflictReason
  ): void => {
    const [first, second] =
      plan.items.indexOf(left) < plan.items.indexOf(right) ? [left, right] : [right, left]
    const key = pairKey(first.key, second.key)
    if (conflictKeys.has(key)) {
      return
    }
    conflictKeys.add(key)
    conflicts.push({ leftKey: first.key, rightKey: second.key, reason })
    const leftSet = conflictsByItem.get(first.key) ?? new Set<string>()
    const rightSet = conflictsByItem.get(second.key) ?? new Set<string>()
    leftSet.add(second.key)
    rightSet.add(first.key)
    conflictsByItem.set(first.key, leftSet)
    conflictsByItem.set(second.key, rightSet)
  }

  for (let leftIndex = 0; leftIndex < plan.items.length; leftIndex += 1) {
    const left = plan.items[leftIndex]
    if (left.execution !== 'worktree') {
      continue
    }
    for (let rightIndex = leftIndex + 1; rightIndex < plan.items.length; rightIndex += 1) {
      const right = plan.items[rightIndex]
      if (right.execution !== 'worktree') {
        continue
      }
      if (left.dependencies.includes(right.key) || right.dependencies.includes(left.key)) {
        addConflict(left, right, 'dependency')
        continue
      }
      const overlap = scopesOverlap(left.fileScopes, right.fileScopes)
      if (overlap) {
        addConflict(left, right, overlap.reason)
      }
    }
  }

  const mutationMemo = new Map<string, boolean>()
  return {
    plan,
    topologicalOrder: topologicalOrder(plan.items),
    conflicts,
    items: plan.items.map((item) => ({
      itemKey: item.key,
      basePolicy: basePolicyFor(item, byKey, mutationMemo),
      conflictsWith: [...(conflictsByItem.get(item.key) ?? [])]
    }))
  }
}
