import type { HarnessCandidate } from '../../../../shared/harness-types'
import {
  harnessCandidateFailure,
  harnessCandidatePendingNotice
} from '../../../../shared/harness-candidate-notice'
import { translate } from '@/i18n/i18n'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { formatHarnessDiffSummary, getHarnessStatusLabel } from './harness-status-label'

export function HarnessCandidateCard({
  candidate,
  label
}: {
  candidate: HarnessCandidate
  label?: string
}): React.JSX.Element {
  const resultBody = candidate.workerResult?.body.trim()
  const pendingNotice = harnessCandidatePendingNotice(candidate)
  const failure = harnessCandidateFailure(candidate)
  const verificationCommandPassed =
    candidate.verification?.exitCode === 0 &&
    !candidate.verification.timedOut &&
    candidate.verification.error === null

  return (
    <Card className="min-w-0 gap-2 p-3 py-3" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium capitalize">{label ?? candidate.agent}</span>
        <Badge
          variant={
            candidate.status === 'failed'
              ? 'destructive'
              : candidate.status === 'verified'
                ? 'default'
                : 'secondary'
          }
        >
          {getHarnessStatusLabel(candidate.status)}
        </Badge>
      </div>
      <p
        className="truncate font-mono text-xs text-muted-foreground"
        title={candidate.branch ?? undefined}
      >
        {candidate.branch ?? translate('harness.branchPending', 'Branch pending')}
      </p>
      {candidate.diff ? (
        <p className="text-xs text-muted-foreground">{formatHarnessDiffSummary(candidate.diff)}</p>
      ) : null}
      {resultBody ? (
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {translate('harness.result', 'Result')}
          </p>
          <p className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 px-2 py-1.5 text-xs text-foreground/90 scrollbar-sleek">
            {resultBody}
          </p>
        </div>
      ) : null}
      {candidate.verification && ['verified', 'failed'].includes(candidate.status) ? (
        <p className="text-xs text-muted-foreground">
          {candidate.status === 'verified'
            ? translate('harness.verificationPassed', 'Verification passed · {{seconds}}s', {
                seconds: (candidate.verification.durationMs / 1000).toFixed(1)
              })
            : verificationCommandPassed
              ? translate(
                  'harness.verificationCommandPassed',
                  'Verification command passed · {{seconds}}s',
                  { seconds: (candidate.verification.durationMs / 1000).toFixed(1) }
                )
              : translate('harness.verificationFailed', 'Verification failed · {{seconds}}s', {
                  seconds: (candidate.verification.durationMs / 1000).toFixed(1)
                })}
        </p>
      ) : null}
      {pendingNotice ? (
        // Why: recovery progress rides the same field as failures; announcing it
        // as an alert told users a healthy restart had broken.
        <p className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted-foreground scrollbar-sleek">
          {pendingNotice}
        </p>
      ) : null}
      {failure ? (
        <p
          className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-xs text-destructive scrollbar-sleek"
          role="alert"
        >
          {failure}
        </p>
      ) : null}
    </Card>
  )
}
