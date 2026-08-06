import { createHash } from 'node:crypto'
import {
  jawsPlanApprovalSchema,
  jawsPlanProposalSchema,
  jawsReviewRetrySchema,
  type JawsPlanApproval,
  type JawsPlanProposal,
  type JawsReviewRetry,
  type JawsRun,
  type JawsRunView
} from '../../shared/jaws-types'
import {
  deriveHarnessRunStatus,
  isHarnessCandidateVerified,
  type HarnessRun
} from '../../shared/harness-types'
import type { Store } from '../persistence'
import type { HarnessService } from '../harness/service'
import { materializeJawsLinearRun } from './linear-materialization'
import {
  publishJawsReview,
  type JawsResultLinearClient,
  type JawsReviewClient
} from './review-publication'

export type JawsStore = Pick<
  Store,
  | 'listJawsRuns'
  | 'getJawsRun'
  | 'saveJawsPlan'
  | 'markJawsApprovalStarted'
  | 'updateJawsLinearMaterialization'
  | 'updateJawsReviewPublication'
  | 'attachJawsHarnessRun'
  | 'failJawsApproval'
>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function planHash(run: {
  sourceWorktreeId: string
  baseSha: string
  plan: JawsPlanProposal['plan']
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        sourceWorktreeId: run.sourceWorktreeId,
        baseSha: run.baseSha,
        plan: run.plan
      })
    )
    .digest('hex')
}

export class JawsService {
  private readonly approvalInFlight = new Map<string, Promise<JawsRunView>>()
  private readonly publicationInFlight = new Map<string, Promise<JawsRunView>>()

  constructor(
    private readonly store: JawsStore,
    private readonly harness: HarnessService,
    private readonly linearClient: JawsResultLinearClient | null = null,
    private readonly reviewClient: JawsReviewClient | null = null
  ) {}

  async propose(input: JawsPlanProposal): Promise<JawsRunView> {
    const proposal = jawsPlanProposalSchema.parse(input)
    const { source, baseSha } = await this.harness.preflight(proposal.worktree)
    const interruptedApproval = this.store
      .listJawsRuns({ sourceWorktreeId: source.id })
      .find(
        (run) =>
          run.approvalStartedAt !== null &&
          run.harnessRunId === null &&
          run.error === null &&
          this.findHarnessRun(run) === null
      )
    if (interruptedApproval) {
      throw new Error('A Jaws approval is still starting. Retry the approved plan first.')
    }
    const run = this.store.saveJawsPlan({
      repoId: source.repoId,
      sourceWorktreeId: source.id,
      sourceWorktreePath: source.git.path,
      baseSha,
      planHash: planHash({ sourceWorktreeId: source.id, baseSha, plan: proposal.plan }),
      plan: proposal.plan
    })
    return this.view(run)
  }

  list(filters: { repoId?: string; sourceWorktreeId?: string } = {}): JawsRunView[] {
    return this.store.listJawsRuns(filters).map((run) => this.view(run))
  }

  show(runId: string): JawsRunView {
    const run = this.store.getJawsRun(runId)
    if (!run) {
      throw new Error('Jaws run not found.')
    }
    return this.view(run)
  }

  async retryReview(input: JawsReviewRetry): Promise<JawsRunView> {
    const retry = jawsReviewRetrySchema.parse(input)
    const run = this.store.getJawsRun(retry.runId)
    if (!run) {
      throw new Error('Jaws run not found.')
    }
    if (run.reviewPublication?.status !== 'failed' && run.reviewPublication?.status !== 'unknown') {
      throw new Error('This Jaws review is not waiting for a retry.')
    }
    return this.reconcileReview(run, true)
  }

  async handleHarnessTerminal(harnessRun: HarnessRun): Promise<void> {
    const run = harnessRun.jawsRunId ? this.store.getJawsRun(harnessRun.jawsRunId) : null
    if (run) {
      await this.reconcileReview(run)
    }
  }

  async resumeReviewPublications(): Promise<void> {
    await Promise.all(
      this.store
        .listJawsRuns()
        .filter(
          (run) =>
            run.reviewPublication?.status === 'planned' ||
            run.reviewPublication?.status === 'publishing'
        )
        .map((run) => this.reconcileReview(run))
    )
  }

  async approve(input: JawsPlanApproval): Promise<JawsRunView> {
    const approval = jawsPlanApprovalSchema.parse(input)
    const run = this.store.getJawsRun(approval.runId)
    if (!run) {
      throw new Error('Jaws run not found.')
    }
    if (run.revision !== approval.revision || run.planHash !== approval.planHash) {
      throw new Error('This plan changed after the approval card was rendered.')
    }
    const pending = this.approvalInFlight.get(approval.runId)
    if (pending) {
      return pending
    }
    const started = this.approveOnce(approval).finally(() => {
      if (this.approvalInFlight.get(approval.runId) === started) {
        this.approvalInFlight.delete(approval.runId)
      }
    })
    this.approvalInFlight.set(approval.runId, started)
    return started
  }

  private async approveOnce(approval: JawsPlanApproval): Promise<JawsRunView> {
    let run = this.store.getJawsRun(approval.runId)
    if (!run) {
      throw new Error('Jaws run not found.')
    }
    if (run.revision !== approval.revision || run.planHash !== approval.planHash) {
      throw new Error('This plan changed after the approval card was rendered.')
    }

    const recoveredHarness = this.findHarnessRun(run)
    if (recoveredHarness) {
      if (run.harnessRunId !== recoveredHarness.id) {
        run = this.store.attachJawsHarnessRun(run.id, recoveredHarness.id)
      }
      return this.view(run)
    }
    if (run.harnessRunId) {
      const message =
        'The approved Harness run is no longer available. Propose a new plan to run it again.'
      this.store.failJawsApproval(run.id, message)
      throw new Error(message)
    }

    run = this.store.markJawsApprovalStarted(run.id)
    try {
      if (run.plan.linear) {
        if (!this.linearClient) {
          throw new Error('runtime_unavailable')
        }
        run = await materializeJawsLinearRun({
          run,
          store: this.store,
          client: this.linearClient
        })
      }
      const harnessRun = await this.harness.start({
        worktree: `id:${run.sourceWorktreeId}`,
        goal: run.plan.goal,
        verificationCommand: run.plan.verificationCommand,
        mode: 'orchestrator',
        expectedBaseSha: run.baseSha,
        jawsRunId: run.id,
        approvedPlan: run.plan,
        ...(run.linearMaterialization?.status === 'confirmed'
          ? { approvedLinearMaterialization: run.linearMaterialization }
          : {})
      })
      run = this.store.attachJawsHarnessRun(run.id, harnessRun.id)
      return this.view(run)
    } catch (error) {
      this.store.failJawsApproval(run.id, errorMessage(error))
      throw error
    }
  }

  private findHarnessRun(run: JawsRun): HarnessRun | null {
    if (run.harnessRunId) {
      try {
        return this.harness.show(run.harnessRunId)
      } catch {
        // Why: a crash may persist the correlated Harness run before the Jaws link.
      }
    }
    return this.harness.list(run.repoId).find((entry) => entry.jawsRunId === run.id) ?? null
  }

  private async reconcileReview(run: JawsRun, force = false): Promise<JawsRunView> {
    const publication = run.reviewPublication
    if (
      !run.plan.review ||
      !publication ||
      !this.reviewClient ||
      (!force && publication.status !== 'planned' && publication.status !== 'publishing')
    ) {
      return this.view(run)
    }
    const pending = this.publicationInFlight.get(run.id)
    if (pending) {
      return pending
    }
    const harnessRun = this.findHarnessRun(run)
    const candidate = harnessRun?.candidates[0]
    if (
      !harnessRun ||
      !candidate ||
      !isHarnessCandidateVerified(candidate, run.plan.verificationCommand)
    ) {
      if (force) {
        throw new Error('A successful Harness verification is required before review retry.')
      }
      return this.view(run)
    }
    const started = publishJawsReview({
      run,
      candidate,
      store: this.store,
      reviewClient: this.reviewClient,
      linearClient: this.linearClient
    })
      .then((updated) => this.view(updated))
      .finally(() => {
        if (this.publicationInFlight.get(run.id) === started) {
          this.publicationInFlight.delete(run.id)
        }
      })
    this.publicationInFlight.set(run.id, started)
    return started
  }

  private view(run: JawsRun): JawsRunView {
    let currentRun = run
    const harnessRun = this.findHarnessRun(run)
    if (harnessRun && currentRun.harnessRunId !== harnessRun.id) {
      currentRun = this.store.attachJawsHarnessRun(currentRun.id, harnessRun.id)
    }
    if (!harnessRun && currentRun.harnessRunId && currentRun.error === null) {
      currentRun = this.store.failJawsApproval(
        currentRun.id,
        'The approved Harness run is no longer available. Propose a new plan to run it again.'
      )
    }
    const harnessStatus = harnessRun ? deriveHarnessRunStatus(harnessRun) : null
    const harnessCandidate = harnessRun?.candidates[0] ?? null
    const linearStatus = currentRun.linearMaterialization?.status
    const reviewStatus = currentRun.reviewPublication?.status
    const status =
      linearStatus === 'decision_required' || linearStatus === 'unknown'
        ? 'decision_required'
        : linearStatus === 'materializing' ||
            (linearStatus === 'planned' && currentRun.approvalStartedAt !== null)
          ? 'materializing_linear'
          : harnessStatus === 'failed'
            ? 'failed'
            : reviewStatus === 'publishing'
              ? 'publishing_review'
              : reviewStatus === 'review_ready'
                ? 'review_ready'
                : harnessStatus === 'completed'
                  ? 'verified'
                  : harnessStatus
                    ? 'running'
                    : currentRun.error
                      ? 'failed'
                      : currentRun.approvalStartedAt
                        ? 'starting'
                        : 'awaiting_approval'
    return {
      ...currentRun,
      status,
      harnessStatus,
      harnessError: harnessRun?.fatalError ?? harnessCandidate?.error ?? null,
      verification: harnessCandidate?.verification ?? null
    }
  }
}
