import {
  JAWS_NATIVE_PLANNER_RUNTIME_CAPABILITY,
  JAWS_TRUSTED_APPROVAL_RELAY_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { assertRuntimeEnvironmentCapability } from '@/runtime/runtime-rpc-client'

export async function assertJawsTargetSupported(target: RuntimeClientTarget): Promise<void> {
  if (target.kind !== 'environment') {
    return
  }
  const message = translate(
    'harness.ownerUpgradeRequired',
    'Update the worktree owner runtime to use Orchestrator.'
  )
  await Promise.all(
    [JAWS_NATIVE_PLANNER_RUNTIME_CAPABILITY, JAWS_TRUSTED_APPROVAL_RELAY_RUNTIME_CAPABILITY].map(
      (capability) => assertRuntimeEnvironmentCapability(target.environmentId, capability, message)
    )
  )
}
