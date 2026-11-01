/**
 * mcp-versions.mjs - version management for manifest-declared MCP servers.
 *
 * Core servers are pinned (e.g. `semble[mcp]==0.7.1`, `context-mode@1.0.169`)
 * so a cold start never re-resolves "latest" — the runner's MCP timeout was
 * previously dying inside that resolve window. Specialist servers stay
 * @latest on purpose (only run inside profile sessions).
 *
 * `checkMcpVersions` compares each pin to the registry's latest so `doctor
 * --mcp` can warn when the pin is stale; `bumpMcpVersions` rewrites the
 * manifest args in place. One file stays the source of truth — no lockfile.
 *
 * Node >=18, stdlib only.
 */
import { execSync } from 'node:child_process';
import https from 'node:https';
import { writeJsonAtomic } from './common.mjs';

/**
 * Extract {kind, pkg, pinned} from a server's config.args. kind is 'npm'
 * (npx `pkg@ver`) or 'pypi' (uvx `pkg[extras]==ver`); pinned is null for
 * unversioned/@latest tokens.
 */
export function parsePin(server) {
  const args = server?.config?.args || [];
  const cmd = server?.config?.command;
  for (const a of args) {
    if (cmd === 'uvx') {
      // --from "semble[mcp]==0.7.1" | bare "code-review-graph==2.3.9"
      const m = /^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?(?:==(.+))?$/.exec(a);
      if (m && !['--from', 'python', '-p'].includes(m[1]) && !a.startsWith('-')) {
        return { kind: 'pypi', pkg: m[1], pinned: m[2] || null };
      }
    } else if (cmd === 'npx') {
      // "context-mode@1.0.169" | "@playwright/mcp@latest" | "chrome-devtools-mcp@latest"
      const m = /^(@[a-z0-9._-]+\/)?([a-z0-9._-]+)(?:@(.+))?$/i.exec(a);
      if (m && !a.startsWith('-')) {
        const pkg = (m[1] || '') + m[2];
        const tag = m[3] || null;
        return { kind: 'npm', pkg, pinned: (tag && tag !== 'latest') ? tag : null };
      }
    }
  }
  return { kind: 'unknown', pkg: null, pinned: null };
}

/** Latest published version for a pinned package. */
export function latestVersion(kind, pkg) {
  if (kind === 'npm') {
    // Windows: npm is npm.cmd and execFileSync can't spawn .cmd without a
    // shell; pkg is a manifest constant so execSync is safe here.
    const out = execSync(`npm view ${pkg} version`,
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim().split(/\s+/).pop();
  }
  if (kind === 'pypi') {
    return new Promise((resolve, reject) => {
      const req = https.get(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`,
        { timeout: 15000 }, res => {
          let buf = '';
          res.on('data', d => { buf += d; });
          res.on('end', () => {
            try { resolve(JSON.parse(buf).info?.version || null); }
            catch { reject(new Error('bad pypi response')); }
          });
        });
      req.on('timeout', () => { req.destroy(new Error('pypi timeout')); });
      req.on('error', reject);
    });
  }
  return null;
}

/**
 * One row per manifest server: pin status + latest when the registry is
 * reachable. Async — the PyPI lookup is an HTTP call.
 */
export async function checkMcpVersions(manifest, { offline = false } = {}) {
  const rows = [];
  for (const s of manifest.mcpServers || []) {
    const pin = parsePin(s);
    const row = {
      name: s.name, tier: s.tier, required: !!s.required,
      command: s.config?.command, kind: pin.kind, pkg: pin.pkg,
      pinned: pin.pinned, latest: null, stale: false, error: null,
    };
    if (!pin.pkg) row.error = 'unparseable args';
    else if (!pin.pinned) row.error = 'unpinned';
    else if (!offline) {
      try {
        row.latest = await latestVersion(pin.kind, pin.pkg);
        row.stale = !!(row.latest && row.latest !== pin.pinned);
      } catch (err) {
        row.error = `lookup failed: ${err.message.slice(0, 60)}`;
      }
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Bump every pinned server to the registry's latest. Rewrites the args
 * token in place (preserves `pkg[extras]` and @latest specialists), saves
 * the manifest atomically. Returns the rows that changed.
 */
export async function bumpMcpVersions(manifestPath, manifest, { only } = {}) {
  const rows = await checkMcpVersions(manifest);
  const changed = [];
  const onlySet = only ? new Set(only) : null;
  for (const row of rows) {
    if (!row.stale) continue;
    if (onlySet && !onlySet.has(row.name)) continue;
    const srv = (manifest.mcpServers || []).find(s => s.name === row.name);
    const args = srv.config.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.includes('==')) {
        args[i] = a.replace(/==[^=\s]+$/, `==${row.latest}`);
        break;
      }
      const at = a.lastIndexOf('@');
      if (at > 0 && !a.endsWith('@latest') || (at > 0 && /@\d/.test(a))) {
        args[i] = `${a.slice(0, at)}@${row.latest}`;
        break;
      }
    }
    changed.push({ name: row.name, was: row.pinned, now: row.latest });
  }
  if (changed.length) {
    writeJsonAtomic(manifestPath, manifest);
  }
  return { rows, changed };
}
