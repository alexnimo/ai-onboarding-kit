/**
 * sync-utils.mjs - shared helpers for the sync engine (bin/lib/sync.mjs).
 * Node >=18, stdlib only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  KIT_ROOT,
  SCHEMA_VERSION,
  sha256,
  sha256File,
  readJson,
  getKitCommit,
} from './common.mjs';

export const CONFLICT_MARKER_RE = /^<{7}/m;
export const PLACEHOLDER_RE = /\{\{[A-Z_]+\}\}/g;
export const NPX_TIMEOUT_MS = 120_000;
// Args passed to npx come from the manifest; forbid shell metachars outright.
const NPX_ARG_RE = /^[A-Za-z0-9@._~\/#+:=-]+$/;

/**
 * Fetch a file's content from the kit's git history.
 *
 * @param {string} commit Commit-ish (state.kitCommit).
 * @param {string} relPath Repo-relative path (forward slashes).
 * @returns {Buffer|null} File bytes, or null when unavailable.
 */
export function gitShow(commit, relPath) {
  if (!commit || commit === 'unknown') return null;
  try {
    return execFileSync('git', ['show', `${commit}:${relPath}`], {
      cwd: KIT_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * List commits that touched a file, newest first (bounded).
 *
 * @param {string} commit Starting commit-ish (usually state.kitCommit or HEAD).
 * @param {string} relPath Repo-relative path (forward slashes).
 * @param {number} max Cap on returned commits.
 * @returns {string[]} Commit shas, newest first.
 */
export function gitRevList(commit, relPath, max = 200) {
  if (!commit || commit === 'unknown') return [];
  try {
    const out = execFileSync('git', ['rev-list', commit, '--', relPath], {
      cwd: KIT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024,
    });
    return out.split('\n').map(s => s.trim()).filter(Boolean).slice(0, max);
  } catch {
    return [];
  }
}

/**
 * Repo-relative path for git commands, or null when the file lives outside
 * the kit repo (custom --manifest locations).
 *
 * @param {string} absPath Absolute path.
 * @returns {string|null} Forward-slash repo-relative path or null.
 */
export function repoRel(absPath) {
  const rel = path.relative(KIT_ROOT, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Load the manifest as committed at `commit` - the entry-level base for
 * managed-key config sync (research decision Q4). Called with each config
 * artifact's recorded kitCommit (falling back to state.kitCommit).
 *
 * @param {string} commit Commit-ish.
 * @param {string} manifestPath Absolute path of the manifest in use.
 * @returns {object|null} Parsed manifest or null when not reconstructable.
 */
export function manifestAtCommit(commit, manifestPath) {
  const rel = repoRel(manifestPath);
  if (!rel) return null;
  const buf = gitShow(commit, rel);
  if (!buf) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}

/**
 * Substitute recorded {{KEY}} placeholder values into template text. Keys
 * without a recorded value keep their {{KEY}} token (needs-fill reporting).
 * With no recorded values (state schema v1) this is the identity function -
 * the base stays the raw template, so project fills read as local edits.
 *
 * @param {string} text Template text.
 * @param {Record<string,string>} values Recorded placeholder values.
 * @returns {string} Rendered text.
 */
export function renderTemplate(text, values) {
  if (!values || typeof values !== 'object') return text;
  return text.replace(PLACEHOLDER_RE, tok => {
    const key = tok.slice(2, -2);
    return key in values ? String(values[key]) : tok;
  });
}

/**
 * List unfilled {{KEY}} tokens in text (deduped, without braces).
 *
 * @param {string} text File text.
 * @returns {string[]} Token keys like ['PROJECT_NAME'].
 */
export function unfilledTokens(text) {
  return [...new Set([...text.matchAll(PLACEHOLDER_RE)].map(m => m[0].slice(2, -2)))];
}

/**
 * Append a needs-fill note when written content still has tokens.
 *
 * @param {string} detail Base detail string.
 * @param {string} text Written content.
 * @returns {string} Detail with optional '; needs-fill: KEYS' suffix.
 */
export function needsFillSuffix(detail, text) {
  const tokens = unfilledTokens(text);
  return tokens.length ? `${detail}; needs-fill: ${tokens.join(',')}` : detail;
}

/**
 * Canonical JSON serialization for entry comparison: recursively sorted keys,
 * compact separators. Comparing canon strings ignores key order and
 * insignificant whitespace (research decision Q4).
 *
 * @param {*} v Any JSON value.
 * @returns {string} Canonical string.
 */
export function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Plain-object check.
 *
 * @param {*} v Value.
 * @returns {boolean} True for non-null non-array objects.
 */
export function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Get a nested value by path segments.
 *
 * @param {object} obj Root object.
 * @param {string[]} segs Path segments.
 * @returns {*} Value or undefined.
 */
export function getPath(obj, segs) {
  let cur = obj;
  for (const s of segs) {
    if (!isObject(cur)) return undefined;
    cur = cur[s];
  }
  return cur;
}

/**
 * Set a nested value by path segments, creating objects as needed.
 *
 * @param {object} obj Root object.
 * @param {string[]} segs Path segments.
 * @param {*} v Value to set.
 */
export function setPath(obj, segs, v) {
  let cur = obj;
  for (const s of segs.slice(0, -1)) {
    if (!isObject(cur[s])) cur[s] = {};
    cur = cur[s];
  }
  cur[segs[segs.length - 1]] = v;
}

/**
 * Run an npx command (skills CLI). Never throws - returns a result object.
 *
 * @param {string[]} args npx arguments (validated to safe chars first).
 * @returns {{ok: boolean, detail: string}}
 */
export function runNpx(args) {
  // Manifest-derived values must never reach a shell: npm ships npx-cli.js
  // next to node.exe, so spawn it under the current interpreter - no shell
  // expansion on any platform. The shim fallback needs cmd.exe on Windows,
  // which is why args are prevalidated against shell metachars regardless.
  for (const a of args) {
    if (!NPX_ARG_RE.test(String(a))) {
      return { ok: false, detail: `unsafe npx argument rejected: ${String(a).slice(0, 40)}` };
    }
  }
  const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  const direct = fs.existsSync(npxCli);
  try {
    const out = execFileSync(
      direct ? process.execPath : 'npx',
      direct ? [npxCli, ...args] : args,
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: NPX_TIMEOUT_MS,
        shell: !direct && process.platform === 'win32',
      });
    return { ok: true, detail: (out || '').trim().split('\n').pop() || 'done' };
  } catch (err) {
    return { ok: false, detail: String(err.message).split('\n')[0] };
  }
}

/**
 * Build the managed-file plan from a manifest: text dests (templates +
 * per-profile rules, mirroring record-state's enumeration) and config paths
 * (mcpConfigPath/hooksConfigPath per agent profile).
 *
 * @param {object} manifest Parsed onboard.manifest.json.
 * @returns {{textDests: Map<string,{src:string,agents:Set<string>|null}>,
 *   configPaths: Map<string,object>}}
 *   `agents: null` marks a universal dest; a Set scopes it to those agents.
 */
export function buildManagedPlan(manifest) {
  const textDests = new Map(); // dest -> {src, agents|null}
  const configPaths = new Map(); // cfgRel -> {mcpKey, hooksFormat, agents, source}

  for (const t of manifest.templates || []) {
    if (t.dest && t.src) textDests.set(t.dest, { src: t.src, agents: null });
  }
  for (const [agentName, profile] of Object.entries(manifest.agentProfiles || {})) {
    if (profile.rulesDir) {
      for (const r of manifest.rules || []) {
        const dest = `${profile.rulesDir}/${r.dest}`;
        const cur = textDests.get(dest);
        if (!cur) textDests.set(dest, { src: r.src, agents: new Set([agentName]) });
        else if (cur.agents) cur.agents.add(agentName); // profiles sharing rulesDir
      }
    }
    for (const key of ['mcpConfigPath', 'hooksConfigPath']) {
      const rel = profile[key];
      if (!rel || rel.startsWith('~')) continue;
      if (!configPaths.has(rel)) {
        configPaths.set(rel, {
          mcpKey: null,
          hooksFormat: null,
          agents: new Set(),
          source: `agentProfiles.${agentName}.${key}`,
        });
      }
      const c = configPaths.get(rel);
      c.agents.add(agentName);
      if (key === 'mcpConfigPath') c.mcpKey = profile.mcpConfigKey || 'mcpServers';
      else c.hooksFormat = profile.hooksConfigFormat || 'standalone';
    }
  }
  return { textDests, configPaths };
}

/**
 * Group manifest hooks into the config-file entry shape the scaffolders
 * write: event -> [{matcher, hooks:[{type,command}]}].
 *
 * @param {Array} hooks Manifest hooks array.
 * @returns {Record<string, Array>} Event -> entry list.
 */
export function groupHooksByEvent(hooks) {
  const grouped = {};
  for (const h of hooks || []) {
    (grouped[h.event] ||= []).push({
      matcher: h.matcher,
      hooks: [{ type: h.type, command: h.command }],
    });
  }
  return grouped;
}

/**
 * Build a baseline state for `sync --adopt` (T4 governance): adoption
 * records ONLY MCP/hooks config files plus the state header. Templates and
 * rules are never adopted - the kit cannot prove it installed a file it
 * didn't write, so template/rule dests stay project-owned (skipped as
 * foreign by syncTextDest) and are not touched by the adopt run itself.
 *
 * Config files are recorded at their current bytes so the managed-key merge
 * can evaluate entries; keys absent at adoption are treated as "never
 * installed" (added), not "deleted by project".
 *
 * @param {string} projectRoot Absolute project path.
 * @param {object} ctx Sync context.
 * @param {object} entry Registry entry ({agents} gates config adoption to
 *   profiles the project actually uses).
 * @param {string} now ISO timestamp.
 * @returns {object} New in-memory state object (persisted by caller).
 */
export function buildAdoptedState(projectRoot, ctx, entry, now) {
  const kitCommit = getKitCommit();
  const artifacts = {};
  for (const [cfgRel, cfg] of ctx.plan.configPaths) {
    // Never adopt a config for an agent the project did not register - a
    // record here would defeat syncConfigFile's agentRelevant guard.
    if (![...cfg.agents].some(a => (entry.agents || []).includes(a))) continue;
    const cfgAbs = path.join(projectRoot, cfgRel);
    if (!fs.existsSync(cfgAbs)) continue;
    artifacts[cfgRel] = { hash: sha256File(cfgAbs), source: cfg.source, syncedAt: now, kitCommit };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    kitCommit,
    manifestHash: sha256File(ctx.manifestPath),
    adoptedAt: now,
    artifacts,
  };
}
