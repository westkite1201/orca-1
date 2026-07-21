// Static repo, source worktree, and Git status fixtures shared by the Harness
// service suites and the scripted runtime caller built on top of them.
import type { HarnessAgent } from '../../shared/harness-types'
import type { GitStatusResult } from '../../shared/git-status-types'
import type { RuntimeWorktreeRecord } from '../../shared/runtime-types'
import type { Repo } from '../../shared/types'

export const BASE_SHA = '0123456789abcdef'
export const REMINTED_PANE_LEAF = '11111111-1111-4111-8111-111111111111'
export const REPO: Repo = {
  id: 'repo-1',
  path: 'repo-root',
  displayName: 'Repo',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'git'
}
export const SOURCE = {
  id: 'source-1',
  repoId: REPO.id,
  parentWorktreeId: null,
  childWorktreeIds: [],
  lineage: null,
  git: {
    path: 'source-root',
    head: BASE_SHA,
    branch: 'main',
    isBare: false,
    isMainWorktree: true
  }
} as unknown as RuntimeWorktreeRecord
export const CLEAN_STATUS: GitStatusResult = {
  entries: [],
  conflictOperation: 'unknown',
  head: BASE_SHA,
  branch: 'main'
}

export const branchRef = (agent: HarnessAgent) => `refs/heads/jaws-harness-run-1-run-1-${agent}`
