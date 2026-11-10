# Local coding CLIs

Resolve binaries in the DSH execution environment, then check installed help:

```bash
command -v codex
command -v opencode
codex --version
codex exec --help
codex exec resume --help
opencode --version
opencode run --help
```

A macOS GUI may inherit a different PATH from Terminal. If discovery fails, inspect known
install locations such as `/opt/homebrew/bin`, `/usr/local/bin`, or the user's installation
directory, and record the verified absolute executable. Use it in each launcher; Node-based
CLIs may also need their Node directory added to that command's PATH. Do not change global
shell configuration or treat a missing executable as a reason to reinstall a working CLI.

When more than one official installation exists, record which one was selected. A CLI found
first on PATH may be older than the configured model. If its provider rejects that model,
compare the installed versions and account model catalogs before retrying. An already
installed vendor-bundled CLI may support the existing configuration; retain the user's
default model unless a per-run change is authorized. A successful turn, not a cached model
name or the version string, establishes that the chosen combination works.

The direct CLI examples below were checked against Codex CLI 0.150.1 and OpenCode 1.19.3;
native history integration was checked with Codex CLI 0.166.0-alpha.6 and the VS Code
extension's 0.164.0-alpha.11.1 history query. They start a real
agent and may use the configured provider; `--help`/`--version` alone are discovery.
Choose the worker checkout and absolute run directory before using an example.

Codex also writes runtime state under its original configuration directory. A DSH sandbox
must permit those normal runtime writes as well as the project. If initialization is denied,
request access to the exact runtime directory or report the block; keep `CODEX_HOME` intact
and keep authentication files out of temporary directories. For an authorized coding task,
an explicitly approved per-run `--sandbox workspace-write` can enable project writes; it
does not grant a broader DSH sandbox or change the user's persistent configuration.

### macOS nested sandboxes

If Codex reports `sandbox_apply: Operation not permitted` for every command or file tool
when launched inside DSH, the outer macOS sandbox can prevent Codex from establishing its
own sandbox. Changing the project directory or model will not resolve this condition.
Stop the failed attempt and preserve its evidence; an exit code of zero can still accompany
a final response that says no work was possible.

DSH's `bash` tool supports a reviewed, single-call escalation using
`sandbox_permissions: "danger-full-access"` and a `justification`. This applies only to the
outer launch and requires approval. Keep the child command's `--sandbox workspace-write`,
fixed binary, cwd and task paths; review any launcher script before approving it once.
This is not authorization for arbitrary unsandboxed shell commands or a session/global
permission change. If approval is unavailable, report the block instead of copying
authentication, disabling the child's sandbox, or trying alternative tools to escape it.

## Codex

### Default native history integration

The user requires GUI history integration by default. Resolve this skill directory's real
path to locate the checkout and use its launcher:

```bash
node "$repo_root/tools/codex-worker.mjs" \
  --cwd "$worker_cwd" --task "$task_file" --run-dir "$run_dir" \
  --codex-bin "$codex_bin"
```

Create the task file outside a fresh run directory. For an explicitly authorized coding
task, add `--sandbox workspace-write`; otherwise retain the CLI's configured permissions.
The launcher keeps the original configuration directory, model and authentication. It saves
the PID, exact task snapshot, events, result and exit status. The official app-server first
creates a persistent native `vscode` conversation without a model turn; `exec resume` then
runs the real assignment in that same ID. No extra bootstrap prompt is sent.

The normal Codex list filters out `exec` workers and empty previews. The launcher names the
native conversation `DSH · <task>` and verifies the ordinary history query after the task
creates its first real user turn. It never changes the source or switches thread IDs during
execution. Existing user section placement is retained. Reopen the IDE history to refresh it.
A section query that explicitly includes all sources does not match IDE history behavior.

Only when the user explicitly asks to keep a task out of the GUI, add `--skip-history`.
This skips native registration; it does not delete the CLI's ordinary local transcript.
An unavailable native API or a missing ordinary-history entry is a pending integration
failure, not permission to edit the database or pretend the GUI entry exists.

To verify a native `cli`/`vscode` worker produced by another launcher, or retry a pending entry:

```bash
node "$repo_root/tools/codex-history.mjs" \
  --thread-id "$thread_id" --codex-bin "$codex_bin" \
  --title "DSH · $task_title" --output "$run_dir/history.json"
```

The helper verifies persistence using ordinary history filters with `sourceKinds: []` and
no section filter. Keep its returned ID and `vscode://openai.chatgpt/local/<id>` IDE link
(or `codex://threads/<id>` desktop link) with the run. The explicit `--skip-history` helper
option performs no Codex RPC operations. Metadata APIs do not provide visual inspection
of the UI; distinguish verified list inclusion from a user-confirmed rendered entry.

An existing `exec` thread cannot be registered by changing its section. An official
`thread/fork` import creates a new native ID and preserves the original. Use
`deferGoalContinuation: true` to prevent automatic goal continuation. A fork can have an
empty preview and remain hidden until it receives a real user turn; disclose any confirmation
turn and verify the ordinary list afterward. Record both IDs and their links. Never rewrite
source/preview fields in the database or rollout to bypass the filters.

### Direct CLI interface

`exec` accepts `-` for a prompt on standard input, `--json` for structured stdout,
`--output-last-message` (`-o`) for its final response, and `--cd` (`-C`) for cwd.

```bash
"$codex_bin" exec -C "$worker_cwd" --json -o "$run_dir/result.md" - \
  < "$run_dir/task.md" > "$run_dir/worker.jsonl" 2> "$run_dir/stderr.log"
```

Capture the exit status immediately in the launcher, even on failure; use the foreground
process handle or PID for monitoring. Record the exact session ID from structured output.
For a supported follow-up, start in the same checkout and use that recorded ID:

```bash
cd "$worker_cwd"
"$codex_bin" exec resume --json -o "$run_dir/result.md" "$session_id" - \
  < "$run_dir/task.md" > "$run_dir/worker.jsonl" 2> "$run_dir/stderr.log"
```

Use a new attempt directory for a follow-up so prior evidence survives. The installed
`resume` subcommand does not expose `-C`; the process cwd supplies its repository context.
These commands retain the user's model, authentication and permission configuration.

Official references: [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

## OpenCode

Installed `run --help` supports `--dir`, `--format json`, and a positional message.
Do not assume Codex's `-` stdin convention is shared. Read `task.md` in the launcher and
pass it as one argument using an argument array, without a shell:

```python
import subprocess

# Each value is an absolute, previously verified path; run_dir is a pathlib.Path.
task = (run_dir / "task.md").read_text()
args = [opencode_bin, "run", "--dir", worker_cwd, "--format", "json", "--", task]
with (run_dir / "worker.jsonl").open("w") as output, (run_dir / "stderr.log").open("w") as errors:
    worker = subprocess.Popen(args, cwd=worker_cwd, stdout=output, stderr=errors)
    # Persist worker.pid and start metadata to run.json before waiting.
    exit_code = worker.wait()
    # Persist exit_code and end time to exit.json, including non-zero exits.
    # Save the final response from the documented events to run_dir/result.md.
```

Keep credentials out of task text; positional arguments may be visible in local process
listings. For a follow-up, add `--session <recorded-id>` before `--`, using the original
checkout. Avoid implicit last-session selection when several workers run concurrently.
Keep existing model and permission settings; report approval or authentication blocks to
the user instead of switching to automatic permission grants.

The [official CLI documentation](https://opencode.ai/docs/cli/commands) may describe newer
versions. The installed command's help is authoritative for its available flags.
