/**
 * onboard-plan.mjs - node-side onboarding plan rows. Stdlib only.
 *
 * Computes the deterministic half of the onboarding plan (the shell
 * scaffold emits only fact rows - exists/missing/install-skill/copy):
 *
 *   template dests   'create' (absent) | 'exists-skip' (present)
 *   region dests     'inject-region' when the file exists without kit
 *                    markers; 'exists-skip' when already managed
 *   config files     'merge-keys' for profile mcpConfigPath +
 *                    hooksConfigPath (additive merge computed in node,
 *                    identical to the scaffold's jq semantics)
 *   import stubs     'append-import' for profile.instructionsImport
 *   bookkeeping      'register' + state-file 'create' rows
 *
 * Rows reuse the sync plan vocabulary {artifact, action, detail?, diff?}
 * plus 'global: true' on rows that touch paths outside the project.
 * No disk writes ever - diffs are computed against in-memory content.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readJson, resolveManifestPath, STATE_REL_PATH } from './common.mjs';
import { extractRegion, injectRegion } from './sync-utils.mjs';
import { unifiedDiff } from './sync-engine.mjs';

const REL = p => p.split(path.sep).join('/');

/**
 * Render a template exactly the way the scaffold installs it: raw bytes
 * except `{{KIT_REGION}}`, which expands to the managedRegions[0] block
 * (single implementation: onboard.mjs inject-regions + sync).
 */
function renderScaffoldTemplate(manifest, manifestRoot, srcAbs) {
  let text = fs.readFileSync(srcAbs, 'utf8');
  const region = manifest.managedRegions?.[0];
  if (region?.src && text.includes('{{KIT_REGION}}')) {
    const block = fs.readFileSync(path.join(manifestRoot, region.src), 'utf8')
      .replace(/\r?\n$/, '');
    text = text.replace('{{KIT_REGION}}', block);
  }
  return text;
}

/**
 * Additive MCP merge - mirrors scaffold.sh: only manifest servers absent
 * from <mcpConfigKey>.<name> are added.
 */
export function mergedMcpConfig(existing, manifest, mcpKey) {
  const out = JSON.parse(JSON.stringify(existing));
  if (!out[mcpKey] || typeof out[mcpKey] !== 'object') out[mcpKey] = {};
  const added = [];
  for (const s of manifest.mcpServers || []) {
    if (s.tier === 'specialist') continue; // specialist servers go to profile destinations only
    if (out[mcpKey][s.name] === undefined) {
      out[mcpKey][s.name] = s.config;
      added.push(s.name);
    }
  }
  return { out, added };
}

/**
 * Additive hooks merge - mirrors scaffold.sh: only manifest events absent
 * from the hooks container are added. 'nested' -> .hooks key; 'standalone'
 * -> top level.
 */
function mergedHooksConfig(existing, manifest, format) {
  const out = JSON.parse(JSON.stringify(existing));
  const container = format === 'nested' ? 'hooks' : null;
  const target = container ? (out[container] ||= {}) : out;
  const byEvent = {};
  for (const h of manifest.hooks || []) {
    (byEvent[h.event] ||= []).push({ matcher: h.matcher, hooks: [{ type: h.type, command: h.command }] });
  }
  const added = [];
  for (const [event, cfg] of Object.entries(byEvent)) {
    if (target[event] === undefined) { target[event] = cfg; added.push(event); }
  }
  return { out, added };
}

function readJsonOr(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { text, data: JSON.parse(text) };
  } catch {
    return { text: null, data: {} };
  }
}

function row(artifact, action, extra = {}) {
  return { artifact, action, ...extra };
}

/**
 * Build node-side plan rows for onboarding `projectRoot` under `profile`.
 *
 * @param {string} projectRoot Absolute or relative target path.
 * @param {object} opts {manifest?, profile?}
 * @returns {{rows: object[], profile: object, projectRoot: string}}
 */
export function buildOnboardRows(projectRoot, opts = {}) {
  const manifestPath = resolveManifestPath(opts.manifest);
  const manifestRoot = path.dirname(manifestPath);
  const manifest = readJson(manifestPath);
  const profileName = opts.profile || 'devin';
  const profile = manifest.agentProfiles?.[profileName];
  if (!profile) {
    throw new Error(`unknown agent profile '${profileName}' - available: ${Object.keys(manifest.agentProfiles || {}).join(', ')}`);
  }
  const root = path.resolve(projectRoot);
  const rows = [];

  // --- templates ---
  for (const t of manifest.templates || []) {
    const destAbs = path.join(root, t.dest);
    const srcAbs = path.join(manifestRoot, t.src);
    if (!fs.existsSync(srcAbs)) continue;
    if (!fs.existsSync(destAbs)) {
      rows.push(row(t.dest, 'create', {
        detail: 'install template',
        diff: unifiedDiff(t.dest, '', renderScaffoldTemplate(manifest, manifestRoot, srcAbs)),
      }));
    } else {
      rows.push(row(t.dest, 'exists-skip', { detail: 'file exists; kit never overwrites it' }));
    }
  }

  // --- managed regions (e.g. AGENTS.md:kit-region on foreign files) ---
  for (const r of manifest.managedRegions || []) {
    const srcAbs = path.join(manifestRoot, r.src);
    if (!r.id || !fs.existsSync(srcAbs)) continue;
    const block = fs.readFileSync(srcAbs, 'utf8').replace(/\r?\n$/, '');
    for (const dest of r.dests || []) {
      const destAbs = path.join(root, dest);
      if (!fs.existsSync(destAbs)) continue; // handled by the template 'create' row
      const text = fs.readFileSync(destAbs, 'utf8');
      const key = `${dest}:${r.id}`;
      if (extractRegion(text, r.id) !== null) {
        // File already carries the kit region - covered by the template
        // exists-skip row; nothing to inject.
        continue;
      }
      rows.push(row(key, 'inject-region', {
        detail: `splice kit-managed region '${r.id}' into existing file`,
        diff: unifiedDiff(dest, text, injectRegion(text, r.id, block)),
      }));
    }
  }

  // --- rules ---
  if (profile.rulesDir && profile.rulesEnabled !== false) {
    for (const r of manifest.rules || []) {
      const dest = `${profile.rulesDir}/${r.dest}`;
      const destAbs = path.join(root, dest);
      const srcAbs = path.join(manifestRoot, r.src);
      if (!fs.existsSync(srcAbs)) continue;
      if (!fs.existsSync(destAbs)) {
        rows.push(row(dest, 'create', {
          detail: `install ${profileName} rule`,
          diff: unifiedDiff(dest, '', fs.readFileSync(srcAbs, 'utf8')),
        }));
      } else if (r.overwrite !== true) {
        rows.push(row(dest, 'exists-skip', { detail: 'rule file exists; not overwritten' }));
      }
    }
  }

  // --- MCP config merge ---
  if (profile.mcpConfigPath) {
    const rel = profile.mcpConfigPath;
    const cfgAbs = path.join(root, rel);
    const { text, data } = readJsonOr(cfgAbs);
    const { out, added } = mergedMcpConfig(data || {}, manifest, profile.mcpConfigKey || 'mcpServers');
    if (added.length || text === null) {
      rows.push(row(rel, 'merge-keys', {
        detail: text === null
          ? `create config with ${added.length} server(s)`
          : `add ${added.length} server(s): ${added.join(', ') || 'none'}`,
        diff: unifiedDiff(rel, text ?? '', JSON.stringify(out, null, 2) + '\n'),
      }));
    }
  }

  // --- hooks config merge ---
  if (profile.hooksConfigPath && profile.hooksConfigFormat) {
    const rel = profile.hooksConfigPath;
    if (rel !== profile.mcpConfigPath) {
      const cfgAbs = path.join(root, rel);
      const { text, data } = readJsonOr(cfgAbs);
      const { out, added } = mergedHooksConfig(data || {}, manifest, profile.hooksConfigFormat);
      if (added.length || text === null) {
        rows.push(row(rel, 'merge-keys', {
          detail: text === null
            ? `create hooks config with ${added.length} event(s)`
            : `add ${added.length} hook event(s): ${added.join(', ') || 'none'}`,
          diff: unifiedDiff(rel, text ?? '', JSON.stringify(out, null, 2) + '\n'),
        }));
      }
    }
    // Shared-path profile (claude-code): MCP + hooks merge into one file.
    if (rel === profile.mcpConfigPath) {
      const cfgAbs = path.join(root, rel);
      const { text, data } = readJsonOr(cfgAbs);
      const mcp = mergedMcpConfig(data || {}, manifest, profile.mcpConfigKey || 'mcpServers');
      const hooks = mergedHooksConfig(mcp.out, manifest, profile.hooksConfigFormat);
      if (mcp.added.length + hooks.added.length || text === null) {
        const i = rows.findIndex(rw => rw.artifact === rel);
        const detail = `add ${[...mcp.added.map(s => `server ${s}`), ...hooks.added.map(e => `hooks ${e}`)].join(', ') || 'nothing'}`;
        const merged = { diff: unifiedDiff(rel, text ?? '', JSON.stringify(hooks.out, null, 2) + '\n'), detail };
        if (i >= 0) Object.assign(rows[i], merged);
        else rows.push(row(rel, 'merge-keys', merged));
      }
    }
  }

  // --- instructions import stub (claude-code CLAUDE.md -> @AGENTS.md) ---
  if (profile.instructionsImport && profile.instructionsFile) {
    const rel = profile.instructionsFile;
    const destAbs = path.join(root, rel);
    const line = profile.instructionsImport;
    if (fs.existsSync(destAbs)) {
      const text = fs.readFileSync(destAbs, 'utf8');
      if (!text.split('\n').some(l => l.trim() === line)) {
        rows.push(row(rel, 'append-import', {
          detail: `append '${line}'`,
          diff: unifiedDiff(rel, text, text.replace(/\n?$/, '\n') + line + '\n'),
        }));
      }
    } else {
      rows.push(row(rel, 'create', {
        detail: `stub delegating to AGENTS.md ('${line}')`,
        diff: unifiedDiff(rel, '', line + '\n'),
      }));
    }
  }

  // --- bookkeeping ---
  const name = path.basename(root);
  rows.push(row('(project)', 'register', {
    detail: `register project '${name}' in the kit registry`,
  }));
  const stateAbs = path.join(root, STATE_REL_PATH);
  if (!fs.existsSync(stateAbs)) {
    rows.push(row(STATE_REL_PATH, 'create', {
      detail: 'record install state for sync (artifact hashes + kitCommit)',
    }));
  }

  return { rows, profile: { name: profileName, ...profile }, projectRoot: root };
}

/**
 * Merge scaffold fact rows into node rows. Node rows win on artifact
 * collision (they carry diffs); fact rows for the same artifact are
 * dropped unless they carry a distinct action.
 *
 * @param {object[]} nodeRows
 * @param {object[]} factRows
 * @returns {object[]}
 */
export function mergeFactRows(nodeRows, factRows) {
  const seen = new Set(nodeRows.map(r => `${r.artifact}${r.action}`));
  const out = [...nodeRows];
  for (const r of factRows || []) {
    const key = `${r.artifact}${r.action}`;
    if (!seen.has(key)) { seen.add(key); out.push(r); }
  }
  return out;
}
