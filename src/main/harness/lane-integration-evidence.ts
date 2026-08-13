import type {
  HarnessExecutionItemV1,
  HarnessLaneIntegrationEvidenceV1
} from '../../shared/harness-allocation-types'
import type { HarnessRun } from '../../shared/harness-types'
import type { TaskRow } from '../runtime/orchestration/types'
import {
  changedPaths,
  isFullOid,
  LaneVerificationError,
  MAX_VERIFIED_FILES,
  normalizedOid,
  readCleanHead,
  readVerifiedRange,
  requireMatchingRanges,
  withinScope,
  type VerifiedRange
} from './lane-git-evidence'
import { runNarrowChecks } from './lane-verification-command'
import type { HarnessRuntimeCaller } from './runtime-caller'
import {
  allocationItem,
  type AllocationStore,
  updateAllocation
} from './worktree-lane-receipt-state'

const MAX_ERROR_CHARS = 1_000
const MAX_COORDINATOR_EVIDENCE_CHARS = 4_000

type WorkerReport = {
  commitSha: string | null
  filesModified: string[]
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readWorkerReport(task: TaskRow): WorkerReport {
  let value: unknown
  try {
    value = task.result ? JSON.parse(task.result) : null
  } catch {
    throw new LaneVerificationError('Worker report is not valid JSON.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LaneVerificationError('Worker report is missing structured evidence.')
  }
  const report = value as Record<string, unknown>
  if (report.provenance !== 'worker_report' || report.outcome !== 'succeeded') {
    throw new LaneVerificationError('Worker report is not a successful lifecycle report.')
  }
  if (report.taskId !== undefined && report.taskId !== task.id) {
    throw new LaneVerificationError('Worker report names a different task.')
  }
  const commitSha =
    typeof report.commitSha === 'string' && isFullOid(report.commitSha)
      ? normalizedOid(report.commitSha)
      : null
  const filesModified = Array.isArray(report.filesModified)
    ? report.filesModified.filter((path): path is string => typeof path === 'string')
    : []
  if (filesModified.length > MAX_VERIFIED_FILES) {
    throw new LaneVerificationError('Worker report exceeds the verified file limit.')
  }
  return { commitSha, filesModified }
}

function formatEvidence(
  evidence: HarnessLaneIntegrationEvidenceV1,
  coordinatorEvidence: string
): string {
  return JSON.stringify({
    provenance: 'harness_runtime_verification',
    coordinatorEvidence: bounded(coordinatorEvidence.trim(), MAX_COORDINATOR_EVIDENCE_CHARS),
    ...evidence
  })
}

async function recoverIntegratedEvidence(args: {
  runtime: HarnessRuntimeCaller
  run: HarnessRun
  item: HarnessExecutionItemV1
}): Promise<HarnessLaneIntegrationEvidenceV1 | null> {
  const receipt = allocationItem(args.run, args.item.key)
  const evidence = receipt.integrationEvidence
  if (!evidence) {
    return null
  }
  if (
    evidence.version !== 1 ||
    evidence.integrationHeadSha !== receipt.integratedHeadSha ||
    evidence.integrationHeadSha !== args.run.allocation?.integrationHeadSha ||
    evidence.checks.length !== args.item.verificationCommands.length ||
    evidence.checks.some(
      (check, index) =>
        check.command !== args.item.verificationCommands[index] || check.exitCode !== 0
    )
  ) {
    throw new LaneVerificationError('Persisted lane integration evidence is inconsistent.')
  }
  const integrationHead = await readCleanHead({
    runtime: args.runtime,
    worktreeId: args.run.allocation!.integrationWorktreeId!,
    label: 'Integration worktree',
    integration: true
  })
  if (integrationHead !== evidence.integrationHeadSha) {
    throw new LaneVerificationError('Integration HEAD changed after verification.', 'conflict')
  }
  if (args.item.execution === 'worktree') {
    if (!receipt.worktreeId || !evidence.workerHeadSha) {
      throw new LaneVerificationError('Persisted worker integration evidence is incomplete.')
    }
    const workerHead = await readCleanHead({
      runtime: args.runtime,
      worktreeId: receipt.worktreeId,
      label: 'Worker worktree',
      integration: false
    })
    if (workerHead !== evidence.workerHeadSha) {
      throw new LaneVerificationError('Worker HEAD changed after integration verification.')
    }
  }
  return evidence
}

export async function verifyHarnessReportedLane(args: {
  runtime: HarnessRuntimeCaller
  store: AllocationStore
  run: HarnessRun
  task: TaskRow
  coordinatorEvidence: string
  timeoutSeconds: number
}): Promise<string> {
  const itemKey = args.run.allocation?.items.find((entry) => entry.taskId === args.task.id)?.itemKey
  const item = args.run.executionPlan?.items.find((entry) => entry.key === itemKey)
  if (!itemKey || !item || !args.run.allocation?.integrationWorktreeId) {
    throw new LaneVerificationError('Harness task has no complete allocation identity.')
  }
  if (args.task.status !== 'reported') {
    throw new LaneVerificationError('Only a reported Harness task can be verified.')
  }
  const recovered = await recoverIntegratedEvidence({ runtime: args.runtime, run: args.run, item })
  if (recovered) {
    return formatEvidence(recovered, args.coordinatorEvidence)
  }

  const receipt = allocationItem(args.run, itemKey)
  try {
    const report = readWorkerReport(args.task)
    const recordedIntegrationBaseSha = args.run.allocation.integrationHeadSha
    if (!receipt.baseSha || !recordedIntegrationBaseSha) {
      throw new LaneVerificationError('Harness lane is missing its recorded base SHA.')
    }
    const integrationBaseSha = normalizedOid(recordedIntegrationBaseSha)

    const integrationWorktreeId = args.run.allocation.integrationWorktreeId
    let workerRange: VerifiedRange | null = null
    let workerHeadSha: string | null = null
    if (item.execution === 'worktree') {
      if (!receipt.worktreeId || !report.commitSha) {
        throw new LaneVerificationError('Mutating worker report requires a commit SHA.')
      }
      workerHeadSha = await readCleanHead({
        runtime: args.runtime,
        worktreeId: receipt.worktreeId,
        label: 'Worker worktree',
        integration: false
      })
      if (workerHeadSha !== report.commitSha) {
        throw new LaneVerificationError('Worker report commit does not match worker HEAD.')
      }
      workerRange = await readVerifiedRange({
        runtime: args.runtime,
        worktreeId: receipt.worktreeId,
        baseSha: normalizedOid(receipt.baseSha),
        headSha: workerHeadSha,
        label: 'Worker commit range'
      })
      updateAllocation(
        args.store,
        args.run.id,
        {
          item: {
            itemKey,
            reportedCommitSha: workerHeadSha,
            integration: 'integrating',
            integrationEvidence: null,
            error: null
          }
        },
        'required'
      )
    } else if (report.commitSha || report.filesModified.length > 0) {
      throw new LaneVerificationError('Read-only worker reported repository changes.')
    }

    const integrationHeadSha = await readCleanHead({
      runtime: args.runtime,
      worktreeId: integrationWorktreeId,
      label: 'Integration worktree',
      integration: true
    })
    let paths: string[] = []
    if (workerRange) {
      if (integrationHeadSha === integrationBaseSha) {
        throw new LaneVerificationError('Worker commit is not integrated.')
      }
      const integrationRange = await readVerifiedRange({
        runtime: args.runtime,
        worktreeId: integrationWorktreeId,
        baseSha: integrationBaseSha,
        headSha: integrationHeadSha,
        label: 'Integration commit range'
      })
      await requireMatchingRanges(args.runtime, workerRange, integrationRange)
      paths = changedPaths(workerRange.entries)
    } else if (
      integrationHeadSha !== normalizedOid(receipt.baseSha) ||
      integrationHeadSha !== integrationBaseSha
    ) {
      throw new LaneVerificationError('Read-only lane changed the integration HEAD.', 'conflict')
    }

    const checks = await runNarrowChecks({
      runtime: args.runtime,
      run: args.run,
      item,
      worktreeId: integrationWorktreeId,
      timeoutSeconds: args.timeoutSeconds
    })
    if (workerRange && receipt.worktreeId) {
      const postCheckWorkerHead = await readCleanHead({
        runtime: args.runtime,
        worktreeId: receipt.worktreeId,
        label: 'Worker worktree after verification',
        integration: false
      })
      if (postCheckWorkerHead !== workerHeadSha) {
        throw new LaneVerificationError('Worker HEAD changed during lane verification.')
      }
    }
    const postCheckHead = await readCleanHead({
      runtime: args.runtime,
      worktreeId: integrationWorktreeId,
      label: 'Integration worktree after verification',
      integration: true
    })
    if (postCheckHead !== integrationHeadSha) {
      throw new LaneVerificationError('Lane verification changed the integration HEAD.', 'conflict')
    }
    const evidence: HarnessLaneIntegrationEvidenceV1 = {
      version: 1,
      workerBaseSha: workerRange?.baseSha ?? null,
      workerHeadSha,
      integrationBaseSha,
      integrationHeadSha,
      changedFiles: paths,
      scopeDrift: paths.filter((path) => !withinScope(path, item.fileScopes)),
      checks,
      verifiedAt: Date.now()
    }
    updateAllocation(
      args.store,
      args.run.id,
      {
        integrationHeadSha,
        item: {
          itemKey,
          integration: item.execution === 'worktree' ? 'integrated' : 'not-required',
          integratedHeadSha: integrationHeadSha,
          integrationEvidence: evidence,
          error: null
        }
      },
      'required'
    )
    return formatEvidence(evidence, args.coordinatorEvidence)
  } catch (error) {
    const current = args.store.getHarnessRun(args.run.id) ?? args.run
    const currentReceipt = allocationItem(current, itemKey)
    if (!currentReceipt.integrationEvidence) {
      updateAllocation(
        args.store,
        args.run.id,
        {
          item: {
            itemKey,
            integration:
              item.execution === 'worktree'
                ? error instanceof LaneVerificationError
                  ? error.integrationState
                  : 'failed'
                : 'not-required',
            error: bounded(errorMessage(error), MAX_ERROR_CHARS)
          }
        },
        'required'
      )
    }
    throw error
  }
}
