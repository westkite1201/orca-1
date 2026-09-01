import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('Jaws planner Codex home serialization', () => {
  it('keeps local and WSL planner launches inside the shared Codex home lock', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../runtime/orca-runtime.ts', import.meta.url)),
      'utf8'
    )
    const planner = source.slice(
      source.indexOf('private async runJawsPlannerForWorktree'),
      source.indexOf('getJawsService()', source.indexOf('private async runJawsPlannerForWorktree'))
    )

    expect(planner).toContain('resolveCodexHomeProcessLockKeyForSpawnEnv')
    expect(planner).toContain('withCodexHomeProcessLock(lockKey')
    expect(planner.indexOf('withCodexHomeProcessLock(lockKey')).toBeLessThan(
      planner.lastIndexOf('runJawsPlanner({')
    )
  })
})
