import { useEffect, useMemo, useRef, useState } from 'react'

import type { HarnessRun } from '../../../../shared/harness-types'
import type { JawsPlanningRun, JawsRunView } from '../../../../shared/jaws-types'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useActiveWorktreeId, useAllWorktrees, useRepos } from '@/store/selectors'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { JawsPlanCard } from '@/components/orchestrator/JawsPlanCard'
import { JawsPlanInputForm } from '@/components/orchestrator/JawsPlanInputForm'
import { JawsPlanningStatus } from '@/components/orchestrator/JawsPlanningStatus'
import { assertJawsTargetSupported } from '@/components/orchestrator/jaws-runtime-capability'
import { refreshJawsRun } from '@/components/orchestrator/jaws-run-refresh'
import { buildJawsWorktreeOptions } from '@/components/orchestrator/jaws-worktree-options'
import { HarnessRunSummary } from './HarnessRunSummary'
import { getHarnessRuntimeTarget } from './use-harness-active-run-reconnect'

const POLL_INTERVAL_MS = 1_500

type HarnessRunDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function isPlanningActive(run: JawsPlanningRun): boolean {
  return run.status === 'queued' || run.status === 'planning'
}

function isPlanningCancelable(run: JawsPlanningRun): boolean {
  return isPlanningActive(run) || run.status === 'needs_input'
}

function isRunActive(run: JawsRunView): boolean {
  return ['materializing_linear', 'starting', 'running', 'publishing_review'].includes(run.status)
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

export function HarnessRunDialog({ open, onOpenChange }: HarnessRunDialogProps): React.JSX.Element {
  const repos = useRepos()
  const worktrees = useAllWorktrees()
  const activeWorktreeId = useActiveWorktreeId()
  const options = useMemo(
    () => buildJawsWorktreeOptions(repos, worktrees, activeWorktreeId),
    [activeWorktreeId, repos, worktrees]
  )
  const defaultWorktreeId = options[0]?.id ?? ''
  const [selectedWorktreeId, setSelectedWorktreeId] = useState(defaultWorktreeId)
  const [goal, setGoal] = useState('')
  const [planning, setPlanning] = useState<JawsPlanningRun | null>(null)
  const [run, setRun] = useState<JawsRunView | null>(null)
  const [harnessRun, setHarnessRun] = useState<HarnessRun | null>(null)
  const [target, setTarget] = useState<RuntimeClientTarget | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [approving, setApproving] = useState(false)
  const [retryingReview, setRetryingReview] = useState(false)
  const [restoreLatestRun, setRestoreLatestRun] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const resolvedWorktreeId = options.some((option) => option.id === selectedWorktreeId)
    ? selectedWorktreeId
    : defaultWorktreeId
  const selectedOption = options.find((option) => option.id === resolvedWorktreeId)
  const runId = run?.id ?? null
  const harnessRunId = run?.harnessRunId ?? null
  const runNeedsPolling = run ? isRunActive(run) || harnessRunId !== null : false

  useEffect(() => {
    if (!open || !restoreLatestRun || !selectedOption || planning || run || goal) {
      return
    }
    let canceled = false
    const discover = async (): Promise<void> => {
      const nextTarget = getHarnessRuntimeTarget(selectedOption.id)
      try {
        await assertJawsTargetSupported(nextTarget)
        const [planningResult, runResult] = await Promise.all([
          callRuntimeRpc<{ planning: JawsPlanningRun[] }>(nextTarget, 'jaws.planningList', {
            worktree: `id:${selectedOption.id}`
          }),
          callRuntimeRpc<{ runs: JawsRunView[] }>(nextTarget, 'jaws.runList', {
            worktree: `id:${selectedOption.id}`
          })
        ])
        if (!canceled) {
          setTarget(nextTarget)
          setPlanning(
            planningResult.planning.find(
              (entry) => isPlanningActive(entry) || entry.status === 'needs_input'
            ) ?? null
          )
          setRun(runResult.runs[0] ?? null)
        }
      } catch (discoveryError) {
        if (!canceled) {
          setError(errorMessage(discoveryError, 'Could not load Jaws runs.'))
        }
      }
    }
    void discover()
    return () => {
      canceled = true
    }
  }, [goal, open, planning, restoreLatestRun, run, selectedOption])

  useEffect(() => {
    if (!open || !planning || !target || !isPlanningActive(planning)) {
      return
    }
    let canceled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const response = await callRuntimeRpc<{ planning: JawsPlanningRun }>(
          target,
          'jaws.planningShow',
          { planningId: planning.id }
        )
        if (canceled) {
          return
        }
        setPlanning(response.planning)
        if (response.planning.status === 'proposed' && response.planning.jawsRunId) {
          const proposal = await callRuntimeRpc<{ run: JawsRunView }>(target, 'jaws.runShow', {
            run: response.planning.jawsRunId
          })
          if (!canceled) {
            setRun(proposal.run)
          }
          return
        }
        if (isPlanningActive(response.planning)) {
          timer = setTimeout(poll, POLL_INTERVAL_MS)
        }
      } catch (pollError) {
        if (!canceled) {
          setError(errorMessage(pollError, 'Could not refresh planning.'))
          timer = setTimeout(poll, POLL_INTERVAL_MS)
        }
      }
    }
    timer = setTimeout(poll, POLL_INTERVAL_MS)
    return () => {
      canceled = true
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [open, planning, target])

  useEffect(() => {
    if (!open || !runId || !target || !runNeedsPolling) {
      return
    }
    let canceled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const latest = await callRuntimeRpc<{ run: JawsRunView }>(target, 'jaws.runShow', {
          run: runId
        })
        if (canceled) {
          return
        }
        setRun(latest.run)
        if (latest.run.harnessRunId) {
          const harness = await callRuntimeRpc<{ run: HarnessRun }>(target, 'harness.show', {
            run: latest.run.harnessRunId
          })
          if (!canceled) {
            setHarnessRun(harness.run)
          }
        }
        if (isRunActive(latest.run)) {
          timer = setTimeout(poll, POLL_INTERVAL_MS)
        }
      } catch (pollError) {
        if (!canceled) {
          setError(errorMessage(pollError, 'Could not refresh this run.'))
          timer = setTimeout(poll, POLL_INTERVAL_MS)
        }
      }
    }
    void poll()
    return () => {
      canceled = true
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [harnessRunId, open, runId, runNeedsPolling, target])

  async function createPlan(): Promise<void> {
    if (!selectedOption || !goal.trim() || submitting) {
      return
    }
    const nextTarget = getHarnessRuntimeTarget(selectedOption.id)
    setSubmitting(true)
    setError(null)
    try {
      await assertJawsTargetSupported(nextTarget)
      const response = await callRuntimeRpc<{ planning: JawsPlanningRun }>(
        nextTarget,
        'jaws.planningStart',
        {
          goal,
          worktreeSelector: `id:${selectedOption.id}`,
          clientRequestId: crypto.randomUUID()
        }
      )
      if (mountedRef.current) {
        setTarget(nextTarget)
        setPlanning(response.planning)
      }
    } catch (startError) {
      if (mountedRef.current) {
        const activePlanning = (
          await callRuntimeRpc<{ planning: JawsPlanningRun[] }>(nextTarget, 'jaws.planningList', {
            worktree: `id:${selectedOption.id}`
          }).catch(() => null)
        )?.planning.find((entry) => isPlanningActive(entry) || entry.status === 'needs_input')
        if (activePlanning) {
          setTarget(nextTarget)
          setPlanning(activePlanning)
          setError(null)
        } else {
          setError(errorMessage(startError, 'Could not create this plan.'))
        }
      }
    } finally {
      if (mountedRef.current) {
        setSubmitting(false)
      }
    }
  }

  async function approve(): Promise<void> {
    if (!run || approving || !target) {
      return
    }
    setApproving(true)
    setError(null)
    try {
      setRun(
        (
          await window.api.jaws!.approvePlan({
            runId: run.id,
            revision: run.revision,
            planHash: run.planHash,
            ...(target.kind === 'environment' ? { runtimeEnvironmentId: target.environmentId } : {})
          })
        ).run
      )
    } catch (approvalError) {
      setError(errorMessage(approvalError, 'Could not approve this plan.'))
      const latest = await refreshJawsRun(target, run.id)
      if (latest) {
        setRun(latest)
      }
    } finally {
      setApproving(false)
    }
  }

  async function retryReview(): Promise<void> {
    if (!run || retryingReview || !target) {
      return
    }
    setRetryingReview(true)
    try {
      setRun(
        (
          await window.api.jaws!.retryReview({
            runId: run.id,
            ...(target.kind === 'environment' ? { runtimeEnvironmentId: target.environmentId } : {})
          })
        ).run
      )
    } catch (retryError) {
      setError(errorMessage(retryError, 'Could not retry review publication.'))
    } finally {
      setRetryingReview(false)
    }
  }

  async function cancelPlanning(): Promise<boolean> {
    if (!planning || !target || !isPlanningCancelable(planning)) {
      return false
    }
    try {
      const response = await callRuntimeRpc<{ planning: JawsPlanningRun }>(
        target,
        'jaws.planningCancel',
        { planningId: planning.id }
      )
      setPlanning(response.planning)
      return true
    } catch (cancelError) {
      setError(errorMessage(cancelError, 'Could not cancel planning.'))
      return false
    }
  }

  async function revisePlanning(): Promise<void> {
    if (await cancelPlanning()) {
      setPlanning(null)
      setRestoreLatestRun(false)
    }
  }

  function reset(): void {
    setPlanning(null)
    setRun(null)
    setHarnessRun(null)
    setTarget(null)
    setError(null)
    setGoal('')
    setRestoreLatestRun(false)
    setSelectedWorktreeId(defaultWorktreeId)
  }

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen) {
      setRestoreLatestRun(true)
    }
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto scrollbar-sleek sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{translate('harness.jawsTitle', 'Jaws orchestrator')}</DialogTitle>
          <DialogDescription>
            {translate(
              'harness.jawsDescription',
              'Create a reviewed plan, then run its tasks in isolated worktrees.'
            )}
          </DialogDescription>
        </DialogHeader>

        {run ? (
          <div className="space-y-3">
            <JawsPlanCard
              run={run}
              error={error}
              approving={approving}
              retryingReview={retryingReview}
              onApprove={target ? () => void approve() : null}
              onRetryReview={target ? () => void retryReview() : null}
              onOpenUrl={(url) => void window.api.shell.openUrl(url)}
            />
            {harnessRun ? <HarnessRunSummary run={harnessRun} pollError={error} /> : null}
          </div>
        ) : planning ? (
          <JawsPlanningStatus
            planning={planning}
            onCancel={() => void cancelPlanning()}
            onRevise={() => void revisePlanning()}
          />
        ) : (
          <JawsPlanInputForm
            options={options}
            selectedOption={selectedOption}
            selectedWorktreeId={resolvedWorktreeId}
            goal={goal}
            submitting={submitting}
            error={error}
            onSelectedWorktreeChange={setSelectedWorktreeId}
            onGoalChange={setGoal}
            onCancel={() => handleOpenChange(false)}
            onSubmit={() => void createPlan()}
          />
        )}

        {run || planning ? (
          <DialogFooter>
            {run && !run.harnessRunId ? (
              <Button
                variant="outline"
                onClick={() => {
                  setGoal(run.plan.goal)
                  setRun(null)
                  setPlanning(null)
                }}
              >
                {translate('harness.refinePlan', 'Refine plan')}
              </Button>
            ) : null}
            {!planning || !isPlanningActive(planning) ? (
              <Button variant="outline" onClick={reset}>
                {translate('harness.newPlan', 'New plan')}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => handleOpenChange(false)}>
              {translate('harness.close', 'Close')}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
