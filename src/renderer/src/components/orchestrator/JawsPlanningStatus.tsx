import { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'

import { normalizeJawsPlanningQuestion, type JawsPlanningRun } from '../../../../shared/jaws-types'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'

function logTone(stream: JawsPlanningRun['logs'][number]['stream']): string {
  if (stream === 'stderr') {
    return 'text-muted-foreground'
  }
  if (stream === 'system') {
    return 'text-foreground'
  }
  return 'text-muted-foreground'
}

function formatLogTime(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

export function JawsPlanningStatus({
  planning,
  onCancel,
  onRevise
}: {
  planning: JawsPlanningRun
  onCancel: () => void
  onRevise: () => void
}): React.JSX.Element {
  const entries = planning.logs ?? []
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const viewport = viewportRef.current
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }, [entries.length])

  const logs =
    entries.length > 0 ? (
      <div className="space-y-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {translate('harness.planningActivity', 'Activity')}
        </p>
        <ScrollArea
          className="h-40 rounded-md border border-border bg-muted/30"
          viewportClassName="p-2"
          viewportRef={viewportRef}
        >
          <div role="log" aria-live="polite" className="space-y-1 font-mono text-[11px]">
            {entries.map((entry, index) => (
              <p key={`${entry.at}-${index}`} className={logTone(entry.stream)}>
                <span className="mr-2 text-muted-foreground">{formatLogTime(entry.at)}</span>
                {entry.message}
              </p>
            ))}
          </div>
        </ScrollArea>
      </div>
    ) : null

  if (planning.status === 'queued' || planning.status === 'planning') {
    return (
      <div className="space-y-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {translate('harness.planning', 'Inspecting the repository and building a plan…')}
          </div>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {translate('harness.cancel', 'Cancel')}
          </Button>
        </div>
        {logs}
      </div>
    )
  }
  if (planning.status === 'needs_input') {
    return (
      <div className="space-y-2 py-2">
        <p className="text-sm font-medium">
          {normalizeJawsPlanningQuestion(planning.question ?? '')}
        </p>
        <Button variant="outline" size="sm" onClick={onRevise}>
          {translate('harness.reviseGoal', 'Revise goal')}
        </Button>
        {logs}
      </div>
    )
  }
  if (planning.status === 'canceled') {
    return (
      <div className="space-y-2 py-2">
        <p className="text-sm text-muted-foreground">
          {translate('harness.planningCanceled', 'Planning canceled.')}
        </p>
        {logs}
      </div>
    )
  }
  return (
    <div className="space-y-2 py-2">
      <p role="alert" className="text-sm text-destructive">
        {planning.error ?? translate('harness.planningFailed', 'Planning did not complete.')}
      </p>
      {logs}
    </div>
  )
}
