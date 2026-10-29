# Mode: lifecycle (full four-phase flow)

> The complete impeccable lifecycle: context → build+refine → check → drift.
> Use when the user wants the full design system lifecycle including drift
> prevention. Requires impeccable installed (skill + npm package).

## When to use

- User explicitly asks for the full lifecycle, or
- New surface where the design system must stay in sync, or
- The project has `DESIGN.md` and the user wants to keep it from drifting.

If impeccable is not installed, fall back to `single` mode (which uses kit skills
for phases 1-3 and skips phase 4).

## Prerequisites

- Impeccable skill installed: `~/.agents/skills/impeccable/SKILL.md`
- Impeccable npm package installed: `<project>/.impeccable/config.json`
- If the npm package is missing, offer to run `npx impeccable install` in the
  project root. If the user declines, fall back to `single` mode.

## The four phases

### Phase 1 — Set context

**Goal:** establish product + design system context before any code.

1. Check if `PRODUCT.md` exists in the project root.
   - If missing → run `/impeccable init` (creates PRODUCT.md: platform, users,
     purpose, positioning, evidence, brand commitments).
   - If present → read it. If stale (product changed since last `init`), offer
     to re-run `init`.
2. Check if `DESIGN.md` exists.
   - If missing → run `/impeccable document` (creates DESIGN.md: colors, type,
     components, radii, design rules + `.impeccable/design.json`).
   - If present → read it. If the code has drifted from DESIGN.md, offer to
     re-run `document`.
3. Run `/impeccable shape` with the brief's `page_kind` and `audience`.
   - `shape` runs a structured discovery interview (5-10 questions): purpose,
     users, content, constraints, feeling.
   - It produces a design brief (intent, not UI) that feeds the direction phase.
   - The orchestrator's brief (from `prompts/brief.md`) is passed to `shape` as
     starting context — `shape` deepens it, doesn't restart from zero.
4. **External reference (if `skillui` on PATH):** when `page_kind=redesign`
   or the brief names an external design to match, run
   `skillui --url <site> --format design-md` (or `--dir` on the target
   codebase) before `shape` — extracted tokens/screenshots become reference
   material for the direction contract, and the extracted DESIGN.md can seed
   or be compared against the project's own.

**Output of phase 1:** PRODUCT.md (fresh or confirmed) + DESIGN.md (fresh or
confirmed) + a shape brief for the surface.

**Fallback (impeccable not installed):** orchestrator's own brief intake +
`.agents/PRD.md` for product context. No DESIGN.md — direction skills infer
from code.

### Phase 2 — Build (direction + implementation + refinement)

**Goal:** design + build + refine the surface.

#### 2a. Direction

- Map `page_kind` → impeccable mode (Persuade/Operate/Read/Experience) per the
  table in `SKILL.md`.
- Option A (impeccable new-work flow): run `/impeccable <describe the surface>`.
  Impeccable's new-work flow has a built-in direction selection with re-roll and
  188 visual-world challengers. It shows the design before building (system
  board + first-screen mock). Use this when the brief is open-ended.
- Option B (separate direction skill): pick from `REGISTRY.md` `direction` tier
  (e.g. `design-taste-frontend`, `high-end-visual-design`, `minimalist-ui`).
  Chain composable ones. Use this when the user named a specific aesthetic.
- Either way, produce the **direction contract** (THESIS / OWN-WORLD / STORY /
  FIRST VIEWPORT / FORM) as a comment at the top of the artifact.

#### 2b. Build

- Invoke `frontend-ui-engineering` (web) to implement the UI.
- One build skill — do not chain.

#### 2c. Refine

- Run `/impeccable polish` as the default final pass (alignment, spacing,
  typography, color, interaction states, motion, copy).
- Chain targeted refine commands based on what the surface needs:
  - `bolder` / `quieter` — voice adjustment
  - `typeset` — typography fixes
  - `layout` — spacing and visual rhythm
  - `colorize` — strategic color
  - `animate` — purposeful motion
  - `delight` — small personality moments
  - `harden` — edge cases, i18n, error states
  - `optimize` — UI performance
  - `adapt` — cross-screen/cross-device
  - `clarify` — UX copy
  - `distill` — ruthless subtraction
  - `onboard` — first-run / empty states
- Do NOT polish work that is not done. If there are TODOs, finish the build first.

**Fallback (impeccable not installed):** no refinement tier — build goes directly
to check. This is a quality loss.

#### 2d. Interactive variant rounds (if `variate` is installed — optional)

- For high-stakes sections (hero, nav, pricing — especially on redesigns of
  existing apps), run a `variate` round before phase 3: live file
  alternatives flipped on the user's own dev server. Variants must reuse the
  project's tokens/components, so DESIGN.md holds — variate can't invent
  colors or dependencies, which makes it design-system-safe by construction.
- One open round at a time; `variate end` closes it (kept file stays).
  Phase 3 then audits the kept result; phase 4 `extract` can pull the kept
  section into the DS like any other shipped component.

### Phase 3 — Check before shipping (mandatory)

**Goal:** verify the implementation holds up and reads as intentional.

Run the full phase-3 flow in `modes/audit.md` (steps 2-5): impeccable `audit`
+ `critique` + `detect`, `browser-testing-with-devtools`, `stop-slop`. That
file is authoritative for what each check runs and how findings are resolved.
Lifecycle additions:

- Route impeccable audit P0s to `/impeccable harden`, theming P1s to
  `typeset` + `polish`, the rest to `polish` — then re-audit.
- Fix or explicitly accept every finding; re-run until clean.

### Phase 4 — Keep from drifting (after shipping)

**Goal:** refresh the design system so it holds the values the code actually
uses, and ensure the drift-prevention hooks are healthy.

1. `/impeccable document` — refresh DESIGN.md after the build. It now holds the
   values the code actually uses (not what was planned before the build).
2. `/impeccable extract` — pull reusable components, tokens, and patterns from
   the new surface into the design system. This is how the DS grows.
3. `/impeccable doctor` — check that the design hook is actually running (not
   just registered). A hook can look installed and scan nothing if its script
   path stops resolving after a move.
4. Verify design hooks are active: `/impeccable hooks status`. If off, turn on:
   `/impeccable hooks on`.

**Fallback (impeccable not installed):** no drift tier. The kit's self-improving
docs section handles engineering docs but not design system drift.

## Completion

A `lifecycle`-mode task is complete when:

- [ ] Phase 1: PRODUCT.md + DESIGN.md fresh or confirmed; shape brief produced
- [ ] Phase 2: direction contract written; build complete; refine passes run
- [ ] Phase 3: audit + critique + detect + browser-testing + stop-slop all ran
- [ ] Phase 3: all findings fixed or explicitly accepted
- [ ] Phase 4: DESIGN.md refreshed; components extracted; doctor clean; hooks on

Report: which impeccable commands ran, audit scores (per dimension), critique
verdict, detect finding count, drift actions taken.
