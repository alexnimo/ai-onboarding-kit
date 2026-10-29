# UI Design Orchestrator — Design Spec

> Status: Approved (2026-08-02)
> Author: brainstorming session
> Owner: ai-onboarding-kit

## 1. Problem

UX/UI decisions currently live inline in `templates/AGENTS.md.tmpl` (the
"Frontend design skill chain (anti-slop)" section, lines 144-157). That section
is a flat table: it lists 4 stages and a "scaffold — add more direction skills
here" note. It does not:

- route among the ~10 installed frontend skills by use case,
- enforce mandatory anti-slop audits after every UI change,
- compose multiple direction skills for higher polish,
- produce multiple competing designs in parallel, or
- assign different models to different design lanes.

The kit also lacks the two new anti-slop skills (`stop-slop` for prose,
`impeccable` for visual) that should run after every UI implementation.

## 2. Goals

1. Move all UX/UI routing decisions out of `AGENTS.md` into a dedicated
   orchestrator skill. `AGENTS.md` only defers to it.
2. Make the orchestrator a **router/orchestrator**, not a casual skill: it
   dispatches to other skills under the hood, enforces mandatory steps, and can
   fan out parallel design lanes.
3. Make the skill set **data-driven** via a registry: adding/removing/chaining
   skills = editing the registry, not rewriting routing logic.
4. Let the registry mix skills from **any repos** — install only what you use;
   the orchestrator routes only among installed skills (presence-checked).
5. Support **multi-design exploration**: fan out K parallel lanes, each with its
   own direction skill AND its own model, producing full implementations on
   isolated worktrees; user picks one, the rest are cleaned up.
6. Enforce **mandatory anti-slop audit** (stop-slop + impeccable) after every UI
   change, via both skill instruction and a PostToolUse hook.

## 3. Non-goals

- Not building a new design system or component library.
- Not replacing the existing frontend skills; the orchestrator routes to them.
- Not auto-installing skills the user did not opt into (except the orchestrator
  itself and the two anti-slop skills, which are required by the orchestrator).
- Not supporting agents that cannot run shell commands for the `devin` CLI
  fan-out path — those agents fall back to `run_subagent` or sequential passes.

## 4. Architecture

### 4.1 Skill structure (lives in the kit as a template)

```
templates/skills/ui-design-orchestrator/
├── SKILL.md            # Router: brief intake → mode → dispatch → audit
├── REGISTRY.md          # Data-driven skill registry (tier/surface/source/composable/trigger)
├── MODELS.md            # Exact model labels for per-lane assignment
├── modes/
│   ├── single.md        # Default inline routing (one design)
│   ├── explore.md       # Parallel subagent fan-out (full implementations)
│   └── audit.md         # Mandatory post-implementation anti-slop sweep
└── prompts/
    ├── brief.md         # Canonical brief template (passed verbatim to subagents)
    ├── lane.md          # Per-lane prompt-file template (brief + skill + chain)
    └── audit.md         # stop-slop + impeccable checklist
```

The scaffold installs this to `~/.agents/skills/ui-design-orchestrator/` (global,
shared by all agents) using the same skip-if-exists behavior as the rest of the
kit.

### 4.2 Three execution modes

**`single` (default).** Inline routing in the main context.

```
brief → route to one direction skill (or chain composable ones)
      → frontend-ui-engineering builds
      → web-design-guidelines reviews
      → browser-testing-with-devtools verifies
      → audit mode runs (mandatory: stop-slop + impeccable)
```

**`explore` (multi-design).** Parallel fan-out.

```
1. Orchestrator reads brief → picks K direction skills from registry (installed only)
2. Build fan-out spec: lane[i] = {skill, model, worktree}
   - model picked from MODELS.md (user can override per lane)
   - worktree = feature/<task-id>-design-<i> (via using-git-worktrees)
3. Per lane, generate prompt-file from prompts/lane.md:
   {brief, assigned skill, build/review/verify chain}
4. Spawn: devin -p --prompt-file .lane-<i>.md --model <model> --permission-mode yolo --export
   (parallel, background; monitor with the factory's patience schedule)
5. Each lane produces: full implementation on its branch + a design summary
   (Design Read, palette, type, screenshot if browser-testing-with-devtools available)
6. Orchestrator presents K summaries side-by-side → user picks one
7. Merge chosen branch; clean up the other K-1 worktrees
8. Run audit mode (stop-slop + impeccable) on the merged result
```

**`audit` (always-on tail).** Runs `stop-slop` (prose) + `impeccable` (visual) on
the diff. Appended to both modes; also runnable standalone.

### 4.3 Skill registry (data-driven core)

Every skill is tagged with a **tier** so routing logic reads tiers, not names:

| Tier | Meaning | When invoked | Composable? |
|---|---|---|---|
| `always` | Mandatory on every UI task | Direction inference + brief | n/a |
| `post` | Mandatory *after* implementation | Anti-slop audit | stacked |
| `direction` | Choose-one (or chain) for new surfaces | New/redesign surface | yes (chainable) |
| `build` | The implementation | After direction locked | no |
| `review` | Audit rendered UI | After build | no |
| `verify` | Browser/responsive test | After review | no |
| `optional` | Route by use case | Mobile, React perf, etc. | case-by-case |

Each registry entry also carries: `source` (repo), `required` (bool),
`surface` (web/mobile/both), `trigger` (one-line when-to-use), `composable`
(bool). The orchestrator **presence-checks** each entry against the 5 skill
search locations the kit already uses before routing; missing optional skills
are skipped, missing required skills produce a warning + an install hint
(`npx skills add <source>@<skill> -g -y`).

### 4.4 Per-lane model control (explore mode)

Two mechanisms, in priority order:

| Mechanism | Model control | Agent file needed? | Where it works |
|---|---|---|---|
| `devin` CLI subprocess (`devin -p --prompt-file ... --model <exact-label> --permission-mode yolo --export`) | **Yes** — `--model` per invocation | No persistent file; prompt-file generated per lane at runtime | Devin + any agent that can shell out |
| `run_subagent` tool (`subagent_general` profile) | No (fixed profiles) | No (built-in) | Devin only |

The orchestrator prefers the `devin` CLI path (matches FACTORY.md's
`invoke_coding_agent` pattern) for per-lane model control. Fallback chain:

1. `devin` CLI available → per-lane `--model` (full control)
2. `devin` CLI unavailable, `run_subagent` available → parallel but no per-lane model
3. Neither → sequential passes in main context (no parallelism)

`MODELS.md` lists the exact model labels the factory uses (`glm-5.2`,
`kimi-k2.7`, `swe-1.7`, `claude-opus-4.8`, etc.) so the orchestrator picks valid
labels, not aliases. Fan-out specs support: different styles + same model, same
style + different models, or fully mixed.

### 4.5 Anti-slop enforcement (both)

- **Skill instruction:** `audit` mode is mandated at the end of every UI task in
  `SKILL.md`.
- **Hook:** a new `PostToolUse` hook in `onboard.manifest.json` fires the audit
  after `edit`/`write` on UI file extensions (`.tsx`, `.jsx`, `.vue`, `.svelte`,
  `.html`, `.css`). Only active for hook-capable agents (devin/hermes/opencode/
  claude-code); the skill instruction covers the rest.

## 5. Integration into the onboarding kit

### 5.1 Manifest changes (`onboard.manifest.json`)

- `skills` array: add `stop-slop` (hardikpandya/stop-slop) and `impeccable`
  (pbakaus/impeccable) as `required: false` (optional, routed by the
  orchestrator). Add `ui-design-orchestrator` — but since it ships as a kit
  template (not via `npx skills add`), it's handled by the scaffold script, not
  the manifest's `skills` array. Instead a new `templateSkills` array lists
  skills the scaffold copies from `templates/skills/` to `~/.agents/skills/`.
- `hooks` array: add a `PostToolUse` hook matching `edit|write` on UI files that
  invokes the audit.
- New `templateSkills` array: `[{ "src": "templates/skills/ui-design-orchestrator", "dest": "ui-design-orchestrator", "required": true }]`.

### 5.2 AGENTS.md.tmpl changes

Replace lines 144-157 (the inline "Frontend design skill chain (anti-slop)"
section) with a one-line deferral:

> For ANY UX/UI decision or frontend implementation, invoke the
> `ui-design-orchestrator` skill. It routes to the right design skills, enforces
> mandatory anti-slop audits, and can fan out multiple design directions with
> per-lane model control. Do not make UX/UI skill choices inline.

### 5.3 Scaffold script changes

`scaffold.ps1` and `scaffold.sh` gain a `templateSkills` install step: for each
entry in `manifest.templateSkills`, copy `templates/skills/<src>` to
`~/.agents/skills/<dest>/` if not already present (skip-if-exists, same as the
skill install behavior). This runs during the normal scaffold flow and during
`--install-skills`.

## 6. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Architecture | Hybrid (Approach C) | Single-mode routing default + subagent fan-out for multi-design, graceful fallback. Portable across the 6 agent profiles. |
| Distribution | Inside the kit (template) | Versioned with the kit, no separate repo to maintain. Structured so it can be published later. |
| Anti-slop enforcement | Both (instruction + hook) | Skill instruction primary; hook as safety net for hook-capable agents. |
| Explore-mode subagent output | Full implementations | Each lane builds a complete working UI on its own worktree. Orchestrator also emits a design summary per lane for cheap comparison before spinning up branches. |

## 7. Open items / future work

- Mobile build skill (gap): the registry has `imagegen-frontend-mobile` for
  direction but no dedicated mobile build skill. Fill later.
- Publish `ui-design-orchestrator` as its own GitHub repo when stable, then move
  it from `templateSkills` to the `skills` array (no rework — structure is
  repo-publish-ready).
- Screenshot capture in explore mode depends on `browser-testing-with-devtools`
  being available; degrade to text-only summary if not.

## 8. Verification

- `onboard.manifest.json` validates as JSON.
- Dry-run scaffold against a temp dir confirms the orchestrator skill is copied
  to `~/.agents/skills/ui-design-orchestrator/` and `AGENTS.md` renders with the
  deferral line.
- The orchestrator `SKILL.md` frontmatter (`name`, `description`) is valid and
  discoverable.
- The PostToolUse hook JSON is well-formed and matches the existing hooks schema.

## 9. Addendum (2026-10-11): external registries for models and spawn agents

Two hardcoded lists were moved to external registry files, matching the
`REGISTRY.md` pattern already used for skills:

- **`MODELS.md`** is now a **task-pool registry**, not a flat table. Pools
  (`webdesign`, `direction`, `build`, `iteration`, `review`) hold ordered
  candidate lists with optional per-candidate "when to prefer" hints and a
  declared pick strategy (`ordered` / `cheapest` / `random` / `spread`). All
  model references in the skill resolve to exact labels **or** `pool:<name>`
  refs through it. The catalog keeps canonical dashed labels (e.g.
  `glm-5-3-flash`); dotted labels in this spec (`glm-5.2`, `claude-opus-4.8`)
  were stale — see `MODELS.md` for current labels.
- **`AGENTS.md`** (new) documents lane-spawn paths for `explore` mode.
  Default: the host agent's own subagent tool (parallel, shared model
  profile). When different models are assigned per lane, two mechanisms in
  priority order: (a) **in-harness subagent profiles** — harnesses like `omp`
  define subagents as profile files with a `model:` frontmatter field
  (`~/.omp/agent/agents/<name>.md`), so a lane-specific profile gives
  per-lane models without leaving the harness; (b) **external agent CLIs**
  (`devin`, `omp`, `pi`) with `--model` flags, `detect`, and `spawn`
  templates using `{{PROMPT_FILE}}`/`{{MODEL}}`/`{{WORKTREE}}` placeholders.
  §4.2/§4.4 devin-CLI spawn references are superseded by this ordering.

Also deduplicated: the `page_kind`→impeccable-mode table and the direction
contract are canonical in `prompts/brief.md`; composability rules are
canonical in `REGISTRY.md`; phase-3 detail is canonical in `modes/audit.md`.
Other files reference rather than restate them.
