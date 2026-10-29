# UI Design Orchestrator — Spawn Agent Registry

> Lane-spawn reference for `explore` mode. Lanes are spawned by the **host
> harness first** — external CLIs only when the harness can't give a lane its
> own model. Adding a spawn option = editing this file, not `explore.md`.

## Spawn paths (in order)

| # | Path | Per-lane model? | Requirement |
|---|---|---|---|
| 1a | Host subagent tool + **per-lane profiles** | yes — profile's `model:` field | Harness supports named subagent profiles with a model field (see below) |
| 1b | Host subagent tool, default profile | no — all lanes share the host's model profile | Any host with a subagent/task tool |
| 2 | External agent CLI (table below) | yes — `--model` flag | CLI on PATH |
| 3 | Sequential in main context | no | Always available |

**Choosing:** all lanes share one model (or model doesn't matter) → path 1b.
Lanes need **different** models → try 1a; if the host can't do per-lane
profiles → path 2; warn and drop to 1b if neither works.

## 1a — Per-lane model via subagent profiles

Harnesses like `omp` define subagents as profile files with a `model:`
frontmatter field (roles like `@task`/`@smol`/`@slow`, or a literal label).
To run a lane on a specific model **inside the harness**:

1. Write a lane profile before spawning:
   `~/.omp/agent/agents/design-lane-<i>.md` (global) or
   `<worktree>/.omp/agents/design-lane-<i>.md` (project-scoped):

   ```markdown
   ---
   name: design-lane-<i>
   description: Design exploration lane (ui-design-orchestrator)
   model:
     - "{{MODEL}}"
   ---

   Worker agent: runs one design lane end-to-end on its own worktree.
   Tools: full access. Finish the lane task; emit the design-summary block.
   ```

2. Spawn the lane through the host's subagent/task tool with
   `agent=design-lane-<i>` and the rendered lane prompt as the task.
3. Clean up lane profiles with the worktrees after the winner is picked.

> This is harness-specific. `omp` supports it (verify:
> `~/.omp/agent/agents/` accepts profiles; `omp agents unpack` shows the
> format). If the host's subagent tool has no profile/agent selector, use
> path 2.

## 2 — External agent CLIs

| name | priority | detect | per-lane model | prompt delivery | sandbox / approval |
|---|---|---|---|---|---|
| `devin` | 1 | `devin` on PATH | `--model {{MODEL}}` (exact label required) | `--prompt-file {{PROMPT_FILE}}` | `--permission-mode yolo` |
| `omp` | 2 | `omp` on PATH | `--model {{MODEL}}` (fuzzy match) | positional `@{{PROMPT_FILE}}` | `--auto-approve` |
| `pi` | 3 | `pi` on PATH | `--model {{MODEL}}` (fuzzy match / `provider/id`) | positional `@{{PROMPT_FILE}}` | `-a` (approve) |

**Spawn templates** — one command per lane, cwd = `{{WORKTREE}}`,
placeholders: `{{PROMPT_FILE}}` = rendered lane prompt,
`{{MODEL}}` = label from `MODELS.md`, `{{WORKTREE}}` = lane worktree:

```bash
# devin
devin -p --prompt-file "{{PROMPT_FILE}}" --model "{{MODEL}}" \
      --permission-mode yolo --export

# omp
omp -p --auto-approve --model "{{MODEL}}" --cwd "{{WORKTREE}}" "@{{PROMPT_FILE}}"

# pi (no --cwd; run inside {{WORKTREE}})
pi -p -a --model "{{MODEL}}" "@{{PROMPT_FILE}}"
```

If the factory helper `invoke_coding_agent` is available, prefer it for the
`devin` path — it handles path conversion, log capture, and timeouts.

## Monitoring

All spawned lanes (subagent or CLI): check every ~10 min (light) to ~20 min
(heavy). Declare a hang after ~30 min with zero file changes **and** zero
process activity in the worktree; then retry or drop the lane and reduce K.

## Adding an agent

1. For a host-harness profile mechanism: extend section 1a with the profile
   format + directory.
2. For a CLI: add a row + a spawn block. Requirements: non-interactive mode,
   prompt-file delivery, unattended approval. Add a `--model` flag if the CLI
   has one — that's the whole point of path 2.
