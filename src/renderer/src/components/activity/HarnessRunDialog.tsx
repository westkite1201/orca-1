import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

import type { HarnessRun } from '../../../../shared/harness-types'
import { HARNESS_ORCHESTRATOR_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from '@/runtime/runtime-rpc-client'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { HarnessDiscoveryNotice } from './HarnessDiscoveryNotice'
import { HarnessRunSummary } from './HarnessRunSummary'
import { getHarnessDialogCopy } from './harness-status-label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  getHarnessRuntimeTarget,
  isHarnessRunActive,
  useHarnessActiveRunReconnect
} from './use-harness-active-run-reconnect'

const POLL_INTERVAL_MS = 1_500

type HarnessRunDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function HarnessRunDialog({ open, onOpenChange }: HarnessRunDialogProps): React.JSX.Element {
  const repos = useRepos()
  const worktrees = useAllWorktrees()
  const activeWorktreeId = useActiveWorktreeId()
  const options = useMemo(() => {
    const repoById = new Map(repos.map((repo) => [repo.id, repo]))
    return worktrees
      .flatMap((worktree) => {
        const repo = repoById.get(worktree.repoId)
        if (!repo || repo.kind === 'folder' || worktree.isBare) {
          return []
        }
        return [
          {
            id: worktree.id,
            label: `${repo.displayName || repo.path} / ${worktree.displayName || worktree.branch}`,
            repoId: repo.id,
            path: worktree.path,
            branch: worktree.branch
          }
        ]
      })
      .sort((left, right) =>
        left.id === activeWorktreeId
          ? -1
          : right.id === activeWorktreeId
            ? 1
            : left.label.localeCompare(right.label)
      )
  }, [activeWorktreeId, repos, worktrees])
  const defaultWorktreeId = options[0]?.id ?? ''
  const [selectedWorktreeId, setSelectedWorktreeId] = useState(defaultWorktreeId)
  const [goal, setGoal] = useState('')
  const [verificationCommand, setVerificationCommand] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const [run, setRun] = useState<HarnessRun | null>(null)
  const [runTarget, setRunTarget] = useState<RuntimeClientTarget | null>(null)
  const [includeTerminalRuns, setIncludeTerminalRuns] = useState(true)
  const mountedRef = useRef(true)

  useEffect(() => {
    // StrictMode replays mount effects, so each live pass must restore the async guard.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const resolvedWorktreeId = options.some((option) => option.id === selectedWorktreeId)
    ? selectedWorktreeId
    : defaultWorktreeId
  const selectedOption = options.find((option) => option.id === resolvedWorktreeId)
  const runId = run?.id
  const runActive = run ? isHarnessRunActive(run) : false
  const formDirty = Boolean(goal || verificationCommand)

  const { status: discoveryStatus, retry: retryDiscovery } = useHarnessActiveRunReconnect({
    open,
    hasInMemoryActiveRun: runActive,
    submitting,
    formDirty,
    includeTerminalRuns,
    sourceWorktreeId: selectedOption?.id ?? null,
    repoId: selectedOption?.repoId ?? null,
    setRun,
    setRunTarget
  })

  useEffect(() => {
    if (!open || !runId || !runTarget || !runActive) {
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const response = await callRuntimeRpc<{ run: HarnessRun }>(runTarget, 'harness.show', {
          run: runId
        })
        if (cancelled) {
          return
        }
        setRun(response.run)
        setPollError(null)
        if (isHarnessRunActive(response.run)) {
          timer = setTimeout(poll, POLL_INTERVAL_MS)
        }
      } catch (pollingError) {
        if (cancelled) {
          return
        }
        setPollError(errorMessage(pollingError, 'Could not refresh this run.'))
        timer = setTimeout(poll, POLL_INTERVAL_MS)
      }
    }

    timer = setTimeout(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [open, runActive, runId, runTarget])

  const canSubmit = Boolean(
    selectedOption && goal.trim() && verificationCommand.trim() && discoveryStatus === 'ready'
  )

  async function startRun(): Promise<void> {
    if (!canSubmit || !selectedOption || submitting) {
      return
    }

    setSubmitting(true)
    setError(null)
    setPollError(null)
    const target = getHarnessRuntimeTarget(selectedOption.id)
    try {
      if (target.kind === 'environment') {
        await assertRuntimeEnvironmentCapability(
          target.environmentId,
          HARNESS_ORCHESTRATOR_RUNTIME_CAPABILITY,
          translate(
            'harness.ownerUpgradeRequired',
            'Update the worktree owner runtime to use Orchestrator.'
          )
        )
      }
      const response = await callRuntimeRpc<{ run: HarnessRun }>(target, 'harness.start', {
        worktree: `id:${selectedOption.id}`,
        goal,
        verificationCommand,
        mode: 'orchestrator'
      })
      if (!mountedRef.current) {
        return
      }
      setRunTarget(target)
      setRun(response.run)
    } catch (startError) {
      if (mountedRef.current) {
        setError(errorMessage(startError, 'Could not start this run.'))
      }
    } finally {
      if (mountedRef.current) {
        setSubmitting(false)
      }
    }
  }

  async function resumeRun(): Promise<void> {
    if (!run || !runTarget || resuming) {
      return
    }

    setResuming(true)
    setPollError(null)
    try {
      const response = await callRuntimeRpc<{ run: HarnessRun }>(runTarget, 'harness.resume', {
        run: run.id
      })
      if (mountedRef.current) {
        setRun(response.run)
      }
    } catch (resumeError) {
      if (mountedRef.current) {
        setPollError(errorMessage(resumeError, 'Could not resume this run.'))
      }
    } finally {
      if (mountedRef.current) {
        setResuming(false)
      }
    }
  }

  function reset(): void {
    setIncludeTerminalRuns(false)
    setRun(null)
    setRunTarget(null)
    setError(null)
    setPollError(null)
    setGoal('')
    setVerificationCommand('')
    setSelectedWorktreeId(defaultWorktreeId)
  }

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen) {
      setIncludeTerminalRuns(true)
    }
    onOpenChange(nextOpen)
  }

  const dialogCopy = getHarnessDialogCopy(run?.mode ?? null, runActive)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto scrollbar-sleek sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{dialogCopy.title}</DialogTitle>
          <DialogDescription>{dialogCopy.description}</DialogDescription>
        </DialogHeader>

        {run ? (
          <HarnessRunSummary run={run} pollError={pollError} />
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void startRun()
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="harness-worktree">
                {translate('harness.gitWorktree', 'Git worktree')}
              </Label>
              <Select
                value={resolvedWorktreeId}
                onValueChange={setSelectedWorktreeId}
                disabled={submitting || options.length === 0}
              >
                <SelectTrigger id="harness-worktree" className="w-full">
                  <SelectValue
                    placeholder={translate('harness.selectWorktree', 'Select a worktree')}
                  />
                </SelectTrigger>
                <SelectContent position="popper" side="bottom" align="start">
                  {options.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedOption ? (
                <p className="truncate font-mono text-[11px] text-muted-foreground">
                  {selectedOption.branch} · {selectedOption.path}
                </p>
              ) : (
                <p className="text-xs text-destructive">
                  {translate(
                    'harness.noGitRepository',
                    'Add a Git repository to start an orchestrator run.'
                  )}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="harness-goal">{translate('harness.goal', 'Issue or goal')}</Label>
              <textarea
                id="harness-goal"
                autoFocus
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                disabled={submitting}
                placeholder={translate(
                  'harness.goalPlaceholder',
                  'Paste an issue or describe the outcome'
                )}
                className="min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="harness-verification">
                {translate('harness.verificationCommand', 'Verification command')}
              </Label>
              <Input
                id="harness-verification"
                value={verificationCommand}
                onChange={(event) => setVerificationCommand(event.target.value)}
                disabled={submitting}
                placeholder={translate('harness.verificationPlaceholder', 'pnpm test')}
                className="font-mono"
              />
            </div>
            {error ? (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <HarnessDiscoveryNotice status={discoveryStatus} onRetry={retryDiscovery} />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
                {translate('harness.cancel', 'Cancel')}
              </Button>
              <Button type="submit" disabled={!canSubmit || submitting} className="w-36">
                {submitting ? (
                  <>
                    <Loader2 className="animate-spin" />
                    {translate('harness.starting', 'Starting…')}
                  </>
                ) : (
                  translate('harness.runComparison', 'Start orchestrator')
                )}
              </Button>
            </DialogFooter>
          </form>
        )}

        {run ? (
          <DialogFooter>
            {runActive &&
            run.candidates.some(
              (candidate) =>
                candidate.error && ['creating', 'ready', 'verifying'].includes(candidate.status)
            ) ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void resumeRun()}
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
            {runActive ? null : (
              <Button type="button" variant="outline" onClick={reset}>
                {translate('harness.newComparison', 'New run')}
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
              {translate('harness.close', 'Close')}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}
