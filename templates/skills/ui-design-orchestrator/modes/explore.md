# Mode: explore (multi-design, parallel fan-out)

> Fan out K parallel lanes, each with its own direction skill AND its own model,
> each producing a full implementation on an isolated worktree. User picks one;
> the rest are cleaned up. Then the mandatory audit runs on the winner.

## When to use

- User asks for "options", "a few designs", "explore", or
- New surface with budget for parallel exploration, or
- User wants to compare different design directions or different models.

Not explore: visual iteration on **one file** of an existing surface → route
to `variate` instead (see REGISTRY optional tier); explore is whole-surface
fan-out.

## Flow

```
1. brief → pick K direction skills (installed only)
2. build fan-out spec: lane[i] = {skill, model, worktree}
3. per lane: generate prompt-file from prompts/lane.md
4. spawn lanes (parallel, background)
5. each lane produces: full implementation + design summary
6. present K summaries side-by-side → user picks one
7. merge chosen branch; clean up the other K-1 worktrees
8. audit the merged result (modes/audit.md)
```

## Step 1 — Pick K direction skills

- Read `REGISTRY.md` `direction` tier.
- Pick K (default 3) **installed** direction skills. Presence-check each.
- Aim for diversity: different aesthetics, or same aesthetic with different
  models (see patterns in `MODELS.md`).
- If fewer than K direction skills are installed, reduce K to the installed
  count. Do not install skills automatically.

## Step 2 — Build the fan-out spec

For each lane `i`:

```
lane[i] = {
  skill:   <direction skill name from REGISTRY.md>,
  model:   <exact label or resolved pool ref from MODELS.md>,
  worktree: feature/<task-id>-design-<i>
}
```

- `task-id` comes from the host context (or `manual` if none).
- Resolve each lane's `model` through `MODELS.md`: user-supplied exact label,
  `pool:<name>` reference (resolved via the pool's pick strategy), or the
  default `pool:webdesign`. For direction-heavy skills (imagegen, stitch),
  use `pool:direction`. Validate every resolved label against the catalog —
  reject aliases.

## Step 3 — Create isolated worktrees

For each lane, use the `using-git-worktrees` skill to create/enter:
`feature/<task-id>-design-<i>` under the project root.

**Critical:** lanes must not share a working directory. Each lane writes to its
own worktree so the K full implementations do not collide on disk.

## Step 4 — Generate per-lane prompt-files

For each lane, render `prompts/lane.md` with:

- The full brief (from `prompts/brief.md`)
- The assigned direction skill name
- The build/review/verify chain instructions (same as `single` mode)
- The worktree path

Write the rendered prompt to `<worktree>/.lane-<i>.md`.

## Step 5 — Spawn lanes (parallel)

### Default: host subagent tool (parallel)

The orchestrator runs inside a coding agent — use the host's own
subagent/task tool to spawn K background lanes:

- One subagent per lane; each gets the rendered lane prompt-file content as
  its task.
- Parallel by default; worktrees keep lanes isolated on disk.
- **Shared model:** all lanes run on the host's model profile. Fine when
  lanes differ only by direction skill.

### Per-lane models — two mechanisms (`AGENTS.md`)

When the user assigned **different** `lane_models` per lane:

1. **In-harness profiles (preferred):** if the host supports named subagent
   profiles with a `model:` field (e.g. `omp` agent files), write one lane
   profile per lane and spawn via the subagent tool with that profile —
   per-lane models without leaving the harness. Format in `AGENTS.md` §1a.
2. **External agent CLI:** walk `AGENTS.md` in `priority` order; run each
   entry's `detect` check; spawn all K lanes with the first passing entry's
   `spawn` template (substitute `{{PROMPT_FILE}}`, `{{MODEL}}`,
   `{{WORKTREE}}`), cwd = the lane's worktree, all in background.

If `lane_models` specified different models but neither mechanism is
available, warn that per-lane models were dropped, then use the default
subagent path.

Monitor per the patience schedule in `AGENTS.md`: check every ~10 min (light)
to ~20 min (heavy); ~30 min of zero file changes AND zero process activity =
hang → retry or drop the lane and reduce K.

### Last resort: sequential (no parallelism)

If the host has no subagent tool:

- Run each lane sequentially in the main context using the rendered lane
  prompt.
- **Limitation:** no parallelism, no per-lane model.
- Document this fallback in the completion summary.

## Step 6 — Collect design summaries

Each lane must produce, alongside its full implementation:

- **Direction contract** (when impeccable is installed): THESIS / OWN-WORLD /
  STORY / FIRST VIEWPORT / FORM — the 5-block contract, at most 150 words.
  Otherwise: **Design Read** (one line: page kind + audience + vibe + design system).
- **Three dials** (DESIGN_VARIANCE / MOTION_INTENSITY / VISUAL_DENSITY)
- **Palette** (hex values, locked accent)
- **Type** (display + body font choices)
- **Layout** (hero treatment, grid, key sections)
- **Screenshot** (if `browser-testing-with-devtools` is available — capture the
  rendered hero; degrade to text-only if not)

The full implementation lives on the lane's worktree branch.

## Step 7 — Present and pick

Present the K summaries side-by-side (text in the terminal; screenshots if
captured). For each lane include:

- The lane spec (`skill` + `model`)
- The design summary
- The branch name and run instructions (`git worktree list` + how to start the
  dev server in that worktree)

Ask the user to pick one. Do not auto-pick.

## Step 8 — Merge and clean up

- Merge the chosen lane's branch (per the project's git workflow — typically a
  PR via `gh`, or fast-forward if the user requests).
- Clean up the other K-1 worktrees:
  ```
  git worktree remove <worktree> --force
  git branch -D <branch>
  ```
  (Confirm with the user before deleting if the worktrees have uncommitted
  changes — but lanes should have committed their work.)

## Step 9 — Check the winner (phase 3, mandatory)

Run phase 3 (check before shipping) on the merged result. This is non-negotiable
— the winner is not exempt from checking just because it was chosen.

- **Review:** impeccable `audit` + `critique` (if installed) OR `web-design-guidelines` (fallback)
- **Verify:** `npx impeccable detect` (if installed) + `browser-testing-with-devtools` (always)
- **Post:** `stop-slop` (prose — mandatory)

Fix or explicitly accept every finding. Re-run after fixes until clean.

## Step 10 — Drift prevention (phase 4, if impeccable is installed)

After the winner is shipped:

- `/impeccable document` — refresh DESIGN.md with the winner's values
- `/impeccable extract` — pull the winner's reusable components/tokens into the DS
- `/impeccable doctor` — verify hook health

## Completion

An `explore`-mode task is complete when:

- [ ] K lanes spawned (document which spawn path was used)
- [ ] K design summaries collected (with direction contract if impeccable)
- [ ] User picked one
- [ ] Chosen branch merged
- [ ] Other K-1 worktrees cleaned up
- [ ] Phase 3 ran on the winner (review + verify + stop-slop)
- [ ] Any phase 3 findings fixed or explicitly accepted
- [ ] Phase 4 ran (if impeccable; recommended, skippable in explore)

Report: which spawn path was used (host subagent / `AGENTS.md` agent name /
sequential), the lane specs, the user's pick, audit scores if impeccable, and
the stop-slop result.
