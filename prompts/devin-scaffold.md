# Devin Scaffold Prompt

> Paste this into Devin (or any AI agent) running in the project you want to onboard.
> The agent will run the scaffold script, install missing skills, merge MCP/hooks/rules config.
> It will NOT fill placeholders — use `prompts/devin-fill-placeholders.md` for that after the scaffold completes.
>
> Assumption: the current working directory is the TARGET project (the one being onboarded).
> You must provide KIT_PATH below — the path to the ai-onboarding-kit directory on your machine.

---

## Instructions for the agent

You are scaffolding a project for AI-agent-optimized development. The current working directory is the project to onboard (TARGET). The onboarding kit is at the path provided by the user as KIT_PATH.

### Inputs

- **KIT_PATH**: The absolute path to the `ai-onboarding-kit` directory (contains `onboard.manifest.json`, `scaffold.ps1`/`scaffold.sh`, `templates/`). Ask the user if not provided.
- **TARGET**: The current working directory. Do not change directories.
- **AGENT**: Which agent profile to use. Default: `devin`. Options: `devin`, `hermes`, `opencode`, `claude-code`, `cursor`, `windsurf`.

### Step 0 - Detect existing onboarding (config-only mode)

If TARGET already has an `AGENTS.md` (or the agent profile's instructions file) AND a `.agents/` directory with content, this is a **re-onboarding** or **additional agent** scenario:

- Use **config-only mode**: run the scaffold with `--config-only` to skip templates and only configure skills + MCP for the target agent.
- Do NOT overwrite the existing `AGENTS.md` or `.agents/` files.
- Skip to Step 2 with the `--config-only` flag.

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

### Step 2 - Install missing skills

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

### Step 3 - Verify MCP config

The scaffold script already merged MCP server config non-destructively. Verify:

1. Check the MCP config file for the target agent (from manifest `agentProfiles.<agent>.mcpConfigPath`).
2. Confirm all required MCP servers are present in the config.
3. Do NOT overwrite or remove any MCP servers that were already configured — the merge is additive only.

### Step 3b - Verify hooks (agents that support hooks)

1. Check the hooks config file for the target agent (from manifest `agentProfiles.<agent>.hooksConfigPath`).
2. Confirm all hooks from the manifest are present.
3. Do NOT overwrite or remove any hooks that were already configured.
4. If the agent does not support hooks (cursor, windsurf), this step is skipped.

### Step 3c - Verify rules (agents that support rules)

1. Check the rules directory for the target agent (from manifest `agentProfiles.<agent>.rulesDir`).
2. Confirm all rule files from the manifest are present.
3. If the agent has `rulesEnabled: false`, this step is skipped.
4. Do NOT fill placeholders in rule files here — that is done by the fill-placeholders prompt.

### Step 4 - Summary

Print a summary of:
- Templates created vs skipped
- Skills installed vs missing (required and optional)
- MCP servers present vs added
- Hooks present vs added
- Rules created vs skipped

### Step 5 - Next steps guidance

Tell the user:
1. The scaffold is complete but files contain `{{placeholders}}` that need to be filled.
2. To fill them, paste the `prompts/devin-fill-placeholders.md` prompt into a new Devin session in this project directory.
3. Or fill them manually using the placeholder hints in `onboard.manifest.json`.

### Step 6 - Commit (optional)

If the project has git initialized and the user wants to commit the scaffold:
```bash
git add AGENTS.md .agents/ docs/ .devin/ .hermes/ .opencode/ .claude/ .cursor/ .windsurf/
git commit -m "chore: scaffold AI-agent-optimized workflow structure"
```

Only add the agent config directories that were created. Don't add directories that don't exist. Do NOT commit yet if the user wants to fill placeholders first — the fill prompt will handle the commit.

---

## Quick reference: Agent config paths

| Agent | Instructions | MCP config | Hooks | Rules |
|---|---|---|---|---|
| devin | `AGENTS.md` | `.devin/config.json` | `.devin/hooks.v1.json` | `.windsurf/rules/` |
| hermes | `AGENTS.md` | `.hermes/mcp.json` | `.hermes/hooks.json` | *(disabled)* |
| opencode | `AGENTS.md` | `.opencode/mcp.json` | `.opencode/hooks.json` | *(disabled)* |
| claude-code | `CLAUDE.md` | `.claude/settings.json` | `.claude/settings.json` | *(disabled)* |
| cursor | `.cursorrules` | `.cursor/mcp.json` | *(none)* | `.cursor/rules/` |
| windsurf | `.windsurf/rules` | `.windsurf/mcp_config.json` | *(none)* | `.windsurf/rules/` |
