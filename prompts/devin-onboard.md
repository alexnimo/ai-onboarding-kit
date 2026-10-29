# Devin Onboarding Prompt (Combined)

> Paste this entire file into Devin (or any AI agent) to onboard a project in one session.
> The agent will scaffold the directory structure, fill in placeholders, install missing skills,
> merge MCP config, and produce a complete AI-optimized project setup.
>
> This is the combined version. For a split flow (recommended for re-runs or when you want
> to control each phase), use:
>   - `prompts/devin-scaffold.md` — run scaffold, install skills, merge MCP/hooks/rules
>   - `prompts/devin-fill-placeholders.md` — fill placeholders (maturity-aware)
>
> For a quick start, use the short version: `prompts/devin-onboard-short.md`

---

## Instructions for the agent

You are onboarding a project to an AI-agent-optimized workflow. The current working directory is the project to onboard (TARGET). The onboarding kit is at the path provided by the user as KIT_PATH. Follow these steps in order.

### Inputs

- **KIT_PATH**: The absolute path to the `ai-onboarding-kit` directory (contains `onboard.manifest.json`, `scaffold.ps1`/`scaffold.sh`, `templates/`). Ask the user if not provided.
- **TARGET**: The current working directory. Do not change directories.
- **AGENT**: Which agent profile to use. Default: `devin`. Options: `devin`, `hermes`, `opencode`, `claude-code`, `cursor`, `windsurf`.

### Critical rules for placeholder filling

1. **Never guess or extrapolate.** If information does not exist in the codebase, config files, or from the user, leave it as `{{KEY}}` with a `<!-- TODO: fill when known -->` comment.
2. **Never fill placeholder docs by inferring from unfinished design docs.** If the only source is a draft/HLD/research doc that is not a finalized decision, do not treat it as ground truth. Mark those sections as TBD.
3. **Never invent a tech stack, commands, ports, or patterns.** These must come from actual config files or the user.
4. **Maturity determines depth.** A design-phase project gets lean, mostly-TBD docs. A mature project gets thorough, inferred docs. Detect maturity first (Step 0a).

### Step 0a - Detect project maturity

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

### Step 0b - Detect existing onboarding (config-only mode)

If TARGET already has an `AGENTS.md` (or the agent profile's instructions file) AND a `.agents/` directory with content, this is a **re-onboarding** or **additional agent** scenario:

- Use **config-only mode**: run the scaffold with `--config-only` to skip templates and only configure skills + MCP for the target agent.
- Do NOT overwrite the existing `AGENTS.md` or `.agents/` files.
- Skip placeholder filling (Step 2) entirely — the existing docs are already filled.

### Step 1 - Run the scaffold script

**For a new or un-onboarded project (full scaffold):**

Windows (PowerShell):
```powershell
& "<KIT_PATH>\scaffold.ps1" -Target "<TARGET>" -Agent "<AGENT>"
```

Unix (bash):
```bash
bash "<KIT_PATH>/scaffold.sh" --target "<TARGET>" --agent "<AGENT>"
```

**For an existing already-onboarded project (config-only for additional agent):**

Windows:
```powershell
& "<KIT_PATH>\scaffold.ps1" -Target "<TARGET>" -Agent "<AGENT>" -ConfigOnly
```

Unix:
```bash
bash "<KIT_PATH>/scaffold.sh" --target "<TARGET>" --agent "<AGENT>" --config-only
```

Replace `<KIT_PATH>`, `<TARGET>`, and `<AGENT>` with the actual values before running. Review the output. Note which templates were created vs skipped, which skills are installed vs missing, and which MCP servers were added vs already present.

### Step 2 - Fill placeholders (skip in config-only mode)

If config-only mode was used, skip this step entirely — the existing files are already filled.

Read `onboard.manifest.json` -> `placeholders` array. For each placeholder, determine its value based on the maturity level detected in Step 0a.

**Placeholder resolution priority:**
1. **Infer from codebase** (mature/early-stage) — always try this first for technical values
2. **Infer from config files** — package.json, pyproject.toml, Makefile, etc.
3. **Ask the user** — only if you cannot infer after steps 1 and 2
4. **Defer as TBD** — for design-phase projects, or when the answer genuinely doesn't exist yet

**For design-phase projects:** Only fill PROJECT_NAME, PROJECT_DESCRIPTION, and PROJECT_MATURITY. Ask the user for a high-level vision if they have one. Everything else: leave as `{{KEY}}` with `<!-- TODO: fill when known -->`. Do NOT infer tech stack, commands, ports, patterns, or invariants. Do NOT fill PRD/SYSTEM/ARCHITECTURE docs by extrapolating from unfinished design docs.

**Optional for design-phase:** If the user wants help defining the vision, scope, or stack, offer to invoke the `brainstorming` skill to explore approaches, or `grill-me` to stress-test their ideas. Do NOT invoke these without the user's consent. Do NOT fill docs with the output of a brainstorming session unless the user asks you to.

**For early-stage projects:** Fill what is directly inferable from existing code/config. Ask the user for missing values. Do not over-document patterns that haven't emerged yet. Leave emerging-pattern placeholders as TBD.

**For mature projects:** Inspect the codebase thoroughly. Fill stack, commands, ports, patterns, invariants, regression examples. Be thorough on STACK_NOTES — this is the most important placeholder.

**Fill rules for all levels:**
- For concrete values: replace `{{KEY}}` directly.
- For TBD values: keep as `{{KEY}}` with a `<!-- TODO: fill when known -->` comment on the line above.
- For N/A values: replace with the N/A note (e.g., `<!-- N/A — no database -->`).

**Key placeholders:**
- `PROJECT_NAME`: directory name or ask user (all levels)
- `PROJECT_DESCRIPTION`: ask user (all levels)
- `PROJECT_MATURITY`: the detected level (all levels)
- `PACKAGE_MANAGER` / `INSTALL_COMMAND` / `DEV_SERVER_COMMAND` / `PROD_SERVER_COMMAND` / `TEST_COMMAND`: detect from lockfiles and config (mature/early-stage), TBD (design-phase)
- `DB_MIGRATION_COMMAND`: detect from framework or `N/A` (mature/early-stage), TBD (design-phase)
- `DEV_PORT` / `PROD_PORT`: detect from config or ask (mature/early-stage), TBD (design-phase)
- `STACK_NOTES`: inspect codebase for stack-specific gotchas (mature), TBD (early-stage/design-phase)
- `SYSTEM_OVERVIEW` / `CANONICAL_PATTERNS` / `CONSISTENCY_CHECKLIST` / `INVARIANTS`: infer from code (mature), partial (early-stage), TBD (design-phase)
- `REGRESSION_EXAMPLES`: check `.agents/BUG_FIX_LOG.md` for entries; if empty, stub table (all levels)
- `PROJECT_SPECIFIC_SKILLS`: check `.windsurf/skills/` and `.agents/skills/` for custom skills; list if found, else empty (all levels)
- `TESTING_SKILLS`: reference relevant testing skills (`test-driven-development`, `browser-testing-with-devtools`, `web-design-guidelines`, plus any project-specific skills found). TBD if no testing infrastructure yet.
- `PROD_VERIFICATION_STEPS`: document verification flow if production exists (mature/early-stage), `<!-- N/A — no production environment yet -->` (design-phase)

### Step 3 - Install missing skills

Re-run the scaffold script with the install flag to install missing required skills:

Windows:
```powershell
& "<KIT_PATH>\scaffold.ps1" -Target "<TARGET>" -Agent "<AGENT>" -InstallSkills
```

Unix:
```bash
bash "<KIT_PATH>/scaffold.sh" --target "<TARGET>" --agent "<AGENT>" --install-skills
```

If any required skills fail to install, report them to the user. Do NOT create skill directories manually — only use `npx skills add`.

For optional skills, do NOT install them automatically. List them and let the user decide.

### Step 4 - MCP config verification

The scaffold script already merged MCP server config non-destructively. Verify:

1. Check the MCP config file for the target agent (from manifest `agentProfiles.<agent>.mcpConfigPath`).
2. Confirm all required MCP servers are present in the config.
3. If any required MCP servers are missing from the config, the scaffold should have added them. Verify the file was written correctly.
4. Do NOT overwrite or remove any MCP servers that were already configured — the merge is additive only.

### Step 4b - Hooks verification (agents that support hooks)

1. Check the hooks config file for the target agent (from manifest `agentProfiles.<agent>.hooksConfigPath`).
2. Confirm all hooks from the manifest are present.
3. Do NOT overwrite or remove any hooks that were already configured.
4. If the agent does not support hooks (cursor, windsurf), this step is skipped.

### Step 4c - Rules verification (agents that support rules)

1. Check the rules directory for the target agent (from manifest `agentProfiles.<agent>.rulesDir`).
2. Confirm all rule files from the manifest are present.
3. Fill any `{{placeholders}}` in the rule files (same as Step 2).
4. If the agent has `rulesEnabled: false`, this step is skipped.

### Step 5 - Project-specific skills (existing projects only)

Check for custom skills in `.windsurf/skills/` and `.agents/skills/`:
- If custom skills exist, reference them in `AGENTS.md` under the `{{PROJECT_SPECIFIC_SKILLS}}` and `{{TESTING_SKILLS}}` placeholders.
- If no custom skills exist, set `{{PROJECT_SPECIFIC_SKILLS}}` to `<!-- No project-specific skills yet -->` and `{{TESTING_SKILLS}}` to the generic skill references.
- Do NOT create skill directories manually. If the user wants custom testing skills, suggest using the `writing-skills` skill to create them.

### Step 6 - Multi-agent onboarding (optional)

If the user wants to onboard additional AI agents to this project:

1. Run the scaffold in config-only mode for each additional agent:
   ```
   bash "<KIT_PATH>/scaffold.sh" --target "<TARGET>" --agent hermes --config-only --install-skills
   ```
2. This will skip templates, check skills (shared globally), and merge MCP config into the agent's config file.
3. The additional agent now has the same skills and MCP servers configured, and reads the same AGENTS.md.

Available agent profiles: `devin`, `hermes`, `opencode`, `claude-code`, `cursor`, `windsurf`.

### Step 7 - Final verification

1. Verify all generated files exist and have no remaining `{{placeholders}}` (except intentionally deferred TBD ones with `<!-- TODO -->` comments).
2. Verify `AGENTS.md` is syntactically valid markdown.
3. Verify `.agents/` files are readable and have content in every section (even if the content is a TBD note).
4. Verify MCP config file exists and contains the required servers.
5. Print a summary of:
   - Maturity level detected
   - Templates created/filled
   - Placeholders filled with concrete values vs left as TBD
   - Skills installed/missing
   - MCP servers present/added
   - Project-specific skills found (if any)

### Step 8 - Commit

If the project has git initialized:
```bash
git add AGENTS.md .agents/ docs/ .devin/ .hermes/ .opencode/ .claude/ .cursor/ .windsurf/
git commit -m "chore: onboard to AI-agent-optimized workflow (maturity: <level>)"
```

Only add the agent config directories that were created. Don't add directories that don't exist. If git is not initialized, suggest initializing it.

---

## Quick reference: Skill behavior

| Situation | Action |
|---|---|
| Skill found in any search location | Skip (no reinstall, no update) |
| Skill missing + `--install-skills` flag | Install via `npx skills add <source>@<skill> -g -y` |
| Skill installed + `--update-skills` flag | Update via `npx skills update <source>@<skill> -g -y` |
| Skill installed + no flags | Skip |
| Optional skill missing | List in summary, do NOT auto-install |

Skill search locations (checked in order):
1. `~/.agents/skills/<name>/SKILL.md` (global, shared by all agents)
2. Agent profile skill dirs (e.g., `~/.claude/skills/` for claude-code)
3. `<project>/.windsurf/skills/<name>/SKILL.md` (project-level)
4. `<project>/.agents/skills/<name>/SKILL.md` (project-level)
5. `~/.agents/.skill-lock.json` (global lock file)

## Quick reference: MCP config behavior

| Situation | Action |
|---|---|
| MCP config file doesn't exist | Create with required + optional servers from manifest |
| MCP config file exists, server missing | Add server (non-destructive merge) |
| MCP config file exists, server present | Skip (never overwrite existing config) |

## Quick reference: Hooks behavior

| Situation | Action |
|---|---|
| Hooks config file doesn't exist | Create with all hooks from manifest |
| Hooks config file exists, event missing | Add event hooks (non-destructive merge) |
| Hooks config file exists, event present | Skip (never overwrite existing hooks) |
| Agent does not support hooks | Skip entirely (cursor, windsurf) |

## Quick reference: Rules behavior

| Situation | Action |
|---|---|
| Rule file doesn't exist | Copy from template |
| Rule file exists | Skip (unless `--force`) |
| Agent has `rulesEnabled: false` | Skip entirely |

## Quick reference: Agent config paths

| Agent | Instructions | MCP config | Hooks | Rules |
|---|---|---|---|---|
| devin | `AGENTS.md` | `.devin/config.json` | `.devin/hooks.v1.json` | `.windsurf/rules/` |
| hermes | `AGENTS.md` | `.hermes/mcp.json` | `.hermes/hooks.json` | *(disabled)* |
| opencode | `AGENTS.md` | `.opencode/mcp.json` | `.opencode/hooks.json` | *(disabled)* |
| claude-code | `CLAUDE.md` | `.claude/settings.json` | `.claude/settings.json` | *(disabled)* |
| cursor | `.cursorrules` | `.cursor/mcp.json` | *(none)* | `.cursor/rules/` |
| windsurf | `.windsurf/rules` | `.windsurf/mcp_config.json` | *(none)* | `.windsurf/rules/` |

## Anti-patterns (DO NOT)

- **Do NOT** fill PRD/SYSTEM/ARCHITECTURE docs by extrapolating from unfinished design docs or HLDs. If a design doc is a draft, it is not a decision.
- **Do NOT** pick a tech stack for a design-phase project. Ask the user or leave TBD.
- **Do NOT** invent commands, ports, or patterns that don't exist in the codebase.
- **Do NOT** fill regression examples with hypothetical bugs. Only document real, known bugs.
- **Do NOT** reference skills that don't exist. Only reference skills that are installed or in the project's skill directories.
- **Do NOT** create skill directories manually — always use `npx skills add`.
