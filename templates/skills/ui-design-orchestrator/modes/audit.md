# Mode: audit (standalone phase 3 — check before shipping)

> Runs the check phase on a UI diff. Used standalone when the user asks to audit
> an already-shipped diff, or as the mandatory tail after `single`/`explore`/
> `lifecycle` modes.

## When to use

- **Standalone:** user asks to audit an already-shipped UI diff ("audit this
  page", "check for AI tells", "review my UI for slop", "does this hold up").
- **As mandatory tail:** appended to `single`, `explore`, and `lifecycle` modes
  (the mode files reference this file for phase 3).

## Mandatory rule

A UI task is **not complete** until phase 3 has run. This mirrors the kit's
existing rule: "Frontend changes without frontend verification skill invocation
→ task is NOT complete."

## Flow

```
1. compute the UI diff
2. review (impeccable audit + critique, OR web-design-guidelines fallback)
3. verify (impeccable detect CLI + browser-testing-with-devtools)
4. post (stop-slop — prose anti-slop, mandatory)
5. report findings; fix or explicitly accept
```

## Step 1 — Compute the diff

- If after a `single`/`explore`/`lifecycle` run: the diff is the working tree
  changes (or the merged branch vs base).
- If standalone: ask the user for the branch/ref, or audit the current working
  tree.
- Scope to UI files: `.tsx`, `.jsx`, `.vue`, `.svelte`, `.html`, `.css`, `.ts`
  (if it contains rendered text), and any copy/content files referenced by the
  UI.

## Step 2 — Review

### If impeccable is installed (preferred)

Run BOTH (they ask different questions — audit = "does this hold up", critique =
"is it any good"):

1. `/impeccable audit <surface>` — 5-dimension technical quality check:
   - Accessibility (WCAG contrast, ARIA, keyboard nav, semantic HTML, form labels)
   - Performance (layout thrashing, expensive animations, missing lazy loading, bundle)
   - Theming (hard-coded colors, dark mode coverage, token consistency)
   - Responsive (breakpoint behavior, touch targets, mobile viewport)
   - Anti-patterns (deterministic detector checks)
   - Each dimension scored 0-4. Each finding tagged P0 (blocks release) to P3 (polish).
   - Route P0s to `/impeccable harden`, theming P1s to `typeset` + `polish`, rest to `polish`.
   - On native projects (ios/android/adaptive), audit runs a native pass: VoiceOver,
     TalkBack, Dynamic Type, touch targets, platform conformance.

2. `/impeccable critique <surface>` — design review:
   - Nielsen's 10 heuristics scored 0-4
   - Cognitive load failure count (out of 8)
   - Persona tests (the evaluator, the returning user, the skeptic)
   - AI slop verdict (pass/fail with specific tells: gradient-text, ai-color-palette, nested-cards, etc.)
   - Priority issues (3-5 items: what, why, fix)
   - Questions to answer before shipping

### If impeccable is NOT installed (fallback)

Invoke `web-design-guidelines` — audits the rendered UI against Web Interface
Guidelines and accessibility. Less rigorous (no P0-P3, no persona tests, no
Nielsen scoring) but covers the basics.

## Step 3 — Verify

### If impeccable npm package is installed

`npx impeccable detect <path-or-url>` — deterministic detector checks:
- Contrast problems, typography drift, layout overflow, generic AI-design tells,
  brittle motion, design-system violations (when DESIGN.md exists).
- Exit code 0 = clean, 2 = findings, 1 = command failed.
- Use `--json` if feeding into CI. Use `--scope type` or `--scope layout` to
  narrow before a targeted refine pass.
- When DESIGN.md exists, detect loads it and enables design-system checks
  (fonts, literal colors, border radii, font sizes).

### Always (regardless of impeccable)

`browser-testing-with-devtools` — MANDATORY responsive verification across
desktop / tablet / mobile. Impeccable's detector is code-level; this is the live
browser check. Both are needed.

## Step 4 — Post (stop-slop, mandatory)

Invoke `stop-slop` on the diff. It catches:

- Banned phrases (throat-clearing openers, emphasis crutches, business jargon,
  adverbs, vague declaratives, meta-commentary)
- Structural clichés (binary contrasts, negative listings, dramatic
  fragmentation, rhetorical setups, false agency, passive voice)
- Sentence-level rules (Wh- starters, em dashes, staccato, lazy extremes,
  active voice)

If `stop-slop` is missing (presence-check failed):

- It is a **required** skill — warn the user.
- Emit the install hint: `npx skills add hardikpandya/stop-slop@stop-slop -g -y`
- Do not silently skip. Either install (with user consent) or block.

## Step 5 — Report and resolve

Report findings grouped by source:

- **impeccable audit:** per-dimension scores (0-4), findings by severity (P0-P3)
- **impeccable critique:** AI slop verdict, heuristic scores, cognitive load,
  persona scores, priority issues, questions to answer
- **impeccable detect:** deterministic findings (rule id, snippet, explanation)
- **browser-testing-with-devtools:** responsive issues
- **stop-slop:** banned phrases / structures found, with file + line

For each finding:

- **Fix** it (preferred), or
- **Explicitly accept** it with a one-line rationale (e.g. "intentional brand
  voice"). Do not silently ignore findings.

Re-run the audit after fixes until clean or all remaining findings are
explicitly accepted.

## Completion

The audit is complete when:

- [ ] Review ran (impeccable audit + critique, OR web-design-guidelines fallback)
- [ ] Verify ran (impeccable detect if installed + browser-testing-with-devtools always)
- [ ] stop-slop ran (or was installed with consent)
- [ ] All findings fixed or explicitly accepted
- [ ] Re-audit confirms clean state

Report: which skills/commands ran, audit scores per dimension (if impeccable),
critique verdict, detect finding count, responsive issues, stop-slop finding
count, what was fixed vs accepted, and the final state.
