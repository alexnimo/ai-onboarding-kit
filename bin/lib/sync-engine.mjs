/**
 * sync-engine.mjs - library facade over the sync engine for the POR-109 Web
 * UI. The UI server imports this module instead of shelling out to
 * `bin/onboard.mjs sync` or reimplementing merge semantics.
 *
 * Exports:
 *   dryRun(projectRoot, opts)                  -> {project, plan, summary}
 *   mergeFile(projectRoot, dest, opts)         -> {base, project, kit, merged, conflict, needsFill}
 *   applyDisposition(projectRoot, dest, disp, opts)
 *        disp in 'accepted' | 'reverted' | 'kit'
 *
 * Engine-internal helpers shared with bin/lib/sync.mjs (the CLI pipeline
 * delegates its per-dest pass through this module):
 *   openProject(entry, ctx) -> {pr, pctx|null}   project state + context
 *   syncDests(pctx)                            all managed dests, CLI order
 *   syncDest(pctx, dest)                       one dest (text or config)
 *   finalizeProject(pctx)                      stale-unresolved sweep + state write
 *   persistSyncState(pctx)                     write state when dirty
 *   buildCtx(opts)                             sync context (manifest/plan/commit)
 *   unifiedDiff(dest, oldText, newText)        unified diff text ('' = identical)
 *
 * Write model: every file write goes through pctx.writeFile/pctx.writeJson.
 * With ctx.capture (implies dry-run) writes are recorded instead of applied,
 * which is how dryRun() produces per-file unified diffs without touching
 * disk and how mergeFile() materializes the merged result.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  STATE_REL_PATH,
  SCHEMA_VERSION,
  sha256,
  sha256File,
  readJson,
  writeFileAtomic,
  writeJsonAtomic,
  loadRegistry,
  resolveManifestPath,
  getKitCommit,
} from './common.mjs';
import {
  CONFLICT_MARKER_RE,
  isObject,
  manifestAtCommit,
  buildManagedPlan,
  buildAdoptedState,
  renderTemplate,
  unfilledTokens,
  canon,
  getPath,
  setPath,
  parseRegionKey,
  extractRegion,
  spliceRegion,
  injectRegion,
} from './sync-utils.mjs';
import { splitLines, diffHunks } from './diff3.mjs';
import {
  reconstructBase,
  syncTextDest,
  syncConfigFile,
  syncRegionDest,
  expandKitRegions,
  prepareConfig,
  commitConfig,
} from './sync-files.mjs';
import { syncSkills } from './sync-skills.mjs';

// ---------- context ----------

/**
 * Build the sync context the per-dest handlers run against. `capture`
 * implies dryRun: file writes are recorded into ctx.capture (Map of
 * project-relative dest -> written text) instead of hitting disk.
 *
 * @param {object} opts {manifest?, force?, adopt?, restoreDeleted?,
 *   updateSkills?, installSkills?, capture?}
 * @returns {object} Sync context.
 */
export function buildCtx(opts = {}) {
  const manifestPath = resolveManifestPath(opts.manifest);
  const manifest = readJson(manifestPath);
  const ctx = {
    dryRun: !!opts.dryRun || !!opts.capture,
    force: !!opts.force,
    updateSkills: !!opts.updateSkills && !opts.capture,
    installSkills: !!opts.installSkills && !opts.capture,
    adopt: !!opts.adopt,
    restoreDeleted: !!opts.restoreDeleted,
    manifestPath,
    manifestRoot: path.dirname(manifestPath),
    manifest,
    plan: buildManagedPlan(manifest),
    kitCommit: getKitCommit(),
  };
  if (opts.capture) ctx.capture = new Map();
  return ctx;
}

/**
 * Look a project up in the registry by absolute path. Unregistered projects
 * get a synthetic entry with no agents or overrides - agent-scoped dests and
 * pins simply do not apply (registration is required for full fidelity).
 *
 * @param {string} projectRoot Absolute project path.
 * @returns {object} Registry entry {name, path, agents, overrides}.
 */
export function projectEntry(projectRoot) {
  const resolved = path.resolve(projectRoot);
  const entry = loadRegistry().projects
    .find(e => path.resolve(e.path) === resolved);
  if (entry) return entry;
  return { name: path.basename(resolved), path: resolved, agents: [], overrides: {} };
}

/**
 * Open a project for syncing: validate the path, load (or adopt) state, and
 * assemble the per-project context the dest handlers consume.
 *
 * @param {object} entry Registry entry {name, path, agents, overrides}.
 * @param {object} ctx Sync context from buildCtx/commandSync.
 * @returns {{pr: object, pctx: object|null}} Report object plus pctx, or
 *   pctx null when the project cannot be synced (missing path, unadopted).
 */
export function openProject(entry, ctx) {
  const projectRoot = entry.path;
  const pr = {
    name: entry.name || path.basename(projectRoot),
    path: projectRoot,
    status: 'ok',
    files: [],
    skills: [],
    conflictCount: 0,
    synced: false,
  };
  const row = (artifact, action, detail) => {
    pr.files.push({ artifact, action, detail });
    if (action === 'conflict') pr.conflictCount++;
  };

  if (!fs.existsSync(projectRoot)) {
    pr.status = 'missing-path';
    row('(project)', 'skip', 'project path does not exist');
    return { pr, pctx: null };
  }

  const statePath = path.join(projectRoot, STATE_REL_PATH);
  let state = null;
  try {
    const parsed = readJson(statePath);
    if (isObject(parsed) && isObject(parsed.artifacts)) state = parsed;
  } catch { /* missing or invalid state file */ }

  const now = new Date().toISOString();
  let adopted = false;
  if (!state) {
    if (!ctx.adopt) {
      pr.status = 'unadopted';
      row('(project)', 'unadopted', 'no .agents/onboarding-state.json - run record-state or sync --adopt');
      return { pr, pctx: null };
    }
    // Adoption records a baseline over MCP/hooks config only; templates and
    // rules are project-owned foreign files the kit never guesses a base
    // for. The adopt run itself skips text dests entirely (AC: zero
    // template/rule files modified). Managed config keys absent at adoption
    // are treated as never-installed (added), not deleted-by-project.
    state = buildAdoptedState(projectRoot, ctx, entry, now);
    adopted = true;
    pr.status = 'adopted';
    row('(project)', 'adopted', `recorded baseline state (${Object.keys(state.artifacts).length} managed artifacts)`);
  }
  pr.synced = true;

  const artifacts = state.artifacts;
  // Backfill v1 records: states written before per-artifact kitCommit have
  // none, but their base WAS reconstructable at state.kitCommit. Stamp it so
  // the commit survives the global pointer advancing past skipped artifacts.
  for (const rec of Object.values(artifacts)) {
    if (rec && !rec.kitCommit && state.kitCommit && state.kitCommit !== 'unknown') {
      rec.kitCommit = state.kitCommit;
    }
  }
  const manifestCache = new Map();
  const writeFile = (abs, text) => {
    if (ctx.capture) ctx.capture.set(abs, text);
    else if (!ctx.dryRun) writeFileAtomic(abs, text);
  };
  const pctx = {
    ctx,
    pr,
    projectRoot,
    entry,
    state,
    artifacts,
    row,
    now,
    adopted,
    stateDirty: pr.status === 'adopted',
    unresolved: new Set(state.unresolved || []),
    skipSet: new Set(entry.overrides?.skip || []),
    pins: entry.overrides?.pins || {},
    placeholders: isObject(state.placeholders) ? state.placeholders : {},
    writeFile,
    writeJson: (abs, data) => writeFile(abs, JSON.stringify(data, null, 2) + '\n'),
    // The managed-key base manifest at a given commit - per config FILE,
    // because rec.kitCommit can lag state.kitCommit after partial syncs.
    baseManifestAt: commit => {
      const c = (commit && commit !== 'unknown') ? commit : state.kitCommit;
      if (!manifestCache.has(c)) {
        manifestCache.set(c, manifestAtCommit(c, ctx.manifestPath));
      }
      return manifestCache.get(c);
    },
  };
  return { pr, pctx };
}

// ---------- per-dest dispatch ----------

/**
 * Sync one managed destination: config paths route to the managed-key
 * merger, everything else to the text (diff3) path.
 *
 * @param {object} pctx Project sync context.
 * @param {string} dest Project-relative dest path.
 */
export function syncDest(pctx, dest) {
  const regionKey = parseRegionKey(dest);
  if (regionKey) {
    const regions = pctx.ctx.plan.regionDests?.get(regionKey.dest) || [];
    const region = regions.find(r => r.id === regionKey.regionId);
    if (region) return syncRegionDest(pctx, regionKey.dest, region);
    pctx.row(dest, 'retired', 'region no longer managed by manifest');
    return;
  }
  if (pctx.ctx.plan.regionDests?.has(dest)) {
    // Dest is region-managed: the region pass owns it entirely (fresh
    // installs render through the region path).
    return;
  }
  const cfgPlan = pctx.ctx.plan.configPaths.get(dest);
  if (cfgPlan) return syncConfigFile(pctx, dest, cfgPlan);
  return syncTextDest(pctx, dest);
}

/**
 * Run every managed dest for a project in CLI order: text dests (manifest
 * plan plus recorded non-config artifacts, which surface as `retired`),
 * then config files. The CLI's per-dest pass delegates here.
 *
 * @param {object} pctx Project sync context.
 */
export function syncDests(pctx) {
  const { ctx, artifacts } = pctx;
  // Text dests: manifest plan plus recorded artifacts that are not config
  // paths (artifacts the manifest dropped surface as `retired`). Adoption
  // runs skip this pass entirely - the kit never guesses a base for
  // template/rule files it cannot prove it installed. Region artifact
  // keys (`<dest>:<id>`) and region-managed dests never enter this pass:
  // a stray `AGENTS.md:kit-region` would hit `existsSync` as a literal
  // path, report `retired`, and --prune would delete the record.
  if (!pctx.adopted) {
    const textDests = new Set(ctx.plan.textDests.keys());
    for (const dest of Object.keys(artifacts)) {
      if (!ctx.plan.configPaths.has(dest) && !parseRegionKey(dest)) {
        textDests.add(dest);
      }
    }
    for (const dest of textDests) {
      if (ctx.plan.regionDests?.has(dest)) continue; // region pass owns it
      syncTextDest(pctx, dest);
    }
  }
  // Region pass: runs even for adopted projects - injection is the whole
  // point of adopt for foreign instruction files (spec: lift of the
  // !adopted gate for regions).
  for (const [dest, regions] of ctx.plan.regionDests || []) {
    for (const region of regions) syncRegionDest(pctx, dest, region);
  }
  // Region records whose dest/id left the manifest surface as retired.
  for (const key of Object.keys(artifacts)) {
    const rk = parseRegionKey(key);
    if (!rk) continue;
    const regions = ctx.plan.regionDests?.get(rk.dest) || [];
    if (!regions.some(r => r.id === rk.regionId)) {
      pctx.row(key, 'retired', 'region no longer managed by manifest; record kept');
    }
  }
  for (const [cfgRel, cfgPlan] of ctx.plan.configPaths) {
    syncConfigFile(pctx, cfgRel, cfgPlan);
  }
}

// ---------- finalize / persist ----------

/**
 * Persist the project state file when anything changed. Shared by
 * finalizeProject (full sync) and applyDisposition (single-dest apply).
 *
 * @param {object} pctx Project sync context.
 */
export function persistSyncState(pctx) {
  const { ctx, state } = pctx;
  state.schemaVersion = SCHEMA_VERSION;
  state.kitCommit = ctx.kitCommit;
  state.manifestHash = sha256File(ctx.manifestPath);
  state.unresolved = [...pctx.unresolved].sort();
  state.lastSyncResult = {
    at: pctx.now,
    conflicts: pctx.pr.conflictCount,
    actions: pctx.pr.files.length,
  };
  writeJsonAtomic(path.join(pctx.projectRoot, STATE_REL_PATH), state);
}

/**
 * End-of-sync bookkeeping: drop stale unresolved entries once the file on
 * disk no longer carries markers (a human resolved them while the kit was
 * unchanged), then persist state only when something changed - keeps
 * re-syncs byte-stable.
 *
 * @param {object} pctx Project sync context.
 */
export function finalizeProject(pctx) {
  const { ctx, state, projectRoot } = pctx;
  for (const key of [...pctx.unresolved]) {
    const rk = parseRegionKey(key);
    const dest = rk ? rk.dest : key;
    const abs = path.join(projectRoot, dest);
    let stillMarked = false;
    if (fs.existsSync(abs)) {
      const text = fs.readFileSync(abs, 'utf8');
      // Region-scoped marker check: a `<<<<<<<` outside the managed
      // region is project content, not our conflict.
      const scanText = rk ? (extractRegion(text, rk.regionId) ?? '') : text;
      stillMarked = CONFLICT_MARKER_RE.test(scanText);
    }
    if (!stillMarked) pctx.unresolved.delete(key);
  }
  const unresolvedBefore = new Set(state.unresolved || []);
  const unresolvedChanged = pctx.unresolved.size !== unresolvedBefore.size
    || [...pctx.unresolved].some(d => !unresolvedBefore.has(d));
  if (!ctx.dryRun && (pctx.stateDirty || unresolvedChanged)) {
    persistSyncState(pctx);
  }
}

// ---------- unified diff ----------

/**
 * Unified-diff two texts (3 context lines). Labels follow git convention
 * (a/<dest>, b/<dest>). Empty string means identical.
 *
 * @param {string} dest Project-relative path (used in ---/+++ headers).
 * @param {string} oldText Current content ('' for absent files).
 * @param {string} newText Proposed content.
 * @returns {string} Unified diff text.
 */
export function unifiedDiff(dest, oldText, newText) {
  const o = oldText === '' ? [] : splitLines(oldText);
  const x = newText === '' ? [] : splitLines(newText);
  const hunks = diffHunks(o, x);
  if (!hunks.length) return '';

  const CTX = 3;
  const groups = [];
  for (const h of hunks) {
    const lo = Math.max(0, h.oStart - CTX);
    const hi = Math.min(o.length, h.oEnd + CTX);
    const last = groups[groups.length - 1];
    if (last && lo <= last.hi) {
      last.hunks.push(h);
      last.hi = Math.max(last.hi, hi);
    } else {
      groups.push({ lo, hi, hunks: [h] });
    }
  }

  const out = [`--- a/${dest}`, `+++ b/${dest}`];
  for (const g of groups) {
    // x-range start: first hunk's x index minus the context lines before
    // it. (Summing per-hunk o->x offsets double-counts earlier insertions.)
    const xLo = g.hunks[0].sStart - (g.hunks[0].oStart - g.lo);
    const oCount = g.hi - g.lo;
    const xCount = oCount + g.hunks.reduce((n, h) => n + (h.sEnd - h.sStart) - (h.oEnd - h.oStart), 0);
    out.push(`@@ -${oCount ? g.lo + 1 : g.lo},${oCount} +${xCount ? xLo + 1 : xLo},${xCount} @@`);
    let pos = g.lo;
    for (const h of g.hunks) {
      for (; pos < h.oStart; pos++) out.push(` ${o[pos]}`);
      for (let i = h.oStart; i < h.oEnd; i++) out.push(`-${o[i]}`);
      for (let i = h.sStart; i < h.sEnd; i++) out.push(`+${x[i]}`);
      pos = h.oEnd;
    }
    for (; pos < g.hi; pos++) out.push(` ${o[pos]}`);
  }
  return out.join('\n') + '\n';
}

// ---------- public facade ----------

const REL = p => p.split(path.sep).join('/');

/**
 * Classify one project's pending sync with zero disk writes - plan rows are
 * identical to `sync --dry-run --json` and each non-skip file row carries a
 * unified `diff` of what a sync would write (config-key rows diff the
 * config file, or its .kit-incoming.json sidecar when the file itself is
 * unchanged). No project files, state, or registry are modified.
 *
 * @param {string} projectRoot Project path (registry entry preferred).
 * @param {object} opts {manifest?, force?, adopt?, restoreDeleted?}
 * @returns {{project: object, plan: object[], summary: object}}
 */
export function dryRun(projectRoot, opts = {}) {
  const ctx = buildCtx({ ...opts, capture: true });
  const entry = projectEntry(projectRoot);
  const { pr, pctx } = openProject(entry, ctx);
  if (pctx) {
    syncDests(pctx);
    pr.skills = syncSkills(pctx);
    finalizeProject(pctx); // ctx.dryRun -> no writes; sweeps in-memory state only
  }

  const diffs = new Map(); // project-relative path -> unified diff
  for (const [abs, text] of ctx.capture) {
    const rel = REL(path.relative(pctx.projectRoot, abs));
    const old = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    diffs.set(rel, unifiedDiff(rel, old, text));
  }
  const plan = pr.files.map(f => {
    const row = { artifact: f.artifact, action: f.action };
    if (f.detail !== undefined) row.detail = f.detail;
    if (f.action !== 'skip' && f.artifact !== '(project)') {
      const dest = f.artifact.split(':')[0];
      row.diff = diffs.get(dest) ?? diffs.get(`${dest}.kit-incoming.json`) ?? '';
    }
    return row;
  });
  const byAction = {};
  for (const r of plan) byAction[r.action] = (byAction[r.action] || 0) + 1;
  return {
    project: pr,
    plan,
    summary: {
      total: plan.length,
      byAction,
      conflicts: pr.conflictCount,
      exitCode: pr.conflictCount > 0 ? 2 : 0,
    },
  };
}

/**
 * Materialize a three-way merge for one dest with no writes.
 *   - text dests:   base = kit template at the dest's recorded kitCommit,
 *                   rendered with recorded placeholder values (unfilled
 *                   {{KEY}} tokens when values were never recorded);
 *                   kit = current render; merged = diff3 output (markers
 *                   included when conflict).
 *   - config dests: per managed key (JSON merges are never marked - the kit
 *                   reports them instead); base/kit are JSON objects keyed
 *                   by report key with each key's resolved value.
 * Returns null when the project cannot be synced (missing/unadopted).
 *
 * @param {string} projectRoot Project path.
 * @param {string} dest Project-relative dest path.
 * @param {object} opts {manifest?}
 * @returns {{base: *, project: string|null, kit: *, merged: string|null,
 *   conflict: boolean, needsFill: boolean}|null}
 */
export function mergeFile(projectRoot, dest, opts = {}) {
  const ctx = buildCtx({ ...opts, capture: true });
  const entry = projectEntry(projectRoot);
  const { pctx } = openProject(entry, ctx);
  if (!pctx) return null;

  const rk = parseRegionKey(dest);
  const fileDest = rk ? rk.dest : dest;
  const destAbs = path.join(pctx.projectRoot, fileDest);
  const project = fs.existsSync(destAbs) ? fs.readFileSync(destAbs, 'utf8') : null;
  const cfgPlan = ctx.plan.configPaths.get(dest);

  let base = null;
  let kit = null;
  if (cfgPlan) {
    const rec = pctx.artifacts[dest];
    const prep = prepareConfig(pctx, dest, cfgPlan, rec);
    const baseMap = {};
    const kitMap = {};
    for (const k of prep.keys) {
      if (k.baseEntry !== undefined) baseMap[k.reportKey] = k.baseEntry;
      kitMap[k.reportKey] = k.newEntry;
    }
    base = baseMap;
    kit = kitMap;
  } else if (rk) {
    // Region: base/kit are the REGION source text (record.source points
    // at the region src file, not a full template).
    const rec = pctx.artifacts[dest];
    const regions = ctx.plan.regionDests?.get(rk.dest) || [];
    const region = regions.find(r => r.id === rk.regionId);
    const srcRel = rec?.source || region?.src;
    const srcAbs = srcRel ? path.join(ctx.manifestRoot, srcRel) : null;
    if (srcAbs && rec) {
      const baseText = reconstructBase(rec, srcAbs, pctx.state.kitCommit, ctx.manifestRoot);
      if (baseText !== null) base = extractRegion(baseText, rk.regionId) ?? baseText;
    }
    if (srcAbs && fs.existsSync(srcAbs)) {
      kit = fs.readFileSync(srcAbs, 'utf8').replace(/\r?\n$/, ''); // match region text on disk
    }
  } else {
    const rec = pctx.artifacts[dest];
    const info = ctx.plan.textDests.get(dest);
    const srcRel = rec?.source || info?.src;
    const srcAbs = srcRel ? path.join(ctx.manifestRoot, srcRel) : null;
    if (srcAbs && rec) {
      const baseText = reconstructBase(rec, srcAbs, pctx.state.kitCommit, ctx.manifestRoot);
      if (baseText !== null) base = renderTemplate(baseText, pctx.placeholders);
    }
    if (srcAbs && fs.existsSync(srcAbs)) {
      kit = renderTemplate(fs.readFileSync(srcAbs, 'utf8'), pctx.placeholders);
    }
  }

  syncDest(pctx, dest);
  const captured = ctx.capture.get(destAbs);
  const merged = captured !== undefined ? captured : project;
  const rowDest = `${dest}:`;
  const conflict = pctx.pr.files.some(
    f => (f.artifact === dest || f.artifact.startsWith(rowDest)) && f.action === 'conflict');
  const needsFill = unfilledTokens(merged ?? kit ?? '').length > 0;
  return { base, project, kit, merged, conflict, needsFill };
}

/**
 * Apply a per-dest disposition, atomically.
 *   accepted  -> run the real sync for this dest (merged or fast-forward
 *                result is written and the artifact record refreshed);
 *                opts.content writes caller-supplied merged content instead
 *                (UI-edited conflict resolution).
 *   reverted  -> no file write, no state artifact change.
 *   kit       -> write the current kit render (or every non-deferred
 *                managed key's kit entry for config dests) and refresh the
 *                record; keys still pinned/exempt keep frozen bases.
 * Throws on unknown disposition/dest; returns {changed, conflict, rows} for
 * 'reverted' without touching disk.
 *
 * @param {string} projectRoot Project path.
 * @param {string} dest Project-relative dest path.
 * @param {'accepted'|'reverted'|'kit'} disposition
 * @param {object} opts {manifest?, content?}
 * @returns {{dest: string, disposition: string, changed: boolean,
 *   conflict: boolean, rows: object[]}}
 */
export function applyDisposition(projectRoot, dest, disposition, opts = {}) {
  if (!['accepted', 'reverted', 'kit'].includes(disposition)) {
    throw new Error(`unknown disposition: ${disposition}`);
  }
  const ctx = buildCtx(opts);
  const entry = projectEntry(projectRoot);
  const { pr, pctx } = openProject(entry, ctx);
  if (!pctx) throw new Error(`project not syncable: ${pr.status}`);
  const rk = parseRegionKey(dest);
  const fileDest = rk ? rk.dest : dest;
  const destAbs = path.join(pctx.projectRoot, fileDest);
  const regions = rk ? (ctx.plan.regionDests?.get(rk.dest) || []) : [];
  const region = rk ? regions.find(r => r.id === rk.regionId) : null;
  if (rk && !region) throw new Error(`not a managed region: ${dest}`);
  const cfgPlan = ctx.plan.configPaths.get(dest);
  const isManaged = cfgPlan || ctx.plan.textDests.has(dest)
    || pctx.artifacts[dest] || region;
  if (!isManaged) throw new Error(`not a managed dest: ${dest}`);
  // Region apply (dest = '<file>:<id>'): 'accepted' runs the region sync
  // pass; 'accepted'+content writes whole-file content with the marker
  // scan scoped to the region; 'kit' splices the kit block inside the
  // markers (injecting when absent). Caller content is allowed only when
  // a region record exists or markers are present - injecting caller
  // content into a markerless foreign file is off-limits.
  if (region) {
    if (pctx.pins[dest] !== undefined || pctx.pins[fileDest] !== undefined
        || pctx.skipSet.has(dest) || pctx.skipSet.has(fileDest)) {
      throw new Error(`dest is pinned/exempt: ${dest}`);
    }
    if (disposition === 'reverted') {
      return { dest, disposition, changed: false, conflict: false, rows: [] };
    }
    if (disposition === 'accepted' && typeof opts.content !== 'string') {
      syncDest(pctx, dest);
    } else {
      const local = fs.existsSync(destAbs) ? fs.readFileSync(destAbs, 'utf8') : '';
      const hasMarkers = extractRegion(local, rk.regionId) !== null;
      if (disposition === 'accepted') {
        if (fs.existsSync(destAbs) && !hasMarkers && !pctx.artifacts[dest]) {
          throw new Error(`unmanaged file (no markers, no record): ${fileDest}`);
        }
        pctx.writeFile(destAbs, opts.content);
        pctx.artifacts[dest] = {
          ...(pctx.artifacts[dest] || {}),
          hash: pctx.artifacts[dest]?.hash || sha256(extractRegion(opts.content, rk.regionId) ?? opts.content),
          source: region.src,
          syncedAt: pctx.now,
          kitCommit: ctx.kitCommit,
          region: true,
        };
        const regionText = extractRegion(opts.content, rk.regionId);
        if (regionText !== null && CONFLICT_MARKER_RE.test(regionText)) {
          pctx.unresolved.add(dest);
        } else {
          pctx.unresolved.delete(dest);
        }
        pctx.stateDirty = true;
        pctx.row(dest, 'merged', 'applied provided content (disposition: accepted)');
      } else { // 'kit': splice the kit block inside markers
        const srcAbs = path.join(ctx.manifestRoot, region.src);
        if (!fs.existsSync(srcAbs)) throw new Error(`no kit region source: ${region.src}`);
        const blockRaw = fs.readFileSync(srcAbs, 'utf8');
        const block = blockRaw.replace(/\r?\n$/, ''); // match splice normalization
        const merged = hasMarkers
          ? spliceRegion(local, rk.regionId, block)
          : injectRegion(local, rk.regionId, block);
        if (merged === null) throw new Error(`marker splice failed: ${fileDest}`);
        pctx.writeFile(destAbs, merged);
        pctx.artifacts[dest] = {
          ...(pctx.artifacts[dest] || {}),
          hash: sha256(blockRaw), source: region.src,
          syncedAt: pctx.now, kitCommit: ctx.kitCommit, region: true,
        };
        pctx.unresolved.delete(dest);
        pctx.stateDirty = true;
        pctx.row(dest, 'fast-forward', 'applied kit region (disposition: kit)');
      }
    }
    if (pctx.stateDirty) persistSyncState(pctx);
    const conflict = pr.files.some(f => f.artifact === dest && f.action === 'conflict');
    return { dest, disposition, changed: true, conflict, rows: pr.files };
  }


  if (disposition === 'reverted') {
    return { dest, disposition, changed: false, conflict: false, rows: [] };
  }

  // UI-initiated writes ('kit', or 'accepted' with caller content) pass
  // the same guards the engine applies before touching disk:
  //   - pinned/exempt dests are never touched;
  //   - a text dest with an existing file but no recorded base is foreign
  //     and never overwritten (configs differ: syncConfigFile merges
  //     managed keys into unrecorded config files, so no foreign check);
  //   - new-file materialization only happens for agents the project
  //     registered (syncTextDest/syncConfigFile apply the same gate).
  const explicitWrite = disposition === 'kit'
    || (disposition === 'accepted' && typeof opts.content === 'string');
  if (explicitWrite) {
    if (pctx.pins[dest] !== undefined || pctx.skipSet.has(dest)) {
      throw new Error(`dest is pinned/exempt: ${dest}`);
    }
    if (cfgPlan) {
      const agentRelevant = [...cfgPlan.agents]
        .some(a => (pctx.entry.agents || []).includes(a));
      if (!pctx.artifacts[dest] && !agentRelevant) {
        throw new Error(`config dest not relevant to project agents: ${dest}`);
      }
      // An unreadable or non-object config file can't carry a managed-key
      // apply - mirror syncConfigFile's skip report instead of throwing a
      // raw parse error mid-disposition.
      if (fs.existsSync(destAbs)) {
        let skipDetail = null;
        try {
          if (!isObject(readJson(destAbs))) skipDetail = 'non-object JSON; left untouched';
        } catch { skipDetail = 'invalid JSON; left untouched'; }
        if (skipDetail) {
          pctx.row(dest, 'skip', skipDetail);
          return { dest, disposition, changed: false, conflict: false, rows: pr.files };
        }
      }
    } else {
      if (fs.existsSync(destAbs) && !pctx.artifacts[dest]) {
        throw new Error(`unmanaged file (no recorded base): ${dest}`);
      }
      if (!pctx.artifacts[dest]) {
        const info = ctx.plan.textDests.get(dest);
        if (info?.agents
            && ![...info.agents].some(a => (pctx.entry.agents || []).includes(a))) {
          throw new Error(`dest is scoped to an agent this project does not use: ${dest}`);
        }
      }
    }
  }

  if (disposition === 'accepted') {
    if (typeof opts.content === 'string') {
      if (cfgPlan) {
        acceptConfigContent(pctx, dest, cfgPlan, destAbs, opts.content);
      } else {
        // Caller-resolved content: write it and refresh the record. Marker
        // scan still applies - content carrying <<<<<<< stays unresolved.
        pctx.writeFile(destAbs, opts.content);
        const info = ctx.plan.textDests.get(dest);
        const srcRel = pctx.artifacts[dest]?.source || info?.src;
        const srcAbs = srcRel ? path.join(ctx.manifestRoot, srcRel) : null;
        const srcHash = srcAbs && fs.existsSync(srcAbs) ? sha256File(srcAbs) : null;
        pctx.artifacts[dest] = {
          ...(pctx.artifacts[dest] || {}),
          hash: srcHash || sha256(opts.content),
          source: srcRel || dest,
          syncedAt: pctx.now,
          kitCommit: ctx.kitCommit,
        };
      }
      if (CONFLICT_MARKER_RE.test(opts.content)) {
        pctx.unresolved.add(dest);
      } else {
        pctx.unresolved.delete(dest);
      }
      pctx.stateDirty = true;
      pctx.row(dest, 'merged', 'applied provided content (disposition: accepted)');
    } else {
      syncDest(pctx, dest);
    }
  } else { // 'kit'
    if (cfgPlan) {
      applyKitConfig(pctx, dest, cfgPlan, destAbs);
      pctx.row(dest, 'fast-forward', 'applied kit entries (disposition: kit)');
    } else {
      const info = ctx.plan.textDests.get(dest);
      const srcAbs = info && path.join(ctx.manifestRoot, info.src);
      if (!srcAbs || !fs.existsSync(srcAbs)) {
        throw new Error(`no current kit source for ${dest}`);
      }
      const kitText = renderTemplate(fs.readFileSync(srcAbs, 'utf8'), pctx.placeholders);
      pctx.writeFile(destAbs, kitText);
      pctx.artifacts[dest] = {
        ...(pctx.artifacts[dest] || {}),
        hash: sha256File(srcAbs),
        source: info.src,
        syncedAt: pctx.now,
        kitCommit: ctx.kitCommit,
      };
      pctx.unresolved.delete(dest);
      pctx.stateDirty = true;
      pctx.row(dest, 'fast-forward', 'applied kit render (disposition: kit)');
    }
  }

  if (pctx.stateDirty) persistSyncState(pctx);
  const rowDest = `${dest}:`;
  const conflict = pr.files.some(
    f => (f.artifact === dest || f.artifact.startsWith(rowDest)) && f.action === 'conflict');
  return { dest, disposition, changed: true, conflict, rows: pr.files };
}

/**
 * 'kit' disposition for a managed-key config file: set every non-deferred
 * manifest key to its kit entry (overriding customizations and restoring
 * deleted keys), drop matching sidecar proposals, and refresh per-key bases
 * only for keys actually resolved - pinned/exempt keys keep frozen bases.
 *
 * @param {object} pctx Project sync context.
 * @param {string} cfgRel Project-relative config path.
 * @param {object} cfgPlan Config plan entry.
 * @param {string} cfgAbs Absolute config path.
 */
function applyKitConfig(pctx, cfgRel, cfgPlan, cfgAbs) {
  const rec = pctx.artifacts[cfgRel];
  let cfgData = {};
  if (fs.existsSync(cfgAbs)) {
    cfgData = readJson(cfgAbs);
    if (!isObject(cfgData)) throw new Error(`non-object JSON at ${cfgRel}`);
  }
  const prep = prepareConfig(pctx, cfgRel, cfgPlan, rec);
  let changed = false;
  for (const k of prep.keys) {
    if (k.deferred) continue; // pinned/exempt keys are not resolved
    const installed = getPath(cfgData, k.pathArr);
    if (installed === undefined || canon(installed) !== canon(k.newEntry)) {
      setPath(cfgData, k.pathArr, k.newEntry);
      changed = true;
    }
  }
  // Resolved keys can no longer have outstanding sidecar proposals.
  const sidecarAbs = `${cfgAbs}.kit-incoming.json`;
  if (fs.existsSync(sidecarAbs)) {
    let sidecar = {};
    try { sidecar = readJson(sidecarAbs); } catch { sidecar = {}; }
    if (isObject(sidecar)) {
      for (const k of prep.keys) {
        if (!k.deferred) delete sidecar[k.reportKey];
      }
      if (Object.keys(sidecar).length) writeJsonAtomic(sidecarAbs, sidecar);
      else fs.rmSync(sidecarAbs, { force: true });
    }
  }
  pctx.unresolved.delete(cfgRel);
  commitConfig(pctx, cfgRel, cfgPlan, rec, cfgData, prep, changed);
}

/**
 * 'accepted' disposition with caller-supplied content for a managed-key
 * config file: write the caller's JSON while preserving the engine's
 * managed-key guarantees -
 *   - deferred (pinned/exempt) keys keep their on-disk values; the caller's
 *     content is not allowed to resolve them.
 *   - per-key bases reconcile like record-state does: a key whose accepted
 *     value equals the current kit entry is re-based to this run's commit,
 *     a differing key keeps its prior effective base (otherwise a later
 *     sync would evaluate it against a stale file-level commit).
 *   - sidecar proposals for keys now matching the kit are dropped.
 *
 * @param {object} pctx Project sync context.
 * @param {string} cfgRel Project-relative config path.
 * @param {object} cfgPlan Config plan entry.
 * @param {string} cfgAbs Absolute config path.
 * @param {string} content Caller-supplied JSON content.
 */
function acceptConfigContent(pctx, cfgRel, cfgPlan, cfgAbs, content) {
  const rec = pctx.artifacts[cfgRel];
  let data;
  try { data = JSON.parse(content); } catch {
    throw new Error(`content is not valid JSON for ${cfgRel}`);
  }
  if (!isObject(data)) throw new Error(`content is not a JSON object for ${cfgRel}`);

  let onDisk = {};
  if (fs.existsSync(cfgAbs)) onDisk = readJson(cfgAbs);

  // Remove a nested leaf (and now-empty parents) - setPath cannot express
  // deletion because JSON.stringify silently drops undefined values into
  // objects, but the empty parent objects it leaves behind are real.
  const delPath = (obj, segs) => {
    const stack = [];
    let cur = obj;
    for (const seg of segs.slice(0, -1)) {
      if (!isObject(cur[seg])) return;
      stack.push([cur, seg]);
      cur = cur[seg];
    }
    delete cur[segs[segs.length - 1]];
    for (let i = stack.length - 1; i >= 0; i--) {
      const [parent, seg] = stack[i];
      if (isObject(parent[seg]) && Object.keys(parent[seg]).length === 0) {
        delete parent[seg];
      } else break;
    }
  };

  const prep = prepareConfig(pctx, cfgRel, cfgPlan, rec);
  const stillDiffer = new Set(prep.deferredKeys);
  for (const k of prep.keys) {
    const installed = getPath(onDisk, k.pathArr);
    if (k.deferred) {
      // Not resolvable: restore the on-disk value (or absence) so caller
      // content cannot override a pin/exemption.
      if (installed === undefined) delPath(data, k.pathArr);
      else setPath(data, k.pathArr, installed);
      continue;
    }
    const accepted = getPath(data, k.pathArr);
    if (canon(accepted) !== canon(k.newEntry)) stillDiffer.add(k.keyId);
  }

  // Reconcile sidecar proposals: drop entries the accepted content resolved
  // - i.e. the accepted value now equals the CURRENT kit entry for that key
  // (or the key left the manifest). A proposal that merely matches the
  // accepted value is stale, not resolved: a key restored to an older kit
  // value still has an outstanding newer proposal.
  const sidecarAbs = `${cfgAbs}.kit-incoming.json`;
  if (fs.existsSync(sidecarAbs)) {
    let sidecar = {};
    try { sidecar = readJson(sidecarAbs); } catch { sidecar = {}; }
    if (isObject(sidecar)) {
      const newByKey = new Map(prep.keys.map(k => [k.reportKey, k.newEntry]));
      for (const key of Object.keys(sidecar)) {
        const pathArr = prep.keyPaths.get(key);
        const installed = pathArr ? getPath(data, pathArr) : undefined;
        if (!pathArr || (installed !== undefined
            && canon(installed) === canon(newByKey.get(key)))) {
          delete sidecar[key];
        }
      }
      if (Object.keys(sidecar).length) writeJsonAtomic(sidecarAbs, sidecar);
      else fs.rmSync(sidecarAbs, { force: true });
    }
  }

  // Per-key bases: keys whose accepted value equals the kit entry resolved
  // to this run's commit; differing and deferred keys keep frozen bases.
  // commitConfig writes the file and refreshes the record.
  const prepForCommit = { ...prep, deferredKeys: stillDiffer };
  commitConfig(pctx, cfgRel, cfgPlan, rec, data, prepForCommit, true);
}

