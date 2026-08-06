import { ipcMain } from 'electron'
import {
  jawsPlanApprovalSchema,
  jawsReviewRetrySchema,
  type JawsPlanApproval,
  type JawsReviewRetry,
  type JawsRunView
} from '../../shared/jaws-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { isTrustedUIRenderer } from './ui'

export function registerJawsHandlers(runtime: OrcaRuntimeService): void {
  ipcMain.removeHandler('jaws:approvePlan')
  ipcMain.removeHandler('jaws:retryReview')
  ipcMain.handle(
    'jaws:approvePlan',
    async (event, input: JawsPlanApproval): Promise<{ run: JawsRunView }> => {
      if (!isTrustedUIRenderer(event.sender)) {
        throw new Error('untrusted_renderer')
      }
      const approval = jawsPlanApprovalSchema.parse(input)
      return { run: await runtime.getJawsService().approve(approval) }
    }
  )
  ipcMain.handle(
    'jaws:retryReview',
    async (event, input: JawsReviewRetry): Promise<{ run: JawsRunView }> => {
      if (!isTrustedUIRenderer(event.sender)) {
        throw new Error('untrusted_renderer')
      }
      const retry = jawsReviewRetrySchema.parse(input)
      return { run: await runtime.getJawsService().retryReview(retry) }
    }
  )
}
