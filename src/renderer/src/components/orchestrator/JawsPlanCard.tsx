import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { JawsRunView } from '../../../../shared/jaws-types'
import { translate } from '@/i18n/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

type JawsPlanCardProps = {
  run: JawsRunView
  error?: string | null
  approving?: boolean
  retryingReview?: boolean
  onApprove?: (() => void) | null
  onRetryReview?: (() => void) | null
  onOpenUrl?: ((url: string) => void) | null
}

function statusLabel(status: JawsRunView['status']): string {
  switch (status) {
    case 'awaiting_approval':
      return translate('auto.components.nativeChat.jaws.approvalNeeded', 'Approval needed')
    case 'materializing_linear':
      return translate(
        'auto.components.nativeChat.jaws.materializingLinear',
        'Creating Linear issues'
      )
    case 'decision_required':
      return translate('auto.components.nativeChat.jaws.decisionRequired', 'Review required')
    case 'starting':
      return translate('auto.components.nativeChat.jaws.starting', 'Starting')
    case 'running':
      return translate('auto.components.nativeChat.jaws.running', 'Running')
    case 'publishing_review':
      return translate('auto.components.nativeChat.jaws.publishingReview', 'Publishing review')
    case 'review_ready':
      return translate('auto.components.nativeChat.jaws.reviewReady', 'Review ready')
    case 'verified':
      return translate('auto.components.nativeChat.jaws.verified', 'Verified')
    case 'failed':
      return translate('auto.components.nativeChat.jaws.failed', 'Failed')
  }
}

function renderOpenableIdentifier(
  label: string,
  url: string | null | undefined,
  onOpenUrl?: ((url: string) => void) | null
): React.JSX.Element {
  if (!url || !onOpenUrl) {
    return <span className="font-medium text-foreground">{label}</span>
  }
  return (
    <Button variant="link" className="h-auto p-0 text-xs" onClick={() => onOpenUrl(url)}>
      {label}
    </Button>
  )
}

export function JawsPlanCard({
  run,
  error = null,
  approving = false,
  retryingReview = false,
  onApprove = null,
  onRetryReview = null,
  onOpenUrl = null
}: JawsPlanCardProps): React.JSX.Element {
  useTranslation()
  const canApprove =
    Boolean(onApprove) &&
    (run.status === 'awaiting_approval' ||
      (run.status === 'decision_required' && run.harnessRunId === null) ||
      ((run.status === 'starting' || run.status === 'failed') && run.harnessRunId === null))
  const canRetryReview =
    !canApprove &&
    Boolean(onRetryReview) &&
    run.status !== 'decision_required' &&
    (run.reviewPublication?.status === 'failed' || run.reviewPublication?.status === 'unknown')

  return (
    <Card className="gap-3 rounded-lg border-input py-3 shadow-xs">
      <CardHeader className="gap-1 px-4">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-sm">
            {translate('auto.components.nativeChat.jaws.title', 'Jaws multi-worktree plan')}
          </CardTitle>
          <Badge variant={run.status === 'failed' ? 'destructive' : 'outline'}>
            {statusLabel(run.status)}
          </Badge>
        </div>
        <p className="whitespace-pre-wrap text-sm text-foreground">{run.plan.goal}</p>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.nativeChat.jaws.worktreeSummary',
            '1 integration + {{tasks}} worker worktrees · coordinator target: at most {{concurrency}} active',
            {
              tasks: run.plan.tasks.filter((task) => task.execution !== 'read-only').length,
              concurrency: run.plan.maxConcurrency
            }
          )}
        </p>
        {run.plan.review ? (
          <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs">
            <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
              {translate('auto.components.nativeChat.jaws.draftReview', 'Draft review')}
            </p>
            <p className="mt-1 text-foreground">
              {run.plan.review.provider ??
                translate('auto.components.nativeChat.jaws.manualProvider', 'Manual')}{' '}
              · {run.plan.review.baseBranch}
            </p>
          </div>
        ) : null}
        {run.plan.linear ? (
          <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs">
            <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
              {translate('auto.components.nativeChat.jaws.linearIssues', 'Linear issues')}
            </p>
            <p className="mt-1 text-muted-foreground">
              {translate('auto.components.nativeChat.jaws.linearTarget', 'Team {{team}}', {
                team: run.plan.linear.team
              })}
              {run.plan.linear.project
                ? ` · ${translate(
                    'auto.components.nativeChat.jaws.linearProject',
                    'Project {{project}}',
                    {
                      project: run.plan.linear.project
                    }
                  )}`
                : ''}
            </p>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-muted-foreground">
                {translate('auto.components.nativeChat.jaws.linearRoot', 'Root')}
              </span>
              {run.linearMaterialization?.rootIssue
                ? renderOpenableIdentifier(
                    run.linearMaterialization.rootIssue.identifier,
                    run.linearMaterialization.rootIssue.url,
                    onOpenUrl
                  )
                : renderOpenableIdentifier(
                    run.plan.linear.rootIssue.kind === 'existing'
                      ? run.plan.linear.rootIssue.identifier
                      : run.plan.linear.rootIssue.title,
                    run.plan.linear.rootIssue.kind === 'existing'
                      ? run.plan.linear.rootIssue.url
                      : null,
                    onOpenUrl
                  )}
            </div>
            {run.plan.linear.rootIssue.kind === 'create' ? (
              <p className="mt-1 whitespace-pre-wrap text-foreground">
                {run.plan.linear.rootIssue.description}
              </p>
            ) : null}
            <ul className="mt-1 space-y-1">
              {run.plan.tasks.map((task) => {
                const issue = run.linearMaterialization?.items.find(
                  (item) => item.key === task.key
                )?.issue
                return (
                  <li key={task.key} className="flex items-center gap-2">
                    <span className="font-mono text-muted-foreground">{task.key}</span>
                    {issue ? (
                      renderOpenableIdentifier(issue.identifier, issue.url, onOpenUrl)
                    ) : (
                      <span className="text-muted-foreground">
                        {translate('auto.components.nativeChat.jaws.pending', 'Pending')}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-2 px-4">
        <p className="text-xs font-medium text-foreground">
          {translate(
            'auto.components.nativeChat.jaws.reviewTasks',
            'Review {{count}} approved tasks',
            {
              count: run.plan.tasks.length
            }
          )}
        </p>
        <ol className="space-y-2 pl-4 text-xs">
          {run.plan.tasks.map((task) => (
            <li key={task.key}>
              <span className="whitespace-pre-wrap font-medium text-foreground">
                {task.key}: {task.title}
              </span>
              <p className="whitespace-pre-wrap text-muted-foreground">{task.objective}</p>
              <p className="font-mono text-[11px] text-muted-foreground">
                {task.execution ?? 'worktree'} ·{' '}
                {task.fileScopes?.length ? task.fileScopes.join(', ') : 'global/unknown scope'}
              </p>
              {task.dependsOn.length > 0 ? (
                <p className="text-muted-foreground">
                  {translate(
                    'auto.components.nativeChat.jaws.dependsOn',
                    'Depends on {{dependencies}}',
                    {
                      dependencies: task.dependsOn.join(', ')
                    }
                  )}
                </p>
              ) : null}
              {task.acceptanceCriteria?.length ? (
                <ul className="list-disc pl-4 text-muted-foreground">
                  {[...new Set(task.acceptanceCriteria)].map((criterion) => (
                    <li key={criterion}>{criterion}</li>
                  ))}
                </ul>
              ) : null}
              {task.verificationCommands?.length ? (
                <p className="break-all font-mono text-[11px] text-muted-foreground">
                  {task.verificationCommands.join(' && ')}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
        <div className="rounded-md border border-border bg-muted px-3 py-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {translate('auto.components.nativeChat.jaws.finalVerification', 'Final verification')}
          </p>
          <pre
            dir="ltr"
            className="whitespace-pre-wrap break-all font-mono text-xs text-foreground"
          >
            <code>{run.plan.verificationCommand}</code>
          </pre>
          {run.verification ? (
            <>
              <p className="mt-1 text-xs text-muted-foreground">
                {translate(
                  'auto.components.nativeChat.jaws.verificationEvidence',
                  'Exit {{exitCode}} · {{duration}} ms',
                  {
                    exitCode: run.verification.exitCode ?? '—',
                    duration: run.verification.durationMs
                  }
                )}
                {run.verification.timedOut
                  ? ` · ${translate('auto.components.nativeChat.jaws.timedOut', 'Timed out')}`
                  : ''}
              </p>
              {run.verification.outputTail ? (
                <pre
                  dir="ltr"
                  className="scrollbar-sleek mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground"
                >
                  <code>{run.verification.outputTail}</code>
                </pre>
              ) : null}
            </>
          ) : null}
        </div>
        {run.reviewPublication?.review || run.reviewPublication?.manualUrl ? (
          <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs">
            <p className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
              {run.reviewPublication.review
                ? translate('auto.components.nativeChat.jaws.reviewResult', 'Draft review')
                : translate(
                    'auto.components.nativeChat.jaws.manualReview',
                    'Manual review required'
                  )}
            </p>
            {renderOpenableIdentifier(
              run.reviewPublication.review
                ? `#${run.reviewPublication.review.number} · ${run.reviewPublication.review.headBranch} → ${run.reviewPublication.review.baseBranch}`
                : translate(
                    'auto.components.nativeChat.jaws.openVerifiedCommit',
                    'Open verified commit'
                  ),
              run.reviewPublication.review?.url ?? run.reviewPublication.manualUrl ?? null,
              onOpenUrl
            )}
          </div>
        ) : null}
        {run.error || run.harnessError || run.reviewPublication?.error || error ? (
          <p role="alert" className="text-xs text-destructive">
            {error ?? run.error ?? run.harnessError ?? run.reviewPublication?.error}
          </p>
        ) : null}
      </CardContent>
      {canApprove || canRetryReview ? (
        <div className="flex items-center px-4">
          {canApprove ? (
            <Button size="sm" disabled={approving} onClick={onApprove ?? undefined}>
              {approving ? <Loader2 className="animate-spin" /> : null}
              {run.approvalStartedAt
                ? translate('auto.components.nativeChat.jaws.retry', 'Retry approved plan')
                : translate('auto.components.nativeChat.jaws.approve', 'Approve plan and run')}
            </Button>
          ) : (
            <Button size="sm" disabled={retryingReview} onClick={onRetryReview ?? undefined}>
              {retryingReview ? <Loader2 className="animate-spin" /> : null}
              {translate('auto.components.nativeChat.jaws.retryReview', 'Retry review publication')}
            </Button>
          )}
        </div>
      ) : null}
    </Card>
  )
}
