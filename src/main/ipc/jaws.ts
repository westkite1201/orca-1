import { ipcMain } from 'electron'
import {
  jawsPlanApprovalRequestSchema,
  jawsReviewRetryRequestSchema,
  type JawsPlanApprovalRequest,
  type JawsReviewRetryRequest,
  type JawsRunView
} from '../../shared/jaws-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getCanonicalUserDataPath } from '../persistence'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'
import { isTrustedUIRenderer } from './ui'

async function callTrustedJawsOwner<TResult>(
  environmentId: string,
  method: string,
  params: unknown
): Promise<TResult> {
  const response = await callRuntimeEnvironment(
    getCanonicalUserDataPath(),
    environmentId,
    method,
    params
  )
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as TResult
}

export function registerJawsHandlers(runtime: OrcaRuntimeService): void {
  ipcMain.removeHandler('jaws:approvePlan')
  ipcMain.removeHandler('jaws:retryReview')
  ipcMain.handle(
    'jaws:approvePlan',
    async (event, input: JawsPlanApprovalRequest): Promise<{ run: JawsRunView }> => {
      if (!isTrustedUIRenderer(event.sender)) {
        throw new Error('untrusted_renderer')
      }
      const { runtimeEnvironmentId, ...approval } = jawsPlanApprovalRequestSchema.parse(input)
      return runtimeEnvironmentId
        ? callTrustedJawsOwner(runtimeEnvironmentId, 'jaws.planApprove', approval)
        : { run: await runtime.getJawsService().approve(approval) }
    }
  )
  ipcMain.handle(
    'jaws:retryReview',
    async (event, input: JawsReviewRetryRequest): Promise<{ run: JawsRunView }> => {
      if (!isTrustedUIRenderer(event.sender)) {
        throw new Error('untrusted_renderer')
      }
      const { runtimeEnvironmentId, ...retry } = jawsReviewRetryRequestSchema.parse(input)
      return runtimeEnvironmentId
        ? callTrustedJawsOwner(runtimeEnvironmentId, 'jaws.reviewRetry', retry)
        : { run: await runtime.getJawsService().retryReview(retry) }
    }
  )
}
