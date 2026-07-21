import { Loader2 } from 'lucide-react'

import type { HarnessRun } from '../../../../shared/harness-types'
import { canResumeHarnessCandidate } from '../../../../shared/harness-candidate-notice'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'

export function HarnessRunActions({
  run,
  runActive,
  resuming,
  cancelling,
  onResume,
  onCancel,
  onReset,
  onClose
}: {
  run: HarnessRun
  runActive: boolean
  resuming: boolean
  cancelling: boolean
  onResume: () => void
  onCancel: () => void
  onReset: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <DialogFooter>
      {runActive && run.candidates.some(canResumeHarnessCandidate) ? (
        <Button
          type="button"
          variant="outline"
          onClick={onResume}
          disabled={resuming}
          className="w-28"
        >
          {resuming ? (
            <>
              <Loader2 className="animate-spin" />
              {translate('harness.resuming', 'Resuming…')}
            </>
          ) : (
            translate('harness.resume', 'Resume')
          )}
        </Button>
      ) : null}
      {runActive ? (
        <Button type="button" variant="outline" onClick={onCancel} disabled={cancelling}>
          {cancelling ? (
            <>
              <Loader2 className="animate-spin" />
              {translate('harness.cancelling', 'Cancelling…')}
            </>
          ) : (
            translate('harness.cancelRun', 'Cancel run')
          )}
        </Button>
      ) : (
        <Button type="button" variant="outline" onClick={onReset}>
          {translate('harness.newComparison', 'New run')}
        </Button>
      )}
      <Button type="button" variant="ghost" onClick={onClose}>
        {translate('harness.close', 'Close')}
      </Button>
    </DialogFooter>
  )
}
