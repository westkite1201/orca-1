import type { HarnessAllocationItemV1 } from '../../shared/harness-allocation-types'
import type { HarnessRun } from '../../shared/harness-types'

export type AllocationStore = {
  getHarnessRun(runId: string): HarnessRun | null
  updateHarnessAllocation?: (
    runId: string,
    patch: {
      integrationWorktreeId?: string | null
      integrationHeadSha?: string | null
      item?: Partial<Omit<HarnessAllocationItemV1, 'itemKey'>> & { itemKey: string }
    },
    options?: { durability?: 'best-effort' | 'required' }
  ) => HarnessRun
}

export function updateAllocation(
  store: AllocationStore,
  runId: string,
  patch: Parameters<NonNullable<AllocationStore['updateHarnessAllocation']>>[1],
  durability: 'best-effort' | 'required' = 'best-effort'
): HarnessRun {
  if (!store.updateHarnessAllocation) {
    throw new Error('Harness allocation persistence is unavailable.')
  }
  return store.updateHarnessAllocation(runId, patch, { durability })
}

export function allocationItem(run: HarnessRun, itemKey: string): HarnessAllocationItemV1 {
  const item = run.allocation?.items.find((entry) => entry.itemKey === itemKey)
  if (!item) {
    throw new Error(`Harness allocation item is missing: ${itemKey}`)
  }
  return item
}
