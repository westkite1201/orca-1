import { deriveHarnessRunStatus, type HarnessRun } from '../../shared/harness-types'
import type { JawsRun, JawsRunView } from '../../shared/jaws-types'

export function createJawsRunView(run: JawsRun, harnessRun: HarnessRun | null): JawsRunView {
  const harnessStatus = harnessRun ? deriveHarnessRunStatus(harnessRun) : null
  const harnessCandidate = harnessRun?.candidates[0] ?? null
  const linearStatus = run.linearMaterialization?.status
  const reviewStatus = run.reviewPublication?.status
  const status =
    linearStatus === 'decision_required' || linearStatus === 'unknown'
      ? 'decision_required'
      : linearStatus === 'materializing' ||
          (linearStatus === 'planned' && run.approvalStartedAt !== null)
        ? 'materializing_linear'
        : harnessStatus === 'failed'
          ? 'failed'
          : reviewStatus === 'publishing'
            ? 'publishing_review'
            : reviewStatus === 'review_ready'
              ? 'review_ready'
              : harnessStatus === 'completed'
                ? 'verified'
                : harnessStatus
                  ? 'running'
                  : run.error
                    ? 'failed'
                    : run.approvalStartedAt
                      ? 'starting'
                      : 'awaiting_approval'
  return {
    ...run,
    status,
    harnessStatus,
    harnessError: harnessRun?.fatalError ?? harnessCandidate?.error ?? null,
    verification: harnessCandidate?.verification ?? null
  }
}
