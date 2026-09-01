import { z } from 'zod'
import {
  jawsPlanningSelectorSchema,
  jawsPlanningStartSchema,
  jawsPlanApprovalSchema,
  jawsPlanProposalSchema,
  jawsReviewRetrySchema
} from '../../../../shared/jaws-types'
import { JAWS_TRUSTED_APPROVAL_RELAY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'

const JawsRunList = z.object({
  repo: OptionalString,
  worktree: OptionalString
})

const JawsRun = z.object({
  run: requiredString('Missing Jaws run id').transform((value) => value.trim())
})

function requireTrustedApprovalRelay(context: {
  clientKind?: string
  clientCapabilities?: readonly string[]
}): void {
  if (
    context.clientKind !== 'runtime' ||
    !context.clientCapabilities?.includes(JAWS_TRUSTED_APPROVAL_RELAY_RUNTIME_CAPABILITY)
  ) {
    throw new Error('trusted_renderer_required')
  }
}

export const JAWS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'jaws.planningList',
    params: JawsRunList,
    handler: async (params, { runtime }) => {
      const worktree = params.worktree ? await runtime.showManagedWorktree(params.worktree) : null
      return {
        planning: runtime
          .getJawsService()
          .listPlanning(worktree ? { sourceWorktreeId: worktree.id } : {})
      }
    }
  }),
  defineMethod({
    name: 'jaws.planningStart',
    params: jawsPlanningStartSchema,
    handler: async (params, { runtime }) => ({
      planning: await runtime.getJawsService().startPlanning(params)
    })
  }),
  defineMethod({
    name: 'jaws.planningShow',
    params: jawsPlanningSelectorSchema,
    handler: async (params, { runtime }) => ({
      planning: await runtime.getJawsService().showPlanning(params)
    })
  }),
  defineMethod({
    name: 'jaws.planningCancel',
    params: jawsPlanningSelectorSchema,
    handler: async (params, { runtime }) => ({
      planning: await runtime.getJawsService().cancelPlanning(params)
    })
  }),
  defineMethod({
    name: 'jaws.planApprove',
    params: jawsPlanApprovalSchema,
    handler: async (params, context) => {
      requireTrustedApprovalRelay(context)
      return { run: await context.runtime.getJawsService().approve(params) }
    }
  }),
  defineMethod({
    name: 'jaws.reviewRetry',
    params: jawsReviewRetrySchema,
    handler: async (params, context) => {
      requireTrustedApprovalRelay(context)
      return { run: await context.runtime.getJawsService().retryReview(params) }
    }
  }),
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
        runs: runtime.getJawsService().list({
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
      run: runtime.getJawsService().show(params.run)
    })
  })
]
