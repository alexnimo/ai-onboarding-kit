#!/usr/bin/env node

/**
 * onboard.mjs - AI onboarding kit registry + state + sync CLI.
 * Node >=18, stdlib only.
 *
 * Maintains two JSON files:
 *   1. Kit-side projects.registry.json - desired-state inventory of onboarded
 *      projects (one entry per resolved absolute project path).
 *   2. Per-project .agents/onboarding-state.json - recorded install base:
 *      hashes of template content AS INSTALLED (pre-placeholder-fill, taken
 *      from the kit source files) plus generated MCP/hooks config files.
 *
 * Usage:
 *   node bin/onboard.mjs register --name X --path P [--agents a,b] [--remove]
 *   node bin/onboard.mjs list [--json]
 *   node bin/onboard.mjs record-state --path P [--manifest <path>]
 *   node bin/onboard.mjs sync [--project NAME] [--dry-run] [--force] [--json]
 *                             [--update-skills] [--install-skills] [--adopt]
 *                             [--prune] [--restore-deleted] [--manifest <path>]
 *   node bin/onboard.mjs doctor [--project NAME] [--json] [--stale-days N]
 *                             [--manifest <path>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATE_REL_PATH,
  SCHEMA_VERSION,
  parseArgs,
  sha256File,
  readJson,
  writeJsonAtomic,
  loadRegistry,
  updateRegistry,
  resolveProjectPath,
  resolveManifestPath,
  getKitCommit,
  parseAgents,
} from './lib/common.mjs';
import { commandSync } from './lib/sync.mjs';
import { commandDoctor } from './lib/doctor.mjs';
import {
  canon,
  getPath,
  isObject,
  groupHooksByEvent,
} from './lib/sync-utils.mjs';
import { startUiServer } from './lib/ui-server.mjs';

// ---------- subcommands ----------

/**
 * register --name X --path P [--agents a,b] [--remove]
 *
 * Upserts (or removes) a project entry keyed by resolved absolute path,
 * serialized by the registry lock.
 *
 * @param {Record<string, *>} opts Parsed flags.
 */
function commandRegister(opts) {
  const projectRoot = resolveProjectPath(opts.path);

  if (opts.remove) {
    const removed = updateRegistry(reg => {
      const idx = reg.projects.findIndex(p => p.path === projectRoot);
      if (idx === -1) return false;
      reg.projects.splice(idx, 1);
      return true;
    });
    console.log(removed ? `Removed: ${projectRoot}` : `Not registered: ${projectRoot}`);
    return;
  }

  const now = new Date().toISOString();
  const newAgents = parseAgents(opts.agents);
  const name = typeof opts.name === 'string' ? opts.name : null;

  const action = updateRegistry(reg => {
    const entry = reg.projects.find(p => p.path === projectRoot);
    if (!entry) {
      reg.projects.push({
        name: name || path.basename(projectRoot),
        path: projectRoot,
        agents: newAgents,
        onboardedAt: now,
        lastSyncAt: now,
        overrides: { skip: [], pins: {} },
      });
      return 'Registered';
    }
    if (name) entry.name = name;
    entry.agents = [...new Set([...(entry.agents || []), ...newAgents])];
    return 'Updated';
  });

  console.log(`${action}: ${name || path.basename(projectRoot)} (${projectRoot})`);
}

/**
 * list [--json]
 *
 * Prints one line per registered project: name, path, agents, lastSyncAt.
 *
 * @param {Record<string, *>} opts Parsed flags.
 */
function commandList(opts) {
  const reg = loadRegistry();
  if (opts.json) {
    console.log(JSON.stringify(reg.projects, null, 2));
    return;
  }
  if (reg.projects.length === 0) {
    console.log('No projects registered.');
    return;
  }
  const rows = reg.projects.map(p => [
    p.name,
    p.path,
    (p.agents || []).join(','),
    p.lastSyncAt || '',
  ]);
  const widths = [0, 0, 0, 0];
  for (const row of rows) {
    row.forEach((cell, i) => { widths[i] = Math.max(widths[i], String(cell).length); });
  }
  for (const row of rows) {
    console.log(row.map((cell, i) => String(cell).padEnd(widths[i])).join('  ').trimEnd());
  }
}

/**
 * record-state --path P [--manifest <path>]
 *
 * Writes <project>/.agents/onboarding-state.json covering:
 *   - manifest template dests (install-base hash: the kit source hash when
 *     the on-disk file matches it; otherwise the previously recorded hash,
 *     or the file hash when there is no prior recording)
 *   - manifest rule dests under each agent profile's rulesDir (same rules)
 *   - MCP/hooks config files for every agent profile present in the project
 *     (hash of the generated file as installed; source = manifest reference)
 * Also stamps lastSyncAt on the project's registry entry when present.
 *
 * @param {Record<string, *>} opts Parsed flags.
 */
function commandRecordState(opts) {
  const projectRoot = resolveProjectPath(opts.path);
  if (!fs.existsSync(projectRoot)) {
    throw new Error(`Project path does not exist: ${projectRoot}`);
  }
  const manifestPath = resolveManifestPath(opts.manifest);
  const manifestRoot = path.dirname(manifestPath);
  const manifest = readJson(manifestPath);
  const statePath = path.join(projectRoot, STATE_REL_PATH);

  // Prior recording is the baseline: files skipped on a repeat scaffold keep
  // their original install-base hash instead of silently adopting the
  // current kit-source hash. The prior state's kitCommit is kept too - it is
  // the commit whose `git show` can reconstruct that base.
  let priorArtifacts = {}, priorKitCommit = null;
  try {
    const prior = readJson(statePath);
    priorArtifacts = prior.artifacts || {};
    priorKitCommit = prior.kitCommit || null;
  } catch { /* no valid prior state - treat as first recording */ }

  const syncedAt = new Date().toISOString();
  const kitCommit = getKitCommit();
  const artifacts = {};

  /**
   * Record a manifest-managed file dest. If the on-disk file matches the
   * current kit source it was (re)installed from it; otherwise preserve the
   * previously recorded install base (and its commit), falling back to the
   * file's own hash when there is no prior recording.
   */
  const addManagedArtifact = (destKey, srcRel) => {
    if (artifacts[destKey]) return;
    const destAbs = path.join(projectRoot, destKey);
    if (!fs.existsSync(destAbs)) return;
    const srcAbs = path.join(manifestRoot, srcRel);
    const fileHash = sha256File(destAbs);
    const sourceHash = fs.existsSync(srcAbs) ? sha256File(srcAbs) : null;
    const prior = priorArtifacts[destKey];
    if (sourceHash && fileHash === sourceHash) {
      artifacts[destKey] = { hash: sourceHash, source: srcRel, syncedAt, kitCommit };
    } else if (prior) {
      const rec = { hash: prior.hash, source: prior.source, syncedAt };
      const priorCommit = prior.kitCommit || priorKitCommit;
      if (priorCommit) rec.kitCommit = priorCommit;
      artifacts[destKey] = rec;
    } else {
      artifacts[destKey] = { hash: fileHash, source: srcRel, syncedAt };
    }
  };

  // Manifest template dests.
  for (const t of manifest.templates || []) {
    addManagedArtifact(t.dest, t.src);
  }

  // Per-agent-profile artifacts present in the project.
  for (const [agentName, profile] of Object.entries(manifest.agentProfiles || {})) {
    // Rules copied into the profile's rulesDir.
    if (profile.rulesDir) {
      for (const r of manifest.rules || []) {
        addManagedArtifact(`${profile.rulesDir}/${r.dest}`, r.src);
      }
    }
    // Generated MCP/hooks config files (hash of the file as installed).
    // Managed-key bases live at the commits recorded for them: whenever a
    // prior record exists, keep its kitCommit as the file-level default and
    // rebuild per-key keyCommits - a key whose installed value already
    // equals the CURRENT manifest entry received that kit update out-of-band
    // and is rebased to this commit, while untouched/customized keys retain
    // their prior effective base. Overrides for keys absent from the current
    // manifest are carried over too, so a temporarily removed key keeps its
    // base until it can be reconciled when re-added. Re-basing every key (or
    // dropping overrides) would misclassify them as customized -> conflict
    // on the next sync.
    for (const key of ['mcpConfigPath', 'hooksConfigPath']) {
      const rel = profile[key];
      if (!rel || rel.startsWith('~') || artifacts[rel]) continue;
      const abs = path.join(projectRoot, rel);
      if (!fs.existsSync(abs)) continue;
      const fileHash = sha256File(abs);
      const prior = priorArtifacts[rel];
      const rec = {
        hash: fileHash,
        source: `agentProfiles.${agentName}.${key}`,
        syncedAt,
        kitCommit,
      };
      if (prior) {
        const priorCommit = (prior.kitCommit && prior.kitCommit !== 'unknown')
          ? prior.kitCommit : priorKitCommit;
        if (priorCommit) rec.kitCommit = priorCommit;
        let cfgData = null;
        try { cfgData = readJson(abs); } catch { /* unreadable */ }
        if (isObject(cfgData)) {
          const prevKC = prior.keyCommits || {};
          const managed = [];
          if (key === 'mcpConfigPath') {
            const mcpKey = profile.mcpConfigKey || 'mcpServers';
            for (const s of manifest.mcpServers || []) {
              managed.push({
                keyId: `${rel}:${mcpKey}.${s.name}`,
                pathArr: [mcpKey, s.name],
                newEntry: s.config,
              });
            }
          } else {
            const format = profile.hooksConfigFormat || 'standalone';
            const prefix = format === 'nested' ? ['hooks'] : [];
            for (const [event, arr] of Object.entries(groupHooksByEvent(manifest.hooks))) {
              managed.push({
                keyId: `${rel}:${[...prefix, event].join('.')}`,
                pathArr: [...prefix, event],
                newEntry: arr,
              });
            }
          }
          const keyCommits = {};
          // Carry over prior overrides for keys NOT in the current manifest:
          // a temporarily removed server/hook keeps its recorded base commit
          // so the next sync reconciles it (instead of a false conflict)
          // when the manifest re-adds it.
          const managedIds = new Set(managed.map(k => k.keyId));
          for (const [kId, c] of Object.entries(prevKC)) {
            if (!managedIds.has(kId) && c && c !== 'unknown' && c !== rec.kitCommit) {
              keyCommits[kId] = c;
            }
          }
          for (const k of managed) {
            const installed = getPath(cfgData, k.pathArr);
            const eff = (installed !== undefined && canon(installed) === canon(k.newEntry))
              ? kitCommit
              : (prevKC[k.keyId] ?? priorCommit);
            if (eff && eff !== 'unknown' && eff !== rec.kitCommit) keyCommits[k.keyId] = eff;
          }
          if (Object.keys(keyCommits).length) rec.keyCommits = keyCommits;
        } else if (prior.keyCommits) {
          rec.keyCommits = prior.keyCommits;
        }
      }
      artifacts[rel] = rec;
    }
  }

  const state = {
    schemaVersion: SCHEMA_VERSION,
    kitCommit,
    manifestHash: sha256File(manifestPath),
    artifacts,
  };
  writeJsonAtomic(statePath, state);

  // Stamp lastSyncAt on the registry entry when the project is registered.
  updateRegistry(reg => {
    const entry = reg.projects.find(p => p.path === projectRoot);
    if (entry) entry.lastSyncAt = syncedAt;
  });

  console.log(`Recorded state: ${statePath} (${Object.keys(artifacts).length} artifacts)`);
}

/**
 * ui [--port 4173]
 *
 * Starts the local sync server (bin/lib/ui-server.mjs): 127.0.0.1-only
 * node:http JSON API + static SPA host. Ctrl-C closes the listener and
 * exits.
 *
 * @param {Record<string, *>} opts Parsed flags.
 */
async function commandUi(opts) {
  // Bare `--port` parses as boolean true - reject it instead of
  // Number(true) silently binding port 1 (review r1 F2).
  if (opts.port !== undefined && typeof opts.port !== 'string') {
    throw new Error('--port requires a value (e.g. --port 4173)');
  }
  const port = opts.port === undefined ? 4173 : Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port: ${opts.port}`);
  }
  const { server, url } = await startUiServer({ port });
  const shutdown = () => {
    server.close(() => process.exit(0));
    // Never hang on half-open sockets.
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.log(`Sync UI server listening at ${url}`);
  console.log('Press Ctrl-C to stop.');
}

// ---------- entry ----------

const USAGE = `Usage:
  node bin/onboard.mjs register --name X --path P [--agents a,b] [--remove]
  node bin/onboard.mjs list [--json]
  node bin/onboard.mjs record-state --path P [--manifest <path>]
  node bin/onboard.mjs sync [--project NAME] [--dry-run] [--force] [--json]
                          [--update-skills] [--install-skills] [--adopt] [--prune]
                          [--restore-deleted] [--manifest <path>]
  node bin/onboard.mjs doctor [--project NAME] [--json] [--stale-days N]
                          [--manifest <path>]
  node bin/onboard.mjs ui [--port 4173]`;

/**
 * CLI entry point.
 *
 * @param {string[]} argv process.argv.slice(2)
 */
function main(argv) {
  const [command, ...rest] = argv;
  const opts = parseArgs(rest);
  switch (command) {
    case 'register': commandRegister(opts); break;
    case 'list': commandList(opts); break;
    case 'record-state': commandRecordState(opts); break;
    case 'sync': commandSync(opts); break;
    case 'doctor': commandDoctor(opts); break;
    case 'ui': commandUi(opts).catch(err => {
      console.error(`ERROR: ${err.message}`);
      process.exit(1);
    }); break;
    case undefined:
    case 'help':
      console.log(USAGE);
      break;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      process.exit(1);
  }
}

const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedAs === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

// Re-exported for tests and kit tooling (helpers live in lib/common.mjs).
export {
  KIT_ROOT,
  REGISTRY_PATH,
  REGISTRY_LOCK_PATH,
  STATE_REL_PATH,
  SCHEMA_VERSION,
  parseArgs,
  sha256,
  sha256File,
  readJson,
  writeJsonAtomic,
  writeFileAtomic,
  loadRegistry,
  saveRegistry,
  updateRegistry,
} from './lib/common.mjs';
