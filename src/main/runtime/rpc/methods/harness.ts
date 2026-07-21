import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'

function requiredTrimmedString(message: string) {
  return requiredString(message)
    .transform((value) => value.trim())
    .pipe(z.string().min(1, message))
}

const HarnessStart = z.object({
  worktree: requiredTrimmedString('Missing worktree selector'),
  goal: requiredTrimmedString('Missing goal'),
  verificationCommand: requiredTrimmedString('Missing verification command'),
  mode: z.enum(['comparison', 'orchestrator']).optional()
})

const HarnessList = z.object({ repo: OptionalString })
const HarnessRun = z.object({ run: requiredTrimmedString('Missing harness run id') })
export const HARNESS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'harness.start',
    params: HarnessStart,
    handler: async (params, { runtime }) => ({
      run: await runtime.getHarnessService().start(params)
    })
  }),
  defineMethod({
    name: 'harness.list',
    params: HarnessList,
    handler: async (params, { runtime }) => {
      const repo = params.repo ? await runtime.showRepo(params.repo) : null
      return { runs: await runtime.getHarnessService().list(repo?.id) }
    }
  }),
  defineMethod({
    name: 'harness.show',
    params: HarnessRun,
    handler: async (params, { runtime }) => ({
      run: await runtime.getHarnessService().show(params.run)
    })
  }),
  defineMethod({
    name: 'harness.resume',
    params: HarnessRun,
    handler: async (params, { runtime }) => ({
      run: await runtime.getHarnessService().resume(params.run)
    })
  }),
  defineMethod({
    name: 'harness.cancel',
    params: HarnessRun,
    handler: async (params, { runtime }) => ({
      run: await runtime.getHarnessService().cancel(params.run)
    })
  })
]
