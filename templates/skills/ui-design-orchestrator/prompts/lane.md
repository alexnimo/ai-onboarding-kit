# Lane prompt-file template

> Rendered per lane in `explore` mode. One file per lane, written to
> `<worktree>/.lane-<i>.md`, then delivered to the lane — as the task of a
> host subagent (default), to a spawn-agent CLI from `AGENTS.md` (prompt-file
> flag or positional `@file`) when per-lane model control is needed, or run
> sequentially as a fallback.
>
> Placeholders in `{{...}}` are filled by the orchestrator at spawn time.

---

# Lane {{LANE_INDEX}} of {{LANE_TOTAL}}

You are one of {{LANE_TOTAL}} parallel design lanes. Each lane is given the same
brief but a **different direction skill** (and possibly a different model). Your
job: produce a **full implementation** on this worktree, plus a **design
summary** for comparison.

## Your assignment

- **Direction skill:** `{{DIRECTION_SKILL}}`
- **Model:** `{{MODEL}}` (informational if you run under a CLI agent that set it; ignore otherwise)
- **Worktree:** `{{WORKTREE_PATH}}`
- **Branch:** `{{BRANCH_NAME}}`

## The brief

{{BRIEF}}

## Your task

1. **Read context** — `PRODUCT.md` + `DESIGN.md` if present (impeccable
   projects); otherwise infer from the brief.
2. **Invoke your assigned direction skill** (`{{DIRECTION_SKILL}}`) to infer the
   design direction. If impeccable is installed, produce the direction
   contract (THESIS / OWN-WORLD / STORY / FIRST VIEWPORT / FORM, ≤150 words);
   otherwise produce a Design Read (one line). Emit before any code.
3. **Build** the full UI using `frontend-ui-engineering` (web) — production
   quality, design-system adherence, a11y, anti-AI-aesthetic. Implement the
   complete page/screen, not a stub.
4. **Review** with `web-design-guidelines` — audit the rendered UI vs Web
   Interface Guidelines and accessibility. Fix findings.
5. **Verify** with `browser-testing-with-devtools` — responsive check across
   desktop / tablet / mobile. Fix findings.
6. **Do NOT run the refine or audit tails** (impeccable `polish`/`audit`,
   `stop-slop`) — the orchestrator runs those on the winning lane after the
   user picks. Your job ends at verify.
7. **Commit** your work on `{{BRANCH_NAME}}`.

## Deliverables

Alongside the full implementation, emit a **design summary** block (the
orchestrator collects these for side-by-side comparison):

```
---design-summary---
lane: {{LANE_INDEX}}
skill: {{DIRECTION_SKILL}}
model: {{MODEL}}
branch: {{BRANCH_NAME}}
design_read: "<one line>"
dials: { variance: N, motion: N, density: N }
palette: ["#hex", "#hex", ...]
type: { display: "<font>", body: "<font>" }
layout: { hero: "<treatment>", grid: "<approach>", sections: [...] }
screenshot: <path or "text-only">
---end-design-summary---
```

## Rules

- Stay in your worktree. Do not touch other lanes' worktrees.
- Do not install skills — assume the assigned skill is installed (the
  orchestrator presence-checked it).
- If your assigned skill is missing, stop and report it in the summary; do not
  substitute a different skill.
- Commit your work. Uncommitted work will be lost when the orchestrator cleans
  up non-winning worktrees.
- One direction skill per lane (you may chain composable direction skills if the
  assigned one is composable — e.g. add `imagegen-frontend-web` for reference
  imagery).
