# AI Onboarding Kit

Onboard any project — new or existing — to a consistent AI-agent-optimized workflow with the same documentation structure, skills, MCP servers, hooks, and rules. Supports multiple AI agents on the same project.

## What it does

- Scaffolds a standard `.agents/` documentation directory (SYSTEM, ARCHITECTURE_PATTERNS, ENGINEERING_RULES, BUG_FIX_LOG, PRD, DEV_WORKFLOW)
- Generates an `AGENTS.md` that acts as a skill router and principle set, with a self-improving documentation maintenance section
- Injects a kit-managed region (`<!-- kit-region:* -->` markers) into an existing `AGENTS.md`/`CLAUDE.md` instead of overwriting it
- Checks which agent skills are installed (across 5 locations) and installs missing ones via `npx skills add`
- Merges MCP server, hooks, and rules config non-destructively (adds missing entries, never overwrites existing config)
- Supports 7 agent profiles: devin, hermes, opencode, claude-code, cursor, windsurf, omp
- Config-only mode for onboarding additional agents to an already-onboarded project (skips templates)
- Maturity-aware placeholder filling: detects design-phase / early-stage / mature projects and adjusts fill depth — no guessing
- Tracks every onboarded project in a kit-side registry (`projects.registry.json`) and a per-project install-state snapshot (`.agents/onboarding-state.json`), then keeps them current with a three-way `sync`
- Specialist profiles: named capability bundles (skills + specialist MCP servers) materialized per harness (`omp --profile qa-agent`, `claude --agent design`, ...)
- Ships a local Web UI (`node bin/onboard.mjs ui`) for reviewing onboarding plans and three-way syncs before anything is written

## How a project moves through the kit

```
                    ┌────────────────────────────────────────────────────┐
                    │  node bin/onboard.mjs onboard --target <project>   │
                    │  builds a plan, serves the review UI               │
                    └────────────────────────────────────────────────────┘
                                       │
            ┌──────────────────────────▼──────────────────────────┐
            │  APPLY (review UI, or --apply)                       │
            │  • scaffold writes templates/config                  │
            │  • project is REGISTERED in projects.registry.json   │
            │  • .agents/onboarding-state.json records the base    │
            └──────────────────────────┬───────────────────────────┘
                                       │
            ┌──────────────────────────▼───────────────────────────┐
            │  FILL — paste prompts/onboard-fill.md into your      │
            │  agent runner (or let a runner do it). {{placeholders}}│
            │  filled per project maturity.                        │
            └──────────────────────────┬───────────────────────────┘
                                       │
        kit evolves ──────────────────▼──────────────────────────
            │  SYNC — node bin/onboard.mjs ui (click through)      │
            │        or node bin/onboard.mjs sync                   │
            │  three-way merge; project edits and fills survive     │
            │                                                      │
            │  DOCTOR — node bin/onboard.mjs doctor                 │
            │  read-only fleet health check                         │
```

The registry entry is created by apply — you never have to run `register` by hand unless you want to add a project that was scaffolded outside the CLI.

## Quick start

### Interactive onboarding (recommended)

```bash
node bin/onboard.mjs onboard --target C:\path\to\your-project --profile devin
```

This runs the scaffold in dry-run mode, merges the results with the node-side plan, then starts the local review server and prints a URL like `http://127.0.0.1:4173/#/onboard?plan=<id>`. Open it in a browser — **nothing is written yet**.

In the review page:

1. Each row is one plan artifact (file, skill, config merge, region injection, bookkeeping). Toggle rows on/off to include or exclude them.
2. Expand a row to see the diff against what's on disk.
3. Rows flagged `merge-keys` or `inject-region` (config merges into files you already own) offer **Resolve with agent** — the chosen runner CLI rewrites the merge, and the result is applied instead of the raw diff.
4. Press **Apply**. Only accepted artifacts are written (via the scaffold's `--only` allowlist), the project is registered, and its install-state is recorded.

Then fill the `{{placeholders}}`: open your agent runner **in the onboarded project** and paste `prompts/onboard-fill.md` (see *Fill* below).

Useful flags for this command:

| Flag | Effect |
|---|---|
| `--profile <name>` | Agent profile to configure (devin, hermes, opencode, claude-code, cursor, windsurf, omp; default `devin`) |
| `--agent <runner>` | Runner CLI used for agent-assisted steps (devin, claude, omp, opencode; default `devin`) |
| `--resolve-with <runner>` | Runner used by **Resolve with agent** buttons (defaults to `--agent`) |
| `--install-skills` / `--update-skills` | Include skill install/update rows in the plan |
| `--json` | Print `{plan, summary}` and exit — writes nothing, no server |
| `--apply` | Skip review, apply the whole plan (CI/scripting) |

```bash
node bin/onboard.mjs onboard --target <path> --profile devin --json    # plan only
node bin/onboard.mjs onboard --target <path> --profile devin --apply   # apply everything
```

### The Web UI

`node bin/onboard.mjs ui [--port 4173]` serves a zero-dependency SPA plus JSON API on `127.0.0.1` only (Ctrl-C to stop). It's used in two places:

- **Onboarding review** (`#/onboard?plan=<id>`) — created automatically by `onboard` without `--apply`/`--json`.
- **Fleet dashboard** (`#/`) — registered projects with agents, last sync, last result. Per project: **Sync** opens a dry-run classify table (nothing written), where every `fast-forward`/`merged`/`conflict` row expands to a unified diff and conflicts open a three-pane base/project/kit view. Apply stays disabled until every conflict has a disposition. **History** shows past applies. `#/profiles` manages specialist profiles.

The server binds loopback only, rejects foreign `Host`/`Origin` headers, and requires `Content-Type: application/json` on mutating routes. Plan ids live in memory for the server's lifetime — restarting the server invalidates an open review page.

### Fill the placeholders

After the scaffold phase, generated files carry `{{PLACEHOLDER}}` keys. Fill them with the maturity-aware prompt — open your agent runner **inside the onboarded project** and paste:

```
Fill the {{placeholders}} in the scaffolded files. Follow @prompts/onboard-fill.md —
detect project maturity, fill placeholders accordingly (infer from the codebase for
mature/early-stage, leave TBD for design-phase, never guess or extrapolate from
unfinished design docs), and commit.
```

See *Maturity-aware onboarding* below for what gets filled at each level.

## Other ways to onboard

### Prompt-driven (any runner, no CLI)

Two phases, run inside the project you want to onboard — the kit lives at `<KIT_PATH>`:

**Phase 1 — Scaffold:**
```
Scaffold this project for the AI-agent-optimized workflow. Follow @prompts/onboard-scaffold.md —
run the scaffold script, install missing required skills, merge MCP/hooks/rules config.
The onboarding kit is at <KIT_PATH>.
```

**Phase 2 — Fill:**
```
Fill the {{placeholders}} in the scaffolded files. Follow @prompts/onboard-fill.md — detect
project maturity, fill placeholders accordingly, and commit.
```

Or one shot:

```
Onboard this project to the AI-agent-optimized workflow. Follow @prompts/onboard.md —
detect project maturity, run the scaffold script, fill the {{placeholders}}, install missing
required skills, merge MCP config, and commit. The onboarding kit is at <KIT_PATH>.
```

### Manual scaffold

```powershell
# Windows
.\scaffold.ps1 -Target C:\path\to\your-project -Agent devin -InstallSkills
```

```bash
# Unix
./scaffold.sh --target /path/to/your/project --agent devin --install-skills
```

This writes files directly with no plan/review step and does **not** register the project — run `node bin/onboard.mjs register --path <dir>` and `record-state` afterwards if you want it under kit sync (or just use `sync --adopt` later for state-less projects).

### Additional agent on an onboarded project

```powershell
.\scaffold.ps1 -Target C:\path\to\project -Agent hermes -ConfigOnly -InstallSkills
./scaffold.sh --target /path/to/project --agent hermes --config-only --install-skills   # Unix
```

Skips templates; only merges the new agent's MCP/hooks config and checks skills. Seconds, since skills install globally.

## CLI reference

### Scaffold scripts

```powershell
.\scaffold.ps1 -Target <dir> [-Agent <name>] [-InstallSkills] [-UpdateSkills]
               [-ConfigOnly] [-Force] [-DryRun] [-OnlyFile <path>] [-ManifestPath <path>]
```

```bash
./scaffold.sh --target <dir> --agent <name> [--install-skills] [--update-skills]
              [--config-only] [--force] [--dry-run] [--only <file>] [--manifest <path>]
```

| Flag | PowerShell | Bash | Description |
|---|---|---|---|
| Target | `-Target <dir>` | `--target <dir>` | Project directory (default: current dir) |
| Agent | `-Agent <name>` | `--agent <name>` | Agent profile (default: devin) |
| Install skills | `-InstallSkills` | `--install-skills` | Install missing required skills via `npx skills add` |
| Update skills | `-UpdateSkills` | `--update-skills` | Update already-installed skills via `npx skills update` |
| Config only | `-ConfigOnly` | `--config-only` | Skip templates, only configure skills + MCP |
| Force | `-Force` | `--force` | Overwrite existing template files |
| Dry run | `-DryRun` | `--dry-run` | Plan only — emits the JSON row list on stdout, writes nothing |
| Only | `-OnlyFile <path>` | `--only <file>` | Apply only artifacts listed in the file (used by the review UI's Apply) |
| Manifest | `-ManifestPath <path>` | `--manifest <path>` | Custom manifest path (default: next to script) |

### Kit CLI (`bin/onboard.mjs`, Node >= 18, stdlib only)

```bash
# Registry
node bin/onboard.mjs register --name X --path P [--agents a,b] [--remove]
node bin/onboard.mjs list [--json]
node bin/onboard.mjs record-state --path P [--manifest <path>] [--dry-run]

# Onboarding (plan → review UI | --json | --apply)
node bin/onboard.mjs onboard --target <path> [--profile <profile>] [--agent <runner>]
                             [--resolve-with <runner>] [--apply] [--json]
                             [--install-skills] [--update-skills] [--force]
                             [--manifest <path>]

# Managed regions (splice kit-owned blocks into foreign AGENTS.md/CLAUDE.md)
node bin/onboard.mjs inject-regions --path P [--agents a,b] [--manifest <path>] [--dry-run]

# Sync + health
node bin/onboard.mjs sync [--project NAME] [--dry-run] [--force] [--json]
                          [--update-skills] [--install-skills] [--adopt] [--prune]
                          [--restore-deleted] [--manifest <path>]
node bin/onboard.mjs doctor [--project NAME] [--json] [--stale-days N] [--manifest <path>]

# Specialist profiles
node bin/onboard.mjs profile --list [--json]
node bin/onboard.mjs profile --plan <id> [--project <path>] [--json]
node bin/onboard.mjs profile --sync <id> [--project <path>]
node bin/onboard.mjs profile --create <id> --label <txt> [--skills a,b] [--mcps a,b]
                          [--harnesses a,b] [--description <txt>]
node bin/onboard.mjs profile --delete <id>

# Web UI
node bin/onboard.mjs ui [--port 4173]
```

## Registry & state

Two state files, both written atomically (tmp + rename) with `schemaVersion: 1`:

- **`projects.registry.json`** (kit root, gitignored — created on first run): desired-state inventory. One entry per project `{name, path, agents[], onboardedAt, lastSyncAt, overrides{skip:[],pins:{}}, lastSyncResult}`, idempotent by resolved path.
- **`.agents/onboarding-state.json`** (per project): recorded install base `{schemaVersion, kitCommit, manifestHash, artifacts}` mapping each dest to `{hash, source, kitCommit, syncedAt}`. Templates hash the kit source as installed (pre-fill); MCP/hooks configs hash the generated file on disk.

Both are local, never committed. Deleting the registry just unregisters everything; `sync --adopt` can re-baseline a state-less project.

## Syncing projects (`sync`)

`sync` re-applies the current kit to every registered project (or one `--project`) using three-way merge against the recorded install base. Project edits and filled `{{PLACEHOLDER}}` values are preserved; local changes are never silently overwritten.

| Situation (per managed file) | Action | Result |
|---|---|---|
| Project file == recorded base | `fast-forward` | Kit update written; base hash refreshed |
| Kit template == recorded base | `project-only` | Local edits kept, nothing written |
| Both changed, disjoint edits | `merged` | diff3 merge written |
| Both changed, same region | `conflict` | Git-style `<<<<<<< / ||||||| / ======= / >>>>>>>` markers written; exit 2 |
| Recorded dest missing from project | `skip` | Project deletion respected (see `--restore-deleted`) |
| File at managed dest, no base | `skip` | Foreign file, never overwritten |
| Managed dest absent, never recorded | `fast-forward` | New kit template propagated (agent-scoped dests only when the agent is registered) |
| Dest no longer in manifest | `retired` | Left on disk, reported; `--prune` deletes it only when project bytes still equal the recorded base |
| Project without state file | `unadopted` | Nothing touched (see `--adopt`) |

Merge bases are reconstructed from git history (`git show <kitCommit>:<src>`, verified against the recorded hash), so placeholder fills read as project-side edits and always survive a merge.

**MCP/hooks configs** merge per manifest key (`mcpServers.<name>`, hook events): unchanged entries follow kit updates, project-added entries stay `project-only`, both-side customizations are preserved with the kit's proposal written to `<config>.kit-incoming.json` (JSON never gets conflict markers).

**Overrides** (per registry entry): `overrides.skip` exempts a path or a `config.json:mcpServers.name` key entirely; `overrides.pins` does the same and records a reason.

**Flags**: `--dry-run` reports without writing (exit code mirrors a real run); `--json` emits the machine-readable report; `--update-skills`/`--install-skills` run `npx skills update|add` (default is a presence check); `--adopt` records a baseline for state-less projects (MCP/hooks configs and skills only — templates and rules are project-owned); `--prune` deletes `retired` dests whose bytes still equal the recorded base; `--restore-deleted` re-adds removed files and managed config keys. Files still carrying conflict markers always report `conflict` (exit 2) — resolve them, then re-run; `--force` is accepted for CLI compatibility but cannot clear them.

Exit code `2` when a conflict needs a human, `0` otherwise. A second sync right after a clean run reports zero actions — idempotent. No report files are written into projects.

Merge bases are tracked per artifact (`artifacts[dest].kitCommit`), so skipping a file through `overrides` while the project advances can't strand its recorded base.

## Fleet health (`doctor`)

Read-only health check over the fleet (or one `--project`): dead paths (suggests `register --remove`), missing/unparseable state files (suggests `sync --adopt`), recorded kit commits missing from the kit repo, drift vs current kit (dry-run sync counts), missing required skills, overrides referencing nonexistent paths, staleness (`lastSyncAt` older than `--stale-days`, default 30). `--json` for the machine report. Exit `3` on any finding, `0` clean.

## What gets scaffolded in a project

```
your-project/
├── AGENTS.md                    # Skill router + principles (read every session)
├── .agents/
│   ├── SYSTEM.md                # System architecture overview
│   ├── ARCHITECTURE_PATTERNS.md # Canonical patterns + consistency checklist
│   ├── ENGINEERING_RULES.md     # Invariants, schema rules, dependency rules
│   ├── BUG_FIX_LOG.md           # Historical bugs (first stop for debugging)
│   ├── PRD.md                   # Product requirements
│   ├── DEV_WORKFLOW.md          # Environment setup, commands, ports
│   └── onboarding-state.json    # Install base for three-way sync
├── docs/                        # Canonical technical docs
├── .devin/                      # devin: config.json (MCP), hooks.v1.json
├── .claude/                     # claude-code: settings.json, CLAUDE.md -> @AGENTS.md
├── .cursor/                     # cursor: mcp.json, rules/
├── .windsurf/                   # windsurf + devin: mcp_config.json, rules/
├── .opencode/                   # opencode: mcp.json, hooks.json
├── .hermes/                     # hermes: mcp.json, hooks.json
└── .omp/                        # omp: mcp.json, rules/
```

## Kit project structure

```
ai-onboarding-kit/
├── onboard.manifest.json        # Single source of truth: dirs, templates, skills,
│                                #   placeholders, MCP/hooks/rules, agent profiles,
│                                #   managed regions, specialist profiles, runners
├── scaffold.ps1                 # Windows scaffolder (PowerShell 5.1+)
├── scaffold.sh                  # Unix scaffolder (bash + jq)
├── bin/
│   ├── onboard.mjs              # Kit CLI: register/list/record-state/onboard/
│   │                            #   inject-regions/sync/doctor/profile/ui
│   ├── lib/                     # sync engine, planner, profiles, diff3, UI server
│   └── ui/                      # Sync/onboard SPA (vanilla ES modules, no build)
├── prompts/
│   ├── onboard-scaffold.md      # Phase 1: scaffold + skills + config merge
│   ├── onboard-fill.md          # Phase 2: fill placeholders (maturity-aware)
│   ├── onboard.md               # Combined one-shot prompt
│   └── onboard-short.md         # Short @-reference invocation
├── templates/
│   ├── AGENTS.md.tmpl           # Generic AGENTS.md with {{placeholders}}
│   ├── kit-region.AGENTS.md     # Managed region injected into foreign AGENTS.md
│   ├── .agents/                 # Doc templates (SYSTEM, ARCHITECTURE_PATTERNS, ...)
│   ├── rules/                   # Agent rule files (coding-standards, dev-environment)
│   └── skills/                  # Kit-bundled skills (ui-design-orchestrator)
├── tests/                       # node --test suites for CLI, engine, UI server
├── docs/specs/                  # Design documents
├── projects.registry.json       # Local fleet registry (gitignored, auto-created)
├── profiles.user.json           # Local specialist profiles (gitignored)
└── profiles.user.json.example   # Shape of profiles.user.json
```

## Skill behavior

| Situation | Action |
|---|---|
| Skill found in any search location | **Skip** — no reinstall, no update |
| Skill missing + `--install-skills` | Install via `npx skills add <source>@<skill> -g -y` |
| Skill installed + `--update-skills` | Update via `npx skills update <source>@<skill> -g -y` |
| Skill installed + no flags | Skip |
| Optional skill missing | Listed in summary, not auto-installed |

### Skill search locations (checked in order)

1. `~/.agents/skills/<name>/SKILL.md` — global, shared by all agents
2. Agent profile skill dirs (e.g. `~/.claude/skills/` for claude-code)
3. `<project>/.windsurf/skills/<name>/SKILL.md` — project-level
4. `<project>/.agents/skills/<name>/SKILL.md` — project-level
5. `~/.agents/.skill-lock.json` — global lock file

A skill found in ANY location is not reinstalled — no ghost directories.

## MCP config behavior

| Situation | Action |
|---|---|
| MCP config file doesn't exist | Create with required + optional servers from manifest |
| Config exists, server missing | **Add** server (non-destructive merge) |
| Config exists, server present | **Skip** — never overwrite |

| Agent | MCP config path | Format |
|---|---|---|
| devin | `.devin/config.json` (under `mcpServers`) | JSON, nested |
| hermes | `.hermes/mcp.json` | JSON |
| opencode | `.opencode/mcp.json` | JSON |
| claude-code | `.claude/settings.json` (under `mcpServers`) | JSON, nested |
| cursor | `.cursor/mcp.json` | JSON |
| windsurf | `.windsurf/mcp_config.json` | JSON |
| omp | `.omp/mcp.json` | JSON |

> **Devin note:** Devin also reads the global Windsurf MCP config at `~/.codeium/windsurf/mcp_config.json` via `read_config_from.windsurf`. Project-level `.devin/config.json` takes priority.
>
> **omp note:** omp auto-imports MCP server definitions from other agents' configs (Claude Code, Codex, Gemini CLI, OpenCode, Cursor, Windsurf, VS Code) — first definition wins. On a multi-agent project, either let omp auto-import or write `.omp/mcp.json`; don't double-register the same server.

## Hooks config behavior

Hooks are lifecycle handlers (PreToolUse, PostToolUse, SessionStart, Stop) running shell commands. Merged non-destructively, same rules as MCP.

| Agent | Hooks config path | Format |
|---|---|---|
| devin | `.devin/hooks.v1.json` | Standalone (hooks object is the file) |
| hermes | `.hermes/hooks.json` | Standalone |
| opencode | `.opencode/hooks.json` | Standalone |
| claude-code | `.claude/settings.json` (under `hooks`) | Nested |
| cursor / windsurf / omp | *(not supported)* | — |

> **omp note:** omp hooks are trusted JS/TS modules under `.omp/hooks/pre/` and `post/` — executable code, not JSON — so the kit writes no hooks config for omp.

Devin supports a standalone (`.devin/hooks.v1.json`, used by the scaffold) and a nested (`"hooks"` key inside `.devin/config.json`) format. To add a hook, edit `onboard.manifest.json` → `hooks` array:

```json
{ "event": "PreToolUse", "matcher": "exec|write", "type": "command",
  "command": "my-hook-script.sh", "required": false, "hint": "What this hook does" }
```

## Rules behavior

Markdown rule files for agents with rule directories. File missing → copied from template; exists → skipped (unless `--force`).

| Agent | Rules directory | Enabled |
|---|---|---|
| devin | `.windsurf/rules/` (via `read_config_from`) | Yes |
| cursor | `.cursor/rules/` | Yes |
| windsurf | `.windsurf/rules/` | Yes |
| omp | `.omp/rules/` | Yes |
| hermes | `.hermes/rules/` | No (`rulesEnabled: false`) |
| opencode | `.opencode/rules/` | No |
| claude-code | `.claude/rules/` | No |

Add a rule: drop `my-rule.md.tmpl` in `templates/rules/`, add `{"src": "templates/rules/my-rule.md.tmpl", "dest": "my-rule.md", "overwrite": false}` to the manifest `rules` array.

## Agent profiles

| Agent | Instructions | MCP config | Hooks | Rules | Extra skill dirs |
|---|---|---|---|---|---|
| devin | `AGENTS.md` | `.devin/config.json` | `.devin/hooks.v1.json` | `.windsurf/rules/` | — |
| hermes | `AGENTS.md` | `.hermes/mcp.json` | `.hermes/hooks.json` | *(disabled)* | — |
| opencode | `AGENTS.md` | `.opencode/mcp.json` | `.opencode/hooks.json` | *(disabled)* | — |
| claude-code | `CLAUDE.md` (+ `@AGENTS.md` import) | `.claude/settings.json` | `.claude/settings.json` | *(disabled)* | `~/.claude/skills` |
| cursor | `AGENTS.md` | `.cursor/mcp.json` | *(none)* | `.cursor/rules/` | — |
| windsurf | `AGENTS.md` | `.windsurf/mcp_config.json` | *(none)* | `.windsurf/rules/` | `.windsurf/skills` |
| omp | `AGENTS.md` | `.omp/mcp.json` | *(none)* | `.omp/rules/` | `~/.omp/agent/skills`, `.omp/skills` |

`~/.agents/skills` is searched for every profile. `instructionsImport` (claude-code's `@AGENTS.md`) is appended to the instructions file by `inject-regions`/`onboard` so the file delegates to the shared `AGENTS.md`.

## Managed regions

`managedRegions` in the manifest defines marker-delimited blocks the kit owns inside foreign files. Today: `kit-region` (source `templates/kit-region.AGENTS.md`, dests `AGENTS.md`, `CLAUDE.md`). If a project already has an `AGENTS.md`, `onboard`/`inject-regions` splices the region in under `<!-- kit-region:start -->` / `<!-- kit-region:end -->` markers instead of overwriting the file; sync then merges only inside the markers.

## Specialist profiles

MCP servers carry a `tier`: `core` (merged into every agent's main config — today `semble`, `code-review-graph`) or `specialist` (never in a main config; routed only to profile destinations — today `chrome-devtools`, `playwright`). This keeps browser/QA schemas out of coding sessions.

A **profile** is a named capability bundle (`id`, `skills`, `cliTools`, `mcpServers`, `harnesses`, agent template, optional `spawn` template). The id doubles as the alias: `omp --profile qa-agent` is the invoke string. Kit profiles live in `manifest.profiles` (`design`, `qa-agent`); user profiles/overrides and generated-artifact hashes persist in `profiles.user.json` (gitignored).

```bash
node bin/onboard.mjs profile --list                        # profiles + invoke strings
node bin/onboard.mjs profile --plan qa-agent --project P   # artifact preview
node bin/onboard.mjs profile --sync qa-agent --project P   # write artifacts
node bin/onboard.mjs profile --create my-p --label "X" --mcps chrome-devtools --harnesses omp
node bin/onboard.mjs profile --delete qa-agent             # removes recorded artifacts
```

Per-harness materialization (`agentProfiles.<name>.specialist` kind):

| Harness | Artifacts | Invoke |
|---|---|---|
| omp | `~/.omp/profiles/<id>/agent/{mcp.json,AGENTS.md}` | `omp --profile <id>` |
| opencode | `opencode.json` `mcp`+`tools` merge + `.opencode/agents/<id>.md` | `opencode run --agent <id>` or `@<id>` |
| claude-code | `.claude/mcp-<id>.json` + `.claude/agents/<id>.md` | `claude --mcp-config .claude/mcp-<id>.json --strict-mcp-config --agent <id>` |
| devin | `.devin/mcp_config.local.json` (`disabled:true`) + `.devin/agents/<id>.md` | `devin mcp enable <srv> -s local` then `devin` |
| cursor / windsurf / hermes | core-only — no specialist artifacts | — |

Core-tier servers are also written into each profile's scoped config (e.g. omp profile `mcp.json` gets `semble`) — those files replace the harness's user scope, so omitting them would drop code search from the profile session. `ui-design-orchestrator` stays core-only.

## The manifest — `onboard.manifest.json`

Everything is driven by one file. To extend the kit:

| Want to... | Edit... |
|---|---|
| Add a skill | `skills` — `{name, source, skill, category, required}` |
| Add an MCP server | `mcpServers` — `{name, tier, required, hint, config}` |
| Add a hook | `hooks` — `{event, matcher, type, command, required, hint}` |
| Add a rule | `rules` — `{src, dest, overwrite}` + `.tmpl` in `templates/rules/` |
| Add a template | `templates` — `{src, dest, overwrite}` + `.tmpl` in `templates/` |
| Add a directory | `directories` |
| Add a placeholder | `placeholders` — `{key, hint}` |
| Add an agent profile | `agentProfiles` — `{instructionsFile, instructionsImport?, mcpConfigPath, hooksConfigPath, hooksConfigFormat, rulesDir, rulesEnabled, skillDirs, readConfigFrom?, notes}` |
| Add a managed region | `managedRegions` — `{id, src, dests[]}` |
| Add an onboarding runner | `onboardingAgents` — `{detect, spawn}`; `{PROMPT_FILE}`/`{PROMPT_TEXT}`/`{PROMPT_FILE_ARG}` tokens expand at spawn |
| Add a specialist profile | `profiles` — `{id, label, skills, cliTools, mcpServers, harnesses}` |

Scaffolds and CLI read the manifest at runtime — no code changes needed.

## Skills

The manifest lists 40 skills across 11 categories (14 required) plus the kit-bundled `ui-design-orchestrator` (`templateSkills`). Required skills install with `--install-skills`; optional skills are only listed. All external skills use the standard [Skills CLI](https://skills.sh/): `npx skills add <owner/repo>@<skill-folder> -g -y` (global `-g`, non-interactive `-y`). Never create skill dirs manually. Kit-bundled `templateSkills` are copied to `~/.agents/skills/` by the scaffold instead.

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
| frontend | `design-taste-frontend`, `frontend-ui-engineering`, `web-design-guidelines`, `redesign-existing-projects`, `high-end-visual-design`, `minimalist-ui`, `stitch-design-taste`, `imagegen-frontend-web`, `imagegen-frontend-mobile`, `vercel-react-best-practices`, `stop-slop`, `impeccable`, `variate`, `improve-ui`, `baseline-ui`, `fixing-accessibility`, `fixing-motion-performance`, `fixing-metadata`, `create-design-md` |
| template (kit-bundled) | `ui-design-orchestrator` |

## UI design orchestrator

`ui-design-orchestrator` is the master router for all UX/UI work. `AGENTS.md` defers design-skill choice to it; it routes to the right skills, runs a four-phase lifecycle (set context → build + refine → check → keep from drifting), and can fan out multiple design directions in parallel with per-lane model control.

| Phase | With [impeccable](https://impeccable.style) | Without (fallback) |
|---|---|---|
| **1 — Context** | `/impeccable init` + `document` + `shape` | Orchestrator brief + `.agents/PRD.md` |
| **2 — Build** | Direction skills → `frontend-ui-engineering` → impeccable refinement | Direction skills → `frontend-ui-engineering` |
| **3 — Check** (mandatory) | `audit` + `critique` + `detect` + `browser-testing-with-devtools` + `stop-slop` | `web-design-guidelines` + `browser-testing-with-devtools` + `stop-slop` |
| **4 — Drift** | `document` + `extract` + `doctor` | (skipped) |

Impeccable needs two installs: `npx skills add pbakaus/impeccable@impeccable -g -y` (the skill) and `npx impeccable install` in the project (detector CLI, hooks, context files). `stop-slop` installs the same way (`hardikpandya/stop-slop@stop-slop`). Both are optional — the orchestrator presence-checks and falls back.

Modes: `single` (default inline routing), `explore` (K parallel lanes — each `{skill, model, worktree}` — pick one, merge, clean up), `lifecycle` (full impeccable lifecycle), `audit` (phase 3 standalone). `page_kind` maps to impeccable modes: landing→Persuade, app_screen→Operate, docs→Read, portfolio→Experience.

Skill source: `templates/skills/ui-design-orchestrator/` — `SKILL.md` (router), `REGISTRY.md` (data-driven skill map — extend routing here, no code changes), `MODELS.md` (per-lane model labels), `modes/`, `prompts/`. Full design: `docs/specs/2026-08-02-ui-design-orchestrator-design.md`.

## Maturity-aware onboarding

The fill prompt detects project maturity and adjusts fill depth — no guessing, no extrapolating.

| Level | Criteria | Fill behavior |
|---|---|---|
| **design-phase** | No source files, no package config | Only PROJECT_NAME, PROJECT_DESCRIPTION, PROJECT_MATURITY; everything else TBD |
| **early-stage** | Some sources or a package config, small/incomplete | Fill what's directly inferable; ask the user for the rest |
| **mature** | Established structure, config, tests, patterns | Full inference: stack, commands, ports, patterns, invariants, regression examples |

Prevented anti-patterns: invented tech stacks, PRDs inferred from draft design docs, hypothetical bugs, references to skills that aren't installed. For design-phase projects the fill prompt may offer the `brainstorming` skill — only with user consent.

## Self-improving documentation

The `AGENTS.md` template instructs every agent session to keep `.agents/` current: new patterns → `ARCHITECTURE_PATTERNS.md`, invariants → `ENGINEERING_RULES.md`, fixed bugs → `BUG_FIX_LOG.md`, new subsystems → `SYSTEM.md`, decisions → ADRs via `documentation-and-adrs`, workflow changes → `DEV_WORKFLOW.md`, filled TBDs → remove `<!-- TODO -->`, maturity changes → update `{{PROJECT_MATURITY}}`.

## Onboarding scenarios

- **New project (design phase):** scaffold → fill marks everything TBD → the agent fills TBDs as the project matures.
- **Existing project:** scaffold (regions injected into existing AGENTS.md, config merged) → fill infers from the codebase → BUG_FIX_LOG seeded with known issues.
- **Additional agent:** `--config-only` run; templates skipped, MCP/hooks merged into the new agent's config, skills already shared globally.

## Design principles

1. **Single source of truth** — `onboard.manifest.json` drives everything.
2. **No ghost directories** — skills only via `npx skills add` or kit `templateSkills` copy.
3. **No unneeded installs** — 5-location presence check first.
4. **Non-destructive config** — MCP/hooks/rules merge, never overwrite.
5. **Stack-agnostic** — one template set; project details are `{{placeholders}}`.
6. **Maturity-aware** — fill depth follows what's actually in the project.
7. **Self-improving docs** — every session keeps `.agents/` current.
8. **Plan before write** — `onboard`/`sync` always offer a dry-run/review step; nothing writes without apply.
9. **Three-way sync** — recorded install base + git history make kit updates mergeable with project edits.
10. **Extensible** — extend via the manifest, not the scripts.
11. **Idempotent** — re-running skips existing work; a second sync reports zero actions.
12. **Agent-first** — prompts handle judgment (maturity, inference); scripts handle mechanics (mkdir, copy, merge).

## Requirements

- **Windows**: PowerShell 5.1+ (built-in)
- **Unix**: bash + [jq](https://stedolan.github.io/jq/)
- **Kit CLI, sync UI, registry/state, skill install**: Node.js >= 18 (`bin/onboard.mjs`, `npx skills add`)
