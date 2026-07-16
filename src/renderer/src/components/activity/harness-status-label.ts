import type {
  HarnessCandidateStatus,
  HarnessDiffSummary,
  HarnessRunMode,
  HarnessRunStatus
} from '../../../../shared/harness-types'
import { translate } from '@/i18n/i18n'

export function getHarnessStatusLabel(status: HarnessCandidateStatus | HarnessRunStatus): string {
  // Persisted status values stay stable; only their presentation follows the active UI language.
  const labels = {
    pending: translate('harness.status.pending', 'Pending'),
    creating: translate('harness.status.creating', 'Creating'),
    ready: translate('harness.status.ready', 'Ready'),
    running: translate('harness.status.running', 'Running'),
    worker_done: translate('harness.status.workerDone', 'Worker done'),
    verifying: translate('harness.status.verifying', 'Verifying'),
    verified: translate('harness.status.verified', 'Verified'),
    failed: translate('harness.status.failed', 'Failed'),
    preparing: translate('harness.status.preparing', 'Preparing'),
    completed: translate('harness.status.completed', 'Completed')
  } satisfies Record<HarnessCandidateStatus | HarnessRunStatus, string>
  return labels[status]
}

export function getHarnessDialogCopy(
  mode: HarnessRunMode | null,
  active: boolean
): { title: string; description: string } {
  if (!mode) {
    return {
      title: translate('harness.runComparison', 'Start orchestrator'),
      description: translate(
        'harness.description',
        'Give Jaws an issue or goal. It will plan lanes, isolate changes, integrate the result, and verify it.'
      )
    }
  }
  if (mode === 'comparison') {
    return {
      title: active
        ? translate('harness.comparisonRunTitle', 'Comparison run')
        : translate('harness.comparisonResultTitle', 'Comparison result'),
      description: translate(
        'harness.comparisonRunDescription',
        'Compare both candidates, their Git evidence, and verification.'
      )
    }
  }
  return {
    title: active
      ? translate('harness.orchestratorRunTitle', 'Orchestrator run')
      : translate('harness.orchestratorResultTitle', 'Orchestrator result'),
    description: translate(
      'harness.orchestratorRunDescription',
      'Track the coordinator, Git evidence, and verification for this run.'
    )
  }
}

export function formatHarnessDiffSummary(diff: HarnessDiffSummary): string {
  const counts = new Map<string, number>()
  for (const file of diff.changedFiles) {
    counts.set(file.status, (counts.get(file.status) ?? 0) + 1)
  }
  if (diff.untrackedPaths.length > 0) {
    counts.set('untracked', diff.untrackedPaths.length)
  }
  const total = diff.changedFiles.length + diff.untrackedPaths.length
  const details = [
    ['added', 'harness.diff.added', 'added'],
    ['modified', 'harness.diff.modified', 'modified'],
    ['deleted', 'harness.diff.deleted', 'deleted'],
    ['renamed', 'harness.diff.renamed', 'renamed'],
    ['copied', 'harness.diff.copied', 'copied'],
    ['untracked', 'harness.diff.untracked', 'untracked']
  ].flatMap(([status, key, fallback]) => {
    const count = counts.get(status)
    return count ? [translate(key, `{{count}} ${fallback}`, { count })] : []
  })
  const totalLabel =
    total === 1
      ? translate('harness.diff.oneFile', '1 file')
      : translate('harness.diff.files', '{{count}} files', { count: total })
  return [totalLabel, ...details].join(' · ')
}
