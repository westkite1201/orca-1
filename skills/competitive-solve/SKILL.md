---
name: competitive-solve
description: >-
  Run one coding goal through Codex and Claude in two independent Orca
  worktrees created from the same clean commit, verify both with the same
  explicit command, and present their changes for human selection. Use for
  competitive solve, parallel implementation comparison, or Codex-vs-Claude
  requests where supervised completion and provenance matter.
---

# Competitive Solve

Run exactly one supervised Codex-vs-Claude comparison. Read the `orca-cli` and
`orchestration` skills first. Use Orca runtime state; do not substitute generic
subagents or `orca orchestration run`.

## Require Inputs

Require:

- A concrete coding goal.
- A non-empty verification command.
- A local Git repository managed by Orca.

Ask for missing inputs before creating worktrees. This workflow does not support
SSH-backed repositories because final Git evidence is collected locally.

## Preserve These Invariants

- Require the source worktree to be clean, including untracked files. Do not
  stash, commit, or discard user changes to make it clean.
- Create exactly two independent top-level worktrees from the same `BASE_SHA`
  with the same inherited setup.
- Give both agents a byte-for-byte same task spec. Only task titles and routing
  metadata may differ.
- Deliver work only through tracked Orca dispatches. Never pass `--prompt` to
  `orca worktree create` in this workflow.
- Treat `worker_done` as a completion signal, not verification. Verify both
  candidates independently with the exact same command.
- Retain every worktree, terminal, task, and dispatch ID returned by Orca. Do
  not infer identity from display names.

## Preflight

Run from a live Orca coordinator terminal:

```bash
orca status --json
test -n "$ORCA_TERMINAL_HANDLE"
test -n "$GOAL"
test -n "$VERIFY_CMD"
test -n "$REPO_PATH"
git -C "$REPO_PATH" status --porcelain=v1 --untracked-files=all
```

Stop if the status output is non-empty. Capture one immutable base and unique
run token:

```bash
BASE_SHA=$(git -C "$REPO_PATH" rev-parse --verify 'HEAD^{commit}')
RUN_TOKEN=$(date -u +%Y%m%dT%H%M%SZ)
orca orchestration task-list --brief --json
```

Inspect existing runtime-global orchestration state, but never reset it. Scope
all later observations to the exact IDs created for this run.

## Create Candidates

Create both candidates without a prompt:

```bash
orca worktree create --repo "path:$REPO_PATH" --name "$RUN_TOKEN-codex" --no-parent --base-branch "$BASE_SHA" --setup inherit --agent codex --json
orca worktree create --repo "path:$REPO_PATH" --name "$RUN_TOKEN-claude" --no-parent --base-branch "$BASE_SHA" --setup inherit --agent claude --json
```

For each response, retain:

- `result.worktree.id`, `path`, `branch`, and `git.head`.
- `result.agentTerminalHandle`, falling back to
  `result.startupTerminal.handle` when necessary.

Require distinct worktree IDs, paths, and branches. Require both `git.head`
values to equal `BASE_SHA` and both `parentWorktreeId` values to be `null`.

Wait for both agents to become ready:

```bash
orca terminal wait --terminal <agent_handle> --for tui-idle --timeout-ms 120000 --json
```

Require `result.wait.satisfied` to be true. If readiness is blocked by trust,
update, or authentication UI, ask the user to resolve it and wait again. For any
other failure, stop and preserve both candidates.

## Dispatch Identical Work

Build one task spec and reuse its exact bytes for both tasks:

```text
Implement this goal in the current worktree:

<goal>

Start SHA: <base_sha>
Do not push, merge, cherry-pick, delete branches or worktrees, or modify another worktree.
```

Create two tasks with distinct titles, then dispatch each once to its recorded
agent terminal:

```bash
orca orchestration task-create --spec "$TASK_SPEC" --task-title "$RUN_TOKEN codex" --json
orca orchestration task-create --spec "$TASK_SPEC" --task-title "$RUN_TOKEN claude" --json
orca orchestration dispatch --task <codex_task_id> --to <codex_handle> --inject --json
orca orchestration dispatch --task <claude_task_id> --to <claude_handle> --inject --json
```

Record each `result.task.id` and `result.dispatch.id`. Require
`result.injected` to be true, then verify both assignments:

```bash
orca orchestration dispatch-show --task <task_id> --json
```

Do not manually mark tasks completed.

## Wait for Completion

Use rolling waits instead of sleeps or terminal peeking:

```bash
orca orchestration check --wait --types worker_done,escalation,decision_gate --timeout-ms 900000 --json
```

Treat a timeout as a checkpoint, not success or failure. Accept a completion
only when its task and dispatch IDs match the recorded pair, Orca accepts its
assigned-pane authority, and both the task and dispatch are completed. Treat a
worker-reported failure as failure even when lifecycle state says completed.
Never fabricate `worker_done` or retry a candidate automatically.

## Verify Independently

After valid completion, launch the exact same user-provided command in a fresh
terminal for each candidate. Make the shell exit with the command's status:

```bash
VERIFY_RUN="${VERIFY_CMD}; __competitive_rc=\$?; exit \$__competitive_rc"
orca terminal create --worktree "id:<worktree_id>" --title "$RUN_TOKEN verify <agent>" --command "$VERIFY_RUN" --json
orca terminal wait --terminal <verification_handle> --for exit --timeout-ms 900000 --json
orca terminal read --terminal <verification_handle> --limit 1000 --json
```

Judge the command by `result.wait.exitCode`, not by the `orca terminal wait`
process exit status. Run no hidden substitute verification command.

Collect actual changes from Git rather than trusting a worker's
`filesModified` claim:

```bash
git -C "$WORKTREE_PATH" status --short --untracked-files=all
git -C "$WORKTREE_PATH" diff --stat "$BASE_SHA" --
git -C "$WORKTREE_PATH" diff --binary "$BASE_SHA" --
git -C "$WORKTREE_PATH" ls-files --others --exclude-standard
```

Call a candidate verified only when it has a valid completion, a non-empty
actual Git change, and verification exit code `0`.

## Report and Stop

Report both candidates in one compact table with:

- Agent and full worktree ID/path.
- Task and dispatch IDs.
- Worker result.
- Changed files and diffstat, including untracked files.
- Verification command and exit code.

Return both worktree IDs so the user can inspect Branch Changes in Orca. Recheck
that the source worktree is still clean.

Do not merge, cherry-pick, push, retry, select a winner, delete branches or
worktrees, close terminals, or clean up during a run. Preserve partial and
failed candidates and ask the user what to do next.
