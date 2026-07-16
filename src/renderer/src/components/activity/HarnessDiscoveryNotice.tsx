import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import type { HarnessDiscoveryStatus } from './use-harness-active-run-reconnect'

export function HarnessDiscoveryNotice({
  status,
  onRetry
}: {
  status: HarnessDiscoveryStatus
  onRetry: () => void
}): React.JSX.Element | null {
  if (status === 'checking' || status === 'retrying') {
    return (
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {status === 'checking'
          ? translate('harness.checkingExisting', 'Checking for an existing run…')
          : translate('harness.discoveryRetrying', 'Reconnecting to check for an existing run…')}
      </p>
    )
  }
  if (status === 'active-conflict') {
    return (
      <p className="text-xs text-destructive" role="alert">
        {translate(
          'harness.activeRunConflict',
          'An active orchestrator run already exists. Clear this form to open it.'
        )}
      </p>
    )
  }
  if (status === 'unsupported') {
    return (
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-destructive" role="alert">
          {translate(
            'harness.ownerUpgradeRequired',
            'Update the worktree owner runtime to use Orchestrator.'
          )}
        </p>
        <Button type="button" variant="outline" size="xs" onClick={onRetry}>
          {translate('harness.retry', 'Retry')}
        </Button>
      </div>
    )
  }
  return null
}
