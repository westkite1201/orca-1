import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { JawsPlanWorktreeOption } from './JawsPlanInputForm'

export function buildJawsWorktreeOptions(
  repos: readonly Repo[],
  worktrees: readonly Worktree[],
  activeWorktreeId: string | null
): JawsPlanWorktreeOption[] {
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  return worktrees
    .flatMap((worktree) => {
      const repo = repoById.get(worktree.repoId)
      return !repo || repo.kind === 'folder' || worktree.isBare
        ? []
        : [
            {
              id: worktree.id,
              label: `${repo.displayName || repo.path} / ${worktree.displayName || worktree.branch}`,
              path: worktree.path,
              branch: worktree.branch
            }
          ]
    })
    .sort((left, right) =>
      left.id === activeWorktreeId
        ? -1
        : right.id === activeWorktreeId
          ? 1
          : left.label.localeCompare(right.label)
    )
}
