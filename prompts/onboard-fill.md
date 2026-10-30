# Placeholder Fill Prompt

> Paste this into any AI coding agent runner running in an already-scaffolded project.
> The agent will fill the `{{placeholders}}` in the generated files based on project maturity.
> It will NOT run the scaffold script, install skills, or merge MCP config — those were already done.
>
> Assumption: the current working directory is the TARGET project, and the scaffold has already been run
> (files like AGENTS.md, .agents/SYSTEM.md, etc. exist with `{{placeholders}}` in them).

---

## Instructions for the agent

You are filling in project-specific details for an AI-agent-optimized project. The current working directory is the project. The scaffold has already been run — files with `{{placeholders}}` already exist. Your job is to resolve those placeholders based on what is actually true about this project.

### Critical rules

1. **Never guess or extrapolate.** If information does not exist in the codebase, config files, or from the user, leave it as `{{KEY}}` with a `<!-- TODO: fill when known -->` comment.
2. **Never fill placeholder docs by inferring from unfinished design docs.** If the only source is a draft/HLD/research doc that is not a finalized decision, do not treat it as ground truth. Mark those sections as TBD.
3. **Never invent a tech stack.** If no code exists and no stack decision has been made, do not pick one. Ask the user, or leave it as TBD.
4. **Never invent commands, ports, or patterns.** These must come from actual config files or the user.
5. **Maturity determines depth.** A design-phase project gets lean, mostly-TBD docs. A mature project gets thorough, inferred docs. Detect maturity first.

### Step 0 - Detect project maturity

Classify the project into one of three maturity levels:

| Level | Criteria | Fill behavior |
|---|---|---|
| **design-phase** | No source files, no package config. Only design docs, README, or nothing. | Fill only PROJECT_NAME and PROJECT_DESCRIPTION (ask user). Everything else: TBD with `<!-- TODO -->`. Do NOT infer tech stack, commands, ports, patterns, or invariants. |
| **early-stage** | Some source files OR a package config exists, but the codebase is small (< ~20 files) or clearly incomplete. | Fill what is directly inferable from existing code/config. Ask the user for missing values. Do not over-document patterns that haven't emerged yet. Leave emerging-pattern placeholders as TBD. |
| **mature** | Significant codebase with established structure, config, tests, and clear patterns. | Full inference: inspect codebase thoroughly for stack, commands, ports, patterns, invariants, regression examples. Fill everything possible. Ask only for what cannot be inferred. |

Detection steps:
- Check for source files: `.py`, `.ts`, `.js`, `.go`, `.rs`, `.java`, etc.
- Check for project config: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.
- Check for lockfiles: `uv.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `go.sum`.
- Count source files to gauge size.
- State your maturity detection result and reasoning to the user before proceeding.

### Step 1 - Read the manifest placeholders

Read `onboard.manifest.json` in the project root (if it was copied there) or from the kit directory. Find the `placeholders` array. Each placeholder has a `key` and a `hint`.

If the manifest is not in the project, read the placeholder hints from the generated files — every `{{KEY}}` in the templates has surrounding comments explaining what goes there.

### Step 2 - Resolve placeholders by maturity

#### For ALL maturity levels

- **PROJECT_NAME**: Use the directory name, or ask the user.
- **PROJECT_DESCRIPTION**: Ask the user. If they give a one-liner, use it. If they say "I don't know yet", leave as TBD.
- **PROJECT_MATURITY**: Set to the detected level (`design-phase`, `early-stage`, or `mature`).

#### design-phase fill rules

- **PACKAGE_MANAGER**: TBD — `<!-- TODO: decide and fill when stack is chosen -->`
- **INSTALL_COMMAND**: TBD
- **DEV_SERVER_COMMAND**: TBD
- **PROD_SERVER_COMMAND**: TBD
- **TEST_COMMAND**: TBD
- **DB_MIGRATION_COMMAND**: TBD
- **DEV_PORT**: TBD
- **PROD_PORT**: TBD
- **STACK_NOTES**: TBD — `<!-- TODO: fill as the project matures and stack-specific gotchas are discovered -->`
- **SYSTEM_OVERVIEW**: Ask the user for a high-level description. If they have one, use it. If not, TBD.
- **SERVICE_BOUNDARIES**: TBD
- **DATA_FLOW**: TBD
- **EXTERNAL_INTEGRATIONS**: TBD
- **SUBSYSTEM_DETAILS**: TBD
- **CANONICAL_PATTERNS**: TBD — `<!-- TODO: fill as patterns emerge -->`
- **CONSISTENCY_CHECKLIST**: TBD
- **INVARIANTS**: TBD
- **ASYNC_RULES**: TBD
- **ERROR_HANDLING_PATTERNS**: TBD
- **TESTING_PATTERNS**: TBD
- **SCHEMA_RULES**: TBD
- **DEPENDENCY_RULES**: TBD
- **REGRESSION_EXAMPLES**: Leave a stub table with no rows and a comment: `<!-- No bugs yet — project is in design phase -->`
- **PROJECT_SPECIFIC_SKILLS**: Leave empty (no custom skills yet).
- **TESTING_SKILLS**: `<!-- TODO: fill when testing infrastructure is set up -->`
- **PROD_VERIFICATION_STEPS**: `<!-- N/A — no production environment yet -->`
- **VISION**: Ask the user. If they have a vision, fill it. If not, TBD.
- **IN_SCOPE**: Ask the user. If not defined, TBD.
- **OUT_OF_SCOPE**: Ask the user. If not defined, TBD.
- **PRIORITIES**: Ask the user. If not defined, TBD.
- **NFRS**: TBD
- **USER_PERSONAS**: Ask the user. If not defined, TBD.
- **ENV_SETUP**: TBD
- **DEV_PROD_SAFETY**: `<!-- N/A — no dev/prod environments yet -->`
- **SERVER_RESTART_NOTES**: `<!-- N/A — no server yet -->`
- **BUG_LOG_ENTRIES**: `<!-- No bugs yet — project is in design phase -->`

**Optional — offer brainstorming:** If the user wants help defining the vision, scope, or stack for a design-phase project, offer to invoke the `brainstorming` skill to explore approaches, or `grill-me` to stress-test their ideas. Do NOT invoke these without the user's consent. Do NOT fill docs with the output of a brainstorming session unless the user asks you to.

#### early-stage fill rules

- **PACKAGE_MANAGER**: Detect from lockfiles if present. If not, ask.
- **INSTALL_COMMAND**: Derive from detected package manager. If not detectable, ask.
- **DEV_SERVER_COMMAND**: Detect from `package.json` scripts, `pyproject.toml`, `Makefile`. If not found, ask.
- **PROD_SERVER_COMMAND**: Detect or ask. If same as dev, note that.
- **TEST_COMMAND**: Detect from config. If not found, ask or TBD.
- **DB_MIGRATION_COMMAND**: Detect from framework (Alembic, Prisma, etc.) or `N/A`. If unclear, ask.
- **DEV_PORT** / **PROD_PORT**: Detect from config or ask.
- **STACK_NOTES**: Inspect existing code for stack-specific gotchas. If none found yet, TBD with a comment.
- **SYSTEM_OVERVIEW**: Infer from code structure + ask user for confirmation.
- **CANONICAL_PATTERNS**: Only document patterns that are clearly established in the code. If patterns are still emerging, TBD.
- **CONSISTENCY_CHECKLIST**: Derive from documented patterns. If none documented, TBD.
- **INVARIANTS**: Only document invariants that are clearly enforced by the code. If none yet, TBD.
- **REGRESSION_EXAMPLES**: Check `.agents/BUG_FIX_LOG.md` for entries. If empty, stub table.
- **PROJECT_SPECIFIC_SKILLS**: Check `.windsurf/skills/` and `.agents/skills/` for custom skills. List them if found.
- **TESTING_SKILLS**: If testing infrastructure exists, reference the relevant skills (`test-driven-development`, `browser-testing-with-devtools`). If not, TBD.
- **PROD_VERIFICATION_STEPS**: If a production environment exists, document the verification steps. If not, `<!-- N/A — no production environment yet -->`.
- All `.agents/` doc placeholders: Fill what's inferable. Ask for missing. TBD for the rest.

#### mature fill rules

- **PACKAGE_MANAGER**: Detect from lockfiles.
- **INSTALL_COMMAND**: From package manager.
- **DEV_SERVER_COMMAND**: From `package.json` scripts, `pyproject.toml`, `Makefile`, or ask.
- **PROD_SERVER_COMMAND**: Detect or ask. If same as dev, note that.
- **TEST_COMMAND**: From config (`pytest`, `npm test`, `cargo test`, etc.).
- **DB_MIGRATION_COMMAND**: Detect from framework or `N/A`.
- **DEV_PORT** / **PROD_PORT**: Detect from config or ask.
- **STACK_NOTES**: Inspect the codebase thoroughly for stack-specific gotchas (hot-reload behavior, cache invalidation, silent import failures, proxy config, etc.). This is the most important placeholder — be thorough.
- **SYSTEM_OVERVIEW**: Infer from code structure, README, and docs.
- **SERVICE_BOUNDARIES**: Identify from code structure (services, modules, packages).
- **DATA_FLOW**: Trace entry points, transformations, storage, outputs.
- **EXTERNAL_INTEGRATIONS**: List from code (API clients, DB connections, third-party services).
- **SUBSYSTEM_DETAILS**: One subsection per major subsystem.
- **CANONICAL_PATTERNS**: Discover from code — async patterns, caching, event flow, error handling, etc.
- **CONSISTENCY_CHECKLIST**: Derive from canonical patterns.
- **INVARIANTS**: Identify non-negotiable rules enforced by the code (deployment order, schema rules, etc.).
- **ASYNC_RULES**: From code (asyncio, threads, worker pools, etc.) or `N/A — this project is synchronous.`
- **ERROR_HANDLING_PATTERNS**: From code (exceptions, result types, error codes, boundaries).
- **TESTING_PATTERNS**: From test config and test files.
- **SCHEMA_RULES**: From DB schema, migrations, ORM models. If no DB, `N/A — this project has no database.`
- **DEPENDENCY_RULES**: From package manager conventions and existing config.
- **REGRESSION_EXAMPLES**: Check `.agents/BUG_FIX_LOG.md` for entries. Summarize known bugs into the regression table. If no known bugs, stub table.
- **PROJECT_SPECIFIC_SKILLS**: Check `.windsurf/skills/` and `.agents/skills/` for custom skills. List them.
- **TESTING_SKILLS**: Reference the skills used for verification (`test-driven-development`, `browser-testing-with-devtools`, `web-design-guidelines`, plus any project-specific skills found).
- **PROD_VERIFICATION_STEPS**: If production exists, document the full verification flow (restart, migrations, E2E checks). If no production, `<!-- N/A — no production environment -->`.
- All `.agents/` doc placeholders: Full inference from codebase.

### Step 3 - Fill the placeholders

For each generated file, replace `{{KEY}}` with the resolved value:

- For concrete values: replace directly.
- For TBD values: keep as `{{KEY}}` with a `<!-- TODO: fill when known -->` comment on the line above, so they're easy to find later with grep.
- For N/A values: replace with the N/A note (e.g., `<!-- N/A — no database -->`).


**Where the placeholders live:** all `AGENTS.md` placeholders sit in the
`## Project profile` section BELOW the
`<!-- END ai-onboarding-kit:kit-region -->` marker. The text between
`<!-- BEGIN`/`END ai-onboarding-kit:kit-region -->` markers is
**kit-managed — never edit it** (the sync engine owns it; edits there
produce merge conflicts). Fill only placeholders outside the markers.
Files to fill (all in the TARGET project):
- `AGENTS.md`
- `.agents/SYSTEM.md`
- `.agents/ARCHITECTURE_PATTERNS.md`
- `.agents/ENGINEERING_RULES.md`
- `.agents/BUG_FIX_LOG.md`
- `.agents/PRD.md`
- `.agents/DEV_WORKFLOW.md`
- Rule files in `.windsurf/rules/` (if present): `dev-environment.md`, `coding-standards.md`
- Rule files in `.cursor/rules/` (if present)

### Step 4 - Detect and reference project-specific skills

Check for custom skills in:
- `.windsurf/skills/`
- `.agents/skills/`

If custom skills exist (e.g., project-specific E2E testing skills), reference them in the `{{PROJECT_SPECIFIC_SKILLS}}` and `{{TESTING_SKILLS}}` placeholders in `AGENTS.md`.

If no custom skills exist, set `{{PROJECT_SPECIFIC_SKILLS}}` to `<!-- No project-specific skills yet -->` and `{{TESTING_SKILLS}}` to the generic skill references (`test-driven-development`, `browser-testing-with-devtools`).

Do NOT create skill directories manually. If the user wants custom testing skills, suggest using the `writing-skills` skill to create them.

### Step 5 - Verify

1. Verify no remaining `{{placeholders}}` except intentionally deferred TBD ones (with `<!-- TODO -->` comments).
2. Verify `AGENTS.md` is syntactically valid markdown.
3. Verify `.agents/` files are readable and have content in every section (even if the content is a TBD note).
4. Print a summary of:
   - Maturity level detected
   - Placeholders filled with concrete values
   - Placeholders left as TBD (with reasons)
   - Project-specific skills found (if any)

### Step 6 - Commit

If the project has git initialized:
```bash
git add AGENTS.md .agents/ .windsurf/rules/ .cursor/rules/
git commit -m "chore: fill onboarding placeholders (maturity: <level>)"
```

Only add files that exist and were modified. If git is not initialized, suggest initializing it.

---

## Quick reference: Placeholder resolution priority

1. **Infer from codebase** (mature/early-stage) — always try this first for technical values
2. **Infer from config files** — package.json, pyproject.toml, Makefile, etc.
3. **Ask the user** — only if you cannot infer after steps 1 and 2
4. **Defer as TBD** — for design-phase projects, or when the answer genuinely doesn't exist yet

## Anti-patterns (DO NOT)

- **Do NOT** fill PRD/SYSTEM/ARCHITECTURE docs by extrapolating from unfinished design docs or HLDs. If a design doc is a draft, it is not a decision.
- **Do NOT** pick a tech stack for a design-phase project. Ask the user or leave TBD.
- **Do NOT** invent commands, ports, or patterns that don't exist in the codebase.
- **Do NOT** fill regression examples with hypothetical bugs. Only document real, known bugs.
- **Do NOT** reference skills that don't exist. Only reference skills that are installed or in the project's skill directories.
- **Do NOT** run the scaffold script, `npx skills add`, or MCP config commands — those were already done by the scaffold prompt.
