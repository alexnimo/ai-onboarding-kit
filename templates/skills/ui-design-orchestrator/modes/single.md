# Mode: single (default)

> Inline routing for one design through the four phases. The orchestrator runs
> this in the main context. Use when the user wants one design, not options.

## Flow (four phases)

```
Phase 1 (context)  → Phase 2 (build)  → Phase 3 (check)  → Phase 4 (drift)
context            → direction        → review            → drift
                     build            → verify
                     refine           → post (stop-slop)
```

### Phase 1 — Context (if impeccable is installed)

- Check for `PRODUCT.md` + `DESIGN.md`. If missing, run `/impeccable init` +
  `/impeccable document`. If present, read them.
- Run `/impeccable shape` with the brief to produce a design brief via discovery
  interview. Pass the orchestrator's brief as starting context.
- **Fallback (impeccable not installed):** use the orchestrator's brief intake
  (`prompts/brief.md`) + `.agents/PRD.md` for product context.
- **External design-system extraction (if `skillui` on PATH):** when
  `page_kind=redesign` or the brief references an external site/design
  ("match Linear", "like Stripe"), run `skillui --url <site> --format
  design-md` (or `--dir` on the codebase) first — the extracted DESIGN.md +
  tokens feed the direction phase instead of inference. `--mode ultra` for
  animated/interaction-heavy references (needs Playwright).

### Phase 2 — Build

#### Direction
- Read `REGISTRY.md` `direction` tier.
- Pick **one** direction skill based on the brief (surface, vibe, audience).
  - New landing/portfolio/redesign → `design-taste-frontend`
  - Existing surface redesign → `redesign-existing-projects` (audit-first)
  - Premium agency-grade → `high-end-visual-design`
  - Editorial/clean → `minimalist-ui`
  - Google Stitch DS → `stitch-design-taste`
- **Composable:** chain additional `direction` skills with `composable: true`.
  Common chains: `<direction> + imagegen-frontend-web` (reference imagery),
  `<direction> + imagegen-frontend-mobile` (mobile surfaces).
- **When impeccable is installed:** you may delegate direction to impeccable's
  new-work flow (`/impeccable <describe it>`) which has built-in direction
  selection with re-roll and 188 visual-world challengers. Produce the direction
  contract (THESIS/OWN-WORLD/STORY/FIRST VIEWPORT/FORM).
- Presence-check each chosen skill. Skip missing optional; warn on missing required.

#### Build
- Invoke `frontend-ui-engineering` (web) — production-quality UI, design-system
  adherence, a11y, anti-AI-aesthetic. One build skill — do not chain.

#### Refine (if impeccable is installed)
- Run `/impeccable polish` as the default final pass.
- Chain targeted refine commands based on what the surface needs (`typeset`,
  `layout`, `harden`, `optimize`, `bolder`/`quieter`, etc.).
- Do NOT polish incomplete work.
- **Fallback (impeccable not installed):** skip refinement — build goes directly
  to check. This is a quality loss.

#### Interactive variant rounds (if `variate` is installed — complex apps / redesigns)
- For high-stakes sections on an existing surface, offer a `variate` round
  **before** phase 3: it writes live alternatives of one file, the user flips
  them on their own dev server and keeps one. It obeys the project's design
  system by construction (variants must use existing tokens/components), so
  it composes cleanly after build + refine. One open round at a time; close
  with `variate end` before running the check — the kept file is what phase
  3 audits. Skip for greenfield whole-page builds (that's what `explore` and
  direction skills are for).

### Phase 3 — Check (mandatory)

1. **Review:**
   - Impeccable installed → `/impeccable audit` (5-dim, P0-P3) + `/impeccable
     critique` (Nielsen, personas, AI slop verdict). Both run.
   - Impeccable NOT installed → `web-design-guidelines` (fallback).
2. **Verify:**
   - Impeccable installed → `npx impeccable detect` (deterministic CLI).
   - Always → `browser-testing-with-devtools` (MANDATORY responsive: desktop /
     tablet / mobile). This stays regardless — impeccable's detector is
     code-level, not live browser.
3. **Post:** `stop-slop` (prose anti-slop — mandatory, runs alongside impeccable).

Fix or explicitly accept every finding. Re-run after fixes until clean.

### Phase 4 — Drift (if impeccable is installed, recommended)

- `/impeccable document` (refresh DESIGN.md post-build)
- `/impeccable extract` (pull components/tokens into the DS)
- `/impeccable doctor` (verify hook health)
- **Fallback (impeccable not installed):** skip. No drift prevention.

## Completion

A `single`-mode task is complete when:

- [ ] Phase 1: context established (or fallback brief intake done)
- [ ] Phase 2: direction skill(s) ran; build skill ran; refine ran (if impeccable)
- [ ] Phase 3: review + verify + stop-slop all ran; findings fixed or accepted
- [ ] Phase 4: drift prevention ran (if impeccable; recommended, skippable in single)

Report which skills/commands ran, which were skipped (and why), audit scores if
impeccable, and the stop-slop result in the completion summary.
