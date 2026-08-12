import {
  HARNESS_MAX_CONCURRENCY,
  type HarnessExecutionKind
} from '../../shared/harness-allocation-types'
import type { HarnessAllocationCompilation } from './worktree-allocation-compiler'

export type HarnessLaneSchedulingInput = {
  compilation: HarnessAllocationCompilation
  readyKeys: string[]
  activeKeys: string[]
  maxConcurrent: number
}

export type HarnessLaneSchedulingResult = {
  selectedKeys: string[]
  deferredKeys: string[]
}

function executionKindFor(
  compilation: HarnessAllocationCompilation,
  itemKey: string
): HarnessExecutionKind | null {
  return compilation.plan.items.find((item) => item.key === itemKey)?.execution ?? null
}

function sortedReadyKeys(
  compilation: HarnessAllocationCompilation,
  readyKeys: readonly string[]
): string[] {
  const planOrder = new Map(compilation.plan.items.map((item, index) => [item.key, index]))
  return [...new Set(readyKeys)].sort((left, right) => {
    const orderDifference =
      (planOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (planOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
    return orderDifference !== 0 ? orderDifference : left.localeCompare(right)
  })
}

function conflictsWith(
  candidate: string,
  occupied: ReadonlySet<string>,
  compilation: HarnessAllocationCompilation
): boolean {
  const item = compilation.items.find((entry) => entry.itemKey === candidate)
  return item?.conflictsWith.some((key) => occupied.has(key)) ?? false
}

export function selectHarnessReadyLanes(
  input: HarnessLaneSchedulingInput
): HarnessLaneSchedulingResult {
  if (
    !Number.isInteger(input.maxConcurrent) ||
    input.maxConcurrent < 1 ||
    input.maxConcurrent > HARNESS_MAX_CONCURRENCY
  ) {
    throw new Error('Harness lane concurrency must be an integer from 1 to 3.')
  }
  const active = new Set(input.activeKeys)
  const ready = sortedReadyKeys(input.compilation, input.readyKeys)
  const selected: string[] = []
  const deferred: string[] = []
  const occupied = new Set(active)
  let slots = Math.max(0, input.maxConcurrent - active.size)

  for (const candidate of ready) {
    if (executionKindFor(input.compilation, candidate) === null) {
      deferred.push(candidate)
      continue
    }
    if (slots <= 0 || conflictsWith(candidate, occupied, input.compilation)) {
      deferred.push(candidate)
      continue
    }
    selected.push(candidate)
    occupied.add(candidate)
    slots -= 1
  }

  return { selectedKeys: selected, deferredKeys: deferred }
}
