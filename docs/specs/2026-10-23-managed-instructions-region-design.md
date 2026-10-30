# Design: Managed kit region inside the project's instructions file

> Status: draft — builder-check findings incorporated (7 must-fix items
> resolved). Decided: full kit content inline in the region.
> Awaiting human approval before planning/implementation.

## Problem

The kit's `AGENTS.md` is the source of truth for coding practices, skill
routing, and doc maintenance. It must propagate updates to every onboarded
project. Today two cases are broken:

1. **Kit-installed projects** — `AGENTS.md` is managed whole-file. Once the
   fill step bakes project values in and the project edits it, every sync
   is a whole-file diff3 merge: noisy conflicts, and kit updates entangled
   with project text.
2. **Foreign projects** (existing hand-written `AGENTS.md`) — scaffold
   skips the file (`overwrite: false`), `--adopt` deliberately leaves it
   unrecorded. Result: the project keeps its instructions (good) but
   **never receives kit practices at all** — no skill router, no doc
   maintenance, no UX orchestrator deferral — and nothing can ever update
   them.

## Verified constraints (evidence, not preferences)

- `AGENTS.md` is the only instruction file auto-loaded across the kit's
  agent targets: devin, hermes, opencode, omp natively; cursor and windsurf
  read it natively (per agents.md supported-agents list). claude-code is the
  exception: `CLAUDE.md`, which supports `@path` imports.
- There is no `SYSTEM.md`-style standard file; no harness auto-loads it.
  A separate instructions file only works via a reference, i.e. one extra
  indirection an agent can skip.
- Harness rules dirs are fragmented and partial coverage
  (`.cursor/rules`, `.windsurf/rules`, `.claude/`, opencode needs an
  `opencode.json` glob, devin/hermes/omp have none). Cannot be the primary
  channel; they stay as the existing complement.
- State records sha256 of kit sources **pre-fill**; `state.placeholders`
  maps key→value and `renderTemplate` substitutes recorded values
  (`sync-utils.mjs:98-112`), leaving unfilled `{{KEY}}` tokens literal.
- Plan-row artifact keys group by dest via `split(':')[0]`
  (`model.mjs:17`), and doctor treats `<path>:<key>` as a managed-key id —
  so `<dest>:<subkey>` is the established namespacing convention.
- `AGENTS.md.tmpl` currently has placeholders *inside* kit sections
  (`PROD_VERIFICATION_STEPS`, `TESTING_SKILLS`, `REGRESSION_EXAMPLES`,
  `PROJECT_SPECIFIC_SKILLS`, `STACK_NOTES`, `INVARIANTS`).

## Design

### Model: two ownership regions in one file

```
AGENTS.md  (project-owned file, forever)
├── # Project X + description              ← project region (never touched)
├── project conventions, commands, rules   ← project region (never touched)
├── <!-- BEGIN ai-onboarding-kit -->
│     full kit block: core rules, routing policy, principles,
│     testing discipline, UX deferral, skill table,
│     doc governance + maintenance, diagram rule   ← kit region
└── <!-- END ai-onboarding-kit -->
```

Kit content is **inline** (decided): guaranteed auto-load, zero
indirection, identical agent-visible content to today's template.

### Single source of truth: `templates/kit-region.AGENTS.md`

- One new file holds the block body **without placeholders** — region sync
  must compare against raw kit bytes at `kitCommit`; placeholder-bearing
  regions would re-render with *recorded* values and create phantom
  conflicts when values change post-install. Region text is always
  rendered verbatim (rendering = identity).
- All current template placeholders that live inside kit sections
  (`PROD_VERIFICATION_STEPS`, `TESTING_SKILLS`, `REGRESSION_EXAMPLES`,
  `PROJECT_SPECIFIC_SKILLS`, `STACK_NOTES`, `INVARIANTS`) move **out** of
  the kit region into a new project-owned `## Project profile` section of
  `AGENTS.md.tmpl`. Kit text that consumed them now references that
  section by name (e.g. "see Project profile → Testing skills").
  `PROJECT_NAME`/`PROJECT_DESCRIPTION`/`PROJECT_MATURITY` stay in the
  title/head, outside markers.
- `AGENTS.md.tmpl` embeds the markers + a `{{KIT_REGION}}` directive the
  scaffold expands with the block file's bytes at copy time. Installed
  files therefore ship markers; the block text exists exactly once in the
  kit.

### Manifest

New top-level `managedRegions` array:

```json
"managedRegions": [
  { "id": "kit-region",
    "src": "templates/kit-region.AGENTS.md",
    "dests": ["AGENTS.md"] }
]
```

Artifact/override key convention: `<dest>:<regionId>` →
`AGENTS.md:kit-region`. Groups under dest in the UI automatically
(`split(':')[0]`); `overrides.skip`/`pins` accept either `AGENTS.md`
(whole entry, including its region) or `AGENTS.md:kit-region` (region
only). `doctor`'s existing `<path>:<key>` parsing covers this verbatim.

`templates[].dest: "AGENTS.md"` keeps `overwrite:false` but its semantics
change: scaffold installs it only when the file is absent, expands
`{{KIT_REGION}}`, and records **no** whole-file artifact — only the
region record. (See Migration.)

### Sync wiring (verified against code; all required)

- `buildManagedPlan` (sync-utils.mjs:239-273) gains a `regionDests` map
  (`dest -> [{id, src}]`). Unknown manifest keys are never rejected, so
  `managedRegions` parses safely but is inert until wired.
- `syncDests` (sync-engine.mjs:235-251) must **exclude region artifact
  keys** from the text-dest pass: today every non-config artifact key is
  added to `textDests`, so `AGENTS.md:kit-region` would hit `syncTextDest`
  as a literal path, report `retired`, and `--prune` would delete the
  record. Dispatch: `dest` in `regionDests` → `syncRegionDest`;
  `cfgPlan` → `syncConfigFile`; else `syncTextDest`. A region-managed
  dest must not produce a whole-file row at all — otherwise a perpetual
  `skip 'unmanaged file'` row fires and UI dispositions route to the
  whole-file apply path (sync-engine.mjs:540-543).
- `mergeFile` / `applyDisposition` (sync-engine.mjs:422,489) gain a
  region route: for `<dest>:<id>` rows they merge/apply the region
  substring, not whole-file base/kit.
- skip/pins are exact-string (`sync-files.mjs:100-101`,
  `sync-engine.mjs:517-518`), so `syncRegionDest` checks BOTH
  `skipSet.has(dest)`/`pins[dest]` and
  `skipSet.has('<dest>:<id>')`/`pins['<dest>:<id>']`; same dual check in
  `applyDisposition`.
- `unresolved` stores `<dest>:<id>` keys, so `finalizeProject`'s
  `existsSync(join(root, dest))` sweep (sync-engine.mjs:285-289) must
  strip the `:<id>` suffix before resolving; the marker check itself is
  region-scoped.
- `CONFLICT_MARKER_RE` applies to the **region text only** — a
  project-authored `<<<<<<<` outside the markers must not false-positive.
- `merge3` (diff3.mjs:196-220) is pure text — reused verbatim on the
  region substring.
- New report actions `injected`, `region-removed`, `migrated` must be
  registered in `ACTIONS` (sync.mjs:42-45) and in UI `SEVERITY` /
  `ACTIONABLE` maps (model.mjs:12-14) with their actionable status.
- Manifest constraint: template/rule dests and region ids MUST NOT
  contain `:` (breaks `destOf`/`overridePath` grouping) — enforce via a
  manifest self-test.

### Region merge (`syncTextDest` sibling: `syncRegionDest`)

For each managed region, per project:

```
extract markers from project file   ──► absent ──► inject (see below)
extract markers from kit block file ──► absent ──► manifest error (abort)
regionLocal == regionBase(recorded) ──► fast-forward: splice kit text
regionKit   == regionBase           ──► project-only (keep local edits)
both changed                      ──► merge3(base, local, kit) on region
                                       text only; splice result back
conflict markers inside region    ──► 'conflict', exit 2 (existing UX)
```

- Region text = lines strictly between the BEGIN/END marker lines.
  Marker lines themselves are fixed constants; both sides must carry the
  same marker pair for a merge. A future marker-format change = new
  `regionId`, not silent drift.
- Everything outside markers is never parsed, hashed, or written — the
  project's half of the file is invisible to the merge by construction.
- Conflict markers land **inside the region only**, labels as today
  (`project` / `kit base <sha>` / `kit v<ver>`). Existing
  "lingering markers = live conflict" gate reuses `CONFLICT_MARKER_RE`
  scoped to the region.
- `--force`, `--dry-run`, `--restore-deleted` semantics mirror
  whole-file sync (restore → re-inject region; deleted markers →
  `region-removed` row, respected unless pinned).
- Unfilled-token reporting (`needsFillSuffix`) is unchanged; region text
  can never contain `{{KEY}}` by construction (enforced by a manifest
  test: `kit-region.*` sources must match `^((?!\{\{).)*$`s).

### Injection for foreign / legacy files

When `dest` exists and has no markers:

| Case | Behavior |
|---|---|
| Foreign `AGENTS.md` (no state record) | Splice block after the first `# ` heading line (else at top). File otherwise byte-identical. Record `{artifacts["AGENTS.md:kit-region"]}` only — file stays foreign. |
| Kit-installed legacy file (whole-file record, may be filled/edited) | Same injection. The pre-existing kit sections become project text — accepted duplication, reported as `injected (legacy kit text now project-owned; consider deduplicating)`; the onboard prompt gains an optional dedupe step. |
| Missing file | `AGENTS.md.tmpl` install path creates it (markers already inside). |

Insertion anchor is deterministic: immediately after the first `# `
heading + following blank line; no heading → file head.

### Agent profiles

- All `AGENTS.md`-reading profiles (devin, hermes, opencode, omp, cursor,
  windsurf) share the single managed `AGENTS.md:kit-region`.
- **claude-code:** `CLAUDE.md` becomes a kit-managed whole-file stub
  (`templates/CLAUDE.md.tmpl`, `overwrite:false`) whose entire managed
  content is `@AGENTS.md` — native import syntax, so the block loads via
  AGENTS.md; no second region to maintain. Projects with an existing
  `CLAUDE.md` keep it; scaffold appends the `@AGENTS.md` line if absent.
- Profiles `cursor`/`windsurf`: their legacy `instructionsFile` entries
  are superseded by `AGENTS.md`; update the profile table +
  `onboard-onboard.md` agent table. Rules-dir files stay as-is (complement).

### `record-state` / `--adopt` — two distinct paths

- **`record-state` (onboard.mjs:147+):** iterates `manifest.templates` and
  calls `addManagedArtifact(t.dest, t.src)` for each. Must (a) skip
  templates whose dest is region-managed (no `artifacts["AGENTS.md"]`),
  and (b) per `managedRegions` entry: if the file lacks markers → inject
  per the table above; then record `artifacts["<dest>:<id>"]` with the
  region-source hash.
- **`sync --adopt` (→ `buildAdoptedState`, sync-utils.mjs:311-329):**
  records **config files only** today, and `syncDests` skips the text
  pass entirely when `pctx.adopted` (sync-engine.mjs:241). To close the
  "adopted projects never get kit updates" gap, `buildAdoptedState`
  gains region handling (inject if markerless + record) and the
  `!pctx.adopted` gate is lifted for region dests only.
- **Legacy kit-installed migration runs in the normal sync path**, not
  `--adopt` (adopt never runs when a state file exists): on first sync,
  if `artifacts["AGENTS.md"]` is a whole-file record and the file has
  markers → drop the file record, create the region record, report
  `migrated`. No markers → inject + migrate.
- `artifacts` schema gains per-region records:
  `{ "AGENTS.md:kit-region": {hash, source, kitCommit, syncedAt, region: true} }`.
  `schemaVersion` bump; v1 records read unchanged (no `region` flag =
  whole-file semantics preserved for other dests).

### Files touched (implementation preview)

- `onboard.manifest.json` — `managedRegions`, claude-code stub template,
  profile table updates.
- `templates/kit-region.AGENTS.md` (new), `templates/AGENTS.md.tmpl`
  (restructure: markers + `{{KIT_REGION}}`, project-profile section).
- `bin/lib/sync-files.mjs` — `syncRegionDest` + marker extract/splice.
- `bin/lib/sync-engine.mjs` — `syncDests`/`syncDest` region dispatch,
  text-dest exclusion of `:<id>` keys, `mergeFile`/`applyDisposition`
  region routing, `unresolved` suffix-strip sweep, state migration.
- `bin/lib/sync-utils.mjs` — marker constants, `extractRegion`,
  `spliceRegion`, `buildManagedPlan.regionDests`, `buildAdoptedState`
  region handling.
- `bin/lib/sync.mjs` — `ACTIONS` registration for `injected`,
  `region-removed`, `migrated`.
- `bin/ui/js/model.mjs` — `SEVERITY`/`ACTIONABLE` entries for the new
  actions.
- `prompts/onboard-onboard.md`, `onboard-scaffold.md`,
  `onboard-fill-placeholders.md` — foreign-`AGENTS.md` flow, dedupe note,
  placeholder list updated for the new Project profile section.
- `README.md` — model description.
- Tests: `sync-engine.test.mjs`, `sync-r2.test.mjs`, `governance.test.mjs`
  + new `sync-region.test.mjs`.

## Acceptance criteria

1. Fresh scaffold on empty dir → `AGENTS.md` contains markers + block +
   project-profile placeholders; `onboard --record` stores a
   `AGENTS.md:kit-region` record, **no** `artifacts["AGENTS.md"]` record.
2. Foreign `AGENTS.md` project onboarded → file gains markers+block at
   the anchor, every other byte unchanged (hash-diff: only inserted
   lines), region record created.
3. Kit edits `kit-region.AGENTS.md` → sync fast-forwards the region in a
   project that never touched it; project text outside markers byte-identical.
4. Project edits outside markers + kit edits region → sync merges,
   outside edits preserved verbatim, zero conflict.
5. Project edits inside markers + kit edits same lines → conflict
   markers inside region, exit 2, rest of file intact.
6. First sync after upgrade on a legacy kit-installed project migrates
   the file-level record to a region record (runs in the normal sync
   path — `--adopt` never runs when state exists); subsequent syncs are
   region-scoped.
7. `overrides.skip: ["AGENTS.md:kit-region"]` freezes the region while
   other artifacts sync; `"AGENTS.md"` freezes both region and (legacy)
   file handling.
8. claude-code project: `CLAUDE.md` contains `@AGENTS.md`; no second
   region record; block loads via import.
9. Manifest test fails if `kit-region.*.md` contains `{{`.
10. UI diff view groups `AGENTS.md:kit-region` rows under `AGENTS.md`
    with a working per-file disposition.

## Non-goals

- Automatic deduplication of kit text baked into legacy files (reported,
  optional prompt step; risky to auto-strip).
- Multiple managed regions per file beyond `kit-region` (schema allows
  it; only one is shipped).
- Managing `.agents/*` docs as regions (they stay whole-file managed;
  they're already kit-owned).
- Cursor `.cursor/rules` / Windsurf `.windsurf/rules` promotion to
  primary channel.

## Open questions

1. Marker string: propose `<!-- BEGIN ai-onboarding-kit -->` /
   `<!-- END ai-onboarding-kit -->` (HTML comments render invisibly in
   markdown). Alternative: `<!-- ai-onboarding-kit:start -->`. OK?
2. Region ID naming: `kit-region` vs `core`. Cosmetic; spec uses
   `kit-region`.
3. Legacy dedupe: report-only (chosen) vs optional `--dedupe-legacy`
   flag that strips known kit sections. Report-only is safer; flag adds
   a template-fingerprint matcher. Confirm report-only.
4. claude-code: `@AGENTS.md` import stub (chosen) vs an independent
   `CLAUDE.md:kit-region`. Import avoids duplicating ~150 lines; depends
   on Claude's import support (verified: `@path` imports load at launch).
