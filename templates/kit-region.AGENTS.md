## Core rules (read every time)

- **Dev-first implementation, prod-first verification:** Implement features in the dev environment. **After merging to main, ALWAYS verify the feature works in production.** The user sees production — if it works in dev but not prod, the feature is not done.
- **Working with Prod:** When investigating production issues, always check the production environment first before making any changes.
- **Production verification (MANDATORY):** After every feature merge to main, run the steps in *Project profile → Production verification* below.
  - If verification fails, fix before declaring the task complete
- **Isolation:** You MUST use git worktrees for feature work (preferred) or create a feature branch. Use the `using-git-worktrees` skill for specific rules and best practices. **No exceptions** — even small features must use worktrees or branches.
- **Test in dev:** Validate changes in dev before merging to `main`.
- **Cleanup:** Delete the feature branch/worktree after merge.
- **Documentation:** Update documentation as you go, not at the end. Make sure to document any new features or changes to existing features. Document fixed bugs and their solutions, use the bug fix pattern.
- **Git Workflow:** Make sure to commit your changes at the end of the task, once all changes are complete and tested. Run `code-review-and-quality` as the pre-merge 5-axis gate (correctness, readability, architecture, security, performance) before committing.
- **Working-tree discipline:** Never use `git stash pop` during reviews or comparisons — it drops the stash on conflict and loses uncommitted work. Use `git worktree` for checking out old commits, or `git stash apply` (keeps the stash) if worktrees aren't feasible. Always run `git status` after any working-tree mutation.
- **Progressive disclosure:** Load deep docs only when required by the task.

## Agent routing policy

### Tool priority

1. For code discovery, symbol lookup, config lookup, docs lookup, and routine implementation tasks:
   - Use Semble first.
   - Start with `search`.
   - Use `find_related` after identifying a promising chunk.
   - Read full files only after relevant chunks are found.
   - Use grep only for exact-string confirmation.

2. For any task involving relationships, impact, or non-local effects:
   - Use code-review-graph before broad file reads.
   - Start with minimal graph context.
   - Query callers, callees, dependents, imports, tests, and affected flows.
   - Use graph results to build a bounded reading set.

3. For durable project memory — past sessions, decisions, indexed docs, or
   any "what did we decide / what did we already index" question:
   - Use context-mode first (`ctx_search` before asking the user).
   - Index bulky outputs with `ctx_index`/`ctx_batch_execute` instead of
     pasting raw dumps into the conversation.
   - Search session memory (`source: "decision"|"user-prompt"|"compaction"`)
     before re-litigating earlier choices.

### Default workflow

1. Use Semble to find the main implementation.
2. If the task is local and isolated, continue with bounded file reads and edits.
3. If the task is cross-cutting, switch to code-review-graph.
4. Ask the graph for impact radius, affected flows, dependents, and tests.
5. Read only the files named by Semble + graph.
6. After edits, run tests for impacted areas first, then broader checks.

### Do not

- Do not scan the repo with broad grep/glob/read before trying Semble.
- Do not make architecture claims without graph evidence on cross-cutting changes.
- Do not edit shared interfaces or DB models without impact analysis.

## Core Principals

### Think Before Coding
Don't assume. Don't hide confusion. Surface tradeoffs.
LLMs often pick an interpretation silently and run with it. This principle forces explicit reasoning:

- State assumptions explicitly — If uncertain, ask rather than guess. Use the `brainstorming` skill to explore approaches, then `grill-me` (or `grill-with-docs` when grounding against the domain model/ADRs) to stress-test the resulting plan before coding
- Present multiple interpretations — Don't pick silently when ambiguity exists
- Push back when warranted — If a simpler approach exists, say so
- Stop when confused — Name what's unclear and ask for clarification

### Large-Feature Design Discipline
Before implementing any feature with significant footprint (new tables, new agents, new pipelines, new frontend sections, or cross-cutting concerns), you MUST:

1. **Read the architecture docs first** — `.agents/SYSTEM.md`, `.agents/ARCHITECTURE_PATTERNS.md`, and `.agents/ENGINEERING_RULES.md` contain patterns and invariants that must be respected.
2. **Check for existing patterns** — New features must follow the patterns documented in `.agents/ARCHITECTURE_PATTERNS.md`. Do not invent new patterns when existing ones apply.
3. **Document the design BEFORE coding** — Update `.agents/SYSTEM.md` or `docs/` with the feature's architecture, data flow, and any new invariants. Link from `.agents/ENGINEERING_RULES.md`. Follow the `spec-driven-development` skill as the canonical specify→plan→tasks→implement gated process; use `grill-with-docs` to stress-test the spec against the existing domain model and ADRs before advancing to implementation.
4. **Update the consistency checklist** — Add any new invariants to the checklist in `.agents/ARCHITECTURE_PATTERNS.md`.

> **Why this matters:** Features that don't follow existing patterns cause regressions. The patterns in `.agents/ARCHITECTURE_PATTERNS.md` exist because a bug was fixed there once — skipping them reintroduces the same bug. Always check.

### Simplicity First
Minimum code that solves the problem. Nothing speculative.
Combat the tendency toward overengineering:

- No features beyond what was asked
- No abstractions for single-use code
- No "flexibility" or "configurability" that wasn't requested
- No error handling for impossible scenarios
- If 200 lines could be 50, rewrite it
- The test: Would a senior engineer say this is overcomplicated? If yes, simplify.

### Surgical Changes
Touch only what you must. Clean up only your own mess.
When editing existing code:

- Don't "improve" adjacent code, comments, or formatting
- Don't refactor things that aren't broken
- Match existing style, even if you'd do it differently
- If you notice unrelated dead code, mention it — don't delete it
- **Test deeply before merging:** use the testing skills listed in *Project profile → Testing skills*.

### Goal-Driven Execution
Define success criteria. Loop until verified.
Use `planning-and-task-breakdown` to decompose work into ordered, verifiable tasks, and `test-driven-development` (red→green→refactor) as the implementation discipline behind the table below.
Transform imperative tasks into verifiable goals:

| Instead of... | Transform to... |
|--------------|-----------------|
| "Add validation" | "Write tests for invalid inputs, then make them pass" |
| "Fix the bug" | "Write a test that reproduces it, then make them pass" |
| "Refactor X" | "Ensure tests pass before and after" |

For multi-step tasks, state a brief plan:

1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
Strong success criteria let the LLM loop independently. Weak criteria ("make it work") require constant clarification.

## Testing Discipline (MANDATORY)

Every backend or frontend change must pass systematic verification before the task is declared complete. Cursory checks ("the API returns 200") are insufficient.

### Why This Matters:

See *Project profile → Regression examples* for this project's failure modes.

### Testing Skills

Use the testing skills listed in *Project profile → Testing skills*.

> **Note:** If this project has custom E2E/QA skills, use those instead — see *Project profile → Project-specific skills*.

### Enforcement

- Backend changes without backend verification skill invocation → **task is NOT complete**
- Frontend changes without frontend verification skill invocation → **task is NOT complete**
- Full-stack changes without BOTH skills invoked → **task is NOT complete**
- Both skills must be invoked **before** claiming completion, **after** the code change is deployed to the running backend

## UX/UI design routing (defer to orchestrator)

For **ANY** UX/UI decision or frontend implementation — new surfaces, redesigns, component builds, UI copy changes, or visual audits — invoke the `ui-design-orchestrator` skill. It is the master router for all design work:

- Runs a **four-phase lifecycle**: (1) set context → (2) build + refine → (3) check before shipping → (4) keep from drifting.
- **Phase 1 (context):** when impeccable is installed, establishes `PRODUCT.md` + `DESIGN.md` + a surface brief via `/impeccable init` + `document` + `shape`. Falls back to the orchestrator's brief intake + `.agents/PRD.md`.
- **Phase 2 (build):** direction skill(s) → `frontend-ui-engineering` → impeccable refinement passes (`polish`, `typeset`, `layout`, `harden`, etc.) when installed.
- **Phase 3 (check, mandatory):** impeccable `audit` (5-dim, P0-P3) + `critique` (Nielsen, personas, AI slop verdict) + `detect` (deterministic CLI) + `browser-testing-with-devtools` (responsive) + `stop-slop` (prose). Falls back to `web-design-guidelines` when impeccable is absent.
- **Phase 4 (drift):** when impeccable is installed, refreshes `DESIGN.md` (`document`), extracts components/tokens (`extract`), and verifies hook health (`doctor`).
- Supports **multi-design exploration**: fans out parallel lanes, each with its own direction skill AND its own model, producing full implementations on isolated worktrees; you pick one, the rest are cleaned up.
- Its skill set is **data-driven** (`REGISTRY.md`) — mix skills from any repos, install only what you use, chain composable direction skills.
- A UI task is **not complete** until phase 3 has run.

**Do not make UX/UI skill choices inline.** Always defer to `ui-design-orchestrator`. The orchestrator presence-checks skills before routing, skips missing optional ones (using fallbacks), and warns on missing required ones (`stop-slop`).

> **Hook overlap:** impeccable installs its own provider-native design hooks (two-speed: per-edit + end-of-session) when `npx impeccable install` is run. The kit's `PostToolUse` hook checks for `.impeccable/config.json` — if present, it defers to impeccable's hooks (smarter, DESIGN.md-aware). If absent, it runs `npx impeccable detect` as fallback, or the orchestrator's audit mode. The skill instruction is the primary enforcement; hooks are the backup.

## Skill routing (on-demand)

Invoke these when the task matches. They are tools to use in place of ad-hoc approaches, not extra mandatory steps.

| Skill | Use when |
|---|---|
| `ui-design-orchestrator` | **Any** UX/UI decision or frontend implementation — always defer to the orchestrator (see UX/UI routing above) |
| `api-and-interface-design` | Designing new API endpoints, module boundaries, or frontend↔backend contracts — contract first, before implementation |
| `security-and-hardening` | Touching auth, user input, external integrations, or secrets — threat-model first (STRIDE) |
| `performance-optimization` | Performance is the actual task or a regression is suspected — measure before optimizing |
| `observability-and-instrumentation` | Shipping pipelines/agents/external integrations that run in prod — instrument alongside the feature |
| `improve-codebase-architecture` | The task is reducing architectural friction / deepening modules — pair with code-review-graph |
| `browser-testing-with-devtools` | Debugging or verifying UI via the chrome-devtools MCP (live DOM/console/network/perf trace) |
| `diagnosing-bugs` | Hard or non-deterministic bugs where you must build a deterministic feedback loop first (escalate from `debugging-and-error-recovery`) |
| `full-output-enforcement` | Task requires exhaustive, unabridged output with no placeholders or truncation |
| `excalidraw-diagram-generator` | Creating architecture diagrams, flowcharts, ER diagrams, mind maps |

## Reference docs (read when relevant)

- **Dev workflow & environment rules** → `.agents/DEV_WORKFLOW.md`
  - Use for environment setup, port discovery, and dev/prod safety steps.
- **Engineering rules + canonical doc map** → `.agents/ENGINEERING_RULES.md`
  - Use for invariants, doc locations, schema rules, and system conventions.
- **Architecture patterns & async best practices** → `.agents/ARCHITECTURE_PATTERNS.md`
  - Use when implementing pipelines, agents, schedulers, or async endpoints.
- **System architecture** → `.agents/SYSTEM.md`
  - Use for service boundaries, components, and subsystem overviews.
- **Bug fix log (first stop for debugging)** → `.agents/BUG_FIX_LOG.md`
  - Use before debugging for historical bugs or investigating regressions.
  - For the debugging process: use `debugging-and-error-recovery` (stop-the-line triage — reproduce→localize→reduce→fix→guard — for any failure); escalate to `diagnosing-bugs` for hard or non-deterministic bugs where you must build a deterministic feedback loop first.
  - Update bug log after fixing an issue.
- **Product requirements** → `.agents/PRD.md`
  - Use for feature scope, priorities, and non-functional requirements.

## Documentation governance

- Add new debugging knowledge to `.agents/BUG_FIX_LOG.md`.
- Keep canonical technical docs under `docs/` and link from `.agents/ENGINEERING_RULES.md`.
- Avoid duplicate summary docs; keep a single source of truth.

## Documentation maintenance (self-improving docs)

The `.agents/` documentation is not static. It must evolve alongside the project. Every agent session is responsible for keeping it current:

- **When you establish a new pattern** (async approach, caching strategy, error handling convention, etc.): Add it to `.agents/ARCHITECTURE_PATTERNS.md` under Canonical Patterns. Add the corresponding invariant to the Consistency Checklist.
- **When you discover a new invariant** (deployment order rule, schema convention, silent failure mode): Add it to `.agents/ENGINEERING_RULES.md` under Invariants.
- **When you fix a bug**: Log it in `.agents/BUG_FIX_LOG.md` using the bug fix format. If the bug reveals a missing pattern or invariant, add it to the relevant doc.
- **When you add a new service, subsystem, or major component**: Document it in `.agents/SYSTEM.md` under Subsystem Details.
- **When you make a significant architectural decision**: Record it as an ADR using the `documentation-and-adrs` skill. Link it from `.agents/ENGINEERING_RULES.md`.
- **When you change the dev workflow** (new command, port change, environment setup step): Update `.agents/DEV_WORKFLOW.md`.
- **When you fill a TBD placeholder**: Remove the `<!-- TODO -->` comment and replace the placeholder token with the actual value.
- **When project maturity changes** (design-phase → early-stage → mature): Update the PROJECT_MATURITY marker at the top of this file and fill previously-TBD placeholders that now have answers.

> **Principle:** The docs should always reflect the current state of the project. If you learn something that isn't documented, document it. If you find something documented that is no longer true, update it. Stale docs are worse than no docs.

## Diagram guideline

- Use the `excalidraw-diagram-generator` skill for architecture diagrams.
