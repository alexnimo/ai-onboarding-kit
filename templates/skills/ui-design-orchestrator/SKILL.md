---
name: ui-design-orchestrator
description: Use for ANY UX/UI decision or frontend implementation — new surfaces, redesigns, component builds, UI copy changes, or visual audits. Routes to the right design skills, enforces mandatory anti-slop audits, and can fan out multiple design directions in parallel with per-lane model control. Do not make UX/UI skill choices inline; defer to this orchestrator.
---

# UI Design Orchestrator

> Master router for all UX/UI work. Dispatches to other skills under the hood.
> Data lives outside this file: skills in `REGISTRY.md`, models in `MODELS.md`,
> spawn agents in `AGENTS.md`. Adding/changing any of those = editing its file.

## When to use

Invoke this skill for **any** of:

- New frontend surface (landing page, portfolio, marketing site, app screen)
- Redesign of an existing surface
- Building or modifying a UI component
- UI copy / text changes inside rendered components
- Visual or prose anti-slop audit of a UI diff
- Icons and visual designs for components
- "Give me a few design options" / multi-design exploration
- Interactive live comparison of variants on an existing surface (route to
  `variate` when installed — see REGISTRY optional tier)

Do **not** use for: pure backend work, non-UI text (docs, READMEs, commit
messages), or API contract design (use `api-and-interface-design`).

## Core principle

This skill is a **router**, not an implementer. It:

1. Reads the brief (see `prompts/brief.md`).
2. Picks an execution **mode**.
3. Dispatches to the right skills per `REGISTRY.md`.
4. Enforces the mandatory **audit** tail.
5. For multi-design, fans out parallel lanes with per-lane models.

Never make UX/UI skill choices inline in the host agent. Always come here.

## Invocation contract

When the host agent invokes this skill, it MUST pass a brief. The brief is the
input contract — without it the orchestrator cannot route. Pass the brief either
inline (the user's request, rephrased into the fields below) or by pointing at a
brief file rendered from `prompts/brief.md`.

### Required fields (every invocation)

| Field | Values | Notes |
|---|---|---|
| `page_kind` | landing / portfolio / redesign / app_screen / editorial / other | Drives direction-skill selection |
| `surface` | web / mobile | Filters the registry by `surface` |
| `audience` | free text | Who scans this and what they want |
| `vibe_words` | free text (the user's own words) | "minimalist", "Linear-style", "Awwwards", etc. |
| `mode` | single / explore / audit / lifecycle | Picks the execution mode (see Step 3); inferable from intent |

### Conditionally required

| Field | Required when | Notes |
|---|---|---|
| `reference_signals` | user provided any | URLs, screenshots, products, brands |
| `brand_assets` | `page_kind=redesign` (always) or any existing brand | logo, color, type, photography — starting material |
| `quiet_constraints` | applicable | accessibility-first / public-sector / regulated / kids' — OVERRIDE aesthetic |
| `content` | always, but may be "TBD — infer from brief" | The actual copy/sections the page must contain |
| `diff_scope` | `mode=audit` (standalone) | File list or `git diff <base>..<head>` |
| `lane_count` | `mode=explore` | Default 3 |
| `lane_models` | `mode=explore` | Per-lane models: exact labels or `pool:<name>` refs from `MODELS.md`; default `pool:webdesign` |
| `lane_skills` | `mode=explore` | Per-lane direction skill names from `REGISTRY.md` (or let the orchestrator pick) |

### Optional fields

| Field | Notes |
|---|---|
| `task_id` | Used for worktree naming in explore mode (`feature/<task_id>-design-<i>`); defaults to `manual` |
| `base_ref` | For audit mode; defaults to the working tree |

### Minimal valid invocations

**Single mode:**
```
page_kind: landing
surface: web
audience: technical buyers
vibe_words: Linear-style minimalist
content: hero, 3 feature sections, pricing, footer
mode: single
```

**Explore mode:**
```
page_kind: portfolio
surface: web
audience: hiring managers
vibe_words: editorial / kinetic-type
mode: explore
lane_count: 3
lane_skills: [design-taste-frontend, minimalist-ui, high-end-visual-design]
lane_models: [glm-5-3-flash, pool:direction, swe-2-high]
```

**Audit mode (standalone):**
```
mode: audit
diff_scope: git diff main..feature/landing-redesign
surface: web
```

If a required field is missing, the orchestrator asks **one** clarifying question
(never a dump). If it can confidently infer the field from context, it declares
the Design Read and proceeds without asking.

## Step 1 — Intake the brief

Collect the brief using `prompts/brief.md` and the Invocation Contract above.
Validate that every required field is present; for missing required fields, ask
one clarifying question or infer from context (declare the inference in the
Design Read).

If the brief is ambiguous, ask **one** clarifying question (never a dump). If you
can confidently infer, declare the design read and proceed.

## Step 2 — Presence-check the registry + detect impeccable

Read `REGISTRY.md`. For every skill you plan to route to, verify it is installed
by probing these locations (in order):

1. `~/.agents/skills/<name>/SKILL.md` — global, shared
2. Agent profile skill dirs (e.g. `~/.claude/skills/`, `~/.windsurf/skills/`)
3. `<project>/.windsurf/skills/<name>/SKILL.md`
4. `<project>/.agents/skills/<name>/SKILL.md`
5. `~/.agents/.skill-lock.json`

Exception: `skillui` is a CLI, not a skill — detect it via
`skillui --version` on PATH instead of the SKILL.md probes above.

**Impeccable detection (critical for phase routing):** check for BOTH:
- The skill: `~/.agents/skills/impeccable/SKILL.md` (gives `/impeccable` commands)
- The npm package: `<project>/.impeccable/config.json` (gives detector CLI + hooks + context files)

If both are present → full four-phase lifecycle is active.
If only the skill is present → phases 1, 2-refine, 3 (audit/critique via commands), 4 are active but no detector CLI or design hooks.
If neither → fall back to kit skills (see fallback table in `REGISTRY.md`).

- Missing **optional** skill → skip that phase/lane; do not fail. Use the fallback.
- Missing **required** skill (`stop-slop`, this orchestrator) →
  warn and emit the install hint:
  `npx skills add <source>@<skill> -g -y` (use the `source` field from the
  registry entry).

## Step 3 — Pick the mode

| User intent | Mode | File |
|---|---|---|
| "Build/design this surface" (single) | `single` | `modes/single.md` |
| "Give me options" / "explore" / "a few designs" / new surface with budget | `explore` | `modes/explore.md` |
| "Audit this diff" / post-implementation check / standalone audit | `audit` | `modes/audit.md` |
| Full lifecycle (context → build+refine → check → drift) | `lifecycle` | `modes/lifecycle.md` |

**Phase 3 (check) is ALWAYS appended** to `single`, `explore`, and `lifecycle` —
it is the mandatory tail, not a separate decision. The standalone `audit` mode
is only for when the user asks to audit an already-shipped diff.

**Phase 4 (drift)** runs after shipping when impeccable is installed. It is
mandatory in `lifecycle` mode and recommended (but skippable) in `single`/`explore`.

## Step 4 — Dispatch per the mode

Follow the chosen mode file. Each mode file is authoritative for its flow,
including fallbacks. Do not duplicate mode logic here.

### Mode summary

- **`single`** — inline routing through the four phases: context → direction(s) →
  build → refine → check (review + verify + post) → drift. Composable direction
  skills may be chained; build does not chain; refine chains applicable passes.
- **`explore`** — fan out K lanes, each `{skill, model, worktree}`. Lanes are
  spawned via the host's subagent tool by default (parallel, fixed-profile
  models); external agent CLIs from `AGENTS.md` are used only when per-lane
  `--model` control is needed. Collect design summaries, present
  side-by-side, user picks one, merge, clean up the rest, then check + drift.
- **`audit`** — standalone phase 3: `stop-slop` (prose) + impeccable `audit` +
  `critique` + `detect` (or `web-design-guidelines` fallback) on the diff.
- **`lifecycle`** — the full four-phase flow explicitly: context → build+refine →
  check → drift. Use when the user wants the complete impeccable lifecycle
  including design system drift prevention.

## Step 5 — Enforce the check (phase 3, mandatory)

After **every** UI implementation (single, explore, or lifecycle), run phase 3
(check before shipping). This is non-negotiable. If `stop-slop` is missing, warn
and emit the install hint — do not silently skip.

A UI task is **not complete** until phase 3 has run. This mirrors the kit's
existing rule: "Frontend changes without frontend verification skill invocation
→ task is NOT complete."

## Step 6 — Run drift prevention (phase 4, when impeccable is installed)

After shipping, if impeccable is installed, run phase 4 (drift prevention):
`/impeccable document` (refresh DESIGN.md) + `/impeccable extract` (pull
components/tokens into the DS) + `/impeccable doctor` (verify hook health).
This is mandatory in `lifecycle` mode and recommended in `single`/`explore`.

## Page kind → impeccable mode mapping

When impeccable is installed, map the brief's `page_kind` to impeccable's four
modes (Persuade / Operate / Read / Experience). The canonical table lives in
`prompts/brief.md` — read it there; the mode comes from the surface, not from
what the company sells. Pass the mapped mode to impeccable commands.

## Direction contract (when impeccable is installed)

When impeccable's new-work flow or `shape` runs, it produces a structured
direction contract (THESIS / OWN-WORLD / STORY / FIRST VIEWPORT / FORM, ≤150
words, comment at the top of the artifact). Adopt it instead of the loose
"Design Read". The canonical definition lives in `prompts/brief.md`. The
finishing review (phase 3) audits the built page against this contract,
promise by promise — a page that promised a radical composition and shipped
the usual template does not pass quietly.

## Per-lane model control (explore mode only)

When fanning out, resolve each lane's model through `MODELS.md`: exact labels
or `pool:<name>` references are both valid; pools resolve via their pick
strategy (`ordered`, `cheapest`, `random`, `spread`). Never use model aliases
— only exact labels or pool refs from `MODELS.md`. Assigning **different**
models to lanes needs either in-harness subagent profiles or an external
agent CLI (`AGENTS.md`); default harness subagents share one model profile.
See `MODELS.md` for assignment patterns.

## Composability rules

Authoritative in `REGISTRY.md` ("Composability rules (recap)"). Key points:
`context`/`direction`/`refine`/`drift` compose; `build`/`review`/`verify` do
not (impeccable `audit` + `critique` both run — different questions); `post`
stacks.

## Spawn fallback chain (explore mode)

1. Host subagent tool → parallel lanes (default; shared model profile).
2. Different models per lane → in-harness profiles if the host supports them,
   else first available agent CLI in `AGENTS.md`.
3. Neither → sequential passes in main context (no parallelism).

Document which path was taken in the completion summary.

## What NOT to do

- Do not make UX/UI skill choices inline in the host agent — defer here.
- Do not skip phase 3 (check before shipping).
- Do not skip phase 4 (drift) in `lifecycle` mode.
- Do not install all registry skills — only what you route to. Missing optional
  skills are skipped, not installed automatically. Use the fallback.
- Do not use model aliases in explore mode.
- Do not fan out without isolated worktrees — lanes must not collide on disk.
- Do not declare a UI task complete before phase 3 has run.
- Do not run impeccable's `audit` on incomplete work — it scores badly because
  it is not done, not because it is bad. Finish the build first.
- Do not confuse impeccable's `audit` (technical quality) with `critique`
  (design quality). Run both for a full picture.
- Do not polish work that is not done. If there are TODOs in the code, you are
  not ready for the `refine` phase.
- Do not hardcode spawn-agent CLIs or model labels in instructions — resolve
  them through `AGENTS.md` and `MODELS.md`. To add an agent or model, edit
  those files only.
