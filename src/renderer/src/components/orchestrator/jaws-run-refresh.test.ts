import { beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeRpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc }))

import { refreshJawsRun } from './jaws-run-refresh'

describe('refreshJawsRun', () => {
  beforeEach(() => callRuntimeRpc.mockReset())

  it('reloads the current revision after a stale approval failure', async () => {
    callRuntimeRpc.mockResolvedValue({ run: { id: 'run-1', revision: 3 } })

    await expect(refreshJawsRun({ kind: 'local' }, 'run-1')).resolves.toMatchObject({
      revision: 3
    })
    expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'jaws.runShow', {
      run: 'run-1'
    })
  })
})
