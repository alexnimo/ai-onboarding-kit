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
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  STATE_REL_PATH,
  SCHEMA_VERSION,
  parseArgs,
  sha256File,
  readJson,
  writeJsonAtomic,
  writeFileAtomic,
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
  extractRegion,
  injectRegion,
} from './lib/sync-utils.mjs';
import {
  buildOnboardRows,
  mergeFactRows,
} from './lib/onboard-plan.mjs';
import { startUiServer } from './lib/ui-server.mjs';
import {
  effectiveProfiles,
  planProfile,
  applyProfilePlan,
  deleteProfileArtifacts,
  invokeStrings,
  skillStatus,
  loadProfileState,
  saveProfileState,
} from './lib/profiles.mjs';

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
 * record-state --path P [--manifest <path>] [--dry-run]
 *
 * Writes <project>/.agents/onboarding-state.json covering:
 *   - manifest template dests (install-base hash: the kit source hash when
 *     the on-disk file matches it; otherwise the previously recorded hash,
 *     or the file hash when there is no prior recording)
 *   - manifest rule dests under each agent profile's rulesDir (same rules)
 *   - MCP/hooks config files for every agent profile present in the project
 * Also stamps lastSyncAt on the project's registry entry when present.
 * --dry-run prints the computed state object and writes nothing.
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

  // Manifest template dests. Region-managed dests are excluded: their
  // file is project-owned; only the `<dest>:<id>` region record exists.
  const regionManaged = new Set(
    (manifest.managedRegions || []).flatMap(r => r.dests || []));
  for (const t of manifest.templates || []) {
    if (!regionManaged.has(t.dest)) addManagedArtifact(t.dest, t.src);
  }

  // Managed regions: record `<dest>:<id>` when the project file carries
  // markers. Markerless files are left for sync to inject (record-state
  // never mutates project content).
  for (const r of manifest.managedRegions || []) {
    const regionSrc = path.join(manifestRoot, r.src);
    if (!r.id || !fs.existsSync(regionSrc)) continue;
    for (const dest of r.dests || []) {
      const destAbs = path.join(projectRoot, dest);
      if (!fs.existsSync(destAbs)) continue;
      const key = `${dest}:${r.id}`;
      if (extractRegion(fs.readFileSync(destAbs, 'utf8'), r.id) === null) continue;
      const prior = priorArtifacts[key];
      if (prior) {
        artifacts[key] = { ...prior, region: true, syncedAt };
      } else {
        artifacts[key] = {
          hash: sha256File(regionSrc), source: r.src,
          syncedAt, kitCommit, region: true,
        };
      }
    }
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
              if (s.tier === 'specialist') continue;
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
  if (opts['dry-run']) {
    // Preview only - print what would be recorded (no file or registry
    // writes). Plan rows can diff this against the current state file.
    console.log(JSON.stringify(state, null, 2));
    return;
  }
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

/**
 * inject-regions --path P [--manifest <path>] [--dry-run]
 *
 * Splice kit-managed regions into markerless destination files (e.g. a
 * foreign AGENTS.md). Single implementation shared by the scaffolds and
 * the sync engine; idempotent — files already carrying markers are
 * skipped. Prints one line per file acted on.
 *
 * @param {Record<string, *>} opts Parsed flags.
 */
function commandInjectRegions(opts) {
  const projectRoot = resolveProjectPath(opts.path);
  const manifestPath = resolveManifestPath(opts.manifest);
  const manifestRoot = path.dirname(manifestPath);
  const manifest = readJson(manifestPath);
  const dry = !!opts['dry-run'];
  let acted = 0;
  for (const r of manifest.managedRegions || []) {
    const srcAbs = path.join(manifestRoot, r.src);
    if (!r.id || !fs.existsSync(srcAbs)) continue;
    const block = fs.readFileSync(srcAbs, 'utf8').replace(/\r?\n$/, '');
    for (const dest of r.dests || []) {
      const destAbs = path.join(projectRoot, dest);
      if (!fs.existsSync(destAbs)) continue;
      const text = fs.readFileSync(destAbs, 'utf8');
      if (extractRegion(text, r.id) !== null) continue; // already managed
      const injected = injectRegion(text, r.id, block);
      if (!dry) writeFileAtomic(destAbs, injected);
      console.log(`  [${dry ? 'would inject' : 'injected'}] ${dest}:${r.id}`);
      acted++;
    }
  }
  // Agent profiles whose instructions file delegates to AGENTS.md via an
  // import line (e.g. claude-code's `@AGENTS.md`): append the line when
  // the file exists and lacks it; create a stub when it doesn't. Scoped
  // to --agents when given (scaffold passes the profile being onboarded).
  const wantedAgents = opts.agents ? parseAgents(opts.agents) : null;
  for (const [name, profile] of Object.entries(manifest.agentProfiles || {})) {
    if (wantedAgents && !wantedAgents.includes(name)) continue;
    const line = profile.instructionsImport;
    const file = profile.instructionsFile;
    if (!line || !file) continue;
    const destAbs = path.join(projectRoot, file);
    if (fs.existsSync(destAbs)) {
      const text = fs.readFileSync(destAbs, 'utf8');
      if (text.split('\n').some(l => l.trim() === line)) continue;
      if (!dry) writeFileAtomic(destAbs, text.replace(/\n?$/, '\n') + line + '\n');
      console.log(`  [${dry ? 'would append' : 'appended'}] ${file} <- ${line} (${name})`);
      acted++;
    } else {
      if (!dry) writeFileAtomic(destAbs, line + '\n');
      console.log(`  [${dry ? 'would create' : 'created'}] ${file} <- ${line} (${name})`);
      acted++;
    }
  }
  if (!acted) console.log('  (no markerless region dests found)');
}

/**
 * onboard --target <path> [--profile <profile>] [--agent <runner>]
 *         [--resolve-with <runner>] [--apply] [--json]
 *         [--install-skills] [--update-skills] [--force] [--manifest <path>]
 *
 * Builds the onboarding plan (node rows from onboard-plan.mjs merged with
 * scaffold --dry-run fact rows), then:
 *   --json    print {plan, summary} and exit (writes nothing)
 *   --apply   write accepted-artifact list and run the real scaffold
 *   default   serve the SPA at #/onboard?plan=<id> and open the browser
 *
 * Registry entries are created only on apply - never during planning.
 *
 * @param {Record<string, *>} opts Parsed flags.
 */
async function commandOnboard(opts) {
  const target = opts.target || opts.path;
  if (!target) throw new Error('onboard requires --target <path>');
  const projectRoot = path.resolve(String(target));
  if (!fs.existsSync(projectRoot)) {
    throw new Error(`target path does not exist: ${projectRoot}`);
  }
  const profile = opts.profile || 'devin';
  const manifestPath = resolveManifestPath(opts.manifest);

  const { rows: nodeRows } = buildOnboardRows(projectRoot, {
    manifest: manifestPath, profile,
  });

  // Shell fact rows: exists/missing/install-skill/copy (skills + template
  // facts node does not own). Runs the REAL scaffold in --dry-run; it
  // emits JSON rows on stdout and writes nothing.
  let factRows = [];
  const scriptDir = path.dirname(manifestPath);
  const scaffold = process.platform === 'win32'
    ? { cmd: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptDir, 'scaffold.ps1'), '-Target', projectRoot, '-Agent', profile, '-DryRun'] }
    : { cmd: 'bash', args: [path.join(scriptDir, 'scaffold.sh'), '--target', projectRoot, '--agent', profile, '--dry-run'] };
  const dryFlag = process.platform === 'win32' ? '-DryRun' : '--dry-run';
  if (opts['install-skills']) scaffold.args.push(process.platform === 'win32' ? '-InstallSkills' : '--install-skills');
  if (opts['update-skills']) scaffold.args.push(process.platform === 'win32' ? '-UpdateSkills' : '--update-skills');
  try {
    const res = spawnSync(scaffold.cmd, scaffold.args, { encoding: 'utf8', timeout: 120000 });
    if (res.stdout) {
      const parsed = JSON.parse(res.stdout.split('@@PLAN_JSON@@').pop());
      factRows = Array.isArray(parsed) ? parsed : [];
    }
  } catch (err) {
    console.error(`WARNING: scaffold --dry-run failed (${err.message}); plan has node rows only.`);
  }

  const plan = mergeFactRows(nodeRows, factRows);
  const byAction = {};
  for (const r of plan) byAction[r.action] = (byAction[r.action] || 0) + 1;
  const result = {
    target: projectRoot,
    profile,
    agent: opts.agent || 'devin',
    resolveWith: opts['resolve-with'] || null,
    plan,
    summary: { total: plan.length, byAction },
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (opts.apply) {
    // --only filter: every plan artifact is applied. Artifacts listed are
    // project-relative paths or names (skills) exactly as the scaffold
    // matches them; (project) bookkeeping rows map to register/state.
    const onlyFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-only-')), 'only.txt');
    fs.writeFileSync(onlyFile,
      plan.map(r => r.artifact).filter(a => a !== '(project)').join('\n') + '\n');
    const args = scaffold.args.filter(a => a !== dryFlag);
    args.push(process.platform === 'win32' ? '-OnlyFile' : '--only', onlyFile);
    const res = spawnSync(scaffold.cmd, args, { stdio: 'inherit' });
    fs.rmSync(path.dirname(onlyFile), { recursive: true, force: true });
    if (res.status !== 0) throw new Error(`scaffold apply exited ${res.status}`);
    console.log('Onboarding applied. Fill {{placeholders}} in the generated files.');
    return;
  }

  // Review mode: session plan + SPA.
  const { server, url, onboardPlans } = await startUiServer({});
  const planId = crypto.randomUUID();
  onboardPlans.set(planId, {
    id: planId, kind: 'onboard', createdAt: new Date().toISOString(),
    ...result,
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  const viewUrl = `${url}/#/onboard?plan=${planId}`;
  console.log(`Onboarding plan: ${plan.length} rows (${Object.entries(byAction).map(([a, n]) => `${n} ${a}`).join(', ')})`);
  console.log(`Review UI: ${viewUrl}`);
  console.log('Press Ctrl-C to stop.');
}

/**
 * profile --list [--json]
 * profile --plan <id> [--project <path>] [--json]
 * profile --sync <id> [--project <path>]
 * profile --create <id> --label <txt> [--skills a,b] [--mcps a,b]
 *         [--harnesses a,b] [--description <txt>]
 * profile --delete <id>
 *
 * Specialist profiles: named capability bundles (skills + MCP servers +
 * agent def) materialized into each supported harness's native scoping
 * mechanism (omp ~/.omp/profiles, opencode agents, claude mcp-config,
 * devin local config). Core-only harnesses get nothing.
 */
function commandProfile(opts) {
  const manifest = readJson(resolveManifestPath(opts.manifest));
  const state = loadProfileState();
  const profiles = effectiveProfiles(manifest, state);

  if (opts.list || (!opts.plan && !opts.sync && !opts.create && !opts.delete)) {
    const rows = profiles.map(p => ({
      id: p.id,
      origin: p.origin,
      label: p.label || '',
      harnesses: p.harnesses || [],
      skills: (p.skills || []).length,
      mcpServers: p.mcpServers || [],
      invoke: invokeStrings(p),
    }));
    if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }
    for (const r of rows) {
      console.log(`${r.id} [${r.origin}] ${r.label}`);
      console.log(`  harnesses: ${r.harnesses.join(', ') || '-'}  skills: ${r.skills}  mcp: ${r.mcpServers.join(', ') || '-'}`);
      for (const [h, cmd] of Object.entries(r.invoke)) console.log(`  ${h}: ${cmd}`);
    }
    return;
  }

  if (opts.create) {
    const id = String(opts.create);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`invalid profile id '${id}' (lowercase letters, digits, dashes)`);
    if (profiles.some(p => p.id === id)) throw new Error(`profile '${id}' already exists`);
    const p = {
      label: opts.label || id,
      description: opts.description || '',
      skills: opts.skills ? String(opts.skills).split(',') : [],
      cliTools: opts.cliTools ? String(opts.cliTools).split(',') : [],
      mcpServers: opts.mcps ? String(opts.mcps).split(',') : [],
      harnesses: opts.harnesses ? String(opts.harnesses).split(',') : ['omp'],
    };
    state.profiles[id] = p;
    saveProfileState(state);
    console.log(`Created user profile '${id}'. Run: node bin/onboard.mjs profile --sync ${id} --project <path>`);
    return;
  }

  if (opts.delete) {
    const id = String(opts.delete);
    const removed = deleteProfileArtifacts(id, state);
    delete state.profiles[id];
    delete state.overrides[id];
    saveProfileState(state);
    for (const r of removed) console.log(`  ${r.action}  ${r.dest}`);
    console.log(`Deleted profile '${id}' (kit profiles can be disabled via overrides, not deleted).`);
    return;
  }

  const id = String(opts.plan || opts.sync);
  const profile = profiles.find(p => p.id === id);
  if (!profile) throw new Error(`unknown profile '${id}' — run profile --list`);
  const projectRoot = opts.project ? resolveProjectPath(opts.project) : null;
  const plan = planProfile(profile, manifest, projectRoot);

  if (opts.plan) {
    if (opts.json) {
      console.log(JSON.stringify({ profile: id, warnings: plan.warnings, artifacts: plan.artifacts.map(a => ({ harness: a.harness, scope: a.scope, dest: a.dest })), invoke: invokeStrings(profile) }, null, 2));
      return;
    }
    for (const w of plan.warnings) console.log(`  warn: ${w}`);
    for (const a of plan.artifacts) console.log(`  [${a.harness}/${a.scope}] ${a.dest}`);
    console.log('invoke:');
    for (const [h, cmd] of Object.entries(invokeStrings(profile))) console.log(`  ${h}: ${cmd}`);
    return;
  }

  // --sync
  const skills = skillStatus(profile);
  const missing = skills.filter(s => !s.present);
  for (const s of skills) console.log(`  skill ${s.present ? '[installed]' : '[MISSING]'}  ${s.name}`);
  if (missing.length) console.log(`  hint: install missing skills via npx skills add before relying on this profile`);
  const results = applyProfilePlan(plan, profile, state);
  saveProfileState(state);
  for (const w of plan.warnings) console.log(`  warn: ${w}`);
  for (const r of results) console.log(`  ${r.action}  ${r.dest}`);
  console.log('invoke:');
  for (const [h, cmd] of Object.entries(invokeStrings(profile))) console.log(`  ${h}: ${cmd}`);
}

// ---------- entry ----------

const USAGE = `Usage:
  node bin/onboard.mjs register --name X --path P [--agents a,b] [--remove]
  node bin/onboard.mjs list [--json]
  node bin/onboard.mjs record-state --path P [--manifest <path>] [--dry-run]
  node bin/onboard.mjs onboard --target <path> [--profile <profile>] [--agent <runner>]
                             [--resolve-with <runner>] [--apply] [--json]
                             [--install-skills] [--update-skills] [--force]
  node bin/onboard.mjs inject-regions --path P [--manifest <path>] [--dry-run]
  node bin/onboard.mjs sync [--project NAME] [--dry-run] [--force] [--json]
                          [--update-skills] [--install-skills] [--adopt] [--prune]
                          [--restore-deleted] [--manifest <path>]
  node bin/onboard.mjs doctor [--project NAME] [--json] [--stale-days N]
                          [--manifest <path>]
  node bin/onboard.mjs profile --list [--json]
  node bin/onboard.mjs profile --plan <id> [--project <path>] [--json]
  node bin/onboard.mjs profile --sync <id> [--project <path>]
  node bin/onboard.mjs profile --create <id> --label <txt>
                          [--skills a,b] [--mcps a,b] [--harnesses a,b]
                          [--description <txt>]
  node bin/onboard.mjs profile --delete <id>
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
    case 'inject-regions': commandInjectRegions(opts); break;
    case 'doctor': commandDoctor(opts); break;
    case 'ui': commandUi(opts).catch(err => {
      console.error(`ERROR: ${err.message}`);
      process.exit(1);
    }); break;
    case 'onboard': commandOnboard(opts).catch(err => {
      console.error(`ERROR: ${err.message}`);
      process.exit(1);
    }); break;
    case 'profile': commandProfile(opts); break;
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
