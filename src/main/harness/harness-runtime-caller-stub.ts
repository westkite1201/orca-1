// Scripted HarnessRuntimeCaller used by the Harness service suites: each
// scenario flag bends one RPC so a single failure path can be exercised.
import { vi } from 'vitest'
import type { HarnessAgent } from '../../shared/harness-types'
import type { GitStatusResult } from '../../shared/git-status-types'
import type { RuntimeTerminalWait } from '../../shared/runtime-types'
import type { HarnessRuntimeCaller } from './runtime-caller'
import {
  BASE_SHA,
  CLEAN_STATUS,
  REMINTED_PANE_LEAF,
  REPO,
  SOURCE,
  branchRef
} from './harness-scenario-fixtures'

export type RuntimeScenario = {
  status?: GitStatusResult
  candidateStatus?: Partial<Record<HarnessAgent, GitStatusResult>>
  candidateBranch?: Partial<Record<HarnessAgent, string>>
  failCreate?: HarnessAgent
  failDispatch?: HarnessAgent
  existingDispatch?: HarnessAgent
  remintedExistingDispatch?: HarnessAgent
  failResolveOnDispatch?: HarnessAgent
  recoverInterruptedCreate?: HarnessAgent
  recoveryTerminalProblem?: 'missing' | 'error' | 'truncated'
  truncateFirstRecoveryList?: boolean
  existingTask?: { agent: HarnessAgent; spec: string }
  wait?: (agent: HarnessAgent, attempt: number) => RuntimeTerminalWait
  remoteRuntimeReady?: boolean[]
  verifyCandidates?: boolean
}

export type HarnessRuntimeStub = {
  runtime: HarnessRuntimeCaller
  call: ReturnType<typeof vi.fn>
}

export function createRuntime(scenario: RuntimeScenario = {}): HarnessRuntimeStub {
  const waitAttempts = new Map<HarnessAgent, number>()
  const resolveAttempts = new Map<HarnessAgent, number>()
  let worktreeListAttempts = 0
  const dispatchedAgents = new Set<HarnessAgent>()
  const tasks: Record<string, unknown>[] = scenario.existingTask
    ? [
        {
          id: `task-${scenario.existingTask.agent}`,
          spec: scenario.existingTask.spec,
          task_title: `Jaws Harness: ${scenario.existingTask.agent === 'codex' ? 'Codex' : 'Claude'}`,
          created_by_terminal_handle: 'jaws-harness:run-1',
          status: 'ready'
        }
      ]
    : []
  let remoteRuntimeReadinessAttempt = 0
  const call = vi.fn(async (method: string, rawParams?: unknown): Promise<unknown> => {
    const params = rawParams as Record<string, unknown>
    if (method === 'worktree.show') {
      return { worktree: SOURCE }
    }
    if (method === 'git.status') {
      if (params.worktree !== 'id:source-1') {
        const agent = String(params.worktree).endsWith('codex') ? 'codex' : 'claude'
        return {
          ...(scenario.candidateStatus?.[agent] ?? CLEAN_STATUS),
          ...(scenario.verifyCandidates ? { head: `head-${agent}` } : {}),
          branch: scenario.candidateBranch?.[agent] ?? branchRef(agent)
        }
      }
      return scenario.status ?? CLEAN_STATUS
    }
    if (method === 'ssh.getState') {
      const readiness = scenario.remoteRuntimeReady ?? [true]
      const runtimeReady =
        readiness[Math.min(remoteRuntimeReadinessAttempt, readiness.length - 1)] ?? false
      remoteRuntimeReadinessAttempt += 1
      return { state: null, runtimeReady }
    }
    if (method === 'git.branchCompare' && scenario.verifyCandidates) {
      const agent = String(params.worktree).endsWith('codex') ? 'codex' : 'claude'
      return {
        summary: {
          baseRef: BASE_SHA,
          baseOid: BASE_SHA,
          compareRef: 'HEAD',
          headOid: `head-${agent}`,
          mergeBase: BASE_SHA,
          changedFiles: 1,
          status: 'ready'
        },
        entries: [{ path: `src/${agent}.ts`, status: 'modified', added: 1, removed: 0 }]
      }
    }
    if (method === 'worktree.create') {
      const agent = params.startupAgent as HarnessAgent
      if (scenario.failCreate === agent) {
        throw new Error(`${agent} create failed`)
      }
      return {
        worktree: {
          id: `worktree-${agent}`,
          repoId: REPO.id,
          parentWorktreeId: null,
          childWorktreeIds: [],
          lineage: null,
          git: {
            path: `candidate-${agent}`,
            head: BASE_SHA,
            branch: `refs/heads/${String(params.branchNameOverride)}`,
            isBare: false,
            isMainWorktree: false
          }
        },
        lineage: null,
        warnings: [],
        agentTerminalHandle: `terminal-${agent}`,
        startupTerminal: {
          spawned: true,
          handle: `terminal-${agent}`,
          paneKey:
            scenario.remintedExistingDispatch === agent
              ? `tab-after-${agent}:${REMINTED_PANE_LEAF}`
              : `pane-${agent}`,
          surface: 'background'
        }
      }
    }
    if (method === 'worktree.list') {
      worktreeListAttempts += 1
      const agent = scenario.recoverInterruptedCreate
      const truncated = scenario.truncateFirstRecoveryList === true && worktreeListAttempts === 1
      return {
        worktrees:
          agent && !truncated
            ? [
                {
                  id: `worktree-${agent}`,
                  repoId: REPO.id,
                  parentWorktreeId: null,
                  childWorktreeIds: [],
                  lineage: null,
                  git: {
                    path: `candidate-${agent}`,
                    head: BASE_SHA,
                    branch: branchRef(agent),
                    isBare: false,
                    isMainWorktree: false
                  }
                }
              ]
            : [],
        totalCount: agent && !truncated ? 1 : 0,
        truncated
      }
    }
    if (method === 'terminal.list') {
      const agent = scenario.recoverInterruptedCreate ?? 'codex'
      if (scenario.recoveryTerminalProblem === 'error') {
        throw new Error('terminal graph is restoring')
      }
      return {
        terminals:
          scenario.recoveryTerminalProblem === 'missing'
            ? []
            : [
                {
                  handle: `terminal-${agent}`,
                  ptyId: `pty-${agent}`,
                  worktreeId: `worktree-${agent}`,
                  worktreePath: `candidate-${agent}`,
                  branch: branchRef(agent),
                  tabId: `tab-${agent}`,
                  leafId: '11111111-1111-4111-8111-111111111111',
                  title: null,
                  connected: true,
                  writable: true,
                  lastOutputAt: null,
                  preview: ''
                }
              ],
        totalCount: scenario.recoveryTerminalProblem === 'missing' ? 0 : 1,
        truncated: scenario.recoveryTerminalProblem === 'truncated'
      }
    }
    if (method === 'terminal.isRunningAgent') {
      return { isRunningAgent: true }
    }
    if (method === 'terminal.resolvePane') {
      const agent = String(params.paneKey).includes('codex') ? 'codex' : 'claude'
      const attempt = (resolveAttempts.get(agent) ?? 0) + 1
      resolveAttempts.set(agent, attempt)
      if (scenario.failResolveOnDispatch === agent && attempt === 2) {
        throw new Error('runtime graph is restoring')
      }
      return {
        terminal: {
          handle: `terminal-${agent}`,
          tabId: `tab-${agent}`,
          leafId: `leaf-${agent}`,
          ptyId: `pty-${agent}`
        }
      }
    }
    if (method === 'terminal.wait') {
      const agent = String(params.terminal).endsWith('codex') ? 'codex' : 'claude'
      const attempt = (waitAttempts.get(agent) ?? 0) + 1
      waitAttempts.set(agent, attempt)
      return {
        wait:
          scenario.wait?.(agent, attempt) ??
          ({
            handle: `terminal-${agent}`,
            condition: 'tui-idle',
            satisfied: true,
            status: 'running',
            exitCode: null
          } satisfies RuntimeTerminalWait)
      }
    }
    if (method === 'orchestration.taskCreate') {
      const agent = String(params.taskTitle).includes('Codex') ? 'codex' : 'claude'
      tasks.push({
        id: `task-${agent}`,
        spec: params.spec,
        task_title: params.taskTitle,
        created_by_terminal_handle: params.callerTerminalHandle,
        status: 'ready'
      })
      return { task: { id: `task-${agent}` } }
    }
    if (method === 'orchestration.taskList') {
      return { tasks }
    }
    if (method === 'orchestration.dispatch') {
      const agent = String(params.to).endsWith('codex') ? 'codex' : 'claude'
      if (scenario.failDispatch === agent) {
        throw new Error(`${agent} dispatch failed`)
      }
      dispatchedAgents.add(agent)
      return { dispatch: { id: `dispatch-${agent}` }, injected: true }
    }
    if (method === 'orchestration.dispatchShow') {
      const agent = String(params.task).endsWith('codex') ? 'codex' : 'claude'
      if (
        scenario.existingDispatch === agent ||
        scenario.remintedExistingDispatch === agent ||
        dispatchedAgents.has(agent)
      ) {
        return {
          dispatch: {
            id: `dispatch-${agent}`,
            task_id: `task-${agent}`,
            assignee_handle:
              scenario.existingDispatch === agent || scenario.remintedExistingDispatch === agent
                ? `terminal-before-restart-${agent}`
                : `terminal-${agent}`,
            assignee_pane_key:
              scenario.remintedExistingDispatch === agent
                ? `tab-before-${agent}:${REMINTED_PANE_LEAF}`
                : `pane-${agent}`,
            status: 'dispatched',
            failure_count: 0,
            last_failure: null,
            dispatched_at: '2026-01-01 00:00:00',
            completed_at: null,
            created_at: '2026-01-01 00:00:00',
            last_heartbeat_at: null
          },
          task: { id: `task-${agent}`, status: 'dispatched' }
        }
      }
      return { dispatch: null, task: { id: `task-${agent}`, status: 'ready' } }
    }
    if (method === 'orchestration.check') {
      return { messages: [], count: 0 }
    }
    throw new Error(`Unexpected runtime call: ${method}`)
  })
  const runVerification = vi.fn(async () => {
    throw new Error('Unexpected Harness verification')
  })
  const abandonDispatch = vi.fn(async () => true)
  const stopChildDispatch = vi.fn(async () => true)
  const stopVerificationTerminal = vi.fn(async () => true)
  return {
    runtime: {
      call,
      abandonDispatch,
      stopChildDispatch,
      stopVerificationTerminal,
      runVerification
    } as HarnessRuntimeCaller,
    call
  }
}
