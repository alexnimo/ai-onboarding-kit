/**
 * sync.mjs - the sync engine: re-apply the current kit to registered projects
 * using three-way merge against the recorded install base. Node >=18, stdlib.
 *
 *   node bin/onboard.mjs sync [--project NAME] [--dry-run] [--force] [--json]
 *                             [--update-skills] [--install-skills] [--adopt]
 *                             [--prune] [--restore-deleted] [--manifest <path>]
 *
 * Per managed file (state = <project>/.agents/onboarding-state.json, where
 * artifacts[dest].hash is the sha256 of the kit template AS INSTALLED, i.e.
 * pre-placeholder-fill):
 *   - project file == recorded base  -> fast-forward to new kit content
 *   - kit template == recorded base  -> project-only (local edits kept)
 *   - both changed                   -> diff3 merge (base = kit template at
 *     state.kitCommit, reconstructed via `git show`, placeholders unfilled);
 *     unresolved hunks get git-diff3 markers and the file is left for a human
 *   - no recorded base               -> skip always (foreign files)
 *
 * MCP/hooks configs merge per managed KEY (mcpServers.<name> / hook event):
 * the base is the manifest entry at state.kitCommit. Entries equal to base
 * follow the kit; customized entries are preserved and proposed in a
 * <config>.kit-incoming.json sidecar - never inline-merged (markers would
 * corrupt JSON).
 *
 * Report actions: fast-forward | merged | conflict | skip | project-only |
 * unadopted | retired | adopted. Exit 2 when any conflict, else 0.
 */

import path from 'node:path';
import {
  readJson,
  loadRegistry,
  updateRegistry,
  resolveManifestPath,
  getKitCommit,
} from './common.mjs';
import { buildManagedPlan } from './sync-utils.mjs';
import { syncSkills } from './sync-skills.mjs';
import { openProject, syncDests, finalizeProject } from './sync-engine.mjs';

/** All actions a report row can carry. */
export const ACTIONS = new Set([
  'fast-forward', 'merged', 'conflict', 'skip', 'project-only',
  'unadopted', 'retired', 'adopted',
  'injected', 'region-removed', 'migrated', // region lifecycle (spec: managed regions)
]);

/**
 * Sync a single registered project.
 *
 * @param {object} entry Registry entry {name, path, agents, overrides}.
 * @param {object} ctx Sync context {manifest, manifestRoot, plan, flags...}.
 * @returns {object} Project report {name,path,status,files,skills,conflictCount,synced}.
 */
function syncProject(entry, ctx) {
  const { pr, pctx } = openProject(entry, ctx);
  if (!pctx) return pr;

  syncDests(pctx);
  pr.skills = syncSkills(pctx);
  finalizeProject(pctx);
  return pr;
}
// ---------- report ----------

/**
 * Print the human-readable sync report.
 *
 * @param {object} report Assembled report object.
 */
function printHuman(report) {
  const lines = [];
  lines.push(`=== Sync report (kit v${report.kitVersion}${report.dryRun ? ', dry-run' : ''}) ===`);
  lines.push('');
  for (const p of report.projects) {
    const statusNote = p.status === 'ok' ? '' : ` [${p.status}]`;
    lines.push(`${p.name} - ${p.path}${statusNote}`);
    if (!p.files.length) {
      lines.push('  (no actions)');
    } else {
      const w = Math.max(...p.files.map(f => f.artifact.length), 8);
      const wa = Math.max(...p.files.map(f => f.action.length), 6);
      for (const f of p.files) {
        lines.push(`  ${f.artifact.padEnd(w)}  ${f.action.padEnd(wa)}  ${f.detail}`);
      }
    }
    if (p.skills.length) {
      const counts = {};
      for (const s of p.skills) counts[s.status] = (counts[s.status] || 0) + 1;
      const missing = p.skills.filter(s => s.status === 'missing').map(s => s.name);
      lines.push(`  skills: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
    }
    lines.push('');
  }
  const parts = Object.entries(report.summary.byAction).filter(([, n]) => n > 0);
  lines.push(`Summary: ${parts.length ? parts.map(([k, n]) => `${n} ${k}`).join(', ') : 'no actions'} across ${report.projects.length} project(s)`);
  lines.push(`Exit code: ${report.exitCode}${report.exitCode === 2 ? ' (conflicts require resolution)' : ''}`);
  console.log(lines.join('\n'));
}

// ---------- command ----------

/**
 * sync [--project NAME] [--dry-run] [--force] [--json] [--update-skills]
 *       [--install-skills] [--adopt] [--prune] [--restore-deleted]
 *       [--manifest <path>]
 *
 * Walk all (or one) registered projects and re-apply the current kit with
 * three-way merge logic against the recorded base. Exit 2 on conflicts.
 * --adopt baselines projects with no state file (config artifacts only -
 * templates/rules stay project-owned). --prune deletes retired dests whose
 * project bytes still equal the recorded base.
 *
 * @param {Record<string, *>} opts Parsed flags.
 */
export function commandSync(opts) {
  if (opts.project === true) throw new Error('Missing value for --project <name|path>');

  const ctx = {
    dryRun: !!opts['dry-run'],
    force: !!opts.force,
    updateSkills: !!opts['update-skills'],
    installSkills: !!opts['install-skills'],
    adopt: !!opts.adopt,
    prune: !!opts.prune,
    restoreDeleted: !!opts['restore-deleted'],
  };
  const asJson = !!opts.json;

  ctx.manifestPath = resolveManifestPath(opts.manifest);
  ctx.manifestRoot = path.dirname(ctx.manifestPath);
  ctx.manifest = readJson(ctx.manifestPath);
  ctx.plan = buildManagedPlan(ctx.manifest);
  ctx.kitCommit = getKitCommit(); // kit HEAD this sync runs against (per-artifact base)

  const reg = loadRegistry();
  let projects = reg.projects;
  if (opts.project !== undefined) {
    const sel = String(opts.project);
    // Name-scoped selector: exact name match only; fall back to an exact
    // resolved-path match when no project claims the name. Never match by
    // basename - two projects can share a directory name.
    projects = projects.filter(e => e.name === sel);
    if (!projects.length) {
      const resolved = path.resolve(sel);
      projects = reg.projects.filter(e => e.path === resolved);
    }
    if (!projects.length) {
      throw new Error(`No registered project matches --project ${sel}`);
    }
  }

  const report = {
    kitVersion: ctx.manifest.version || 'unknown',
    manifest: ctx.manifestPath,
    dryRun: ctx.dryRun,
    startedAt: new Date().toISOString(),
    projects: [],
  };

  const syncedPaths = [];
  for (const entry of projects) {
    const pr = syncProject(entry, ctx);
    report.projects.push(pr);
    if (pr.synced) syncedPaths.push(entry.path);
  }

  if (!ctx.dryRun && syncedPaths.length) {
    const at = report.startedAt;
    const set = new Set(syncedPaths);
    updateRegistry(reg2 => {
      for (const e of reg2.projects) if (set.has(e.path)) e.lastSyncAt = at;
    });
  }

  const byAction = {};
  const actions = [];
  for (const p of report.projects) {
    for (const f of p.files) {
      byAction[f.action] = (byAction[f.action] || 0) + 1;
      actions.push({ project: p.name, artifact: f.artifact, action: f.action, detail: f.detail });
    }
  }
  const totalConflicts = report.projects.reduce((n, p) => n + p.conflictCount, 0);
  report.actions = actions;
  report.summary = { total: actions.length, byAction };
  report.exitCode = totalConflicts > 0 ? 2 : 0;

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
  process.exitCode = report.exitCode;
}

// Exported for tests.
export { syncProject };
