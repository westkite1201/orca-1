import type { HarnessRun } from '../../../../shared/harness-types'
import { deriveHarnessRunStatus } from '../../../../shared/harness-types'
import { translate } from '@/i18n/i18n'
import { Badge } from '@/components/ui/badge'
import { HarnessCandidateCard } from './HarnessCandidateCard'
import { getHarnessStatusLabel } from './harness-status-label'

export function HarnessRunSummary({
  run,
  pollError
}: {
  run: HarnessRun
  pollError: string | null
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{run.goal}</p>
          <p className="font-mono text-[11px] text-muted-foreground">{run.baseSha.slice(0, 12)}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {run.verificationCommand}
          </p>
        </div>
        <Badge variant="outline">{getHarnessStatusLabel(deriveHarnessRunStatus(run))}</Badge>
      </div>
      <div
        className={
          run.candidates.length > 1
            ? 'grid grid-cols-1 gap-3 sm:grid-cols-2'
            : 'grid grid-cols-1 gap-3'
        }
      >
        {run.candidates.map((candidate) => (
          <HarnessCandidateCard
            key={candidate.id}
            candidate={candidate}
            label={
              run.mode === 'orchestrator'
                ? translate('harness.coordinator', 'Codex coordinator')
                : undefined
            }
          />
        ))}
      </div>
      {run.fatalError ? (
        <p className="text-xs text-destructive" role="alert">
          {run.fatalError}
        </p>
      ) : null}
      {pollError ? (
        <p className="text-xs text-destructive" role="alert">
          {pollError}
        </p>
      ) : null}
    </div>
  )
}
