import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

import type { HarnessRun } from '../../../../shared/harness-types'
import { HARNESS_ORCHESTRATOR_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'

export function isHarnessRunActive(run: HarnessRun): boolean {
  return (
    run.fatalError === null &&
    run.candidates.some(
      (candidate) => candidate.status !== 'verified' && candidate.status !== 'failed'
    )
  )
}

export function findHarnessRunToReconnect(
  runs: readonly HarnessRun[],
  sourceWorktreeId: string,
  includeTerminalRuns = true
): HarnessRun | null {
  return runs.reduce<HarnessRun | null>((latest, run) => {
    if (
      run.sourceWorktreeId !== sourceWorktreeId ||
      (!includeTerminalRuns && !isHarnessRunActive(run))
    ) {
      return latest
    }
    if (!latest) {
      return run
    }
    const runActive = isHarnessRunActive(run)
    const latestActive = isHarnessRunActive(latest)
    if (runActive !== latestActive) {
      return runActive ? run : latest
    }
    return run.createdAt > latest.createdAt ? run : latest
  }, null)
}

export function getHarnessRuntimeTarget(sourceWorktreeId: string): RuntimeClientTarget {
  const environmentId = getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), sourceWorktreeId)
  return environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }
}

type HarnessActiveRunReconnectOptions = {
  open: boolean
  hasInMemoryActiveRun: boolean
  submitting: boolean
  formDirty: boolean
  includeTerminalRuns: boolean
  sourceWorktreeId: string | null
  repoId: string | null
  setRun: Dispatch<SetStateAction<HarnessRun | null>>
  setRunTarget: Dispatch<SetStateAction<RuntimeClientTarget | null>>
}

export type HarnessDiscoveryStatus =
  | 'checking'
  | 'ready'
  | 'retrying'
  | 'active-conflict'
  | 'unsupported'

const DISCOVERY_RETRY_MS = 2_000

type HarnessDiscoveryController = {
  status: HarnessDiscoveryStatus
  retry: () => void
}

export function useHarnessActiveRunReconnect({
  open,
  hasInMemoryActiveRun,
  submitting,
  formDirty,
  includeTerminalRuns,
  sourceWorktreeId,
  repoId,
  setRun,
  setRunTarget
}: HarnessActiveRunReconnectOptions): HarnessDiscoveryController {
  const [retrySequence, setRetrySequence] = useState(0)
  const [discoveryStatus, setDiscoveryStatus] = useState<HarnessDiscoveryStatus>('checking')
  const discoveryContextRef = useRef<string | null>(null)
  const retryDiscovery = useCallback(() => {
    setDiscoveryStatus('checking')
    setRetrySequence((value) => value + 1)
  }, [])

  useEffect(() => {
    if (!open) {
      discoveryContextRef.current = null
      setDiscoveryStatus('checking')
      return
    }
    if (hasInMemoryActiveRun || submitting || !sourceWorktreeId || !repoId) {
      setDiscoveryStatus('ready')
      return
    }

    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    const discoveryContext = `${sourceWorktreeId}\0${repoId}\0${String(formDirty)}\0${String(includeTerminalRuns)}`
    if (discoveryContextRef.current !== discoveryContext) {
      discoveryContextRef.current = discoveryContext
      setDiscoveryStatus('checking')
    }
    const retry = (status: HarnessDiscoveryStatus = 'retrying'): void => {
      if (cancelled) {
        return
      }
      setDiscoveryStatus(status)
      retryTimer = setTimeout(() => setRetrySequence((value) => value + 1), DISCOVERY_RETRY_MS)
    }
    const reconnect = async (): Promise<void> => {
      const target = getHarnessRuntimeTarget(sourceWorktreeId)

      try {
        if (
          target.kind === 'environment' &&
          !(await runtimeEnvironmentSupportsCapability(
            target.environmentId,
            HARNESS_ORCHESTRATOR_RUNTIME_CAPABILITY
          ))
        ) {
          if (!cancelled) {
            setDiscoveryStatus('unsupported')
          }
          return
        }
        const response = await callRuntimeRpc<{ runs: HarnessRun[] }>(target, 'harness.list', {
          repo: `id:${repoId}`
        })
        if (cancelled) {
          return
        }
        const selectedRun = findHarnessRunToReconnect(
          response.runs,
          sourceWorktreeId,
          includeTerminalRuns
        )
        if (formDirty) {
          if (selectedRun && isHarnessRunActive(selectedRun)) {
            retry('active-conflict')
          } else {
            setDiscoveryStatus('ready')
          }
          return
        }
        setDiscoveryStatus('ready')
        if (!selectedRun) {
          return
        }

        // Why: SSH resume can be slow. Show durable state as soon as discovery
        // succeeds so latency cannot leave a misleading empty form visible.
        setRunTarget(target)
        setRun(selectedRun)
        if (!isHarnessRunActive(selectedRun)) {
          return
        }
        try {
          const resumed = await callRuntimeRpc<{ run: HarnessRun }>(target, 'harness.resume', {
            run: selectedRun.id
          })
          if (!cancelled && isHarnessRunActive(resumed.run)) {
            setRun(resumed.run)
          }
        } catch {
          // A failed resume should not hide persisted work; polling can recover later.
        }
      } catch (error) {
        if (cancelled) {
          return
        }
        if (isRuntimeCompatBlockError(error)) {
          setDiscoveryStatus('unsupported')
        } else {
          retry()
        }
      }
    }

    void reconnect()
    return () => {
      cancelled = true
      if (retryTimer) {
        clearTimeout(retryTimer)
      }
    }
  }, [
    formDirty,
    hasInMemoryActiveRun,
    includeTerminalRuns,
    open,
    repoId,
    retrySequence,
    setRun,
    setRunTarget,
    sourceWorktreeId,
    submitting
  ])

  return { status: discoveryStatus, retry: retryDiscovery }
}
