/**
 * sync-files.mjs - per-file sync for the sync engine. Node >=18, stdlib only.
 *
 * Text dests (templates/rules) merge via diff3 against the recorded base;
 * agent config files (MCP servers, hooks) merge per managed KEY against the
 * manifest entry at each artifact's recorded kitCommit. See
 * docs/research/t_096c11fb.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  sha256,
  sha256File,
  readJson,
} from './common.mjs';
import { merge3 } from './diff3.mjs';
import {
  CONFLICT_MARKER_RE,
  gitShow,
  gitRevList,
  repoRel,
  renderTemplate,
  needsFillSuffix,
  canon,
  isObject,
  getPath,
  setPath,
  groupHooksByEvent,
} from './sync-utils.mjs';

/**
 * Reconstruct the recorded base content for a template artifact: prefer the
 * current kit source when it still matches the recorded hash, else recover
 * the template at the artifact's recorded kitCommit (falling back to
 * state.kitCommit for v1 records) via `git show` and verify it against the
 * recorded hash. When neither commit matches - e.g. the global kitCommit
 * advanced while this artifact was skipped - walk the file's own history
 * (`git rev-list`) for a matching base.
 *
 * @param {object} rec State artifact record {hash, source, kitCommit?}.
 * @param {string} srcAbs Absolute path of the current kit source.
 * @param {string} kitCommit state.kitCommit fallback commit.
 * @param {string} manifestRoot Directory of the active manifest; bounds
 *   on-disk sources outside the kit repo.
 * @returns {string|null} Base text, or null when unreconstructable.
 */
export function reconstructBase(rec, srcAbs, kitCommit, manifestRoot) {
  const rel = repoRel(srcAbs);
  if (!rel) {
    // Source outside the kit repo - no git history can vouch for it. The
    // on-disk fast path still applies, but ONLY when the path stays under
    // the active manifest's root (custom --manifest locations legitimately
    // live outside the repo): a source escaping even that root is purely
    // state-file controlled and can never be kit content.
    const relM = path.relative(manifestRoot || '', srcAbs);
    if (relM.startsWith('..') || path.isAbsolute(relM)) return null;
    if (fs.existsSync(srcAbs) && sha256File(srcAbs) === rec.hash) {
      return fs.readFileSync(srcAbs, 'utf8');
    }
    return null;
  }
  if (fs.existsSync(srcAbs) && sha256File(srcAbs) === rec.hash) {
    return fs.readFileSync(srcAbs, 'utf8');
  }
  const seen = new Set();
  const candidates = [rec.kitCommit, kitCommit]
    .filter(c => c && c !== 'unknown' && !seen.has(c) && seen.add(c));
  // Scan the file's whole history as fallback - covers v1 records (no
  // per-artifact commit) and states whose global kitCommit overtook the
  // recorded base while the artifact was skipped.
  for (const c of gitRevList('HEAD', rel)) {
    if (!seen.has(c) && seen.add(c)) candidates.push(c);
  }
  for (const c of candidates) {
    const buf = gitShow(c, rel);
    if (buf && sha256(buf) === rec.hash) return buf.toString('utf8');
  }
  return null;
}

/**
 * Sync one text (template/rules) destination for a project.
 *
 * Classification (recorded base = artifacts[dest].hash, the sha256 of the kit
 * template as installed, pre-placeholder-fill):
 *   local == base            -> fast-forward to new kit content
 *   kit source == base       -> project-only (local edits kept)
 *   both changed             -> diff3 merge; conflicts get markers + exit 2
 *   no state entry + exists  -> foreign file, skip always
 *
 * @param {object} pctx Project sync context (see sync.mjs).
 * @param {string} dest Project-relative dest path.
 */
export function syncTextDest(pctx, dest) {
  const { ctx, projectRoot, entry, state, artifacts, row, skipSet, pins } = pctx;
  const rec = artifacts[dest];
  const info = ctx.plan.textDests.get(dest); // {src, agents|null}

  if (pins[dest] !== undefined) { row(dest, 'skip', `pinned: ${pins[dest]}`); return; }
  if (skipSet.has(dest)) { row(dest, 'skip', 'exempt: overrides.skip'); return; }
  if (!info) {
    // Non-manifest dests reach this pass only via recorded artifacts, so rec
    // is always defined here. Two safety gates before --prune may delete:
    //   1. dest must resolve INSIDE the project - artifact keys come from a
    //      state file the kit did not author, so '../outside.md' must never
    //      reach the filesystem.
    //   2. the recorded base must be reconstructable as kit-shipped content
    //      (record-state's file-hash fallback is not) AND the project bytes
    //      must still equal that base either raw (unrendered install) or
    //      rendered with the recorded placeholders (install-time fill is a
    //      pristine kit artifact, not project customization).
    const destAbs = path.join(projectRoot, dest);
    const relDest = path.relative(projectRoot, destAbs);
    if (relDest.startsWith('..') || path.isAbsolute(relDest)) {
      row(dest, 'retired', 'state key escapes the project root - kept, fix the state file');
      return;
    }
    // Resolve the dest once: this doubles as the exists check (a dangling
    // path fails to resolve), and the RESOLVED path - not destAbs - is what
    // gets hashed and deleted, so a symlink swapped between the check and
    // the delete cannot redirect the removal outside the project (the
    // check-then-act race on the symlink itself).
    let realDest = null;
    try { realDest = fs.realpathSync(destAbs); } catch { /* absent or dangling */ }
    if (realDest === null) {
      if (ctx.prune) { delete artifacts[dest]; pctx.stateDirty = true; }
      row(dest, 'retired', ctx.prune
        ? (ctx.dryRun ? 'file absent; would prune state record (dry-run)' : 'file absent; state record pruned')
        : 'no longer managed by manifest; file already absent');
      return;
    }
    // The lexical check misses symlinks: a retired dest under a symlinked
    // directory inside the project can resolve outside it. Verify the real
    // path stays within the real project root before hashing/deleting.
    const realRoot = fs.realpathSync(projectRoot);
    const relReal = path.relative(realRoot, realDest);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
      row(dest, 'retired', 'dest resolves outside the project root via a symlink - kept');
      return;
    }
    // A symlink ALIAS inside the project is just as wrong: realDest then
    // names a different file than the recorded dest, and deleting realDest
    // removes that file while the recorded (symlinked) path survives. Only
    // a dest whose real path equals the recorded dest's real path is
    // prunable. The baseline is the REAL root + the lexical relDest - not
    // path.resolve(destAbs) - because registry paths are lexical-only and
    // may themselves pass through symlinks (/var->/private/var, junctions);
    // comparing against the lexical path would make every dest an "alias"
    // and silently disable --prune for such projects. Case-fold on Windows.
    const expectedDest = path.join(realRoot, relDest);
    const samePath = realDest === expectedDest
      || (process.platform === 'win32' && realDest.toLowerCase() === expectedDest.toLowerCase());
    if (!samePath) {
      row(dest, 'retired', 'dest resolves through a symlink to a different path - kept');
      return;
    }
    const srcAbs = rec.source ? path.join(ctx.manifestRoot, rec.source) : null;
    const baseText = srcAbs ? reconstructBase(rec, srcAbs, state.kitCommit, ctx.manifestRoot) : null;
    if (baseText === null) {
      row(dest, 'retired', 'no longer managed by manifest; recorded base not reconstructable as kit content - kept');
      return;
    }
    let localBytes = null;
    try { localBytes = fs.readFileSync(realDest); } catch { /* raced away */ }
    if (localBytes === null) {
      row(dest, 'retired', 'file vanished during the check - kept');
      return;
    }
    const localHash = sha256(localBytes);
    const renderedHash = sha256(renderTemplate(baseText, pctx.placeholders));
    if (localHash !== rec.hash && localHash !== renderedHash) {
      row(dest, 'retired', 'no longer managed by manifest; project content differs from recorded base - kept');
      return;
    }
    if (!ctx.prune) { row(dest, 'retired', 'no longer managed by manifest (unchanged; --prune removes)'); return; }
    // Delete the verified resolved path, never destAbs: if a path component
    // is a symlink that got swapped after the check, the removal still
    // targets the file that was verified inside the project.
    if (!ctx.dryRun) fs.rmSync(realDest);
    delete artifacts[dest];
    pctx.stateDirty = true;
    row(dest, 'retired', ctx.dryRun ? 'would prune (dry-run)' : 'pruned retired file at recorded base');
    return;
  }

  const destAbs = path.join(projectRoot, dest);
  const srcAbs = path.join(ctx.manifestRoot, info.src);
  const srcHash = fs.existsSync(srcAbs) ? sha256File(srcAbs) : null;

  if (!rec) {
    // A file sitting at a managed dest with no recorded base is foreign -
    // skip always (never silently overwrite).
    if (fs.existsSync(destAbs)) { row(dest, 'skip', 'unmanaged file (no recorded base)'); return; }
    // Dest absent and never recorded: the kit gained this template after the
    // project was onboarded - propagate it (re-apply semantics; nothing local
    // exists to overwrite). Agent-scoped dests (profile rulesDirs) only
    // materialize when the project registered that agent.
    if (info.agents && !(entry.agents || []).some(a => info.agents.has(a))) return;
    if (!srcHash) { row(dest, 'skip', 'kit source missing'); return; }
    const text = renderTemplate(fs.readFileSync(srcAbs, 'utf8'), pctx.placeholders);
    pctx.writeFile(destAbs, text);
    artifacts[dest] = { hash: srcHash, source: info.src, syncedAt: pctx.now, kitCommit: ctx.kitCommit };
    pctx.stateDirty = true;
    row(dest, 'fast-forward', needsFillSuffix('new managed file', text));
    return;
  }
  if (!fs.existsSync(destAbs)) {
    if (ctx.restoreDeleted && srcHash) {
      const text = renderTemplate(fs.readFileSync(srcAbs, 'utf8'), pctx.placeholders);
      pctx.writeFile(destAbs, text);
      rec.hash = srcHash; rec.kitCommit = ctx.kitCommit; rec.syncedAt = pctx.now; pctx.stateDirty = true;
      row(dest, 'fast-forward', 'restored deleted file');
    } else {
      row(dest, 'skip', 'deleted by project');
    }
    return;
  }
  if (!srcHash) { row(dest, 'retired', 'kit source removed'); return; }

  const localHash = sha256File(destAbs);
  if (localHash === srcHash) {
    // Already at current kit content (covers both-unchanged and a project
    // that converged to the kit version on its own) - just refresh the base.
    if (rec.hash !== srcHash) { rec.hash = srcHash; rec.kitCommit = ctx.kitCommit; rec.syncedAt = pctx.now; pctx.stateDirty = true; }
    pctx.unresolved.delete(dest);
    return;
  }
  if (localHash === rec.hash) {
    // Project untouched since the recording -> fast-forward to new kit bytes.
    const newText = renderTemplate(fs.readFileSync(srcAbs, 'utf8'), pctx.placeholders);
    pctx.writeFile(destAbs, newText);
    rec.hash = srcHash; rec.kitCommit = ctx.kitCommit; rec.syncedAt = pctx.now; pctx.stateDirty = true;
    pctx.unresolved.delete(dest);
    row(dest, 'fast-forward', needsFillSuffix('applied kit update', newText));
    return;
  }

  // Lingering markers from a previous conflicted merge are a live conflict.
  // This check MUST precede the kit-unchanged early return: the conflicted
  // run already advanced rec.hash to srcHash, so srcHash === rec.hash would
  // otherwise mask the markers as a harmless 'project-only' (exit 0).
  const localText = fs.readFileSync(destAbs, 'utf8');
  const marked = CONFLICT_MARKER_RE.test(localText);
  if (marked) {
    // A marked file is always a conflict until a human resolves it -
    // including under --force. Markers are ours-side content no merge can
    // strip, so a forced re-merge could only nest more markers; and with the
    // kit unchanged this is where r1's bug lived (srcHash === rec.hash
    // masking the file as 'project-only', exit 0 while markers remained).
    row(dest, 'conflict', 'unresolved conflict markers (resolve them, then re-run sync)');
    pctx.unresolved.add(dest); pctx.stateDirty = true;
    return;
  }
  if (srcHash === rec.hash) {
    row(dest, 'project-only', 'kit unchanged; local edits kept (skipped write)');
    return;
  }

  // Both sides changed -> three-way merge.
  const baseText = reconstructBase(rec, srcAbs, state.kitCommit, ctx.manifestRoot);
  if (baseText === null) {
    row(dest, 'skip', 'recorded base unreconstructable; kept local');
    return;
  }
  const eol = localText.includes('\r\n') ? '\r\n' : '\n';
  const { text: mergedText, conflicts } = merge3(
    renderTemplate(baseText, pctx.placeholders),
    localText,
    renderTemplate(fs.readFileSync(srcAbs, 'utf8'), pctx.placeholders),
    {
      ours: 'project',
      base: `kit base ${String(rec.kitCommit || state.kitCommit || 'unknown').slice(0, 7)}`,
      theirs: `kit v${ctx.manifest.version || 'unknown'}`,
      eol,
    },
  );
  rec.hash = srcHash; rec.kitCommit = ctx.kitCommit; rec.syncedAt = pctx.now; pctx.stateDirty = true;
  // Old markers embedded in ours flow through the merge as content - the
  // file is only clean when the OUTPUT carries no marker lines.
  const stillMarked = CONFLICT_MARKER_RE.test(mergedText);
  if (conflicts === 0 && mergedText === localText) {
    if (stillMarked) {
      pctx.unresolved.add(dest);
      row(dest, 'conflict', 'conflict markers remain in file (resolve them manually)');
      return;
    }
    pctx.unresolved.delete(dest);
    row(dest, 'project-only', 'already contains kit changes; kept local');
    return;
  }
  pctx.writeFile(destAbs, mergedText);
  if (conflicts > 0 || stillMarked) {
    pctx.unresolved.add(dest);
    row(dest, 'conflict', conflicts > 0
      ? `${conflicts} conflict region(s) - markers written${ctx.dryRun ? ' (dry-run; nothing written)' : ''}`
      : 'conflict markers remain in file (resolve them manually)');
  } else {
    pctx.unresolved.delete(dest);
    row(dest, 'merged', needsFillSuffix('merged kit update around local edits', mergedText));
  }
}

/**
 * Managed-key sync for one agent config file (MCP servers and/or hooks).
 *
 * Per manifest key (mcpServers.<name>, hook event):
 *   installed == recorded base -> apply the kit entry (follows the kit)
 *   installed != base          -> customized: preserve, publish the kit's
 *     proposal via <config>.kit-incoming.json, report conflict
 *   absent + base existed      -> project deleted a managed key: leave absent
 *   absent + no base           -> add (scaffold parity)
 *   no base at all             -> skip-always (legacy/foreign entries)
 *
 * Project-added keys inside managed containers are reported project-only
 * and never touched. No markers are ever written into JSON.
 *
 * @param {object} pctx Project sync context.
 * @param {string} cfgRel Project-relative config path.
 * @param {object} cfgPlan {mcpKey, hooksFormat, agents:Set, source}.
 */
export function syncConfigFile(pctx, cfgRel, cfgPlan) {
  const { ctx, projectRoot, entry, artifacts, row, skipSet, pins } = pctx;
  const rec = artifacts[cfgRel];
  const cfgAbs = path.join(projectRoot, cfgRel);

  // Relevant only when the file was recorded or its agent is registered -
  // never create config files for agents the project does not use.
  const agentRelevant = [...cfgPlan.agents].some(a => (entry.agents || []).includes(a));
  if (!rec && !agentRelevant) return;
  if (pins[cfgRel] !== undefined) { row(cfgRel, 'skip', `pinned: ${pins[cfgRel]}`); return; }
  if (skipSet.has(cfgRel)) { row(cfgRel, 'skip', 'exempt: overrides.skip'); return; }

  const fileExists = fs.existsSync(cfgAbs);
  if (!fileExists && rec && !ctx.restoreDeleted) {
    row(cfgRel, 'skip', 'deleted by project');
    return;
  }
  let cfgData = {};
  if (fileExists) {
    try { cfgData = readJson(cfgAbs); } catch {
      row(cfgRel, 'skip', 'invalid JSON; left untouched');
      return;
    }
    if (!isObject(cfgData)) { row(cfgRel, 'skip', 'non-object JSON; left untouched'); return; }
  }

  const prep = prepareConfig(pctx, cfgRel, cfgPlan, rec);
  let changed = false;
  const proposals = {};
  for (const k of prep.keys) {
    const keyId = k.keyId;
    if (k.deferred) { row(keyId, 'skip', k.skipDetail); continue; }
    const baseEntry = k.baseEntry;

    const installed = getPath(cfgData, k.pathArr);
    const hasBase = baseEntry !== undefined;
    if (installed === undefined) {
      // A managed key missing from an EXISTING file means the project deleted
      // it - leave it absent unless --restore-deleted. A missing file just
      // gets every managed key added (scaffold add-missing parity). On an
      // adoption run absence means "never installed" - the recorded base was
      // just established, nothing was deleted - so the key is added.
      if (fileExists && hasBase && !ctx.restoreDeleted && !pctx.adopted) {
        row(keyId, 'skip', 'managed key deleted by project');
      } else {
        setPath(cfgData, k.pathArr, k.newEntry); changed = true;
        row(keyId, 'fast-forward', fileExists && hasBase ? 'restored deleted managed key' : 'added managed key');
      }
      continue;
    }
    const instC = canon(installed);
    const newC = canon(k.newEntry);
    if (instC === newC) continue; // already at kit state
    if (hasBase && instC === canon(baseEntry)) {
      setPath(cfgData, k.pathArr, k.newEntry); changed = true;
      row(keyId, 'fast-forward', 'kit update applied');
      continue;
    }
    if (!hasBase) {
      row(keyId, 'skip', 'no recorded base (customized or foreign entry); preserved');
      continue;
    }
    // Customized by the project AND changed by the kit -> preserve local,
    // publish the kit's proposal via the sidecar (JSON must stay valid).
    proposals[k.reportKey] = k.newEntry;
    row(keyId, 'conflict', `customized entry preserved; kit proposal -> ${cfgRel}.kit-incoming.json`);
  }

  // Report project-added keys inside managed containers (untouched).
  if (cfgPlan.mcpKey && isObject(cfgData[cfgPlan.mcpKey])) {
    for (const name of Object.keys(cfgData[cfgPlan.mcpKey])) {
      if (!prep.manifestServers.has(name)) {
        row(`${cfgRel}:${cfgPlan.mcpKey}.${name}`, 'project-only', 'project-added entry; untouched');
      }
    }
  }
  if (cfgPlan.hooksFormat) {
    const hooksRoot = cfgPlan.hooksFormat === 'nested' ? cfgData.hooks : cfgData;
    if (isObject(hooksRoot)) {
      for (const event of Object.keys(hooksRoot)) {
        if (!prep.manifestEvents.has(event)) {
          const prefix = cfgPlan.hooksFormat === 'nested' ? 'hooks.' : '';
          row(`${cfgRel}:${prefix}${event}`, 'project-only', 'project-added hook event; untouched');
        }
      }
    }
  }

  // Sidecar: aggregate outstanding kit proposals per managed key. Upsert new
  // proposals, drop keys that were resolved or left the manifest, and delete
  // the file when emptied (research decision Q4).
  const sidecarAbs = `${cfgAbs}.kit-incoming.json`;
  let sidecar = {};
  if (fs.existsSync(sidecarAbs)) {
    try { sidecar = readJson(sidecarAbs); } catch { sidecar = {}; }
    if (!isObject(sidecar)) sidecar = {};
  }
  for (const key of Object.keys(sidecar)) {
    const pathArr = prep.keyPaths.get(key);
    const installed = pathArr ? getPath(cfgData, pathArr) : undefined;
    if (!pathArr || (installed !== undefined && canon(installed) === canon(sidecar[key]))) {
      delete sidecar[key];
    }
  }
  Object.assign(sidecar, proposals);
  if (Object.keys(sidecar).length) pctx.writeJson(sidecarAbs, sidecar);
  else if (fs.existsSync(sidecarAbs) && !ctx.dryRun) fs.rmSync(sidecarAbs, { force: true });

  commitConfig(pctx, cfgRel, cfgPlan, rec, cfgData, prep, changed);
}

/**
 * Enumerate managed keys for a config path and resolve each key's effective
 * base entry. The base manifest is read at THIS FILE's recorded commit
 * (rec.kitCommit) - or a per-key override commit for keys frozen while
 * pinned/exempt - never the global state.kitCommit, which may have advanced
 * while this config was skipped and would misclassify unchanged entries.
 * Deferred (pinned/exempt) keys still get a resolved base so callers can
 * inspect it; they are flagged via `deferred`/`deferredKeys`.
 *
 * @param {object} pctx Project sync context.
 * @param {string} cfgRel Project-relative config path.
 * @param {object} cfgPlan {mcpKey, hooksFormat, agents:Set, source}.
 * @param {object|undefined} rec artifacts[cfgRel] record.
 * @returns {{keys: object[], keyPaths: Map, manifestServers: Set,
 *   manifestEvents: Set, baseManifest: object|null, prevFileBase: string,
 *   deferredKeys: Set, effCommit: Function}}
 */
export function prepareConfig(pctx, cfgRel, cfgPlan, rec) {
  const { ctx, state, skipSet, pins } = pctx;
  const manifest = ctx.manifest;
  const baseManifest = pctx.baseManifestAt(rec?.kitCommit);

  // Per-key effective base commits. rec.kitCommit is the file-level base;
  // rec.keyCommits[keyId] overrides it for keys whose base was established at
  // a different commit - a deferred (pinned/exempt) key freezes at the commit
  // it was last resolved from, and a resolved key tracks this run's commit.
  // Entries equal to the file-level commit are dropped (redundant).
  const keyCommits = { ...(rec?.keyCommits || {}) };
  const prevFileBase = (rec?.kitCommit && rec.kitCommit !== 'unknown')
    ? rec.kitCommit : state.kitCommit;
  const effCommit = keyId => keyCommits[keyId] ?? prevFileBase;

  const keys = []; // {keyId, reportKey, pathArr, newEntry, baseEntry?, kind, keyName, baseCommit?}
  const manifestServers = new Set();
  const manifestEvents = new Set();
  const push = (reportKey, pathArr, newEntry, baseEntry, kind, keyName) => {
    keys.push({
      keyId: `${cfgRel}:${reportKey}`,
      reportKey, pathArr, newEntry, baseEntry, kind, keyName,
    });
  };
  if (cfgPlan.mcpKey) {
    const baseServers = new Map((baseManifest?.mcpServers || []).map(s => [s.name, s.config]));
    for (const s of manifest.mcpServers || []) {
      manifestServers.add(s.name);
      push(`${cfgPlan.mcpKey}.${s.name}`, [cfgPlan.mcpKey, s.name], s.config,
        baseServers.has(s.name) ? baseServers.get(s.name) : undefined, 'mcp', s.name);
    }
  }
  if (cfgPlan.hooksFormat) {
    const prefix = cfgPlan.hooksFormat === 'nested' ? ['hooks'] : [];
    const grouped = groupHooksByEvent(manifest.hooks);
    const baseGrouped = groupHooksByEvent(baseManifest?.hooks);
    for (const [event, arr] of Object.entries(grouped)) {
      manifestEvents.add(event);
      push([...prefix, event].join('.'), [...prefix, event], arr,
        baseGrouped[event], 'hook', event);
    }
  }

  const deferredKeys = new Set();
  for (const k of keys) {
    if (pins[k.keyId] !== undefined) {
      k.deferred = true; k.skipDetail = `pinned: ${pins[k.keyId]}`; deferredKeys.add(k.keyId);
      continue;
    }
    if (skipSet.has(k.keyId)) {
      k.deferred = true; k.skipDetail = 'exempt: overrides.skip'; deferredKeys.add(k.keyId);
      continue;
    }
    // The effective base BEFORE the key is marked resolved - a key released
    // from a pin must still evaluate against its frozen base commit.
    k.baseCommit = effCommit(k.keyId);
    if (k.baseCommit !== prevFileBase) {
      const om = pctx.baseManifestAt(k.baseCommit);
      k.baseEntry = k.kind === 'mcp'
        ? (om?.mcpServers || []).find(s => s.name === k.keyName)?.config
        : groupHooksByEvent(om?.hooks)[k.keyName];
    }
  }

  return {
    keys,
    keyPaths: new Map(keys.map(k => [k.reportKey, k.pathArr])),
    manifestServers,
    manifestEvents,
    baseManifest,
    prevFileBase,
    deferredKeys,
    effCommit,
  };
}

/**
 * Persist a managed-key config result: write the file (when changed) and
 * refresh the artifact record with the per-key base-commit bookkeeping.
 * Shared by syncConfigFile and the applyDisposition 'kit' path in
 * sync-engine.mjs - the file-level kitCommit advances only when every
 * managed key was evaluated at it; deferred keys keep frozen effective
 * bases via keyCommits overrides.
 *
 * @param {object} pctx Project sync context.
 * @param {string} cfgRel Project-relative config path.
 * @param {object} cfgPlan Config plan entry.
 * @param {object|undefined} rec Prior artifacts[cfgRel] record.
 * @param {object} cfgData Final file content (already mutated).
 * @param {object} prep Result of prepareConfig.
 * @param {boolean} changed Whether cfgData was mutated.
 */
export function commitConfig(pctx, cfgRel, cfgPlan, rec, cfgData, prep, changed) {
  const { ctx, artifacts } = pctx;
  const cfgAbs = path.join(pctx.projectRoot, cfgRel);

  // File-level commit advances only when every managed key was evaluated at
  // it: a write (fast-forward/add/restore) or a run with no deferred keys.
  // Deferred keys keep frozen effective bases via keyCommits overrides.
  const advanceFile = changed || prep.deferredKeys.size === 0;
  const newFileCommit = (advanceFile && ctx.kitCommit !== 'unknown')
    ? ctx.kitCommit : prep.prevFileBase;
  const oldKC = rec?.keyCommits || {};
  const keyCommitsOut = {};
  const managedIds = new Set(prep.keys.map(k => k.keyId));
  // Carry overrides for keys absent from the current manifest: a temporarily
  // removed key keeps its recorded base so it can be reconciled on re-add.
  for (const [kId, c] of Object.entries(oldKC)) {
    if (!managedIds.has(kId) && c && c !== 'unknown' && c !== newFileCommit) {
      keyCommitsOut[kId] = c;
    }
  }
  // A key whose base was recorded at the FILE level (no override) loses that
  // base if the file commit advances while the key is absent - freeze it via
  // an explicit override so a later re-add is not reported "no recorded base".
  const absentIds = new Set();
  if (cfgPlan.mcpKey) {
    for (const s of prep.baseManifest?.mcpServers || []) {
      absentIds.add(`${cfgRel}:${cfgPlan.mcpKey}.${s.name}`);
    }
  }
  if (cfgPlan.hooksFormat) {
    const prefix = cfgPlan.hooksFormat === 'nested' ? ['hooks'] : [];
    for (const event of Object.keys(groupHooksByEvent(prep.baseManifest?.hooks))) {
      absentIds.add(`${cfgRel}:${[...prefix, event].join('.')}`);
    }
  }
  for (const kId of absentIds) {
    if (!managedIds.has(kId) && !(kId in keyCommitsOut)
        && prep.prevFileBase && prep.prevFileBase !== 'unknown' && prep.prevFileBase !== newFileCommit) {
      keyCommitsOut[kId] = prep.prevFileBase;
    }
  }
  for (const k of prep.keys) {
    const c = prep.deferredKeys.has(k.keyId) ? prep.effCommit(k.keyId) : ctx.kitCommit;
    if (c && c !== 'unknown' && c !== newFileCommit) keyCommitsOut[k.keyId] = c;
  }
  const sameKC = Object.keys(keyCommitsOut).length === Object.keys(oldKC).length
    && Object.entries(keyCommitsOut).every(([k, v]) => oldKC[k] === v);

  if (changed) pctx.writeJson(cfgAbs, cfgData);
  if (!ctx.dryRun && fs.existsSync(cfgAbs)
      && (changed || !rec || prep.prevFileBase !== newFileCommit || !sameKC)) {
    const recOut = {
      ...(rec || {}),
      hash: sha256File(cfgAbs),
      source: rec?.source || cfgPlan.source,
      syncedAt: pctx.now,
      kitCommit: newFileCommit,
    };
    if (Object.keys(keyCommitsOut).length) recOut.keyCommits = keyCommitsOut;
    else delete recOut.keyCommits;
    artifacts[cfgRel] = recOut;
    pctx.stateDirty = true;
  }
}
