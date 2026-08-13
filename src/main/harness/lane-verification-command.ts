import type {
  HarnessExecutionItemV1,
  HarnessLaneIntegrationEvidenceV1
} from '../../shared/harness-allocation-types'
import type { HarnessRun } from '../../shared/harness-types'
import { LaneVerificationError } from './lane-git-evidence'
import type { HarnessRuntimeCaller } from './runtime-caller'

export async function runNarrowChecks(args: {
  runtime: HarnessRuntimeCaller
  run: HarnessRun
  item: HarnessExecutionItemV1
  worktreeId: string
  timeoutSeconds: number
}): Promise<HarnessLaneIntegrationEvidenceV1['checks']> {
  const checks: HarnessLaneIntegrationEvidenceV1['checks'] = []
  for (const command of args.item.verificationCommands) {
    const result = await args.runtime.runVerification({
      runId: args.run.id,
      agent: 'codex',
      worktree: `id:${args.worktreeId}`,
      command,
      timeoutSeconds: args.timeoutSeconds,
      // Why: lane checks must not overwrite the final candidate verification recovery receipt.
      trackCandidate: false
    })
    if (result.exitCode !== 0 || result.timedOut || result.error) {
      throw new LaneVerificationError(`Lane verification failed: ${command}`)
    }
    checks.push({ command, exitCode: result.exitCode, durationMs: result.durationMs })
  }
  return checks
}
