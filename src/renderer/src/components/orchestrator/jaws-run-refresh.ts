import type { JawsRunView } from '../../../../shared/jaws-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

export async function refreshJawsRun(
  target: RuntimeClientTarget,
  runId: string
): Promise<JawsRunView | null> {
  try {
    return (await callRuntimeRpc<{ run: JawsRunView }>(target, 'jaws.runShow', { run: runId })).run
  } catch {
    return null
  }
}
