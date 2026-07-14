import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
const skillPath = join(projectDir, 'skills', 'competitive-solve', 'SKILL.md')

describe('competitive-solve skill guidance', () => {
  it('keeps both candidates fair, supervised, and independently verified', () => {
    const skill = readFileSync(skillPath, 'utf8')

    expect(skill).toContain('name: competitive-solve')
    expect(skill).toContain('byte-for-byte same task spec')
    for (const agent of ['codex', 'claude']) {
      expect(skill).toMatch(
        new RegExp(
          `orca worktree create[^\\r\\n]*--no-parent[^\\r\\n]*--base-branch[^\\r\\n]*--setup inherit[^\\r\\n]*--agent ${agent}[^\\r\\n]*--json`
        )
      )
    }
    expect(skill).not.toMatch(/orca worktree create[^\r\n]*--prompt/)
    expect(skill).toContain('orca orchestration task-create')
    expect(skill).toContain('orca orchestration dispatch --task')
    expect(skill).toContain('--inject')
    expect(skill).toContain('`worker_done` as a completion signal, not verification')
    expect(skill).toContain(
      'terminal wait --terminal <verification_handle> --for exit --timeout-ms 900000 --json'
    )
    expect(skill).toContain('`result.wait.exitCode`')
    expect(skill).toContain('a non-empty\nactual Git change')
    expect(skill).toContain(
      'Do not merge, cherry-pick, push, retry, select a winner, delete branches or'
    )
  })
})
