export const HARNESS_EXECUTION_PLAN_VERSION = 1 as const
export const DEFAULT_HARNESS_MAX_CONCURRENCY = 2 as const
export const HARNESS_MAX_CONCURRENCY = 3 as const

export type HarnessExecutionKind = 'read-only' | 'worktree'
export type HarnessConcurrency = 1 | 2 | 3

export type HarnessExecutionItemV1 = {
  key: string
  title: string
  objective: string
  execution: HarnessExecutionKind
  dependencies: string[]
  fileScopes: string[]
  acceptanceCriteria: string[]
  verificationCommands: string[]
}

export type HarnessExecutionPlanV1 = {
  version: typeof HARNESS_EXECUTION_PLAN_VERSION
  revision: number
  planHash: string
  maxConcurrency: HarnessConcurrency
  items: HarnessExecutionItemV1[]
}

export type HarnessAllocationMaterializationV1 = 'planned' | 'creating' | 'created' | 'failed'

export type HarnessAllocationIntegrationV1 =
  | 'not-required'
  | 'pending'
  | 'integrating'
  | 'integrated'
  | 'conflict'
  | 'failed'

export type HarnessLaneIntegrationEvidenceV1 = {
  version: typeof HARNESS_EXECUTION_PLAN_VERSION
  workerBaseSha: string | null
  workerHeadSha: string | null
  integrationBaseSha: string
  integrationHeadSha: string
  changedFiles: string[]
  scopeDrift: string[]
  checks: { command: string; exitCode: number; durationMs: number }[]
  verifiedAt: number
}

export type HarnessAllocationItemV1 = {
  itemKey: string
  taskId: string | null
  materialization: HarnessAllocationMaterializationV1
  attempt: number
  baseSha: string | null
  worktreeId: string | null
  terminalPaneKey: string | null
  reportedCommitSha: string | null
  integration: HarnessAllocationIntegrationV1
  integratedHeadSha: string | null
  integrationEvidence: HarnessLaneIntegrationEvidenceV1 | null
  error: string | null
}

export type HarnessAllocationStateV1 = {
  version: typeof HARNESS_EXECUTION_PLAN_VERSION
  integrationWorktreeId: string | null
  integrationHeadSha: string | null
  items: HarnessAllocationItemV1[]
}

export type HarnessAllocationPatchV1 = {
  integrationWorktreeId?: string | null
  integrationHeadSha?: string | null
  item?: Partial<Omit<HarnessAllocationItemV1, 'itemKey'>> & { itemKey: string }
}

export type HarnessWorkerCommitReportV1 = {
  taskId: string
  dispatchId: string
  baseSha: string
  headSha: string
  changedFiles: string[]
  checks: { command: string; exitCode: number }[]
}

export function createHarnessAllocationState(
  plan: HarnessExecutionPlanV1
): HarnessAllocationStateV1 {
  return {
    version: HARNESS_EXECUTION_PLAN_VERSION,
    integrationWorktreeId: null,
    integrationHeadSha: null,
    items: plan.items.map((item) => ({
      itemKey: item.key,
      taskId: null,
      materialization: 'planned',
      attempt: 0,
      baseSha: null,
      worktreeId: null,
      terminalPaneKey: null,
      reportedCommitSha: null,
      integration: item.execution === 'read-only' ? 'not-required' : 'pending',
      integratedHeadSha: null,
      integrationEvidence: null,
      error: null
    }))
  }
}
