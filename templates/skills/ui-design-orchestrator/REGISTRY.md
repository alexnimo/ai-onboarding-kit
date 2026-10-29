# UI Design Orchestrator — Skill Registry

> Data-driven routing. The orchestrator reads tiers, not skill names.
> **Adding/chaining skills = editing this file**, not `SKILL.md`.

## Tiers

| Tier | Phase | Meaning | When invoked | Composable? |
|---|---|---|---|---|
| `always` | — | Mandatory on every UI task | Entry point | n/a |
| `context` | 1 — Set context | Establish product + design system context | Before direction | yes (init + document + shape) |
| `direction` | 2 — Build (inference) | Choose-one (or chain) for new surfaces | New/redesign surface | yes (chainable) |
| `build` | 2 — Build (implementation) | The implementation | After direction locked | no |
| `refine` | 2 — Build (refinement) | Targeted refinement passes on built UI | After build, before review | yes (chain applicable passes) |
| `review` | 3 — Check before shipping | Design + technical quality audit | After refine | no |
| `verify` | 3 — Check before shipping | Browser/responsive test | After review | no |
| `post` | 3 — Check before shipping | Mandatory anti-slop (prose) | After verify | stacked |
| `audit-fix` | 3 — Check before shipping (remediation) | Dedicated audit + fix lanes for findings | After review/verify findings, or standalone cleanup | yes (chain one fix lane per finding type) |
| `drift` | 4 — Keep from drifting | Refresh design system + extract + hook health | After shipping | yes (document + extract + doctor) |
| `optional` | case-by-case | Route by use case | Mobile, React perf, etc. | case-by-case |

## Entry fields

| Field | Description |
|---|---|
| `name` | Skill folder name (used for presence-check + invocation) |
| `source` | GitHub repo for install (`owner/repo`) — used by `npx skills add` |
| `skill` | Skill folder name within the repo (may differ from `name`) |
| `tier` | One of the tiers above |
| `surface` | `web` / `mobile` / `both` |
| `required` | `true` = orchestrator warns if missing; `false` = skip if missing |
| `composable` | `true` = may chain with other composable same-tier skills |
| `commands` | (impeccable only) specific `/impeccable` commands invoked at this tier |
| `trigger` | One-line when-to-use |

## Required skills (orchestrator depends on these)

| name | source | skill | tier | surface | required | composable | trigger |
|---|---|---|---|---|---|---|---|
| `ui-design-orchestrator` | (this kit) | ui-design-orchestrator | always | both | true | n/a | Entry point for all UX/UI work |
| `stop-slop` | hardikpandya/stop-slop | stop-slop | post | both | true | stacked | After any UI copy/text change — removes AI prose tells |

## Impeccable — four-phase toolkit (when installed, owns phases 1, 2-refine, 3, 4)

Impeccable is not a single skill — it's a 20+ command toolkit spanning the entire design lifecycle.
When installed, it participates in four phases via specific commands. The orchestrator invokes the
right commands per phase. When impeccable is NOT installed, the orchestrator falls back to kit skills
(noted per tier below).

**Two installation paths (both needed for full flow):**
1. `npx skills add pbakaus/impeccable@impeccable -g -y` — installs the skill (gives the agent `/impeccable` commands)
2. `npx impeccable install` (run in the project root) — installs the npm package (detector CLI, design hooks, context file scaffolding)

The orchestrator checks for `.impeccable/config.json` to determine if the npm package is active.

### Phase 1 — Set context (`context` tier)

| name | source | commands | surface | required | composable | trigger |
|---|---|---|---|---|---|---|
| `impeccable` | pbakaus/impeccable | `init`, `document`, `shape` | both | false | yes | Before any direction skill — establish/refresh PRODUCT.md + DESIGN.md + surface brief. `init` creates PRODUCT.md (strategy); `document` creates DESIGN.md (visual system) + `.impeccable/design.json`; `shape` runs a discovery interview producing a design brief. |
| `skillui` | amaancoderx/npxskillui | `skillui --url/--dir/--repo` (CLI, not a skill — detect via PATH: `skillui --version`; install `npm i -g skillui`) | both | false | no | Extract a design system from an external site or codebase → DESIGN.md + token JSONs + screenshots. Use in phase 1 when `page_kind=redesign` or the brief says "match/like <site>": run `skillui --url <site> --format design-md` (or `--dir` on the target repo), feed the extracted DESIGN.md/tokens to `shape` + direction skills. Complements impeccable `document` (which reads our own code) — skillui is for external/foreign design systems. |

> **Fallback (impeccable not installed):** orchestrator's own brief intake (`prompts/brief.md`) + `.agents/PRD.md` for product context. No DESIGN.md equivalent — direction skills infer from code.

### Phase 2 — Build: direction (`direction` tier, choose-one or chain)

| name | source | skill | surface | required | composable | trigger |
|---|---|---|---|---|---|---|
| `design-taste-frontend` | Leonxlnx/taste-skill | taste-skill | web | false | true | New landing/portfolio/redesign — infer direction first |
| `high-end-visual-design` | Leonxlnx/taste-skill | soft-skill | web | false | true | Premium agency-grade aesthetic |
| `minimalist-ui` | Leonxlnx/taste-skill | minimalist-skill | web | false | true | Editorial / clean / warm monochrome |
| `stitch-design-taste` | Leonxlnx/taste-skill | stitch-skill | web | false | true | Google Stitch design-system direction |
| `imagegen-frontend-web` | Leonxlnx/taste-skill | imagegen-frontend-web | web | false | true | Reference imagery per section (composes with another direction skill) |
| `imagegen-frontend-mobile` | Leonxlnx/taste-skill | imagegen-frontend-mobile | mobile | false | true | Mobile screen reference imagery |
| `redesign-existing-projects` | Leonxlnx/taste-skill | redesign-skill | both | false | true | Redesigning an *existing* surface (audit-first) |

> **When impeccable is installed:** `/impeccable shape` (phase 1) feeds the direction skills. Impeccable's own new-work flow (`/impeccable <describe it>`) can also serve as the direction engine — it has a built-in direction selection with re-roll and 188 visual-world challengers. The orchestrator may delegate direction to impeccable's new-work flow instead of a separate direction skill when the brief calls for it.

### Phase 2 — Build: implementation (`build` tier, one per stage)

| name | source | skill | surface | required | composable | trigger |
|---|---|---|---|---|---|---|
| `frontend-ui-engineering` | addyosmani/agent-skills | frontend-ui-engineering | web | false | no | Implement production-quality UI (design-system, a11y, anti-AI-aesthetic) |

> **Gaps to fill later:** a dedicated mobile `build` skill (currently only `imagegen-frontend-mobile` for direction).

### Phase 2 — Build: refinement (`refine` tier, chain applicable passes)

| name | source | commands | surface | required | composable | trigger |
|---|---|---|---|---|---|---|
| `impeccable` | pbakaus/impeccable | `polish`, `bolder`, `quieter`, `typeset`, `layout`, `colorize`, `animate`, `delight`, `overdrive`, `adapt`, `clarify`, `distill`, `harden`, `onboard`, `optimize` | both | false | yes | After build, before review — targeted refinement based on what the surface needs. `polish` is the default final pass (alignment, spacing, typography, color, interaction states, motion, copy). Other commands are targeted: `bolder`/`quieter` for voice, `typeset` for type, `layout` for spacing, `harden` for edge cases, `optimize` for perf, etc. |

> **Fallback (impeccable not installed):** no refinement tier — build goes directly to review. This is a quality loss; install impeccable for the full flow.

### Phase 3 — Check before shipping (`review` + `verify` + `post` tiers)

| name | source | skill | tier | commands | surface | required | composable | trigger |
|---|---|---|---|---|---|---|---|---|
| `impeccable` | pbakaus/impeccable | impeccable | review | `audit`, `critique` | both | false | no | `audit`: 5-dimension technical check (a11y, perf, theming, responsive, anti-patterns) with P0-P3 severity. `critique`: design review with Nielsen heuristics, persona tests, cognitive load, AI slop verdict. Both run (they ask different questions: audit = "does this hold up", critique = "is it any good"). |
| `impeccable` | pbakaus/impeccable | impeccable | verify | `detect` (CLI) | web | false | no | `npx impeccable detect` — deterministic detector checks (contrast, typography drift, layout overflow, AI tells, design-system violations). Exit code 2 = findings. Also available as `--json` for CI. |
| `browser-testing-with-devtools` | addyosmani/agent-skills | browser-testing-with-devtools | verify | — | both | false | no | MANDATORY responsive verification (desktop/tablet/mobile). Stays even when impeccable is installed — impeccable's detector is code-level, not live browser. |
| `stop-slop` | hardikpandya/stop-slop | stop-slop | post | — | both | true | stacked | After any UI copy/text change — removes AI prose tells. Runs alongside impeccable (prose vs visual — complementary, not overlapping). |

> **Fallback (impeccable not installed):** `web-design-guidelines` (review) replaces impeccable's audit + critique. Less rigorous (no P0-P3, no persona tests, no Nielsen scoring) but covers accessibility + Web Interface Guidelines. `browser-testing-with-devtools` stays regardless.

| name | source | skill | tier | surface | required | composable | trigger |
|---|---|---|---|---|---|---|---|
| `web-design-guidelines` | vercel-labs/agent-skills | web-design-guidelines | review | web | false | no | FALLBACK review when impeccable is not installed — audit rendered UI vs Web Interface Guidelines / accessibility |

## Phase 3 — Remediation (`audit-fix` tier, chain one fix lane per finding type)

| name | source | skill | tier | surface | required | composable | trigger |
|---|---|---|---|---|---|---|---|
| `improve-ui` | ibelick/ui-skills | improve-ui | audit-fix | both | false | false | Contract-gated audit of an existing surface; writes remediation plans to design-plans/ for the build phase |
| `baseline-ui` | ibelick/ui-skills | baseline-ui | audit-fix | web | false | true | Fast deslop pass: spacing, hierarchy, typography, small layout fixes |
| `fixing-accessibility` | ibelick/ui-skills | fixing-accessibility | audit-fix | web | false | true | Fix lane for accessibility findings (names, keyboard, focus first) |
| `fixing-motion-performance` | ibelick/ui-skills | fixing-motion-performance | audit-fix | web | false | true | Fix lane for motion/perf findings (compositor-first, never-patterns) |
| `fixing-metadata` | ibelick/ui-skills | fixing-metadata | audit-fix | web | false | true | Fix lane for metadata/SEO/social-card findings |
| `create-design-md` | ibelick/ui-skills | create-design-md | audit-fix | both | false | false | Standalone DESIGN.md reconstruction (repo or URL mode) — no-impeccable fallback for design-doc drift |

> T2 (modes/audit-fix.md) defines the finding-type routing and the fix-loop contract that dispatches these lanes. All rows are `required: false` — when a lane is missing, the orchestrator falls back to its generic inline fix; never auto-install.

### Phase 4 — Keep from drifting (`drift` tier, after shipping)

| name | source | commands | surface | required | composable | trigger |
|---|---|---|---|---|---|---|
| `impeccable` | pbakaus/impeccable | `document`, `extract`, `doctor` | both | false | yes | After shipping — `document` refreshes DESIGN.md so it holds the values the code actually uses; `extract` pulls reusable components, tokens, and patterns into the design system; `doctor` checks hook health (ensures the design hook is actually running, not just registered). |

> **Fallback (impeccable not installed):** no drift tier. The kit's self-improving docs section in AGENTS.md handles engineering docs but not design system drift. Install impeccable for design system drift prevention.

### Phase 4 — Design hooks (automatic, when npm package installed)

When `npx impeccable install` has been run in the project, impeccable installs its **own** provider-native design hooks (Claude Code `.claude/settings.local.json`, Codex `.codex/hooks.json`, Cursor `.cursor/hooks.json`, Copilot `.github/hooks/impeccable.json`). These hooks run the detector automatically on UI edits with a two-speed design (per-edit: only broken things; end-of-session: full rule set).

**Hook overlap resolution:** the orchestrator's `PostToolUse` hook (from the kit manifest) checks for `.impeccable/config.json`. If present → **defer to impeccable's own hooks** (they're smarter — two-speed, DESIGN.md-aware). If absent → run `npx impeccable detect` as fallback (if the npm package is available) or the orchestrator's audit mode.

## Optional (route by use case)

| name | source | skill | tier | surface | required | composable | trigger |
|---|---|---|---|---|---|---|---|
| `vercel-react-best-practices` | vercel-labs/agent-skills | react-best-practices | optional | web | false | case | React/Next.js performance optimization |
| `variate` | Nutlope/variate | variate | optional | web | false | case | Interactive live variant rounds on ONE file: user flips alternatives on their own dev server, picks live, then narrows. Route here for complex apps/redesigns — a refinement step inside the flow (after build/refine, before phase 3), not a replacement for explore mode. |

## Page kind → impeccable mode mapping

Impeccable names four modes (per-surface, not per-company). The orchestrator's `page_kind` brief field maps to them:

| Orchestrator `page_kind` | Impeccable mode | What it means |
|---|---|---|
| landing / marketing / pricing / campaign | Persuade | The visitor decides and acts. Design earns attention. |
| app_screen / dashboard / editor / admin / tool | Operate | The visitor completes a task. Density, predictable controls. |
| docs / guide / help / changelog | Read | The visitor understands something. Comprehension first. |
| portfolio / gallery / showcase | Experience | The visitor is inside the work. The artifact leads. |

The mode comes from the surface, not from what the company sells. A developer tool's landing page is still Persuade. A fashion house's documentation is still Read.

## Presence-check locations (probe in order)

1. `~/.agents/skills/<name>/SKILL.md` — global, shared by all agents
2. Agent profile skill dirs (e.g. `~/.claude/skills/`, `~/.windsurf/skills/`)
3. `<project>/.windsurf/skills/<name>/SKILL.md` — project-level
4. `<project>/.agents/skills/<name>/SKILL.md` — project-level
5. `~/.agents/.skill-lock.json` — global lock file

For impeccable's npm package, also check: `<project>/.impeccable/config.json` (indicates `npx impeccable install` has been run).

If a skill exists in ANY of these, it is considered installed.

## Install hints (when a skill is missing)

**Skill (gives the agent `/impeccable` commands):**
```
npx skills add pbakaus/impeccable@impeccable -g -y
```

**Npm package (gives the project detector CLI + hooks + context files):**
```
npx impeccable install
```

Both are needed for the full four-phase flow. The skill alone gives commands but no detector or hooks. The npm package alone gives the detector but no agent-facing commands.

**stop-slop:**
```
npx skills add hardikpandya/stop-slop@stop-slop -g -y
```

## Composability rules (recap)

- `context` skills compose — `init` + `document` + `shape` may all run in sequence.
- `direction` skills compose — chain several for higher polish.
- `build` does NOT compose — one per stage.
- `refine` skills compose — chain applicable passes (e.g. `polish` + `typeset` + `harden`).
- `review` / `verify` do NOT compose — one per stage (impeccable `audit` + `critique` are the exception — both run because they ask different questions).
- `post` skills stack — `stop-slop` runs (prose). Impeccable's visual anti-slop is handled by `critique` + `detect` in the review/verify tiers, not as a separate `post`.
- `drift` skills compose — `document` + `extract` + `doctor` may all run.
- `optional` skills are case-by-case; consult the trigger column.

## Fallback summary (impeccable not installed)

| Phase | With impeccable | Without impeccable (fallback) |
|---|---|---|
| 1 — Set context | `init` + `document` + `shape` → PRODUCT.md + DESIGN.md | Orchestrator brief intake + `.agents/PRD.md` |
| 2 — Direction | Impeccable new-work flow OR separate direction skills | Separate direction skills |
| 2 — Build | `frontend-ui-engineering` | `frontend-ui-engineering` |
| 2 — Refine | `polish` + targeted refine commands | (skipped — no refinement tier) |
| 3 — Review | `audit` (5-dim, P0-P3) + `critique` (Nielsen, personas) | `web-design-guidelines` (less rigorous) |
| 3 — Verify | `detect` (CLI) + `browser-testing-with-devtools` (responsive) | `browser-testing-with-devtools` only |
| 3 — Post | `stop-slop` (prose) | `stop-slop` (prose) |
| 4 — Drift | `document` + `extract` + `doctor` + design hooks | (skipped — no drift tier) |

## How to add a new skill

1. Add a row to the appropriate tier table above.
2. Set `source`, `skill`, `surface`, `required`, `composable`, `trigger`.
3. For impeccable commands, set `commands` to the specific `/impeccable` commands.
4. If `required: true`, the orchestrator will warn when it is missing.
5. No code changes to `SKILL.md` — routing reads this file.
