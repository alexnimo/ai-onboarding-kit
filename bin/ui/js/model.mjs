/**
 * model.mjs - pure view-model for the sync SPA (no DOM, no fetch). Plan
 * grouping, disposition defaults, apply gating, route parsing. Unit-tested
 * in tests/sync-spa-model.test.mjs.
 *
 * Plan rows come from POST /api/dry-run: {artifact, action, detail?, diff?}.
 * artifact is either a project-relative dest or `<dest>: <configKey>`; a
 * disposition is per dest (file), so rows are grouped by dest here.
 */

/** Actions that carry a disposition; skip/retired rows are informational. */
export const ACTIONABLE = new Set(['fast-forward', 'merged', 'conflict', 'injected', 'migrated',
  'create', 'inject-region', 'merge-keys', 'append-import', 'register',
  'install-skill', 'update-skill', 'copy-skill']);

const SEVERITY = { conflict: 4, merged: 3, 'inject-region': 3, 'merge-keys': 3, 'fast-forward': 2, create: 2, injected: 2, migrated: 2, 'append-import': 2, 'install-skill': 2, 'update-skill': 2, 'copy-skill': 2, register: 1, retired: 1, 'region-removed': 1, 'missing-skill': 1, 'exists-skip': 0, skip: 0 };

/** @param {string} artifact Plan row artifact. @returns {string} dest. */
export function destOf(artifact) {
  return artifact.split(':')[0];
}

/**
 * Group plan rows by dest. File action = most severe row action. The
 * `(project)` pseudo-row is excluded (the view reports it separately).
 *
 * @param {{artifact: string, action: string, detail?: string, diff?: string}[]} rows
 * @returns {{dest: string, action: string, actionable: boolean, rows: object[]}[]}
 */
export function groupPlan(rows) {
  const files = new Map();
  for (const row of rows) {
    if (row.artifact === '(project)') continue;
    const dest = destOf(row.artifact);
    let file = files.get(dest);
    if (!file) {
      file = { dest, action: 'skip', rows: [] };
      files.set(dest, file);
    }
    file.rows.push(row);
    if ((SEVERITY[row.action] ?? 0) > (SEVERITY[file.action] ?? 0)) {
      file.action = row.action;
    }
  }
  return [...files.values()].map(f => ({ ...f, actionable: ACTIONABLE.has(f.action) }));
}

/**
 * Default disposition: fast-forward and merged rows default to accepted;
 * conflicts have NO default (operator must choose).
 *
 * @param {{action: string, actionable: boolean}} file
 * @returns {'accepted'|null}
 */
export function defaultDisposition(file) {
  if (!file.actionable || file.action === 'conflict') return null;
  return 'accepted';
}

/**
 * @param {object[]} files Grouped files.
 * @returns {Record<string, 'accepted'|'reverted'|'kit'>} dest -> disposition.
 */
export function initialDispositions(files) {
  const disp = {};
  for (const file of files) {
    const d = defaultDisposition(file);
    if (d) disp[file.dest] = d;
  }
  return disp;
}

/**
 * @param {object[]} files Grouped files.
 * @param {Record<string, string>} disp Current dispositions.
 * @returns {object[]} Conflict files still lacking a disposition.
 */
export function unresolvedConflicts(files, disp) {
  return files.filter(f => f.actionable && f.action === 'conflict' && !disp[f.dest]);
}

/**
 * Apply gate. Blocked when nothing is actionable, or any conflict file has no
 * disposition. Non-conflict actionable files always carry a default.
 *
 * @param {object[]} files Grouped files.
 * @param {Record<string, string>} disp Current dispositions.
 * @returns {{ok: boolean, reason: 'nothing-to-apply'|'unresolved-conflicts'|null, files: object[]}}
 */
export function applyGate(files, disp) {
  if (!files.some(f => f.actionable)) {
    return { ok: false, reason: 'nothing-to-apply', files: [] };
  }
  const missing = unresolvedConflicts(files, disp);
  if (missing.length) {
    return { ok: false, reason: 'unresolved-conflicts', files: missing };
  }
  return { ok: true, reason: null, files: [] };
}

/**
 * Request body for POST /api/plans/:id/apply: one entry per actionable dest.
 * Only valid after applyGate().ok.
 *
 * @param {object[]} files Grouped files.
 * @param {Record<string, string>} disp Current dispositions.
 * @returns {Record<string, string>} dest -> disposition.
 */
export function buildPayload(files, disp) {
  const payload = {};
  for (const file of files) {
    if (!file.actionable) continue;
    const d = disp[file.dest];
    if (!d) throw new Error(`no disposition for ${file.dest}`);
    payload[file.dest] = d;
  }
  return payload;
}

/**
 * Counts of actionable files per disposition.
 *
 * @param {object[]} files Grouped files.
 * @param {Record<string, string>} disp Current dispositions.
 * @returns {{accepted: number, reverted: number, kit: number, total: number}}
 */
export function tallyDispositions(files, disp) {
  const out = { accepted: 0, reverted: 0, kit: 0, total: 0 };
  for (const file of files) {
    if (!file.actionable) continue;
    out.total++;
    const d = disp[file.dest];
    if (d) out[d]++;
  }
  return out;
}

/**
 * Per-action file counts (file-level, not row-level).
 *
 * @param {object[]} files Grouped files.
 * @returns {Record<string, number>} action -> count.
 */
export function countByAction(files) {
  const out = {};
  for (const file of files) out[file.action] = (out[file.action] || 0) + 1;
  return out;
}

/**
 * Per-disposition counts from apply results (ok entries only).
 *
 * @param {{dest: string, disposition: string, ok: boolean}[]} results
 * @returns {{accepted: number, reverted: number, kit: number, failed: number}}
 */
export function resultCounts(results) {
  const out = { accepted: 0, reverted: 0, kit: 0, failed: 0 };
  for (const r of results || []) {
    if (!r.ok) out.failed++;
    else if (out[r.disposition] !== undefined) out[r.disposition]++;
  }
  return out;
}

/**
 * Badge text + tone for a lastSyncResult (apply shape or CLI shape).
 *
 * @param {object|null} res
 * @returns {{tone: 'ok'|'conflict'|'neutral', label: string}}
 */
export function describeLastResult(res) {
  if (!res) return { tone: 'neutral', label: 'Never synced' };
  if (Array.isArray(res.accepted)) {
    const a = res.accepted.length;
    const r = res.reverted?.length ?? 0;
    const k = res.kit?.length ?? 0;
    const failed = res.errors ?? 0;
    const label = `${a} accepted, ${r} reverted, ${k} kit`
      + (failed ? `, ${failed} failed` : '');
    return { tone: failed ? 'conflict' : 'ok', label };
  }
  const conflicts = res.conflicts ?? 0;
  if (conflicts) {
    return { tone: 'conflict', label: `${conflicts} conflict${conflicts === 1 ? '' : 's'}` };
  }
  return { tone: 'ok', label: `Synced, ${res.actions ?? 0} actions` };
}

/**
 * Hash route -> view. Unknown or incomplete routes fall back to dashboard.
 *   #/                        overview dashboard + doctor
 *   #/sync?path=<project>     dry-run classify + apply
 *   #/history?path=<project>  past syncs
 *   #/project?path=<project>  project detail (agents, MCP, skills, profiles)
 *   #/profiles                specialist profile management
 *   #/skills                  skill/CLI/MCP catalog + install
 *
 * @param {string} hash location.hash
 * @returns {{name: 'dashboard'|'profiles'|'skills'}
 *   |{name: 'sync'|'history'|'project', path: string}
 *   |{name: 'onboard', plan: string}}
 */
export function parseRoute(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const qi = raw.indexOf('?');
  const seg = (qi === -1 ? raw : raw.slice(0, qi)).replace(/^\/+|\/+$/g, '');
  const params = new URLSearchParams(qi === -1 ? '' : raw.slice(qi + 1));
  const project = params.get('path');
  if (seg === 'profiles') return { name: 'profiles' };
  if (seg === 'skills') return { name: 'skills' };
  if ((seg === 'sync' || seg === 'history' || seg === 'project') && project) {
    return { name: seg, path: project };
  }
  if (seg === 'onboard' && params.get('plan')) {
    return { name: 'onboard', plan: params.get('plan') };
  }
  return { name: 'dashboard' };
}
