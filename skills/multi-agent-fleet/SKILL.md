---
name: multi-agent-fleet
description: Coordinate coding CLI workers from DSH on the local machine. Use when the user asks DSH to split, dispatch, track, or review work performed by Codex, OpenCode, or other installed coding agents; remote workers require an explicitly authorized host list.
---

# Multi-agent fleet

DSH coordinates the work; installed CLI processes do the assigned tasks.
Start locally. One machine is enough. Remote access to DSH does not authorize remote workers.

Codex workers must appear in the user's native Codex GUI history by default. Skip GUI
registration only when the user explicitly opts out for that task; background execution
is not an opt-out. Keep the original thread ID and transcript, and use the official section
metadata APIs rather than editing Codex databases or changing a thread's source.

## 1. Establish the run

Read the repository instructions, working-tree status, and the user's requested outcome.
Preserve existing edits and record the base commit before creating any worker checkout.
Identify the allowed repositories, writable locations, external actions, and acceptance checks.

Resolve each installed worker's absolute executable path and read its version and `--help`.
For Codex, OpenCode, or another CLI, inspect the relevant subcommand's help as well.
Confirm prompt input, working-directory selection, output format, and supported resume behavior.
Use [local CLI reference](references/local-agents.md) when preparing a local launcher;
verify its examples against the installed binary before using them.

Use the user's existing model, authentication, sandbox, and approval configuration.
Record configuration names or paths when useful, without copying credentials into task files.
Keep the worker's original configuration directory. Do not copy or symlink authentication
files into temporary run directories to work around a sandbox failure. Ask for the specific
runtime-directory access the CLI needs, or report the block. A task may explicitly authorize
a bounded per-run workspace-write mode; that does not authorize broader or global changes.
If a CLI is missing or needs login, report that requirement and continue independent work.
When approval blocks a worker, report the exact action and approval route to the user.
Keep its current permissions; unattended execution is not a reason to widen them.
If the provider rejects the configured model, preserve the error and use a different model
only within the user's authorization. Metadata or a local model cache alone is not proof
that the account can run it. Avoid repeated preflight attempts with the same rejected setup.

Complete this step when the run has a repository, base commit, available worker,
verified invocation interface, permission boundary, and checkable outcome.

## 2. Split the work

Make tasks small enough to review independently, with explicit file ownership and dependencies.
Use one active task per worker. Assign another task only after that run is reconciled.
Begin with one or two workers, within available memory, CPU, disk, and provider capacity.
Serialize tasks that touch the same files or depend on an unfinished change.
Give a research or review worker a read-only assignment when it does not need to edit.

For every writing worker, create a separate Git worktree and a uniquely named branch
from the recorded base. Verify its path, branch, and status before launching the worker.
Keep the user's dirty working tree intact. An uncommitted prerequisite needs an explicitly
chosen transfer method; it is not automatically present in a new worktree.
Read the repository and directory instructions applicable inside each worker worktree.

Create an absolute run directory outside the worker's commit scope, for example
`<run-root>/<run-id>/<task-id>/`. Keep it available after the CLI exits.
Write the task to `task.md`, then verify its contents before dispatch.

```markdown
# <task-id>: <outcome>

Goal: <specific resulting behavior>
Repository: <absolute repository path>
Cwd: <absolute worker worktree path>
Base: <commit>
Scope: <files or directories this worker may change>
Inputs: <relevant instructions, source locations, dependencies>
Acceptance: <observable behavior and required validation commands>
Permissions: <allowed writes and external actions; current approvals remain in effect>
Delivery: return changes, checks, evidence, and blockers in the final response; preserve the diff.
```

State whether commits, pushes, PR creation, or merging are included in the task authorization.
Omit unsupported CLI flags from the launcher rather than guessing their meaning.
Complete this step when every ready task has an isolated checkout and an unambiguous task file.

## 3. Launch and record

Invoke the verified absolute executable from the task's recorded working directory.
Use the CLI's documented file or standard-input mechanism for the task text.
Keep prompts and paths as arguments or file contents; apply proper shell quoting when needed.

For Codex, use the repository's `tools/codex-worker.mjs` launcher described in the
[local reference](references/local-agents.md). It registers `thread.started` in the native
Pinned section and saves `history.json`, retaining the original history and live thread.
If the user has already organized that thread into another section, preserve that placement.
Only pass `--skip-history` after an explicit user opt-out. Normal local transcript persistence
remains enabled; an opt-out from GUI registration does not request deleting local history.
If an older launcher must be used, run `tools/codex-history.mjs` for its exact emitted ID.
Retry a pending registration after worker exit. Report unavailable registration rather than
silently leaving an otherwise required conversation hidden.

Save these artifacts for each attempt:

| Artifact | Contents |
| --- | --- |
| `task.md` | The exact assignment received by this attempt |
| `run.json` | Worker binary/version, cwd, branch/base, start time, PID or process handle |
| `worker.log` | Captured stdout/stderr or documented structured events |
| `exit.json` | Exit code or termination signal and end time, written by the launcher |
| `result.md` | Worker final response saved by the launcher, with changes, checks, and blockers |
| `review.md` | Independent review and acceptance decision |
| `history.json` | Native thread ID, GUI registration result and open link, or explicit opt-out |

Have the worker return its result through the CLI output. The launcher or coordinator saves
`result.md` in the run directory; the worker need not write outside its authorized checkout.
Capture the worker's exit status, including when output is piped to a log.
A log pipeline's successful exit does not establish that the worker succeeded.
If the CLI emits a session ID, record that exact ID with its CLI and attempt.
Use restrictive file access for logs that may contain project data; redact secrets in reports.

Complete this step when a launch has a recorded process identity and durable output paths.
If launch fails, record the failure; do not mark the task as running.
GUI registration is complete only when the native section query returns that same worker
ID. A rollout file or a deep link alone does not establish inclusion in the GUI list.

## 4. Track and recover

Maintain a task table with task, worker, branch, run directory, state, and next action.
Use states such as `queued`, `running`, `blocked`, `review`, and `accepted`.
Compare the recorded process identity, log activity, and task-specific evidence together.
A quiet log or unchanged file count alone does not establish a stalled process.
Inspect only processes recorded for this run; verify identity before interrupting one.

If a worker needs a decision or approval, mark it blocked and report what is missing.
Keep unrelated tasks moving when they can proceed within the existing authorization.
For failures, save the exit status and relevant log excerpt before choosing another attempt.

Resume only when the installed CLI documents it and the exact recorded session ID is available.
Otherwise create a new attempt with the task, current diff, and previous evidence as inputs.
Editing `task.md` does not change the input already consumed by a running CLI.
Steer a running worker only through a supported control interface; terminal keystrokes do not
update a non-interactive execution. If replacement is needed, stop the recorded process,
check its owned children, preserve its work, and write a new attempt's assignment.

Use foreground checks or a tracked background process for the current request.
Create a recurring schedule only when the user explicitly requests one, with its stated cadence.
Complete recovery when each attempt has a known outcome and the next action is recorded.

## 5. Review and integrate

Treat worker completion as a request for review, including a zero exit code.
DSH or a separate reviewer inspects the actual diff against the task and repository instructions.
Check the changed-file scope, behavior, edge cases, and unrelated edits.
Require command, cwd, exit code, and meaningful output for each claimed validation result.
Run the checks needed to verify the change; record failures, skipped checks, and limitations.
Required tests and CI remain acceptance conditions. A timeout or empty test selection is not a pass.
Keep validation within the assigned repository and recorded run artifacts. If runtime
configuration integrity is relevant, prefer metadata or a pre-recorded hash; report missing
evidence rather than dumping global configuration or attempting an unrequested restoration.

Return concrete findings to the worker when changes are needed, using a supported follow-up
or a new attempt. Keep implementation and independent acceptance decisions distinguishable.
Integrate accepted changes in dependency order; validate the combined result when it adds risk.
Use only the commit, push, PR, or merge actions authorized for this task and repository.
Respect branch protection and review requirements; an agent's recommendation grants no authority.

Complete this step when `review.md` records acceptance with evidence, or specific unresolved findings.

## 6. Close the run

Report accepted work, validation, remaining blockers, and where the branches and evidence live.
Include the Codex GUI title/open link and registration state, or the user's explicit opt-out.
Confirm that each launched attempt has an exit record or is deliberately still running.
Retain unfinished or unreviewed worktrees and their logs so another turn can continue safely.
Remove a completed worktree only after its work is preserved, its status is clean, and removal
is appropriate to the user's task. Preserve unexpected changes for review.
Limit cleanup to the exact paths and processes recorded for this run.

## Remote workers

Use this branch only when the user explicitly authorizes remote dispatch.
Record the approved host aliases, repository paths, runtimes, and action scope before connecting.
Verify each host and its installed CLI interface; apply the same isolation and evidence workflow.
Keep authentication on the intended host and preserve its approval and permission settings.
Provisioning machines, opening ports, changing access, and incurring cloud costs require their
own task authorization. Restrict remote mutations and cleanup to the recorded approved targets.
