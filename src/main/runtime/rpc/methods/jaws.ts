import { z } from 'zod'
import { jawsPlanProposalSchema } from '../../../../shared/jaws-types'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'

const JawsRunList = z.object({
  repo: OptionalString,
  worktree: OptionalString
})

const JawsRun = z.object({
  run: requiredString('Missing Jaws run id').transform((value) => value.trim())
})

export const JAWS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'jaws.planPropose',
    params: jawsPlanProposalSchema,
    handler: async (params, { runtime }) => ({
      run: await runtime.getJawsService().propose(params)
    })
  }),
  defineMethod({
    name: 'jaws.runList',
    params: JawsRunList,
    handler: async (params, { runtime }) => {
      const repo = params.repo ? await runtime.showRepo(params.repo) : null
      const worktree = params.worktree ? await runtime.showManagedWorktree(params.worktree) : null
      return {
        runs: await runtime.getJawsService().list({
          ...(repo ? { repoId: repo.id } : {}),
          ...(worktree ? { sourceWorktreeId: worktree.id } : {})
        })
      }
    }
  }),
  defineMethod({
    name: 'jaws.runShow',
    params: JawsRun,
    handler: async (params, { runtime }) => ({
      run: await runtime.getJawsService().show(params.run)
    })
  })
]
