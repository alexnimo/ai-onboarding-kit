# Design: Specialist MCP tiers — keeping context-hungry servers out of coding sessions

> Status: **implemented 2026-10-29** — core slice shipped: manifest tiers +
> `profiles` array, `bin/lib/profiles.mjs` engine, `onboard.mjs profile`
> subcommand, per-harness emitters (omp/opencode/claude-code/devin), tier
> filter in scaffold/plan/sync paths, `profiles.user.json` state,
> `templates/agents/`, tests (`tests/profiles.test.mjs`, 12 cases). UI page
> + API routes follow in the same change. mcporter dropped — native
> scoping only; weak harnesses get core-only profiles.
## Problem

`onboard.manifest.json` has one flat `mcpServers` array. The scaffold/plan
merge **every** entry — `required` only decorates the log line — into the
agent's single project MCP config (`scaffold.ps1:411`, `onboard-plan.mjs:53`).
Result: `chrome-devtools` (optional, ~10-25k tokens of tool schemas) lands in
every session of every agent, including factory coding agents that will never
open a browser. The same will happen for playwright-mcp, AWS MCP, and any
future heavy server.

A proposal suggested per-agent `tools: [mcp__chrome-devtools_*]` subagent
files plus omp profiles. Verification below shows that mechanism is **wrong
for omp** (subagents cannot filter MCP tools at all) and unnecessary for most
other harnesses.

## Verified constraints (per-harness, all checked against current docs 2026-10-25)

| Harness | Keep server out of a session | Per-agent schema scoping in-session | Lazy schema load |
|---|---|---|---|
| **omp** | `omp --profile <name>` → user-scope `~/.omp/profiles/<name>/agent/mcp.json` is the only user MCP source. Project `.omp/mcp.json` + foreign-config import still apply unless `mcp.disabledServers[]` | **None.** Subagent `tools:` filters built-ins only; MCP tools are additive. Subagents share the parent's MCPManager — they can't reach a server the session doesn't have, and can't exclude one it does | `tools.xdev` (default on): MCP tools mount as `xd://` devices, docs shown as one catalog line each (`tools.xdevDocs: catalog`). Schemas load on demand |
| **opencode** | `mcp.<name>.enabled: false` → server not started | Global `"tools": {"server_*": false}` + per-agent `"server_*": true` (or `permission` map). Denied tools are not advertised to that agent; subagents get own context via Task/`@mention` | **None** — deferred-MCP-loading issue closed not-planned; all enabled-server schemas load unless tool-filtered |
| **devin** | `disabled: true` on the server entry, or `devin mcp disable <name>` — "skipped during tool discovery, tools won't appear, process won't start". Config layering: `~/.config/devin/mcp_config.json`, `.devin/mcp_config.json`, `.devin/mcp_config.local.json` | `.devin/agents/<name>.md` frontmatter `allowed-tools` allowlist (built-in tool names; `mcp__` patterns confirmed only for *permissions* allow/deny/ask, which gate approval not schema loading) | None documented |
| **claude-code** | `disabledMcpjsonServers[]`, or `--mcp-config <file> --strict-mcp-config` per session | `.claude/agents/*.md` `tools:`/`disallowedTools:` accept `mcp__<server>__*` | **ToolSearch on by default** (`ENABLE_TOOL_SEARCH`): names+descriptions only until searched |
| **cursor** | UI toggle in Customize panel disables server (no schemas). No config-file `disabled` field | None — Custom Modes tool filtering removed in Cursor 2.1 | None |
| **windsurf** | None per-project beyond removing the entry | None | None |

Cross-cutting facts:

- omp foreign-config auto-import (Claude Code, Cursor, etc.) is
  profile-independent → a heavy server in `.cursor/mcp.json` can leak into
  omp sessions. Suppress via `disabledServers[]` in omp config.
- mcporter (openclaw/mcporter): harness-agnostic CLI bridge. `mcporter call
  <server>.<tool> k=v` via bash = zero tool schemas in context; per-server
  `allowedTools`/`blockedTools`; `mcporter daemon` keeps servers warm
  (`lifecycle: keep-alive`); `mcporter generate-cli` emits a standalone
  typed CLI per server; `mcporter list --schema` fetches signatures into the
  transcript on demand. `mcporter serve` (single aggregate MCP server) does
  NOT reduce schema tokens — the union is still listed; only useful with
  `allowedTools` filtering.
- opencode `.opencode/agent/*.md` note: dir is `agents/` (plural) per
  current docs.

## What survives from the proposal — and what doesn't

Survives (adopt):

- Thin-orchestrator intent: heavy servers should never sit in the default
  coding session.
- Specialist subagent files with narrow built-in allowlists + bounded
  `output` schemas — worth shipping for omp/opencode/devin/claude-code;
  just **without** `mcp__*` entries in `tools:`.
- Per-capability omp profiles (`browser-debug`, `aws-read`) — the only omp
  mechanism that truly gates which servers exist.
- Structured-output contracts and "no raw dumps" rules — harness-agnostic,
  keep.

Refuted (drop):

- `tools: [mcp__chrome-devtools_*]` in omp subagents — `tools:` is a
  built-in allowlist; MCP tools can't be listed.
- `task.eager: never` — invalid; enum is `default|preferred|always`
  (`default` is least eager).
- `tools.discoveryMode: mcp-only` — removed; replaced by `tools.xdev`.
- "Profiles ensure a specialist can't see an unrelated server set" — only
  true for omp's user-scope files; project config and foreign imports still
  apply, so profiles need `disabledServers[]` to be airtight.

## Design

### Tier model in the manifest

```json
"mcpServers": [
  { "name": "semble",           "required": true,  "tier": "core",       "config": {...} },
  { "name": "code-review-graph","required": true,  "tier": "core",       "config": {...} },
  { "name": "chrome-devtools",  "required": false, "tier": "specialist", "config": {...},
    "capabilities": ["ui-qa"] },
  { "name": "playwright",       "required": false, "tier": "specialist", "config": {...},
    "capabilities": ["ui-qa"] },
  { "name": "aws",              "required": false, "tier": "specialist", "config": {...},
    "capabilities": ["aws-read", "aws-deploy"] }
]
```

- `tier: "core"` (default when absent): merged into every agent's main
  config — today's behavior for the two required servers.
- `tier: "specialist"`: **never** merged into a main config. Routed per the
  capability matrix below and only into harnesses that natively support
  scoping.
- `capabilities`: named bundles so profile definitions and skill/agent
  templates can say "the ui-qa bundle needs chrome-devtools + playwright"
  without hardcoding server names; also the join key for profile
  `mcpServers` references.

### MCP bootstrapping (how a server actually gets configured + started)

Profiles never hand-write server config — they **name** entries:

```
profile "ui-qa".mcpServers = ["chrome-devtools", "playwright"]
        │
        ▼  name reference into manifest.mcpServers[] (single source of truth:
        ▼  {command, args, env} lives there; user profiles may inline an
        ▼  entry for servers the manifest doesn't know)
kit emitter resolves names → writes the full server definition into the
harness-specific destination (per-harness table below) with the harness's
shape (plain entry / "enabled": false / mcp key + agent allowlist /
disabledServers leak-guard)
        │
        ▼  at session/subagent start the harness spawns the server process
        ▼  itself (npx/uvx/command), discovers tools, injects schemas —
        ▼  only into the context that can see that destination
session starts clean; heavy schemas exist only inside the profile boundary
```

So the kit's job stops at writing the right JSON to the right file — the
bootstrap (process spawn, tool discovery, schema injection) is 100% the
harness's. `env` blocks support `${VAR}` placeholders resolved by the
harness at launch, so secrets never live in the profile definition.

### Skills under profiles — the three-state model, honestly

"Loaded vs not loaded" splits into three real states, and isolation
strength differs per harness:

| State | Meaning | How the profile controls it |
|---|---|---|
| installed | `SKILL.md` exists on disk, appears as a metadata line in the skill catalog (~30 tokens) | `skills[]` on the profile → scaffold runs `npx skills add`/copy per profile on sync (presence-check, same engine as today) |
| loaded | full skill body auto-injected / auto-invoked in that context | omp profile's own `skills/` dir (`~/.omp/profiles/<id>/agent/skills/<name>`) + `autoload-skills` in agent frontmatter; opencode `permission.skill`; elsewhere: the profile's generated instructions/agent file names its skills |
| absent | not installed at all | default — kit never installs a profile's skills outside profiles that list them |

Hard skill *hiding* (coding profile can't even see a specialist skill's
name) is only fully achievable where skills live per-profile (omp profile
skill dir) — everywhere else skills share the global `~/.agents/skills`
pool, so the boundary is **routing** (who gets told to load it), not
visibility. MCP isolation is the hard boundary; skill isolation is a soft
one. That asymmetry is inherent to the harnesses, not fixable in the kit.

### Unification with the design orchestrator's existing "profiles"

The orchestrator's `AGENTS.md` spawn registry + `MODELS.md` pools are a
**different axis** — not a duplicate:

| | Orchestrator lane spawn (AGENTS.md/MODELS.md) | Kit profile (this design) |
|---|---|---|
| Axis | *which model* / *which transport* — per-run | *which capability set* — durable |
| Lifetime | ephemeral lane agents, created per explore run | persistent named persona |
| Payload | `--model` label + prompt file | skills + MCP servers + tools + agent file |
| Decided at | runtime, inside the skill | kit config, persisted |

Unification decision: **one roof, two facets.** A kit profile is the
persona (capability bundle); MODELS.md pools stay the model-resolution
layer. The orchestrator's AGENTS.md spawn-CLI table gets generalized into
the profile system as an optional `spawn` template per profile — e.g.
`profile "design"` can declare `spawn.omp = 'omp -p --auto-approve
--profile design "@{PROMPT_FILE}"'`, reusing the same
`{PROMPT_FILE}`/`{MODEL}` placeholder convention. The ad-hoc lane-spawn
mechanism (1a lane profiles, external CLI rows) stays for per-run
parallelism — profiles are *durable* personas, lanes are *transient*
workers; they compose, they don't merge.

So a `design` profile would be:

```json
{
  "id": "design",
  "label": "Design orchestration (explore lanes, audits, visual QA)",
  "skills": ["ui-design-orchestrator", "design-taste-frontend",
             "minimalist-ui", "high-end-visual-design", "impeccable",
             "stop-slop"],
  "cliTools": ["skillui"],
  "mcpServers": ["chrome-devtools", "playwright"],
  "agent": { "file": "templates/agents/design.md.tmpl" },
  "spawn": { "omp": "omp -p --auto-approve --profile design \"@{PROMPT_FILE}\"" },
  "harnesses": ["omp", "opencode", "claude-code"]
}
```

One nuance: `ui-design-orchestrator` itself stays **required in core** —
the kit's AGENTS.md deferral routes every UI task through it from the main
session. The `design` profile carries it too, but as the *executor* of
the work, not the router. Core keeps the router; the profile keeps the
tooling + heavy skills + browser MCP.

### Per-harness routing (capability matrix in `agentProfiles`)

New optional profile keys:

| Profile | Specialist routing | Mechanism |
|---|---|---|
| `omp` | `specialistProfiles: { "browser-debug": ["ui-qa"], "aws-read": ["aws-read","aws-deploy"] }` | Scaffold writes `~/.omp/profiles/<name>/agent/mcp.json` (user-level; state records it as user-scoped artifact, like skill dirs) + appends specialist server names to `disabledServers[]` in the default omp config to block foreign-import leaks. Interactive use = `omp --profile browser-debug`. In-session: `tools.xdev` catalog already makes specialist schemas ~free if a project opts into `.omp/mcp.json` registration anyway |
| `opencode` | `specialistAgents` | `.opencode/mcp.json` gets specialist entries `"enabled": true`; generated `opencode.json` carries global `"tools": {"chrome-devtools_*": false, ...}` + `.opencode/agents/ui-qa.md` subagent with `"tools": {"chrome-devtools_*": true, "playwright_*": true}` + `permission` map. Specialist schemas load only into the ui-qa subagent's context |
| `devin` | `specialistConfig: ".devin/mcp_config.local.json"` | Specialist entries written with `"disabled": true`; agents re-enable per session (`devin mcp enable chrome-devtools -s local`) or the factory spawns a QA session. Update `mcpConfigPath` → `.devin/mcp_config.json` (dedicated file since v3000.3; old `config.json` key auto-migrated — manifest is stale here) |
| `claude-code` | `specialistAgents` | `.mcp.json` specialist entries + `disabledMcpjsonServers` in `.claude/settings.json`; a `.claude/agents/ui-qa.md` re-enables via `tools: mcp__chrome-devtools__*`. ToolSearch makes even enabled servers cheap |

### Rejected alternative: mcporter gateway — decided 2026-10-28

Considered and dropped: mcporter (openclaw/mcporter) as a universal CLI
bridge (`mcporter call` = zero-schema bash calls) would have covered
cursor/windsurf/hermes and CI one-offs. Rejected to keep the stack simple:
every harness with real scoping uses its native mechanism, and harnesses
without scoping simply get **core-only** profiles — specialist servers are
never written to their configs at all. If a weak-harness need emerges
later, the decision can be revisited; the manifest tier model already
separates the server data from the destination.

Note for the record: `mcporter serve` aggregates servers by re-listing all
their schemas (increases context cost); only the per-call `mcporter call`
bash path was zero-schema. A lazy "search-then-call" gateway in general
gives deferral, not isolation — heavy tool outputs would land in the
calling agent's context and every registered server stays reachable. That
fails the factory requirement that coding agents *cannot* reach QA/deploy
tools.

### Weak harnesses: core-only

`cursor`, `windsurf`, `hermes` have no native mechanism to keep a
configured server's schemas out of a session. **Design consequence:** the
kit writes only core-tier entries to their MCP configs; specialist
profiles are not materialized for them. Users wanting browser QA on a
windsurf-managed project run the specialist profile under a supporting
harness (omp/opencode/claude-code/devin) — skills and AGENTS.md are
shared, so nothing else is lost.

## Profile architecture (v2)

### Entity model

A **profile** is a named, user-editable bundle:

```json
{
  "id": "ui-qa",
  "label": "UI QA & browser debugging",
  "description": "Chrome DevTools + Playwright for visual QA/verification",
  "skills": ["browser-testing-with-devtools", "web-design-guidelines"],
  "cliTools": ["skillui"],
  "mcpServers": ["chrome-devtools", "playwright"],
  "agent": { "file": "templates/agents/ui-qa.md.tmpl" },
  "harnesses": ["omp", "opencode", "devin", "claude-code"],
  "origin": "kit"
}
```

- `mcpServers`/`cliTools`/`skills` are **name references** into the manifest
  arrays — single source of truth for server config, no drift. A profile
  may also inline a server entry for user-defined servers.
- `harnesses`: which agent profiles this bundle materializes for. Unchecked
  harnesses get nothing.
- `agent.file`: template for the specialist agent/subagent definition
  emitted per harness (see emission table).
- `origin`: `"kit"` ships with the manifest (read-only base, overridable);
  `"user"` lives only in user state.
- The **core profile** is implicit and universal: every artifact the kit
  already emits (AGENTS.md, `.agents/` docs, rules, core-tier MCP servers,
  core skills). It is the base every specialist profile adds to — profiles
  never remove core items.

### Persistence (two files, mirroring `projects.registry.json`)

| File | Owner | Contents |
|---|---|---|
| `onboard.manifest.json` → `profiles` | kit repo | Kit-shipped profile definitions (`ui-qa`, `aws-read`…), read-only at runtime |
| `profiles.user.json` (kit root, gitignored) | user | User-created profiles + overrides on kit profiles (`disabled`, `skills +=`, `harnesses` change) + generated-artifact state |

**Alias = the profile id itself.** Creating a profile named `ui-qa` *is*
the alias mechanism: the kit materializes `~/.omp/profiles/ui-qa/`,
`.opencode/agents/ui-qa.md`, `.claude/agents/ui-qa.md`, etc., and the user
invokes `omp --profile ui-qa`. Renaming = delete + recreate (sync garbage-
collects the old artifacts); no separate alias indirection to rot.

Generated-artifact state: `profiles.user.json` also records
`{ profileId, harness, dest, hash }` per emitted file — same state model as
`.agents/onboarding-state.json`, so removal is deterministic (delete only
what we wrote, byte-identical check) and edits to generated files are
detectable.

### Per-harness emission + CLI invocation

| Harness | What the kit writes for profile `ui-qa` | How to invoke |
|---|---|---|
| **omp** | `~/.omp/profiles/ui-qa/agent/mcp.json` (profile servers only) + `~/.omp/profiles/ui-qa/agent/AGENTS.md` (profile instructions) + `disabledServers` entries in default config to block foreign-import leaks | `omp --profile ui-qa` |
| **opencode** | `.opencode/agents/ui-qa.md` (subagent def, `mode: subagent`, per-agent `tools`/`permission` enabling profile servers) + `opencode.json` entries: specialist servers in `mcp` + global `"tools": {"<srv>_*": false}` | `opencode run --agent ui-qa "…"`; interactively: `@ui-qa …` or Task tool |
| **devin** | `.devin/agents/ui-qa.md` + specialist servers in `.devin/mcp_config.local.json` with `"disabled": true` (enabled per session) | `devin mcp enable chrome-devtools -s local` then `devin` (agent files still experimental — verify `allowed-tools`) |
| **claude-code** | `.claude/agents/ui-qa.md` with `tools: mcp__chrome-devtools__*` + servers in `.mcp.json` + `disabledMcpjsonServers` in settings | `claude --agent ui-qa`; or `claude -p --agents '<json>'` ephemeral |
| **cursor / windsurf / hermes** | **Nothing** — no native scoping, core-only (see "Weak harnesses") | n/a — specialist work runs under a supporting harness |

Headless/factory calls (any profile): `omp --profile ui-qa -p "…"`,
`opencode run --agent ui-qa "…"`, `claude -p --agent ui-qa "…"`.

### UI wiring

New `#/profiles` page in `bin/ui/` (same vanilla-ESM, no-build convention):

- **Profile list**: name, origin badge (kit/user), harness chips, skill/MCP
  counts; per-row edit/delete; "New profile" with alias input.
- **Editor**: checkboxes for manifest skills/cliTools/mcpServers (grouped
  core vs specialist), harness multi-select, agent-template picker.
- **Per-harness preview**: dry-run artifact plan + the exact CLI invocation
  line from the table above, copyable.
- **Sync**: `POST /api/profiles/:id/sync { projectPath? }` — writes
  user-level artifacts (`~/.omp/profiles/…`) and, when a target project is
  selected, project-level ones (`.opencode/agents/…`, `.mcp.json` keys).

New API surface in `bin/lib/ui-server.mjs`:
`GET/POST /api/profiles`, `PUT/DELETE /api/profiles/:id`,
`GET /api/profiles/:id/plan?harness=&project=` (artifact preview + CLI
strings), `POST /api/profiles/:id/sync`.

### Removal semantics

Deleting a profile removes only kit-generated artifacts recorded in
`profiles.user.json` state (byte-identical or recorded-base check):
`~/.omp/profiles/<id>/` dir, generated agent `.md` files, managed config
keys (`mcpServers.<name>` entries that no other profile references,
`disabledServers` entries). User-authored files and modified generated
files are kept and reported.

### Software-factory usage pattern

- Coding agent profiles get **zero** specialist artifacts: no schemas, no
  config entries, no started server processes.
- UI-QA work routes one of two ways:
  - In-session subagent (opencode `ui-qa` agent, claude-code `ui-qa` agent,
    devin `.devin/agents/ui-qa.md`) — schemas land only in the child
    context, which is disposable.
  - Separate specialist session (`omp --profile browser-debug`, `devin mcp
    enable` run) — hard isolation for harnesses where subagents share the
    parent's tool surface (omp).
- Harnesses without native scoping (cursor/windsurf/hermes) receive only
  core-tier entries — specialist work on those projects runs through a
  scoping-capable harness.

## Open questions

- hermes MCP/subagent capabilities — unverified; treated as core-only
  until checked.
- Whether the kit should also scaffold the omp `browser-debug` profile
  *agents* (`browser-debugger.md` etc.) — likely yes as `templateAgents`,
  but frontmatter must drop `mcp__*` from `tools:`.
- Devin `allowed-tools` acceptance of `mcp__server` patterns — docs confirm
  only for `permissions`, not subagent frontmatter; test before relying.


## Implementation sketch (if approved)

1. `onboard.manifest.json`: add `tier` to `mcpServers` entries; new
   top-level `profiles` array (kit-shipped bundles); per-harness
   specialist keys in `agentProfiles` (`specialistProfiles`,
   `specialistAgents`, `specialistConfig`, or `coreOnly`); fix devin
   `mcpConfigPath` → `.devin/mcp_config.json`.
2. `scaffold.{ps1,sh}` + `onboard-plan.mjs`: split merge loop by tier;
   per-harness profile emitters (omp profile dir, opencode/claude/devin
   agent files + config keys); `profiles.user.json` read/write.
3. `sync-files.mjs`/`sync-utils.mjs`: register new managed paths
   (`.opencode/agents/*.md`, `.devin/mcp_config.local.json`, `.mcp.json`
   keys, `.claude/agents/*.md`, `~/.omp/profiles/*/agent/*` as
   user-scoped) — per-key bases already exist (`mcpServers.<name>`);
   moving a server between dests = retire key + add key, both supported.
4. `bin/lib/ui-server.mjs` + `bin/ui/`: `#/profiles` page + API routes
   (`/api/profiles` CRUD, `plan`, `sync`).
5. `templates/agents/*.tmpl` specialist agent templates (omp profile
   AGENTS.md, opencode agent frontmatter, claude-code agent frontmatter,
   devin agent frontmatter) — `mcp__*` only where the harness supports it
   (claude-code/opencode), never in omp `tools:`.
6. Update `kit-region.AGENTS.md` routing table (browser-testing row points
   at the profile's specialist route); REGISTRY note for playwright-mcp
   pairing.
