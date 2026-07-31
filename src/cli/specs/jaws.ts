import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const JAWS_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['jaws', 'plan', 'propose'],
    summary: 'Propose a Jaws multi-worktree execution plan',
    usage: 'orca jaws plan propose --worktree <selector> --plan-file <path|-> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree', 'plan-file'],
    notes: [
      'Use --plan-file - to read the plan JSON from stdin.',
      'Plan JSON shape: {"goal":"...","verificationCommand":"...","maxConcurrency":1..3,"tasks":[...],"review":{"provider":"github","baseBranch":"main","createDraft":true}}. Use 1..8 unique, acyclic tasks.'
    ],
    examples: [
      'orca jaws plan propose --worktree active --plan-file jaws-plan.json --json',
      'orca jaws plan propose --worktree active --plan-file - --json'
    ]
  },
  {
    path: ['jaws', 'run', 'list'],
    summary: 'List Jaws plans and runs',
    usage: 'orca jaws run list [--repo <selector>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'worktree'],
    examples: ['orca jaws run list --worktree active --json']
  },
  {
    path: ['jaws', 'run', 'show'],
    summary: 'Show one Jaws plan or run',
    usage: 'orca jaws run show <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'id'],
    positionalArgs: ['id'],
    examples: ['orca jaws run show 2f9e... --json']
  }
]
