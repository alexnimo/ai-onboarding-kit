/**
 * doctor.mjs - fleet health check for registered projects (T4 governance).
 * Node >=18, stdlib only.
 *
 *   node bin/onboard.mjs doctor [--project NAME] [--json] [--stale-days N]
 *
 * Per project, read-only:
 *   - path exists                        -> error: suggests register --remove
 *   - state file present/parses          -> error: suggests sync --adopt
 *   - state.kitCommit exists in kit repo -> warn (bases unreconstructable)
 *   - drift vs current kit (dry-run sync): project-only / kit-ahead /
 *     would-be-conflict counts; retired artifacts -> warn: sync --prune;
 *     project-deleted managed files/keys -> error
 *   - skills per the scaffold 5-location check: missing required -> warn;
 *     missing optional -> informational
 *   - overrides (skip/pins) referencing nonexistent paths -> warn
 *   - staleness: lastSyncAt older than --stale-days (default 30) -> warn:
 *     run sync
 *
 * Exit 3 when any project reports a finding (error or warning), 0 clean.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  KIT_ROOT,
  STATE_REL_PATH,
  readJson,
  loadRegistry,
  resolveManifestPath,
  getKitCommit,
} from './common.mjs';
import { isObject, buildManagedPlan } from './sync-utils.mjs';
import { syncProject } from './sync.mjs';

/** Default staleness window in days (lastSyncAt older -> finding). */
const DEFAULT_STALE_DAYS = 30;

/**
 * True when `commit` is a commit object reachable in the kit repo.
 *
 * @param {string} commit Commit-ish.
 * @returns {boolean}
 */
function kitCommitExists(commit) {
  // kitCommit is state-file controlled (untrusted): only a hex sha shape is
  // ever a valid commit, so anything else fails the check without ever
  // reaching git (and can never be parsed as an option).
  if (!commit || commit === 'unknown' || !/^[0-9a-f]{4,64}$/i.test(String(commit))) {
    return false;
  }
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`, '--end-of-options'], {
      cwd: KIT_ROOT,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the project-relative path an override references. Pin/skip entries
 * may be whole paths (AGENTS.md) or managed key ids (<path>:<dotted.key>) -
 * the key id's path component is everything before the first ':'.
 *
 * @param {string} ref Override key.
 * @returns {string} Project-relative path to probe.
 */
function overridePath(ref) {
  const i = ref.indexOf(':');
  return i === -1 ? ref : ref.slice(0, i);
}

/**
 * Classify a dry-run sync row into drift counters / findings.
 *
 * @param {object} f Row {artifact, action, detail}.
 * @param {object} drift Counters to increment.
 * @param {Array} findings Finding sink.
 * @param {string} projectName For finding context.
 */
function classifyRow(f, drift, findings) {
  if (f.action === 'project-only') drift.projectOnly++;
  else if (f.action === 'fast-forward' || f.action === 'merged') drift.kitAhead++;
  else if (f.action === 'conflict') {
    drift.wouldBeConflicts++;
    findings.push({
      level: 'error',
      check: 'drift',
      message: `${f.artifact}: ${f.detail}`,
      suggestion: 'run sync, resolve the markers/proposals, then re-sync',
    });
  } else if (f.action === 'retired') {
    drift.retired++;
    findings.push({
      level: 'warn',
      check: 'retired',
      message: `${f.artifact}: ${f.detail}`,
      suggestion: 'run sync --prune to remove pristine retired files',
    });
  } else if (f.action === 'skip'
    && (f.detail === 'deleted by project'
      || f.detail === 'managed key deleted by project'
      || f.detail === 'invalid JSON; left untouched')) {
    findings.push({
      level: 'error',
      check: 'managed-content',
      message: `${f.artifact}: ${f.detail}`,
      suggestion: 'restore the file/key (sync --restore-deleted) or drop its state entry',
    });
  }
}

/**
 * Health-check one registered project.
 *
 * @param {object} entry Registry entry {name, path, agents, lastSyncAt, overrides}.
 * @param {object} ctx {manifest, manifestPath, plan, kitCommit, staleDays}.
 * @returns {object} Project report.
 */
export function checkProject(entry, ctx) {
  const projectRoot = entry.path;
  const pr = {
    name: entry.name || path.basename(projectRoot),
    path: projectRoot,
    findings: [],
    drift: { projectOnly: 0, kitAhead: 0, wouldBeConflicts: 0, retired: 0 },
    skills: { requiredMissing: [], optionalMissing: [], checked: 0 },
    lastSyncAt: entry.lastSyncAt || null,
    stateKitCommit: null,
  };
  const find = (level, check, message, suggestion) =>
    pr.findings.push({ level, check, message, suggestion });

  // 1. Path exists - everything else is moot for a dead path.
  if (!fs.existsSync(projectRoot)) {
    find('error', 'path', 'project path does not exist',
      'node bin/onboard.mjs register --path <path> --remove');
    pr.status = 'dead-path';
    return pr;
  }

  // 2. State file present and parseable.
  const statePath = path.join(projectRoot, STATE_REL_PATH);
  let state = null;
  try {
    const parsed = readJson(statePath);
    if (isObject(parsed) && isObject(parsed.artifacts)) state = parsed;
  } catch { /* handled below */ }
  if (!fs.existsSync(statePath)) {
    find('error', 'state', 'no .agents/onboarding-state.json',
      'node bin/onboard.mjs sync --project <name> --adopt');
    pr.status = 'unadopted';
    return pr;
  }
  if (!state) {
    find('error', 'state', 'onboarding-state.json is missing or unparseable',
      'inspect the file, then re-run sync --adopt to re-baseline');
    pr.status = 'bad-state';
    return pr;
  }
  pr.stateKitCommit = state.kitCommit || null;

  // 3. The recorded kit commit must still exist - without it recorded bases
  // and managed-key manifests are unreconstructable.
  if (!kitCommitExists(state.kitCommit)) {
    find('warn', 'kit-commit',
      `recorded kitCommit ${String(state.kitCommit || '(missing)').slice(0, 12)} not found in kit repo`,
      'bases may be unreconstructable; re-sync with the current kit history present');
  }

  // 4. Drift vs the current kit: a full dry-run sync classifies every managed
  //    artifact/key without writing anything.
  const prSync = syncProject(entry, {
    dryRun: true,
    adopt: false,
    manifestPath: ctx.manifestPath,
    manifestRoot: ctx.manifestRoot,
    manifest: ctx.manifest,
    plan: ctx.plan,
    kitCommit: ctx.kitCommit,
  });
  for (const f of prSync.files) classifyRow(f, pr.drift, pr.findings);

  // 5. Skills (5-location presence check ran inside the dry-run sync).
  //    Requiredness comes from the manifest, not row detail text: under the
  //    forced dry-run an absent bundled template skill reports
  //    'would-install'/'install-failed' (and 'missing' with 'kit source
  //    missing'), none of which carry the required/optional tag.
  const requiredSkills = new Set();
  for (const s of ctx.manifest.skills || []) if (s.required) requiredSkills.add(s.name);
  for (const ts of ctx.manifest.templateSkills || []) if (ts.required) requiredSkills.add(ts.dest);
  // Statuses meaning "not installed": absent entirely, install/update that
  // failed, or an install the dry-run only simulated.
  const absent = new Set(['missing', 'would-install', 'install-failed', 'update-failed', 'install-reported-ok']);
  for (const s of prSync.skills || []) {
    pr.skills.checked++;
    if (!absent.has(s.status)) continue;
    (requiredSkills.has(s.name) ? pr.skills.requiredMissing : pr.skills.optionalMissing).push(s.name);
  }
  if (pr.skills.requiredMissing.length) {
    find('warn', 'skills',
      `required skills missing: ${pr.skills.requiredMissing.join(', ')}`,
      'run sync --install-skills (or npx skills add <source>@<skill> -g -y)');
  }

  // 6. Overrides must reference paths that exist in the project.
  for (const ref of entry.overrides?.skip || []) {
    const rel = overridePath(ref);
    if (!fs.existsSync(path.join(projectRoot, rel))) {
      find('warn', 'overrides', `overrides.skip references nonexistent path: ${ref}`,
        'remove the stale entry from the registry overrides');
    }
  }
  for (const ref of Object.keys(entry.overrides?.pins || {})) {
    const rel = overridePath(ref);
    if (!fs.existsSync(path.join(projectRoot, rel))) {
      find('warn', 'overrides', `overrides.pins references nonexistent path: ${ref}`,
        'remove the stale entry from the registry overrides');
    }
  }

  // 7. Staleness: never synced, or lastSyncAt beyond the window.
  if (!entry.lastSyncAt) {
    find('warn', 'stale', 'project has never been synced', 'run sync');
  } else {
    const ageMs = Date.now() - Date.parse(entry.lastSyncAt);
    if (Number.isFinite(ageMs) && ageMs > ctx.staleDays * 24 * 60 * 60 * 1000) {
      const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      find('warn', 'stale', `last synced ${days} days ago (window: ${ctx.staleDays}d)`, 'run sync');
    }
  }

  pr.status = pr.findings.some(f => f.level === 'error') ? 'errors'
    : pr.findings.length ? 'warnings' : 'clean';
  return pr;
}

/**
 * Print the human-readable doctor report.
 *
 * @param {object} report Assembled report.
 */
function printHuman(report) {
  const lines = [];
  lines.push(`=== Doctor report (kit v${report.kitVersion}) ===`);
  lines.push('');
  for (const p of report.projects) {
    lines.push(`${p.name} - ${p.path} [${p.status}]`);
    const d = p.drift;
    if (d.projectOnly || d.kitAhead || d.wouldBeConflicts || d.retired) {
      lines.push(`  drift: ${d.projectOnly} project-only, ${d.kitAhead} kit-ahead, `
        + `${d.wouldBeConflicts} would-be-conflicts, ${d.retired} retired`);
    }
    if (p.skills.checked) {
      const miss = [...p.skills.requiredMissing, ...p.skills.optionalMissing];
      lines.push(`  skills: ${p.skills.checked - miss.length}/${p.skills.checked} present`
        + (miss.length ? ` (missing: ${miss.join(', ')})` : ''));
    }
    for (const f of p.findings) {
      lines.push(`  ${f.level === 'error' ? 'ERROR' : 'warn '} [${f.check}] ${f.message}`);
      if (f.suggestion) lines.push(`         -> ${f.suggestion}`);
    }
    if (!p.findings.length) lines.push('  (clean)');
    lines.push('');
  }
  lines.push(`Summary: ${report.summary.totalFindings} finding(s) across ${report.projects.length} project(s)`);
  lines.push(`Exit code: ${report.exitCode}`);
  console.log(lines.join('\n'));
}

/**
 * doctor [--project NAME] [--json] [--stale-days N] [--manifest <path>]
 *
 * @param {Record<string, *>} opts Parsed flags.
 */
export function commandDoctor(opts) {
  if (opts.project === true) throw new Error('Missing value for --project <name|path>');
  const staleDays = opts['stale-days'] !== undefined && opts['stale-days'] !== true
    ? Number(opts['stale-days']) : DEFAULT_STALE_DAYS;
  if (!Number.isFinite(staleDays) || staleDays < 0) {
    throw new Error('--stale-days must be a non-negative number');
  }

  const manifestPath = resolveManifestPath(opts.manifest);
  const ctx = {
    manifestPath,
    manifestRoot: path.dirname(manifestPath),
    manifest: readJson(manifestPath),
    staleDays,
  };
  ctx.plan = buildManagedPlan(ctx.manifest);
  ctx.kitCommit = getKitCommit();

  const reg = loadRegistry();
  let projects = reg.projects;
  if (opts.project !== undefined) {
    const sel = String(opts.project);
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
    manifest: manifestPath,
    generatedAt: new Date().toISOString(),
    staleDays,
    projects: projects.map(e => checkProject(e, ctx)),
  };
  const totalFindings = report.projects.reduce((n, p) => n + p.findings.length, 0);
  report.summary = { totalFindings };
  report.exitCode = totalFindings > 0 ? 3 : 0;

  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  process.exitCode = report.exitCode;
}
