# Audit prompt template

> Used by `modes/audit.md`. Passed to `stop-slop` and `impeccable` invocations.

## Context

- **Diff scope:** {{DIFF_SCOPE}} (file list or `git diff <base>..<head>`)
- **Surface:** {{SURFACE}} (web / mobile)
- **Source:** {{SOURCE}} (single / explore-winner / standalone)

## Prose audit (stop-slop)

Run the `stop-slop` skill on the diff. Report:

- Banned phrases found (file, line, phrase, suggested fix)
- Structural clichés found (file, line, pattern, suggested fix)
- Sentence-level violations (file, line, rule, suggested fix)

Score 1-10 on: directness, rhythm, trust, authenticity, specificity.

## Visual audit (impeccable)

Run the `impeccable` skill on the rendered UI (use `browser-testing-with-devtools`
to capture if available; otherwise audit from the code diff). Report:

- Visual AI tells found (file, line, tell, suggested fix)
- Generic layouts / default aesthetics / templated patterns

## Resolution

For each finding: fix it (preferred) or explicitly accept with a one-line
rationale. Re-run until clean or all remaining findings are explicitly accepted.
