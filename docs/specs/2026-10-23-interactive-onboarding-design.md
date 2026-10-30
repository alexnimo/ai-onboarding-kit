# Design: Interactive onboarding flow + multi-agent runner

> Status: draft — builder-check findings incorporated (5 blocking items
> resolved). Awaiting human approval. Companion spec:
> `2026-10-23-managed-instructions-region-design.md` (module 1, approved).
> This is module 2 of the same initiative.

## Problem

Onboarding today is a paste-a-prompt-into-Devin flow with three gaps:

1. **No preview.** The scaffold writes files immediately; the user sees
   changes only via `git diff` after the fact.
2. **No approval step.** Nothing between "run it" and "it's written" —
   no way to decline individual files or inspect MCP merges first.
3. **Devin-only.** The prompts assume Devin. Users who want claude-code,
   omp, or opencode to perform the agent-side steps (placeholder fill,
   conflict resolution) have no supported path.

## Verified constraints

- `node bin/onboard.mjs ui` already serves a zero-dep SPA with exactly
  the review-then-apply machinery this needs: `POST /api/dry-run` →
  session plan, `GET /api/plans/:id/diff|merge`, `POST
  /api/plans/:id/apply {dispositions}` (ui-server.mjs:25-34). Binding is
  127.0.0.1, mutating routes require JSON content-type + same-origin.
- `--dry-run` already exists for `sync` (sync.mjs:5,119) and captures
  per-dest writes without touching disk (`ctx.capture`).
- Runner CLIs verified: `devin -p --prompt-file F --permission-mode yolo`,
  `omp -p --auto-approve "@F"`, `claude -p "<prompt>" --permission-mode
  bypassPermissions`, `opencode run "<msg>"`. Prompt-file delivery for
  claude/opencode = inject file contents into the arg/stdin (no native
  `@file` flag verified).
- Kit design principle #9: extensibility via manifest, not scripts.
- `invoke_coding_agent` factory helper exists for devin paths
  (orchestrator AGENTS.md:76).

## Design

### 1. New subcommand: `onboard`

```
node bin/onboard.mjs onboard --target <path>
    [--profile <target-profile>]      # which agent profile gets configured (default devin)
    [--agent <runner>]                # which CLI runs agent steps: devin|claude|omp|opencode (default devin)
    [--apply]                         # skip review UI, apply the whole plan
    [--resolve-with <runner>]         # hand merge/conflict rows to an agent CLI
    [--install-skills] [--update-skills] [--force] [--manifest <path>]
    [--json]                          # machine-readable plan/report, no UI
```

Naming (decided): `--profile` = the target agent profile the project is
configured for (rules dir, MCP config path, instructions file);
`--agent` = the runner CLI that performs agent steps. `--agent` defaults
to **`devin` explicitly** — never auto-detect: an implicit pick is
invisible to the user. Missing binary = hard error naming it.

**Default = review mode** (the "dry mode" the user asked for):

1. Build the **onboard plan**: the same plan-row vocabulary as sync
   (`{artifact, action, detail, diff}`), where actions include
   `create`, `inject-region`, `merge-keys`, `exists-skip`,
   `install-skill`, `register`.
2. Start the UI server (reuse `startUiServer`) and open the browser at
   an onboard view (`#/onboard?plan=<id>`).
3. User reviews grouped changes with diffs, sets per-artifact
   dispositions (`accept`/`skip`; edit-in-place for text), then applies.
4. Agent-assisted rows: any `merge-keys`/conflict-carrying row can be
   sent to a runner (`--resolve-with`, or a per-row "resolve with agent"
   button) — kit spawns the CLI headless with a resolve prompt
   (dest + marked content + "output the resolved file only"), applies
   the returned content via the existing `opts.content` path in
   `applyDisposition`.
5. `--apply` = non-interactive path: compute plan → apply all → print
   report (for scripting/CI).

### Plan assembly: split ownership (builder-verified)

The earlier "shell emits the whole plan" claim fails three ways:
jq-based MCP/hooks merges can't diff without running the merge anyway,
`npx skills` installs are global and un-previewable, and region
injection + record-state live in node (spec 1). The plan is therefore a
**merge of two row sources**:

| Source | Rows | Preview |
|---|---|---|
| `onboard-plan.mjs` (node) | `create`/`inject-region` for templates + regions, `merge-keys` for MCP/hooks (merged JSON computed in node), `register`, state-file create | Full diffs via `ctx.capture`-style preview writers; JSON merges rendered before/after |
| `scaffold --dry-run` (shell) | `exists-skip`/`missing-skill`/`install-skill`/`copy-skill` fact rows | Text diffs for `cp`-type creates only; `npx`-backed rows are "would run" notices — no diff, out-of-project `~/` paths carry a `global: true` flag the UI renders separately |

- `record-state` gains a dry-run mode so region injection + artifact
  records preview through the same path that applies them (spec 1
  dependency).
- Scaffold `--dry-run` emits fact rows only — it never materializes
  jq merges (node owns JSON merge previews; the merge inputs are
  manifest-derived and deterministic).
- **Apply** stays shell-side for v1 (scaffold runs for real), with
  accepted-row filtering passed via a `--only <file>` plan manifest.
  Full node-side apply is a later cutover if the shell's drift surface
  becomes a problem.

### UI/API reality checks (builder-verified)

- `/api/dry-run` cannot serve onboard: `openProject` returns
  `unadopted` with no file pass for state-less targets. New
  `/api/onboard/plans` (+ `/apply`, `/resolve`) routes are **required**,
  accepting `{target, agent}` — the project isn't registered yet.
- Disposition vocabulary is `accepted|reverted|kit`, not accept/skip —
  onboard `skip` maps to `reverted`. New actions (`create`,
  `inject-region`, `merge-keys`, `install-skill`, `register`,
  `exists-skip`, `missing-skill`, `copy-skill`) must register in
  `SEVERITY`/`ACTIONABLE` (model.mjs:12-14) and the apply gate.
- The existing apply route validates dests via `planDests` and calls
  `applyDisposition` **without** `opts.content` — the resolve-agent
  route must pass returned content explicitly.
- Agent-resolved content on a region dest requires spec 1's
  `applyDisposition` region routing to land first — sequencing
  dependency, not a gap.
- `parseRoute` needs an `onboard` case (model.mjs:196-206).


### 2. Multi-agent runner (`--agent`)

New manifest section `onboardingAgents` (manifest-driven, per principle 9):

```json
"onboardingAgents": {
  "devin":    { "detect": "devin",    "spawn": "devin -p --prompt-file {PROMPT_FILE} --permission-mode yolo --export" },
  "claude":   { "detect": "claude",   "spawn": "claude -p {PROMPT_TEXT} --permission-mode bypassPermissions" },
  "omp":      { "detect": "omp",      "spawn": "omp -p --auto-approve {PROMPT_FILE_ARG}" },
  "opencode": { "detect": "opencode", "spawn": "opencode run {PROMPT_TEXT}" }
}
```

- `detect` = binary checked on PATH at runtime; missing → error naming
  the missing CLI (never silently fall back to another agent).
- `{PROMPT_FILE}` = native prompt-file flag; `{PROMPT_TEXT}`/`{PROMPT_FILE_ARG}`
  = content injected as arg / `@file` positional (spawned via execFile —
  no shell interpolation, no escaping issues).
- opencode's unattended-approval flag is **unverified** — resolve during
  implementation; if none exists, opencode is documented as
  interactive-review-only for resolve steps.
- `--agent` selects *which CLI performs agent steps* (placeholder fill,
  assisted merges); `--profile` stays the target profile (which
  MCP/hooks/rules config gets written). Orthogonal knobs. Default for
  `--agent`: `devin` (explicit — see Naming).

### 3. Prompt generalization

- `prompts/devin-*.md` → runner-agnostic `prompts/onboard.md`,
  `onboard-scaffold.md`, `onboard-fill.md` (rename; no stale copies —
  clean cutover per kit conventions, README references updated).
- Inside the prompts: replace Devin-specific language with the generic
  contract (KIT_PATH, TARGET, AGENT_PROFILE inputs). One prompt set
  serves every runner.
- With `onboard` + `--agent`, the runner CLI only runs the **fill** step
  (`onboard-fill.md`): scaffold/config/registration are deterministic
  and already done by the kit. The combined `onboard.md` stays for
  manual paste-in flows.

### 4. UI: extend, don't add a TUI

Reuse the existing SPA + server (bin/ui). Additions:

- `#/onboard` view: plan summary (N creates, M merges, K skips),
  grouped per-artifact rows with collapsible diffs (existing diff
  renderer), accept/skip toggles, "resolve with agent" on merge rows,
  Apply/Cancel bar.
- **All CLI options are UI-native**: the onboard view's header carries
  the same controls — target path, `--profile` and `--agent` dropdowns
  (agent list rendered from `onboardingAgents`, detected binaries
  marked, missing ones disabled with a reason), install/update-skills
  toggles, and a per-row runner picker on merge rows (defaulting to
  `--resolve-with`/`--agent`). Changing profile/agent re-issues
  `POST /api/onboard/plans` and rebuilds the plan in place. Nothing the
  CLI exposes is CLI-only except `--apply`/`--json` (the UI IS the
  interactive path).
- Why not Bubbletea/Go TUI: the kit is Node-stdlib by design
  (ui-server.mjs:5); a Go TUI adds a runtime + rebuild for zero
  capability gain — diff review and dispositions already work in the
  SPA. Non-interactive environments get `--apply`/`--json`.

### 5. Wiring (files touched, preview)

- `onboard.manifest.json` — `onboardingAgents` (inert to existing code:
  verified nothing validates unknown keys).
- `bin/onboard.mjs` — `onboard` subcommand + arg validation;
  `record-state --dry-run` mode.
- `bin/lib/onboard-plan.mjs` (new) — node-side plan rows: template
  creates, region injection, MCP/hooks merged-JSON previews, registry
  + state-file rows; merges in scaffold fact rows.
- `scaffold.ps1` / `scaffold.sh` — `--dry-run` emitting fact-row JSON
  (exists/missing/install-skill/copy); `--only <file>` accepted-row
  filter for apply.
- `bin/lib/ui-server.mjs` — `POST /api/onboard/plans`,
  `GET /api/onboard/plans/:id`, `POST /api/onboard/plans/:id/apply`,
  `POST /api/onboard/plans/:id/resolve` (passes `opts.content`).
- `bin/ui/` — `#/onboard` view + `parseRoute` case + new-action
  SEVERITY/ACTIONABLE entries.
- `bin/lib/agent-spawn.mjs` (new) — runner detect/spawn/timeout/capture.
- `prompts/` — rename `devin-*.md` → runner-agnostic names; generic
  rewrite; NOTE: spec 1 also edits these files — coordinate (it updates
  them for the foreign-AGENTS.md flow first, this spec renames after).
- `scaffold.ps1`/`scaffold.sh` "Next Steps" strings — drop the
  Devin-specific wording (scaffold.sh:521, ps1:587).
- `README.md` — new flow + prompt-name references.

## Acceptance criteria

1. `onboard --target <empty-dir>` (no `--apply`) produces a plan, opens
   the review UI, writes **nothing** to disk (verified: target dir
   unchanged except nothing).
2. Approving a subset in the UI writes exactly the accepted artifacts;
   skipped ones absent.
3. `onboard --apply --json` on a fresh dir produces identical results
   to interactive accept-all.
4. `--dry-run` scaffold emits plan JSON identical in action set to a
   real run's report (fixture diff).
5. `--agent claude` spawns `claude -p …` with the fill prompt;
   `--agent omp` → `omp -p --auto-approve "@file"`; missing binary →
   clear error, no fallback.
6. A merge/conflict row resolved via `--resolve-with omp` applies the
   agent's returned content through `applyDisposition`'s content path
   (marker scan still enforced).
7. `AGENTS.md:kit-region` injection (spec 1) appears as a plan row with
   a readable diff in the onboard view.
8. Registry entry created only on apply, never on plan.
9. Renamed prompts: no file under `prompts/` references Devin-only
   mechanics; README quick-start uses `onboard --agent`.

## Non-goals

- Terminal-native TUI (Bubbletea or Node TUI lib) — web UI covers the
  stated need; revisit only if headless-SSH usage becomes a complaint.
- Interactive per-hunk editing inside the UI (whole-file accepted
  content edits only, same as today).
- Runner support beyond the four listed (manifest table makes adding
  one a config edit).
- Auto-approving without review when conflicts exist — conflicts always
  require human or agent resolution first.

## Open questions

1. `onboard` subcommand name vs `plan`/`preview` — `onboard` reads
   naturally; confirm.
2. ~~`--via` default / auto-detect~~ — **decided**: `--agent` defaults to
   `devin` explicitly; no auto-detection (user: an implicit pick is
   never obvious).
3. opencode unattended approval: unverified flag — acceptable to ship
   with it documented as "resolve steps may require interactive
   opencode" for v1?
