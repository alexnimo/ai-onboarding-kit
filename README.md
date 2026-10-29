# AI Onboarding Kit

Onboard any project - new or existing - to a consistent AI-agent-optimized workflow with the same design patterns, skills, tools, and directory structure. Supports multiple AI agents on the same project.

## What it does

- Scaffolds a standard `.agents/` documentation directory (SYSTEM, ARCHITECTURE_PATTERNS, ENGINEERING_RULES, BUG_FIX_LOG, PRD, DEV_WORKFLOW)
- Generates a generic `AGENTS.md` that acts as a skill router and principle set, with a self-improving documentation maintenance section
- Checks which agent skills are installed (across 5 locations) and installs missing ones via `npx skills add`
- Optionally updates already-installed skills via `npx skills update`
- Merges MCP server config non-destructively (adds missing servers, never overwrites existing config)
- Supports 7 agent profiles: devin, hermes, opencode, claude-code, cursor, windsurf, omp
- Config-only mode for onboarding additional agents to an already-onboarded project (skips templates, only configures skills + MCP)
- Provides split onboarding prompts: scaffold (run scripts, install skills, merge config) and fill-placeholders (maturity-aware, no scaffold commands)
- Maturity-aware filling: detects design-phase / early-stage / mature projects and adjusts fill depth — no guessing, no extrapolating from unfinished design docs
- Self-improving docs: AGENTS.md instructs every agent session to keep `.agents/` docs current as the project evolves
- Maintains a kit-side project registry (`projects.registry.json`) and per-project install-state snapshot (`.agents/onboarding-state.json`) via `bin/onboard.mjs`

## Quick start

### Option A - Two-phase onboarding (recommended)

The onboarding flow is split into two phases. Run them in sequence from the project you want to onboard:

**Phase 1 — Scaffold** (run the scaffold script, install skills, merge MCP/hooks/rules):
1. Open Devin in the project you want to onboard
2. Paste this prompt:
   ```
   Scaffold this project for the AI-agent-optimized workflow. Follow @prompts/devin-scaffold.md — run the scaffold script, install missing required skills, merge MCP/hooks/rules config. The onboarding kit is at <KIT_PATH>.
   ```
3. Devin runs the scaffold, installs skills, merges config. Placeholders are NOT filled yet.

**Phase 2 — Fill placeholders** (maturity-aware, no scaffold commands):
1. In the same project, paste this prompt:
   ```
   Fill the {{placeholders}} in the scaffolded files. Follow @prompts/devin-fill-placeholders.md — detect project maturity, fill placeholders accordingly (infer from codebase for mature/early-stage, leave TBD for design-phase, never guess or extrapolate from unfinished design docs), and commit.
   ```
2. Devin detects maturity, fills what's knowable, leaves TBD for what isn't, and commits.

### Option B - One-shot onboarding (combined)

If you prefer a single session that does both phases:
```
Onboard this project to the AI-agent-optimized workflow. Follow @prompts/devin-onboard.md — detect project maturity, run the scaffold script, fill the {{placeholders}} accordingly, install missing required skills, merge MCP config, and commit. The onboarding kit is at <KIT_PATH>.
```

### Option C - Manual scaffold + fill

```powershell
# Windows - full scaffold for a new project
.\scaffold.ps1 -Target C:\path\to\your-project -Agent devin
.\scaffold.ps1 -Target C:\path\to\your-project -Agent devin -InstallSkills
```

```bash
# Unix - full scaffold for a new project
./scaffold.sh --target /path/to/your/project --agent devin
./scaffold.sh --target /path/to/your/project --agent devin --install-skills
```

Then manually fill the `{{placeholders}}` in the generated files, or paste the fill-placeholders prompt to fill them automatically.

### Option D - Onboard an additional agent to an existing project

If the project is already onboarded (has AGENTS.md + .agents/) and you want to add another agent:

```powershell
# Windows - config only (skills + MCP), no template overwrite
.\scaffold.ps1 -Target C:\path\to\project -Agent hermes -ConfigOnly -InstallSkills
```

```bash
# Unix - config only
./scaffold.sh --target /path/to/project --agent hermes --config-only --install-skills
```

This takes seconds: skills are shared globally via `~/.agents/skills/`, so they're already installed. Only the agent's MCP config file is created/merged.

## Project structure

```
ai-onboarding-kit/
├── README.md                    # This file
├── onboard.manifest.json        # Single source of truth: dirs, templates, skills, placeholders, MCP, agent profiles
├── scaffold.ps1                 # Windows scaffolder (PowerShell)
├── scaffold.sh                  # Unix scaffolder (bash, requires jq)
├── bin/
│   └── onboard.mjs              # Registry + install-state CLI (Node >=18, stdlib only)
├── projects.registry.json       # Kit-side project inventory (gitignored, created on first run)
├── templates/
│   ├── AGENTS.md.tmpl           # Generic AGENTS.md with {{placeholders}}
│   └── .agents/
│       ├── SYSTEM.md.tmpl
│       ├── ARCHITECTURE_PATTERNS.md.tmpl
│       ├── ENGINEERING_RULES.md.tmpl
│       ├── BUG_FIX_LOG.md.tmpl
│       ├── PRD.md.tmpl
│       └── DEV_WORKFLOW.md.tmpl
└── prompts/
    ├── devin-scaffold.md          # Phase 1: run scaffold, install skills, merge MCP/hooks/rules
    ├── devin-fill-placeholders.md # Phase 2: fill placeholders (maturity-aware, no scaffold commands)
    ├── devin-onboard.md           # Combined one-shot prompt (scaffold + fill in one session)
    └── devin-onboard-short.md     # Short @-reference invocation prompt
```

## What gets scaffolded in your project

```
your-project/
├── AGENTS.md                    # Skill router + principles (agent reads this every session)
├── .agents/
│   ├── SYSTEM.md                # System architecture overview
│   ├── ARCHITECTURE_PATTERNS.md # Canonical patterns + consistency checklist
│   ├── ENGINEERING_RULES.md     # Invariants, schema rules, dependency rules
│   ├── BUG_FIX_LOG.md           # Historical bugs (first stop for debugging)
│   ├── PRD.md                   # Product requirements (hard copy)
│   └── DEV_WORKFLOW.md          # Environment setup, commands, port assignments
├── docs/                        # Canonical technical docs
├── .devin/
│   ├── config.json              # MCP server config (under mcpServers key)
│   └── hooks.v1.json            # Lifecycle hooks (PreToolUse, PostToolUse, etc.)
├── .windsurf/
│   ├── mcp_config.json          # Windsurf MCP config (if agent=windsurf)
│   └── rules/                   # Rule files (dev-environment.md, coding-standards.md)
├── .cursor/
│   ├── mcp.json                 # Cursor MCP config (if agent=cursor)
│   └── rules/                   # Rule files
└── .omp/
    └── mcp.json                 # omp MCP config (if agent=omp)
```

## CLI reference

### PowerShell (Windows)

```powershell
.\scaffold.ps1 -Target <dir> [-Agent <name>] [-InstallSkills] [-UpdateSkills] [-ConfigOnly] [-Force] [-ManifestPath <path>]
```

### Bash (Unix)

```bash
./scaffold.sh [--target <dir>] [--agent <name>] [--install-skills] [--update-skills] [--config-only] [--force] [--manifest <path>]
```

### Flags

| Flag | PowerShell | Bash | Description |
|---|---|---|---|
| Target | `-Target <dir>` | `--target <dir>` | Project directory to scaffold into (default: current dir) |
| Agent | `-Agent <name>` | `--agent <name>` | Agent profile: devin, hermes, opencode, claude-code, cursor, windsurf, omp (default: devin) |
| Install skills | `-InstallSkills` | `--install-skills` | Install missing required skills via `npx skills add` |
| Update skills | `-UpdateSkills` | `--update-skills` | Update already-installed skills via `npx skills update` |
| Config only | `-ConfigOnly` | `--config-only` | Skip templates, only configure skills + MCP (for additional agents) |
| Force | `-Force` | `--force` | Overwrite existing template files |
| Manifest | `-ManifestPath <path>` | `--manifest <path>` | Custom manifest path (default: next to script) |

## Onboarding registry & state

At the end of a successful run, the scaffold calls `bin/onboard.mjs` (Node >=18, stdlib only) to update two state files. This is best-effort: if node is missing the scaffold prints a warning and still succeeds.

- **`projects.registry.json`** (kit root, gitignored): desired-state inventory. One entry per onboarded project - `{name, path (resolved absolute), agents[], onboardedAt, lastSyncAt, overrides{skip:[],pins:{}}}` - idempotent by resolved path.
- **`.agents/onboarding-state.json`** (per project): recorded install base - `{schemaVersion, kitCommit, manifestHash, artifacts}` mapping each dest path to `{hash, source, syncedAt}`. Template and rule dests hash the kit source file as installed (pre-placeholder-fill); MCP/hooks config paths hash the generated file on disk.

Both files are written atomically (tmp + rename) and stamped `schemaVersion: 1`.

```bash
node bin/onboard.mjs register --name my-project --path /path/to/project [--agents devin,hermes]
node bin/onboard.mjs register --path /path/to/project --remove
node bin/onboard.mjs list [--json]
node bin/onboard.mjs record-state --path /path/to/project [--manifest <path>]
node bin/onboard.mjs sync [--project NAME] [--dry-run] [--force] [--json]
                        [--update-skills] [--install-skills] [--adopt] [--prune]
                        [--restore-deleted] [--manifest <path>]
node bin/onboard.mjs doctor [--project NAME] [--json] [--stale-days N]
                        [--manifest <path>]
node bin/onboard.mjs ui [--port 4173]
```

## Syncing projects (`sync`)

`sync` re-applies the current kit to every registered project (or one
`--project`) using three-way merge against the recorded install base in each
project's `.agents/onboarding-state.json`. Project edits and filled
`{{PLACEHOLDER}}` values are preserved; local changes are never silently
overwritten.

| Situation (per managed file) | Action | Result |
|---|---|---|
| Project file == recorded base | `fast-forward` | Kit update written; base hash refreshed |
| Kit template == recorded base | `project-only` | Local edits kept, nothing written |
| Both changed, disjoint edits | `merged` | diff3 merge written |
| Both changed, same region | `conflict` | Git-style `<<<<<<< / ||||||| / ======= / >>>>>>>` markers written; exit 2 |
| Recorded dest missing from project | `skip` | Project deletion respected (see `--restore-deleted`) |
| File at managed dest, no base | `skip` | Foreign file, never overwritten |
| Managed dest absent, never recorded | `fast-forward` | New kit template propagated (agent-scoped dests only when the agent is registered) |
| Dest no longer in manifest | `retired` | Left on disk, reported; `--prune` deletes it only when project bytes still equal the recorded base (customized retired files are kept) |
| Project without state file | `unadopted` | Nothing touched (see `--adopt`) |

Merge bases are reconstructed from git history (`git show <kitCommit>:<src>`,
verified against the recorded hash), so placeholder fills read as project-side
edits and always survive a merge.

**MCP/hooks configs** merge per manifest key (`mcpServers.<name>`, hook events)
instead of whole files: entries unchanged since install follow kit updates,
project-added entries stay `project-only`, and entries customized on both sides
are preserved while the kit's proposal is published to
`<config>.kit-incoming.json` (JSON never gets conflict markers).

**Overrides** (per registry entry): `overrides.skip` exempts a path or a
`config.json:mcpServers.name` key entirely; `overrides.pins` does the same and
reports a reason.

**Flags**: `--dry-run` reports without writing (exit code reflects what a real
run would do); `--json` emits the machine-readable report; `--update-skills` /
`--install-skills` run `npx skills update|add` for manifest skills (default is
a presence check matching the scaffold's search locations); `--adopt` records
a baseline for state-less projects (MCP/hooks configs and skills only -
templates and rules are project-owned and never adopted or written by the
adopt run); `--prune` deletes `retired` dests whose bytes still equal the
recorded base; `--restore-deleted` re-adds files and managed config keys the
project removed. Files still carrying conflict markers
always report `conflict` (exit 2) - resolve the markers manually, then re-run;
`--force` is accepted for CLI compatibility but cannot clear them.

Exit code is `2` when any conflict needs a human, `0` otherwise. A second sync
right after a clean run reports zero actions - sync is idempotent. No report
files are written into projects.

Merge bases are tracked per artifact: each recorded file keeps the kit commit
it was installed/synced from (`artifacts[dest].kitCommit`), so skipping a file
through `overrides` while the rest of the project advances cannot strand its
recorded base - the next merge still reconstructs it from git history.

**Library facade** (`bin/lib/sync-engine.mjs`): the same engine is exposed as
in-process functions for the POR-109 sync Web UI - `dryRun(projectRoot)`
returns the `sync --dry-run --json` plan plus per-file unified diffs with
zero disk writes, `mergeFile(projectRoot, dest)` materializes the three-way
base/kit/project/merged views without writing, and
`applyDisposition(projectRoot, dest, 'accepted'|'reverted'|'kit')` applies or
defers a single dest atomically (managed-key configs refresh per-key bases
only for keys actually resolved).

**Local sync server** (`bin/lib/ui-server.mjs`, `ui` subcommand): a
zero-dependency node:http JSON API + static SPA host (`bin/ui/`) over the
facade. It binds 127.0.0.1 only and 403s any request whose Host header is
not exactly `127.0.0.1:<port>` or `localhost:<port>` (cheap DNS-rebinding
defense - no auth in v1). Mutating routes additionally require
`Content-Type: application/json` and reject any `Origin` header that is
not this server (cross-origin browser POSTs cannot forge either).
`POST /api/dry-run` stores the plan in a bounded session-only in-memory
store (plan ids never touch disk);
`POST /api/plans/:id/apply` runs only the submitted dispositions and
records `lastSyncResult {at, accepted[], reverted[], kit[], action}` on the
project's registry entry - the apply-history source of truth behind
`GET /api/history?project=`. Reads: `GET /api/projects`,
`GET /api/plans/:id[/diff|/merge?dest=]`; writes:
`POST|DELETE /api/projects` (lock-serialized like CLI register).
## Fleet health (`doctor`)

`doctor` is a read-only health check over the registered fleet (or one
`--project`). Per project it reports: dead paths (suggests `register
--remove`), missing/unparseable state files (suggests `sync --adopt`),
recorded kit commits missing from the kit repo, drift vs the current kit
(project-only / kit-ahead / would-be-conflict / retired counts, computed via
a dry-run sync), required skills missing per the scaffold's 5-location check,
overrides referencing nonexistent paths, and staleness (`lastSyncAt` older
than `--stale-days`, default 30). `--json` emits the machine-readable
report. Exit code is `3` when any project reports a finding, `0` clean.

**Sync Web UI** (`bin/ui/`, served by `node bin/onboard.mjs ui`): a vanilla
ES-module SPA with no build step. Dashboard lists registered projects with
agent counts and last sync status. Each project runs a dry run first (nothing
is written); the classify table shows fast-forward, merged, conflict, and skip
rows with per-file Accept / Revert / Kit controls. Every non-skip row expands
to a unified diff; conflict rows open a three-pane base / project / kit view.
Apply is disabled until every conflict file has a disposition, and runs only
on an explicit click. The result banner and the history panel read the
registry's `lastSyncResult`. v1 resolves conflicts per file, not per hunk.

## Skill behavior

| Situation | Action |
|---|---|
| Skill found in any search location | **Skip** - no reinstall, no update |
| Skill missing + `--install-skills` | Install via `npx skills add <source>@<skill> -g -y` |
| Skill installed + `--update-skills` | Update via `npx skills update <source>@<skill> -g -y` |
| Skill installed + no flags | Skip |
| Optional skill missing | List in summary, do NOT auto-install |

### Skill search locations (checked in order)

1. `~/.agents/skills/<name>/SKILL.md` - global, shared by all agents
2. Agent profile skill dirs (e.g., `~/.claude/skills/` for claude-code)
3. `<project>/.windsurf/skills/<name>/SKILL.md` - project-level
4. `<project>/.agents/skills/<name>/SKILL.md` - project-level
5. `~/.agents/.skill-lock.json` - global lock file

If a skill exists in ANY of these, it is NOT reinstalled. This prevents ghost directories and unneeded installations.

## MCP config behavior

| Situation | Action |
|---|---|
| MCP config file doesn't exist | Create with required + optional servers from manifest |
| MCP config file exists, server missing | **Add** server (non-destructive merge) |
| MCP config file exists, server present | **Skip** - never overwrite existing config |

The MCP config path is agent-specific (from manifest `agentProfiles`):

| Agent | MCP config path | Format |
|---|---|---|
| devin | `.devin/config.json` (under `mcpServers` key) | JSON, nested |
| hermes | `.hermes/mcp.json` | JSON |
| opencode | `.opencode/mcp.json` | JSON |
| claude-code | `.claude/settings.json` (under `mcpServers` key) | JSON, nested |
| cursor | `.cursor/mcp.json` | JSON |
| windsurf | `.windsurf/mcp_config.json` | JSON |
| omp | `.omp/mcp.json` | JSON |

> **Devin note:** Devin also reads the global Windsurf MCP config at `~/.codeium/windsurf/mcp_config.json` via `read_config_from.windsurf`. Project-level `.devin/config.json` takes priority.
>
> **omp note:** omp auto-imports MCP server definitions from other agents' configs (Claude Code, Codex, Gemini CLI, OpenCode, Cursor, Windsurf, VS Code) - the first definition found wins; definitions are not merged. On a multi-agent project, either let omp auto-import the existing config or write `.omp/mcp.json` - do not double-register the same server in both.

## Hooks config behavior

Hooks are lifecycle event handlers (PreToolUse, PostToolUse, SessionStart, Stop) that run shell commands. The scaffold merges hooks non-destructively, same as MCP config.

| Situation | Action |
|---|---|
| Hooks config file doesn't exist | Create with all hooks from manifest |
| Hooks config file exists, event missing | **Add** event hooks (non-destructive merge) |
| Hooks config file exists, event present | **Skip** - never overwrite existing hooks |

The hooks config path and format are agent-specific:

| Agent | Hooks config path | Format |
|---|---|---|
| devin | `.devin/hooks.v1.json` | Standalone (hooks object is the entire file) |
| hermes | `.hermes/hooks.json` | Standalone |
| opencode | `.opencode/hooks.json` | Standalone |
| claude-code | `.claude/settings.json` (under `hooks` key) | Nested |
| cursor | *(not supported)* | - |
| windsurf | *(not supported)* | - |
| omp | *(not supported)* | - |

> **omp note:** omp hooks are trusted TypeScript/JavaScript modules under `.omp/hooks/pre/` and `.omp/hooks/post/` - executable code, not declarative JSON - so the kit does not write a hooks config for omp (same treatment as cursor/windsurf).

### Devin hooks format

Devin supports two hook file formats:
- **Standalone** (recommended): `.devin/hooks.v1.json` - the hooks object IS the entire file
- **Nested**: `.devin/config.json` under the `"hooks"` key

The scaffold uses the standalone format (`.devin/hooks.v1.json`) as recommended by the Devin docs.

### Adding custom hooks

Edit `onboard.manifest.json` -> `hooks` array:
```json
{
  "event": "PreToolUse",
  "matcher": "exec|write",
  "type": "command",
  "command": "my-hook-script.sh",
  "required": false,
  "hint": "What this hook does"
}
```

## Rules behavior

Rules are markdown files loaded by agents that support rule directories (Windsurf `.windsurf/rules/`, Cursor `.cursor/rules/`). Devin reads these via `read_config_from.windsurf` and `read_config_from.cursor`.

| Situation | Action |
|---|---|
| Rule file doesn't exist | **Copy** from template |
| Rule file exists | **Skip** (unless `--force`) |

| Agent | Rules directory | Enabled |
|---|---|---|
| devin | `.windsurf/rules/` (read via `read_config_from`) | Yes |
| cursor | `.cursor/rules/` | Yes |
| windsurf | `.windsurf/rules/` | Yes |
| hermes | `.hermes/rules/` | No (set `rulesEnabled: true` to enable) |
| opencode | `.opencode/rules/` | No |
| claude-code | `.claude/rules/` | No |
| omp | `.omp/rules/` | Yes |

### Adding custom rules

1. Create a `.tmpl` file in `templates/rules/`
2. Add to `onboard.manifest.json` -> `rules` array:
   ```json
   { "src": "templates/rules/my-rule.md.tmpl", "dest": "my-rule.md", "overwrite": false }
   ```

## Agent profiles

The manifest defines profiles for 7 agents. Each profile specifies:

- `instructionsFile`: The file the agent reads for instructions (AGENTS.md, CLAUDE.md, .cursorrules, etc.)
- `mcpConfigPath`: Where the agent's MCP config lives
- `hooksConfigPath`: Where hooks config lives (or `null` if not supported)
- `hooksConfigFormat`: `standalone` or `nested` (or `null`)
- `rulesDir`: Where rule files are copied (or `null`)
- `rulesEnabled`: Whether to copy rules for this agent
- `skillDirs`: Additional skill search directories beyond the global `~/.agents/skills/`
- `readConfigFrom`: (Devin only) Import settings from other tools
- `notes`: Agent-specific notes

| Agent | Instructions | MCP config | Hooks | Rules | Extra skill dirs |
|---|---|---|---|---|---|
| devin | `AGENTS.md` | `.devin/config.json` | `.devin/hooks.v1.json` | `.windsurf/rules/` | - |
| hermes | `AGENTS.md` | `.hermes/mcp.json` | `.hermes/hooks.json` | *(disabled)* | - |
| opencode | `AGENTS.md` | `.opencode/mcp.json` | `.opencode/hooks.json` | *(disabled)* | - |
| claude-code | `CLAUDE.md` | `.claude/settings.json` | `.claude/settings.json` | *(disabled)* | `~/.claude/skills` |
| cursor | `.cursorrules` | `.cursor/mcp.json` | *(none)* | `.cursor/rules/` | - |
| windsurf | `.windsurf/rules` | `.windsurf/mcp_config.json` | *(none)* | `.windsurf/rules/` | `.windsurf/skills` |
| omp | `AGENTS.md` | `.omp/mcp.json` | *(none)* | `.omp/rules/` | `~/.omp/agent/skills`, `.omp/skills` |

### Multi-agent onboarding

Most agents share the same skills (via `~/.agents/skills/`) and the same `AGENTS.md`. The only difference is the MCP config file location. To onboard a second agent:

```bash
./scaffold.sh --target /path/to/project --agent hermes --config-only --install-skills
```

This takes seconds because:
- Skills are already installed globally (shared)
- Only the MCP config file needs to be created/merged
- No templates are overwritten

## The manifest - `onboard.manifest.json`

Everything is driven by this single file. To extend the kit:

| Want to... | Edit... |
|---|---|
| Add a new skill | `skills` array - add `{name, source, skill, category, required}` |
| Add a new MCP server | `mcpServers` array - add `{name, required, hint, config}` |
| Add a new hook | `hooks` array - add `{event, matcher, type, command, required, hint}` |
| Add a new rule | `rules` array - add `{src, dest, overwrite}` and drop the `.tmpl` file in `templates/rules/` |
| Add a new template | `templates` array - add `{src, dest, overwrite}` and drop the `.tmpl` file in `templates/` |
| Add a new directory | `directories` array |
| Add a new placeholder | `placeholders` array - add `{key, hint}` |
| Add a new agent profile | `agentProfiles` object - add `{instructionsFile, mcpConfigPath, hooksConfigPath, hooksConfigFormat, rulesDir, rulesEnabled, skillDirs, notes}` |

The scaffold scripts read this file at runtime - no code changes needed.

### How to add a skill

1. Find the skill on [skills.sh](https://skills.sh/) or GitHub
2. Add to `onboard.manifest.json`:
   ```json
   { "name": "my-new-skill", "source": "owner/repo", "skill": "skill-folder-name", "category": "backend", "required": false }
   ```
3. Run the scaffold script - it will detect if the skill is installed and install it if missing + `--install-skills`

### How to add an MCP server

1. Add to `onboard.manifest.json`:
   ```json
   {
     "name": "my-mcp-server",
     "required": false,
     "hint": "What it does",
     "config": {
       "command": "npx",
       "args": ["-y", "@my-mcp/server"],
       "env": {}
     }
   }
   ```
2. Run the scaffold script - it will merge the server into each agent's MCP config file (non-destructive)

### How to add a hook

1. Add to `onboard.manifest.json` -> `hooks` array:
   ```json
   {
     "event": "PreToolUse",
     "matcher": "exec|write|edit",
     "type": "command",
     "command": "my-hook-script.sh",
     "required": false,
     "hint": "What this hook does"
   }
   ```
2. Run the scaffold script - it will merge the hook into each agent's hooks config file (non-destructive, only for agents that support hooks)

### How to add a rule

1. Create a `.tmpl` file in `templates/rules/` (e.g., `my-rule.md.tmpl`)
2. Add to `onboard.manifest.json` -> `rules` array:
   ```json
   { "src": "templates/rules/my-rule.md.tmpl", "dest": "my-rule.md", "overwrite": false }
   ```
3. Run the scaffold script - it will copy the rule to each agent's rules directory (only for agents with `rulesEnabled: true`)

## Skills

The manifest lists 33 skills across 7 categories plus 1 kit-bundled template skill (`ui-design-orchestrator`). Required skills are installed automatically with `--install-skills`. Optional skills are listed but not installed.

### Skill install mechanism

All skills use the standard [Skills CLI](https://skills.sh/):

```bash
npx skills add <owner/repo>@<skill-folder> -g -y
```

- `-g` installs globally (user-level, at `~/.agents/skills/`)
- `-y` skips confirmation prompts

Never create skill directories manually - always use `npx skills add`.

**Exception — kit-bundled template skills:** skills that ship with the kit (in `templates/skills/`) are installed by the scaffold script copying the directory to `~/.agents/skills/`, not via `npx skills add`. See `templateSkills` in the manifest. The `ui-design-orchestrator` is installed this way.

### Skill categories

| Category | Skills |
|---|---|
| thinking | `brainstorming`, `grill-me`, `grill-with-docs` |
| planning | `spec-driven-development`, `planning-and-task-breakdown`, `test-driven-development` |
| quality | `code-review-and-quality` |
| debugging | `debugging-and-error-recovery`, `diagnosing-bugs` |
| workflow | `using-git-worktrees`, `handoff` |
| documentation | `documentation-and-adrs`, `excalidraw-diagram-generator` |
| meta | `find-skills`, `full-output-enforcement` |
| backend | `api-and-interface-design`, `security-and-hardening`, `performance-optimization`, `observability-and-instrumentation`, `improve-codebase-architecture` |
| testing | `browser-testing-with-devtools` |
| frontend | `design-taste-frontend`, `frontend-ui-engineering`, `web-design-guidelines`, `redesign-existing-projects`, `high-end-visual-design`, `minimalist-ui`, `stitch-design-taste`, `imagegen-frontend-web`, `imagegen-frontend-mobile`, `vercel-react-best-practices`, `stop-slop`, `impeccable` |
| template (kit-bundled) | `ui-design-orchestrator` |

## UI Design Orchestrator

The `ui-design-orchestrator` skill is the master router for all UX/UI work. `AGENTS.md` does not make UX/UI skill choices inline — it defers to this orchestrator, which routes to the right design skills under the hood, runs a four-phase lifecycle (set context → build + refine → check → keep from drifting), and can fan out multiple design directions in parallel with per-lane model control.

### The four-phase lifecycle

When [impeccable](https://impeccable.style) is installed (both the skill AND the npm package), the orchestrator runs a complete four-phase design lifecycle. When it's not installed, the orchestrator falls back to kit skills for phases 1-3 and skips phase 4.

| Phase | With impeccable | Without impeccable (fallback) |
|---|---|---|
| **1 — Set context** | `/impeccable init` (PRODUCT.md) + `document` (DESIGN.md) + `shape` (discovery brief) | Orchestrator brief intake + `.agents/PRD.md` |
| **2 — Build** | Direction skill(s) → `frontend-ui-engineering` → impeccable refinement (`polish`, `typeset`, `layout`, `harden`, etc.) | Direction skill(s) → `frontend-ui-engineering` (no refinement) |
| **3 — Check** (mandatory) | `audit` (5-dim, P0-P3) + `critique` (Nielsen, personas) + `detect` (CLI) + `browser-testing-with-devtools` + `stop-slop` | `web-design-guidelines` + `browser-testing-with-devtools` + `stop-slop` |
| **4 — Drift** | `document` (refresh DESIGN.md) + `extract` (pull components) + `doctor` (hook health) | (skipped) |

**Impeccable is not a single skill — it's a 20+ command toolkit.** The orchestrator invokes the right commands per phase. Two installation paths are needed for the full flow:
1. `npx skills add pbakaus/impeccable@impeccable -g -y` — the skill (gives the agent `/impeccable` commands)
2. `npx impeccable install` (in the project root) — the npm package (detector CLI, design hooks, context files)

### What it does

- **Runs the four-phase lifecycle** (context → build+refine → check → drift) with graceful fallback when impeccable is absent.
- **Multi-design exploration (`explore` mode):** fans out K parallel lanes, each with its own direction skill AND its own model, each producing a full implementation on an isolated git worktree. The user picks one; the rest are cleaned up. Then phases 3 + 4 run on the winner.
- **Data-driven skill set:** the registry (`REGISTRY.md` inside the skill) maps skills from any repos. Mix skills from `Leonxlnx/taste-skill`, `hardikpandya/stop-slop`, `pbakaus/impeccable`, etc. Install only what you use — the orchestrator presence-checks skills before routing and skips missing optional ones (using fallbacks).
- **Per-lane model control:** in `explore` mode, each lane can use a different model (`glm-5.2`, `kimi-k2.7`, `swe-1.7`, `claude-opus-4.8`, etc. — see `MODELS.md`).
- **Direction contract:** when impeccable is installed, the orchestrator adopts impeccable's structured 5-block contract (THESIS / OWN-WORLD / STORY / FIRST VIEWPORT / FORM) instead of a loose design read — more rigorous and inspectable.

### Four modes

| Mode | When | What |
|---|---|---|
| `single` (default) | One design | Inline routing through all four phases |
| `explore` | "Give me options" / new surface with budget | Parallel fan-out: K lanes, each `{skill, model, worktree}`, full implementations, pick one, merge, clean up, phases 3+4 on winner |
| `lifecycle` | Full impeccable lifecycle explicitly | All four phases with mandatory drift prevention |
| `audit` (always-on tail) | After every UI change / standalone | Phase 3 only: `stop-slop` + impeccable `audit` + `critique` + `detect` (or fallback). Also runnable standalone. |

### Page kind → impeccable mode mapping

Impeccable names four modes (per-surface, not per-company). The orchestrator's `page_kind` brief field maps to them:

| `page_kind` | Impeccable mode | Meaning |
|---|---|---|
| landing / marketing / pricing / campaign | Persuade | The visitor decides and acts. Design earns attention. |
| app_screen / dashboard / editor / admin / tool | Operate | The visitor completes a task. Density, predictable controls. |
| docs / guide / help / changelog | Read | The visitor understands something. Comprehension first. |
| portfolio / gallery / showcase | Experience | The visitor is inside the work. The artifact leads. |

### Enforcement (skill + hooks)

- **Skill instruction:** the orchestrator mandates phase 3 at the end of every UI task.
- **PostToolUse hook:** the scaffold configures a hook (for hook-capable agents) that fires after `edit`/`write` on UI files. It checks for `.impeccable/config.json` — if present, it defers to impeccable's own two-speed hooks (per-edit + end-of-session, DESIGN.md-aware). If absent, it runs `npx impeccable detect` as fallback, or the orchestrator's audit mode.

### Skill structure

```
templates/skills/ui-design-orchestrator/
├── SKILL.md            # Router: brief intake → mode → dispatch → phases
├── REGISTRY.md          # Data-driven skill registry (tier/surface/source/composable/trigger/commands)
├── MODELS.md            # Exact model labels for per-lane assignment
├── modes/
│   ├── single.md        # Default inline routing (four phases)
│   ├── explore.md       # Parallel subagent fan-out (full implementations)
│   ├── lifecycle.md     # Full four-phase impeccable lifecycle
│   └── audit.md         # Standalone phase 3 (check before shipping)
└── prompts/
    ├── brief.md         # Canonical brief (reads PRODUCT.md/DESIGN.md, maps page_kind→mode)
    ├── lane.md          # Per-lane prompt-file template (brief + skill + chain)
    └── audit.md         # stop-slop + impeccable checklist
```

### How to extend

- **Add a skill to the routing:** edit `REGISTRY.md` inside the installed skill (or the kit template at `templates/skills/ui-design-orchestrator/REGISTRY.md`). Add a row with `name`, `source`, `skill`, `tier`, `surface`, `required`, `composable`, `trigger`. For impeccable commands, set `commands` to the specific `/impeccable` commands. No code changes to `SKILL.md`.
- **Add a model for per-lane assignment:** edit `MODELS.md`.
- **Add a new mode:** add a file under `modes/` and reference it from `SKILL.md`.

### Install

The orchestrator is installed automatically by the scaffold (it's a `templateSkill` in the manifest, copied to `~/.agents/skills/ui-design-orchestrator/`). The anti-slop skill (`stop-slop`) and the four-phase toolkit (`impeccable`) are optional community skills — install on demand:

```bash
# stop-slop (prose anti-slop — required by the orchestrator)
npx skills add hardikpandya/stop-slop@stop-slop -g -y

# impeccable skill (gives the agent /impeccable commands)
npx skills add pbakaus/impeccable@impeccable -g -y

# impeccable npm package (detector CLI + design hooks + context files)
# run this in your project root after installing the skill:
npx impeccable install
```

The orchestrator warns and emits these install hints if it routes to a phase and finds the relevant skill missing.

### Design spec

See `docs/specs/2026-08-02-ui-design-orchestrator-design.md` for the full design.

## Maturity-aware onboarding

The fill-placeholders prompt detects project maturity and adjusts fill depth accordingly. This prevents the agent from guessing or extrapolating when there isn't enough information.

### Three maturity levels

| Level | Criteria | Fill behavior |
|---|---|---|
| **design-phase** | No source files, no package config. Only design docs, README, or nothing. | Fill only PROJECT_NAME, PROJECT_DESCRIPTION, and PROJECT_MATURITY. Everything else: TBD with `<!-- TODO -->`. Do NOT infer tech stack, commands, ports, patterns, or invariants. Do NOT fill docs from unfinished design docs. |
| **early-stage** | Some source files OR a package config exists, but the codebase is small or clearly incomplete. | Fill what is directly inferable from existing code/config. Ask the user for missing values. Do not over-document patterns that haven't emerged yet. |
| **mature** | Significant codebase with established structure, config, tests, and clear patterns. | Full inference: inspect codebase thoroughly for stack, commands, ports, patterns, invariants, regression examples. Fill everything possible. |

### Anti-patterns prevented

- **No guessing:** If information doesn't exist in the codebase or from the user, it stays TBD.
- **No extrapolation from unfinished docs:** Draft HLDs and research docs are not treated as decisions. The agent will not fill PRD/SYSTEM/ARCHITECTURE docs by inferring from them.
- **No invented tech stacks:** For design-phase projects, the agent does not pick a stack. It asks the user or leaves TBD.
- **No hypothetical bugs:** Regression examples and bug logs only contain real, known issues.
- **No referencing non-existent skills:** Only skills that are installed or in the project's skill directories are referenced.

### Optional: brainstorming for design-phase projects

For design-phase projects, the fill prompt can offer to invoke the `brainstorming` skill to help define vision, scope, or stack — but only with the user's consent. This closes the gap between "we have no requirements" and "we need to start building" without the agent making opinionated decisions.

## Self-improving documentation

The AGENTS.md template includes a "Documentation maintenance" section that instructs every agent session to keep the `.agents/` docs current:

- New patterns → `.agents/ARCHITECTURE_PATTERNS.md`
- New invariants → `.agents/ENGINEERING_RULES.md`
- Fixed bugs → `.agents/BUG_FIX_LOG.md`
- New subsystems → `.agents/SYSTEM.md`
- Architectural decisions → ADRs via `documentation-and-adrs` skill
- Workflow changes → `.agents/DEV_WORKFLOW.md`
- Filled TBDs → remove `<!-- TODO -->` and replace `{{KEY}}` with the value
- Maturity changes → update the `{{PROJECT_MATURITY}}` marker and fill previously-TBD placeholders

This ensures the docs evolve with the project, regardless of whether it starts as design-phase or mature.

## Onboarding scenarios

### New project (design phase, no code)

1. **Scaffold phase:** Run scaffold → creates directory structure with stub templates
2. **Fill phase:** Devin detects `design-phase` maturity → fills only PROJECT_NAME, PROJECT_DESCRIPTION, PROJECT_MATURITY. Everything else: TBD with `<!-- TODO -->` comments
3. As the project matures, the agent fills TBDs during normal development (self-improving docs)

### Existing project (code already exists)

1. **Scaffold phase:** Run scaffold → creates directory structure with stub templates
2. **Fill phase:** Devin detects `early-stage` or `mature` → inspects the codebase to infer stack, commands, ports, patterns, invariants. Fills what's knowable, TBD for the rest.
3. Devin checks for project-specific skills in `.windsurf/skills/` and `.agents/skills/` and references them in AGENTS.md
4. Historical bugs are seeded into BUG_FIX_LOG.md if known

### Existing project + additional agent (config-only)

1. Run scaffold with `--config-only --agent <new-agent>`
2. Templates are skipped (AGENTS.md and .agents/ already exist and are filled)
3. Skills are checked (already installed globally, shared)
4. MCP config is merged into the new agent's config file
5. The new agent now reads the same AGENTS.md and has the same skills + MCP servers

## Design principles

1. **Single source of truth** - `onboard.manifest.json` drives everything. No hardcoded lists in scripts.
2. **No ghost directories** - skills are only installed via `npx skills add`, never manually created.
3. **No unneeded installations** - the script checks 5 locations before installing a skill.
4. **Non-destructive MCP** - MCP config is merged, never overwritten. Existing servers are preserved.
5. **Stack-agnostic** - one template works for any stack. Project-specific details are `{{placeholders}}`.
6. **Maturity-aware** - the fill prompt detects project maturity and adjusts fill depth. Design-phase projects get lean, mostly-TBD docs. Mature projects get thorough, inferred docs. No guessing, no extrapolation from unfinished docs.
7. **Self-improving docs** - AGENTS.md instructs every agent session to keep `.agents/` docs current as the project evolves.
8. **Split prompts** - scaffold and fill are separate prompts so they can be run independently. The scaffold prompt runs commands; the fill prompt only edits files. No re-running scaffold commands when only filling is needed.
9. **Extensible** - add skills, templates, placeholders, MCP servers, or agent profiles by editing the manifest, not the scripts.
10. **Idempotent** - re-running the scaffold skips existing files. Safe to re-run.
11. **Multi-agent** - onboard multiple agents to the same project in seconds via config-only mode.
12. **Agent-first** - the prompts handle the intelligent parts (maturity detection, inference, filling, verification). The script handles the mechanical parts (mkdir, copy, check, merge).

## Requirements

- **Windows**: PowerShell 5.1+ (built-in)
- **Unix**: bash + [jq](https://stedolan.github.io/jq/)
- **Skill installation**: Node.js / npx (for `npx skills add`)
- **Registry/state recording**: Node.js >= 18 (optional - scaffold warns and skips if node is missing)
