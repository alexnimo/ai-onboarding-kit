/**
 * ui-server.mjs - local sync server for the POR-109 Web UI (UI-2).
 *
 * Zero-dependency node:http JSON API + static SPA host (bin/ui/). Same
 * stdlib philosophy as bin/onboard.mjs: no Fastify, no DB, no build step.
 *
 * Binding decisions (architect, card t_8ec6284d):
 *   - binds 127.0.0.1 only and 403s any request whose Host header is not
 *     exactly `127.0.0.1:<port>` or `localhost:<port>` (cheap DNS-rebinding
 *     defense; no auth in v1);
 *   - mutating API routes additionally require `Content-Type:
 *     application/json` and reject any `Origin` header that is not this
 *     server itself - a browser page on another origin cannot forge either
 *     (review r1 F1);
 *   - plans are session-only: POST /api/dry-run stores the dryRun() result
 *     in memory keyed by id; nothing about a plan reaches disk; GETs never
 *     mutate; the store is bounded by PLAN_TTL_MS / MAX_PLANS (review r1 F3);
 *   - apply runs ONLY the dispositions in the request body, one
 *     applyDisposition() call per dest (per-file atomic), then records
 *     lastSyncResult {at, accepted[], reverted[], kit[], action} on the
 *     project's registry entry - the apply-history source of truth;
 *   - the server calls ONLY the sync-engine facade (dryRun/mergeFile/
 *     applyDisposition) - never bin/lib/sync internals.
 *
 * API (all JSON, /api prefix):
 *   GET    /api/projects                      registry entries + state summary
 *   POST   /api/projects  {name, path, agents[]}  register (path must exist)
 *   DELETE /api/projects?path=                remove
 *   POST   /api/dry-run   {project}           -> {planId, plan, summary}
 *   GET    /api/plans/:id                     session plan
 *   GET    /api/plans/:id/diff?dest=          unified diff text (JSON)
 *   GET    /api/plans/:id/merge?dest=         mergeFile() result
 *   POST   /api/plans/:id/apply {dispositions:{<dest>: accepted|reverted|kit}}
 *   GET    /api/history?project=<path>        lastSyncResult entries
 *   GET    /api/profiles                      effective profiles + catalog
 *   GET    /api/profiles/:id/plan?project=    planProfile() result (preview)
 *   POST   /api/profiles/:id/sync {project?}  applyProfilePlan + record
 *   POST   /api/profiles {id, ...fields}      create user profile
 *   PUT    /api/profiles/:id                  edit user profile / kit override
 *   DELETE /api/profiles/:id                  delete artifacts + profile
 *   GET    /api/skills                        manifest skills + presence
 *   POST   /api/skills/install {name}         npx skills add <src>@<skill>
 *   POST   /api/skills/update {name}          npx skills update <name>
 *   GET    /api/doctor                        per-project health findings
 *   GET    /api/project/detail?path=          agents, configs, skill status
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  STATE_REL_PATH,
  readJson,
  loadRegistry,
  updateRegistry,
  resolveProjectPath,
  writeFileAtomic,
  writeJsonAtomic,
  resolveManifestPath,
} from './common.mjs';
import {
  effectiveProfiles,
  planProfile,
  applyProfilePlan,
  deleteProfileArtifacts,
  invokeStrings,
  skillStatus,
  PROFILES_USER_PATH,
} from './profiles.mjs';
import { checkProject } from './doctor.mjs';
import { buildManagedPlan, isObject, extractRegion } from './sync-utils.mjs';
import { getKitCommit } from './common.mjs';
import { dryRun, mergeFile, applyDisposition } from './sync-engine.mjs';

import { buildOnboardRows, mergeFactRows } from './onboard-plan.mjs';
import { listRunners, spawnRunner, which } from './agent-spawn.mjs';
export const UI_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

const DISPOSITIONS = new Set(['accepted', 'reverted', 'kit']);
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY = 100;
const MAX_PLANS = 200;
const PLAN_TTL_MS = 30 * 60 * 1000;

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
// Fields the UI/PUT routes may write onto user profiles or kit overrides.
const PROFILE_EDITABLE = ['label', 'description', 'skills', 'cliTools',
  'mcpServers', 'harnesses', 'alias', 'disabled', 'copyAuth', 'includeCoreMcp'];
const PROFILE_LIST_FIELDS = ['skills', 'cliTools', 'mcpServers', 'harnesses'];

/** Error carrying an HTTP status; anything else becomes a bare 500. */
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

/**
 * Host-header check: exact `127.0.0.1:<port>` / `localhost:<port>` only.
 * Binds to the port actually bound (not the advertised one) so `--port 0`
 * stays reachable.
 *
 * @param {http.IncomingMessage} req
 * @param {number} port Bound port.
 * @returns {boolean}
 */
function hostAllowed(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * Origin check: when an `Origin` header is present it must be this server
 * itself. Host alone does not stop cross-origin browser requests - a page
 * on evil.example can POST to the loopback URL with a perfectly legal Host
 * header, but it cannot suppress or forge the Origin header.
 *
 * @param {http.IncomingMessage} req
 * @param {number} port Bound port.
 * @returns {boolean}
 */
function originAllowed(req, port) {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // non-browser client (curl etc.)
  try {
    const url = new URL(String(origin));
    const host = url.hostname.toLowerCase();
    return (host === '127.0.0.1' || host === 'localhost')
      && Number(url.port) === port;
  } catch {
    return false;
  }
}

/**
 * Read a JSON request body; enforces JSON content-type when the header is
 * present, a size cap, and surface-level errors (no stack traces).
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<object>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'];
    if (type && !String(type).toLowerCase().includes('application/json')) {
      reject(httpError(415, 'expected application/json body'));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => reject(httpError(400, 'failed reading request body')));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!isObject(parsed)) {
          reject(httpError(400, 'JSON body must be an object'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(httpError(400, 'invalid JSON body'));
      }
    });
  });
}

/**
 * State-file summary for one project: unresolved count, lastSyncAt, and the
 * newest lastSyncResult across registry entry and state file (apply writes
 * the registry; full syncs write the state file - reads prefer the newer).
 *
 * @param {object} entry Registry entry.
 * @returns {object} Summary fields merged onto the API row.
 */
function projectStateSummary(entry) {
  const summary = {
    missing: !fs.existsSync(entry.path),
    unresolvedCount: 0,
    lastSyncAt: entry.lastSyncAt ?? null,
    lastSyncResult: entry.lastSyncResult ?? null,
    hasState: false,
  };
  if (summary.missing) return summary;
  let state = null;
  try {
    const parsed = readJson(path.join(entry.path, STATE_REL_PATH));
    if (isObject(parsed)) state = parsed;
  } catch { /* missing/corrupt state -> zero summary */ }
  if (!state) return summary;
  summary.hasState = true;
  summary.unresolvedCount = Array.isArray(state.unresolved)
    ? state.unresolved.length : 0;
  const stateRes = isObject(state.lastSyncResult) ? state.lastSyncResult : null;
  const regRes = summary.lastSyncResult;
  if (stateRes && (!regRes || String(stateRes.at || '') >= String(regRes.at || ''))) {
    summary.lastSyncResult = stateRes;
  }
  if (stateRes?.at && (!summary.lastSyncAt || stateRes.at > summary.lastSyncAt)) {
    summary.lastSyncAt = stateRes.at;
  }
  return summary;
}

/**
 * Create the sync server.
 *
 * @param {object} opts {uiDir?, maxPlans?, planTtlMs?, home?,
 *   profilesStatePath?} extras are for tests (home redirects user-scope
 *   profile artifacts; profilesStatePath redirects profiles.user.json).
 */
export function createUiServer(opts = {}) {
  const uiDir = path.resolve(opts.uiDir || UI_DIR);
  const uiRoot = `${uiDir}${path.sep}`;
  const maxPlans = opts.maxPlans ?? MAX_PLANS;
  const planTtlMs = opts.planTtlMs ?? PLAN_TTL_MS;
  // planId -> {id, project, plan, summary, createdAt}. Bounded: expired
  // plans are evicted on access and insert; beyond maxPlans the oldest
  // entries drop (Map preserves insertion order).
  const plans = new Map();
  // Onboard plans live in their own store: different row vocabulary and
  // apply semantics (scaffold-driven) than sync plans.
  const onboardPlans = new Map();

  /** Drop plans older than the TTL. */
  const evictExpired = () => {
    const cutoff = Date.now() - planTtlMs;
    for (const [id, plan] of plans) {
      if (Date.parse(plan.createdAt) <= cutoff) plans.delete(id);
    }
  };

  /** Insert a plan, evicting expired entries and enforcing the cap. */
  const putPlan = (id, plan) => {
    evictExpired();
    while (plans.size > 0 && plans.size >= maxPlans) {
      plans.delete(plans.keys().next().value);
    }
    plans.set(id, plan);
  };
  /** Same TTL/cap discipline for onboard plans. */
  const putOnboardPlan = (id, plan) => {
    evictExpired();
    while (onboardPlans.size > 0 && onboardPlans.size >= maxPlans) {
      onboardPlans.delete(onboardPlans.keys().next().value);
    }
    onboardPlans.set(id, plan);
  };
  const getOnboardPlan = id => {
    const plan = onboardPlans.get(id);
    if (!plan) throw httpError(404, `unknown onboard plan: ${id}`);
    if (Date.parse(plan.createdAt) <= Date.now() - planTtlMs) {
      onboardPlans.delete(id);
      throw httpError(404, `expired onboard plan: ${id}`);
    }
    return plan;
  };

  /**
   * Run the platform scaffold in --dry-run and return its fact rows.
   * Writes nothing by contract (verified in the scaffold).
   */
  const scaffoldFacts = (target, profile, installSkills) => new Promise(resolve => {
    const manifestDir = path.resolve(path.dirname(UI_DIR), '..');
    const isWin = process.platform === 'win32';
    const [cmd, args] = isWin
      ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(manifestDir, 'scaffold.ps1'), '-Target', target, '-Agent', profile, '-DryRun', ...(installSkills ? ['-InstallSkills'] : [])]]
      : ['bash', [path.join(manifestDir, 'scaffold.sh'), '--target', target, '--agent', profile, '--dry-run', ...(installSkills ? ['--install-skills'] : [])]];
    execFile(cmd, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        // @@PLAN_JSON@@ sentinel: stdout may carry stray human chatter on
        // Windows (Write-Host leaks into the pipe under some hosts).
        const json = String(stdout).split('@@PLAN_JSON@@').pop();
        resolve(JSON.parse(json) || []);
      } catch { resolve([]); }
    });
  });


  /** Apply an onboard plan: run the real scaffold with an --only list. */
  const scaffoldApply = (target, profile, artifacts, installSkills) => new Promise(resolve => {
    const manifestDir = path.resolve(path.dirname(UI_DIR), '..');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-only-'));
    const onlyFile = path.join(tmp, 'only.txt');
    fs.writeFileSync(onlyFile, artifacts.join('\n') + '\n');
    const isWin = process.platform === 'win32';
    const [cmd, args] = isWin
      ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(manifestDir, 'scaffold.ps1'), '-Target', target, '-Agent', profile, '-OnlyFile', onlyFile, ...(installSkills ? ['-InstallSkills'] : [])]]
      : ['bash', [path.join(manifestDir, 'scaffold.sh'), '--target', target, '--agent', profile, '--only', onlyFile, ...(installSkills ? ['--install-skills'] : [])]];
    execFile(cmd, args, { timeout: 600000, maxBuffer: 32 * 1024 * 1024 }, err => {
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve(err ? { ok: false, error: `scaffold apply failed: ${err.message}` } : { ok: true });
    });
  });

  const sendJson = (res, status, obj) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(`${JSON.stringify(obj)}\n`);
  };

  const sendError = (res, err) => {
    const status = err.expose ? err.status : 500;
    sendJson(res, status, { error: err.expose ? err.message : 'internal error' });
    if (!err.expose) console.error('ui-server 500:', err);
  };

  /** Registry entry + state summary (API payload form). */
  const registryRow = entry => ({ ...entry, ...projectStateSummary(entry) });

  const resolveProjectParam = raw => {
    try {
      return resolveProjectPath(raw);
    } catch (err) {
      throw httpError(400, err.message);
    }
  };

  // ---------- profiles ----------

  // User-scope artifacts resolve through `home` (opts.home in tests keeps
  // writes out of the real home dir); state file redirects through
  // profilesStatePath so tests never touch the real profiles.user.json.
  const profilesStatePath = opts.profilesStatePath || PROFILES_USER_PATH;
  const home = opts.home ?? os.homedir();
  /** profiles.user.json -> state (missing file -> empty store). */
  const loadProfilesState = () => {
    const empty = { schemaVersion: 1, profiles: {}, overrides: {},
      artifacts: {}, custom: { mcpServers: [], skills: [] } };
    if (!fs.existsSync(profilesStatePath)) return empty;
    const s = readJson(profilesStatePath);
    const c = isObject(s.custom) ? s.custom : {};
    return {
      schemaVersion: s.schemaVersion ?? 1,
      profiles: isObject(s.profiles) ? s.profiles : {},
      overrides: isObject(s.overrides) ? s.overrides : {},
      artifacts: isObject(s.artifacts) ? s.artifacts : {},
      custom: {
        mcpServers: Array.isArray(c.mcpServers) ? c.mcpServers : [],
        skills: Array.isArray(c.skills) ? c.skills : [],
      },
    };
  };

  const saveProfilesState = state => {
    writeJsonAtomic(profilesStatePath, {
      schemaVersion: 1,
      profiles: state.profiles,
      overrides: state.overrides,
      artifacts: state.artifacts,
      custom: state.custom || { mcpServers: [], skills: [] },
    });
  };

  /** Parsed manifest (loaded per request: no stale catalog). */
  const loadManifest = () => readJson(resolveManifestPath(undefined));

  /** Catalog names the create/edit forms validate against. */
  const profileCatalog = (manifest, state) => ({
    skills: [
      ...(manifest.skills || []).map(s => s.name),
      ...(manifest.templateSkills || []).map(t => t.dest),
      ...(state?.custom?.skills || []).map(s => s.name),
    ],
    cliTools: (manifest.cliTools || []).map(t => t.name),
    mcpServers: [
      ...(manifest.mcpServers || []).map(s => ({
        name: s.name, tier: s.tier || 'core', required: !!s.required,
      })),
      ...(state?.custom?.mcpServers || []).map(s => ({
        name: s.name, tier: s.tier || 'specialist', required: false, custom: true,
      })),
    ],
    harnesses: Object.keys(manifest.agentProfiles || {}),
    custom: {
      skills: state?.custom?.skills || [],
      mcpServers: state?.custom?.mcpServers || [],
    },
  });

  /** Profile -> API payload (skill presence + invoke strings). */
  const profileRow = profile => ({
    ...profile,
    skills: skillStatus(profile, { home }),
    invoke: invokeStrings(profile),
  });

  /**
   * Validate + pick editable profile fields off a request body. Throws
   * 400 on bad types or names outside the manifest catalog + custom items.
   */
  const pickProfileFields = (body, manifest, state) => {
    const fields = {};
    for (const key of PROFILE_EDITABLE) {
      if (body[key] === undefined) continue;
      if (PROFILE_LIST_FIELDS.includes(key)) {
        if (!Array.isArray(body[key])
            || body[key].some(v => typeof v !== 'string')) {
          throw httpError(400, `${key} must be an array of strings`);
        }
        fields[key] = [...new Set(body[key])];
      } else if (key === 'disabled' || key === 'copyAuth' || key === 'includeCoreMcp') {
        fields[key] = body[key] === true;
      } else {
        if (typeof body[key] !== 'string') {
          throw httpError(400, `${key} must be a string`);
        }
        if (key === 'alias' && body[key]
            && !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(body[key])) {
          throw httpError(400,
            'alias must be a shell-safe name (letters, digits, -, _)');
        }
        fields[key] = body[key];
      }
    }
    const catalog = profileCatalog(manifest, state);
    const mcpNames = new Set(catalog.mcpServers.map(s => s.name));
    for (const name of fields.mcpServers || []) {
      if (!mcpNames.has(name)) {
        throw httpError(400, `unknown mcpServer: ${name}`);
      }
    }
    const harnessNames = new Set(catalog.harnesses);
    for (const name of fields.harnesses || []) {
      if (!harnessNames.has(name)) {
        throw httpError(400, `unknown harness: ${name}`);
      }
    }
    const skillNames = new Set(catalog.skills);
    for (const name of fields.skills || []) {
      if (!skillNames.has(name)) {
        throw httpError(400, `unknown skill: ${name}`);
      }
    }
    return fields;
  };

  /** Effective profile by id (null when unknown or disabled). */
  const findProfile = (manifest, state, id) =>
    effectiveProfiles(manifest, state).find(p => p.id === id) || null;

  const getPlan = id => {
    const plan = plans.get(id);
    if (!plan) throw httpError(404, `unknown plan: ${id}`);
    if (Date.parse(plan.createdAt) <= Date.now() - planTtlMs) {
      plans.delete(id);
      throw httpError(404, `plan expired: ${id}`);
    }
    return plan;
  };

  /** Plan file dests: config rows are `<file>: <key>` - dests are files. */
  const planDests = plan => {
    const dests = new Set();
    for (const row of plan.plan) {
      if (row.artifact === '(project)') continue;
      dests.add(row.artifact.split(':')[0]);
    }
    return dests;
  };

  function serveStatic(req, res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      sendError(res, httpError(400, 'bad URL encoding'));
      return;
    }
    const abs = path.normalize(path.join(uiDir, rel));
    if (abs !== uiDir && !abs.startsWith(uiRoot)) {
      sendError(res, httpError(403, 'forbidden'));
      return;
    }
    let target = abs;
    try {
      if (rel.endsWith('/') || fs.statSync(target).isDirectory()) {
        target = path.join(target, 'index.html');
      }
    } catch { /* stat failed - handled by existsSync below */ }
    if (!fs.existsSync(target)) {
      // SPA fallback: extensionless paths render the app shell; asset paths
      // with an extension 404 so missing files are never masked.
      if (!path.extname(rel)) target = path.join(uiDir, 'index.html');
      if (!fs.existsSync(target)) {
        sendError(res, httpError(404, 'not found'));
        return;
      }
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()]
        || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(target).pipe(res);
  }

  async function handleApi(req, res, url) {
    const { pathname, searchParams } = url;
    const method = req.method;

    // Mutating routes speak JSON only. Without this, a browser page can
    // send a "simple" (no-preflight) form POST cross-origin; requiring a
    // JSON Content-Type forces a preflight the foreign origin can never
    // pass (we emit no CORS headers) - and non-browser clients just set it.
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const type = String(req.headers['content-type'] || '').toLowerCase();
      if (!type.includes('application/json')) {
        throw httpError(415, 'mutating API calls require application/json');
      }
    }

    // GET /api/projects
    if (method === 'GET' && pathname === '/api/projects') {
      const reg = loadRegistry();
      sendJson(res, 200, { projects: reg.projects.map(registryRow) });
      return;
    }

    // POST /api/projects {name, path, agents[]}
    if (method === 'POST' && pathname === '/api/projects') {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectParam(body.path);
      if (!fs.existsSync(projectRoot)) {
        throw httpError(400, `project path does not exist: ${projectRoot}`);
      }
      if (body.name !== undefined && typeof body.name !== 'string') {
        throw httpError(400, 'name must be a string');
      }
      const agents = [...new Set(body.agents || [])];
      const valid = new Set(Object.keys(loadManifest().agentProfiles || {}));
      const bad = agents.filter(a => !valid.has(a));
      if (bad.length) {
        throw httpError(400,
          `unknown agents: ${bad.join(', ')} — valid: ${[...valid].join(', ')}`);
      }
      if (!agents.length) {
        throw httpError(400,
          'agents is empty — pick at least one harness to onboard for (agents drive which config files are written)');
      }
      const name = typeof body.name === 'string' && body.name
        ? body.name : null;
      const now = new Date().toISOString();
      let result;
      const action = updateRegistry(reg => {
        const entry = reg.projects.find(p => p.path === projectRoot);
        if (!entry) {
          result = {
            name: name || path.basename(projectRoot),
            path: projectRoot,
            agents,
            onboardedAt: now,
            lastSyncAt: now,
            overrides: { skip: [], pins: {} },
          };
          reg.projects.push(result);
          return 'registered';
        }
        if (name) entry.name = name;
        entry.agents = [...new Set([...(entry.agents || []), ...agents])];
        result = entry;
        return 'updated';
      });
      sendJson(res, action === 'registered' ? 201 : 200,
        { action, project: result });
      return;
    }

    // DELETE /api/projects?path=
    if (method === 'DELETE' && pathname === '/api/projects') {
      const raw = searchParams.get('path');
      if (!raw) throw httpError(400, 'missing required query param: path');
      const projectRoot = resolveProjectParam(raw);
      const removed = updateRegistry(reg => {
        const idx = reg.projects.findIndex(p => p.path === projectRoot);
        if (idx === -1) return false;
        reg.projects.splice(idx, 1);
        return true;
      });
      sendJson(res, 200, { removed });
      return;
    }

    // POST /api/dry-run {project}
    if (method === 'POST' && pathname === '/api/dry-run') {
      const body = await readJsonBody(req);
      const projectRoot = resolveProjectParam(body.project);
      let result;
      try {
        result = dryRun(projectRoot);
      } catch (err) {
        throw httpError(400, err.message);
      }
      if (result.project.status === 'missing-path') {
        throw httpError(400, `project path does not exist: ${projectRoot}`);
      }
      const planId = crypto.randomUUID();
      putPlan(planId, {
        id: planId,
        project: projectRoot,
        plan: result.plan,
        summary: result.summary,
        createdAt: new Date().toISOString(),
      });
      sendJson(res, 200, {
        planId,
        plan: result.plan,
        summary: result.summary,
      });
      return;
    }

    // /api/plans/:id[/diff|/merge|/apply]
    const planMatch = /^\/api\/plans\/([^/]+)(\/(diff|merge|apply))?$/.exec(pathname);
    if (planMatch) {
      const plan = getPlan(planMatch[1]);
      const sub = planMatch[3];

      if (!sub && method === 'GET') {
        sendJson(res, 200, plan);
        return;
      }

      if (sub === 'diff' && method === 'GET') {
        const dest = searchParams.get('dest');
        if (!dest) throw httpError(400, 'missing required query param: dest');
        const row = plan.plan.find(r => r.artifact === dest)
          || plan.plan.find(r => r.artifact.split(':')[0] === dest);
        if (!row) throw httpError(404, `dest not in plan: ${dest}`);
        sendJson(res, 200, {
          dest,
          artifact: row.artifact,
          action: row.action,
          diff: row.diff ?? '',
        });
        return;
      }

      if (sub === 'merge' && method === 'GET') {
        const dest = searchParams.get('dest');
        if (!dest) throw httpError(400, 'missing required query param: dest');
        if (!planDests(plan).has(dest)) {
          throw httpError(404, `dest not in plan: ${dest}`);
        }
        const merged = mergeFile(plan.project, dest);
        if (!merged) throw httpError(400, 'project not syncable');
        sendJson(res, 200, { dest, ...merged });
        return;
      }

      if (sub === 'apply' && method === 'POST') {
        const body = await readJsonBody(req);
        const dispositions = body.dispositions;
        if (!isObject(dispositions) || !Object.keys(dispositions).length) {
          throw httpError(400, 'dispositions must be a non-empty object');
        }
        const valid = planDests(plan);
        for (const [dest, disp] of Object.entries(dispositions)) {
          if (!valid.has(dest)) {
            throw httpError(400, `dest not in plan: ${dest}`);
          }
          if (!DISPOSITIONS.has(disp)) {
            throw httpError(400,
              `invalid disposition for ${dest}: ${String(disp)}`);
          }
        }
        const results = [];
        const lists = { accepted: [], reverted: [], kit: [] };
        let errors = 0;
        let conflicts = 0;
        for (const [dest, disposition] of Object.entries(dispositions)) {
          try {
            const r = applyDisposition(plan.project, dest, disposition);
            results.push({
              dest, disposition, ok: true,
              changed: r.changed, conflict: r.conflict,
            });
            lists[disposition].push(dest);
            if (r.conflict) conflicts++;
          } catch (err) {
            errors++;
            results.push({
              dest, disposition, ok: false,
              changed: false, error: err.message,
            });
          }
        }
        // History source of truth: lastSyncResult on the registry entry,
        // with a capped trail for GET /api/history. Lock-serialized via
        // updateRegistry, same as CLI register.
        const projectRoot = plan.project;
        let entry = null;
        try {
          updateRegistry(reg => {
            entry = reg.projects.find(
              p => path.resolve(p.path) === projectRoot);
            if (!entry) return;
            entry.lastSyncResult = {
              at: new Date().toISOString(),
              action: 'apply',
              accepted: lists.accepted,
              reverted: lists.reverted,
              kit: lists.kit,
              errors,
              conflicts,
            };
            entry.lastSyncAt = entry.lastSyncResult.at;
            const history = Array.isArray(entry.history) ? entry.history : [];
            history.push(entry.lastSyncResult);
            entry.history = history.slice(-MAX_HISTORY);
          });
        } catch (err) {
          // Apply already succeeded; a broken registry must not 500 the
          // response - report history persistence inline instead.
          sendJson(res, 200, {
            results,
            lastSyncResult: null,
            historyError: err.message,
          });
          return;
        }
        sendJson(res, 200, {
          results,
          registered: !!entry,
          lastSyncResult: entry ? entry.lastSyncResult : null,
        });
        return;
      }

      throw httpError(405, 'method not allowed');
    }

    // GET /api/profiles - effective profiles + form catalog.
    if (method === 'GET' && pathname === '/api/profiles') {
      const manifest = loadManifest();
      const state = loadProfilesState();
      sendJson(res, 200, {
        profiles: effectiveProfiles(manifest, state).map(profileRow),
        catalog: profileCatalog(manifest, state),
      });
      return;
    }

    // POST /api/profiles {id, label?, description?, skills?, cliTools?,
    //   mcpServers?, harnesses?} - create a user profile.
    if (method === 'POST' && pathname === '/api/profiles') {
      const body = await readJsonBody(req);
      const manifest = loadManifest();
      const id = body.id;
      if (typeof id !== 'string' || !PROFILE_ID_RE.test(id)) {
        throw httpError(400,
          'id must match /^[a-z0-9][a-z0-9-]*$/ (lowercase letters, digits, dashes)');
      }
      const state = loadProfilesState();
      if (findProfile(manifest, state, id)
          || (manifest.profiles || []).some(p => p.id === id)) {
        throw httpError(409, `profile '${id}' already exists`);
      }
      const fields = pickProfileFields(body, manifest, state);
      const profile = {
        label: fields.label ?? id,
        description: fields.description ?? '',
        skills: fields.skills ?? [],
        cliTools: fields.cliTools ?? [],
        mcpServers: fields.mcpServers ?? [],
        harnesses: fields.harnesses ?? ['omp'],
        ...(fields.alias ? { alias: fields.alias } : {}),
        ...(fields.copyAuth ? { copyAuth: true } : {}),
        ...(fields.includeCoreMcp === false ? { includeCoreMcp: false } : {}),
      };
      state.profiles[id] = profile;
      saveProfilesState(state);
      sendJson(res, 201, {
        profile: { ...profile, id, origin: 'user' },
      });
      return;
    }

    // /api/profiles/:id[/plan|/sync]
    const profMatch = /^\/api\/profiles\/([^/]+)(\/(plan|sync))?$/.exec(pathname);
    if (profMatch) {
      const id = decodeURIComponent(profMatch[1]);
      const sub = profMatch[3];
      const manifest = loadManifest();
      const state = loadProfilesState();

      if (sub === 'plan' && method === 'GET') {
        const profile = findProfile(manifest, state, id);
        if (!profile) throw httpError(404, `unknown profile: ${id}`);
        const raw = searchParams.get('project');
        const projectRoot = raw ? resolveProjectParam(raw) : null;
        const plan = planProfile(profile, manifest, projectRoot, { home });
        sendJson(res, 200, {
          profile: id,
          warnings: plan.warnings,
          artifacts: plan.artifacts.map(a => ({
            harness: a.harness, scope: a.scope, dest: a.dest,
          })),
          invoke: invokeStrings(profile),
        });
        return;
      }

      if (sub === 'sync' && method === 'POST') {
        const profile = findProfile(manifest, state, id);
        if (!profile) throw httpError(404, `unknown profile: ${id}`);
        const body = await readJsonBody(req);
        const projectRoot = body.project
          ? resolveProjectParam(body.project) : null;
        const plan = planProfile(profile, manifest, projectRoot, { home });
        const results = applyProfilePlan(plan, profile, state, { home });
        saveProfilesState(state);
        sendJson(res, 200, {
          skills: skillStatus(profile, { home }),
          warnings: plan.warnings,
          results,
          invoke: invokeStrings(profile),
        });
        return;
      }

      // PUT /api/profiles/:id - user profiles replace editable fields;
      // kit profiles merge them into state.overrides[id] ({disabled:true}
      // hides a kit profile).
      if (!sub && method === 'PUT') {
        const body = await readJsonBody(req);
        const isUser = isObject(state.profiles[id]);
        const isKit = (manifest.profiles || []).some(p => p.id === id);
        if (!isUser && !isKit) {
          throw httpError(404, `unknown profile: ${id}`);
        }
        const fields = pickProfileFields(body, manifest, state);
        if (isUser) {
          state.profiles[id] = { ...state.profiles[id], ...fields };
        } else {
          state.overrides[id] = { ...state.overrides[id], ...fields };
          if (body.disabled === true) state.overrides[id].disabled = true;
          if (body.disabled === false) delete state.overrides[id].disabled;
        }
        saveProfilesState(state);
        sendJson(res, 200, {
          profile: findProfile(manifest, state, id),
        });
        return;
      }

      // DELETE /api/profiles/:id - remove recorded artifacts, then drop the
      // user profile and/or kit override. The kit manifest definition is
      // never touched (kitProfile:true tells the UI it persists).
      if (!sub && method === 'DELETE') {
        const isUser = isObject(state.profiles[id]);
        const isKit = (manifest.profiles || []).some(p => p.id === id);
        if (!isUser && !isKit && !isObject(state.overrides[id])) {
          throw httpError(404, `unknown profile: ${id}`);
        }
        const removed = deleteProfileArtifacts(id, state, { home });
        delete state.profiles[id];
        delete state.overrides[id];
        saveProfilesState(state);
        sendJson(res, 200, { removed, kitProfile: isKit });
        return;
      }

      throw httpError(405, 'method not allowed');
    }
    // GET /api/skills - manifest skill catalog + presence + cliTools.
    if (method === 'GET' && pathname === '/api/skills') {
      const manifest = loadManifest();
      const skillRows = (manifest.skills || []).map(s => ({
        name: s.name,
        source: s.source,
        skill: s.skill,
        category: s.category || '',
        required: !!s.required,
        installed: skillStatus({ skills: [s.name] }, { home })[0].present,
      }));
      const templateRows = (manifest.templateSkills || []).map(t => ({
        name: t.dest,
        source: 'kit template',
        skill: t.dest,
        category: 'template',
        required: !!t.required,
        installed: skillStatus({ skills: [t.dest] }, { home })[0].present,
      }));
      const toolRows = (manifest.cliTools || []).map(t => ({
        name: t.name, install: t.install, check: t.check,
        required: !!t.required, category: t.category || '',
        hint: t.hint || '',
      }));
      sendJson(res, 200, {
        skills: [...skillRows, ...templateRows],
        cliTools: toolRows,
        mcpServers: (manifest.mcpServers || []).map(s => ({
          name: s.name, tier: s.tier || 'core', required: !!s.required,
          hint: s.hint || '',
        })),
      });
      return;
    }

    // POST /api/skills/install|update {name} - runs npx skills add/update.
    // Commands come from manifest metadata (source@skill for install, name
    // for update) - arbitrary input never reaches the shell (execFile, no
    // shell:true).
    if (method === 'POST' && /^\/api\/skills\/(install|update)$/.test(pathname)) {
      const action = pathname.endsWith('install') ? 'install' : 'update';
      const body = await readJsonBody(req);
      const manifest = loadManifest();
      const entry = (manifest.skills || []).find(s => s.name === body.name);
      if (!entry) throw httpError(400, `unknown skill: ${body.name}`);
      const args = action === 'install'
        ? ['skills', 'add', `${entry.source}@${entry.skill}`, '-g', '-y']
        : ['skills', 'update', entry.name, '-g', '-y'];
      const result = await new Promise(resolve => {
        execFile('npx', args, { timeout: 300000, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout, stderr) => resolve({
            ok: !err,
            command: `npx ${args.join(' ')}`,
            output: String(stdout || '').slice(-4000),
            error: err ? String(stderr || err.message || 'failed').slice(-2000) : null,
          }));
      });

      sendJson(res, result.ok ? 200 : 500, result);
      return;
    }
    // POST /api/catalog/skill {name, source, skill} - declare a custom
    // (user-catalog) skill so profiles can reference it. Does NOT install;
    // use /api/skills/install afterwards to run npx skills add.
    if (method === 'POST' && pathname === '/api/catalog/skill') {
      const body = await readJsonBody(req);
      const manifest = loadManifest();
      const state = loadProfilesState();
      const { name, source, skill } = body;
      if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-_]*$/i.test(name)) {
        throw httpError(400, 'name must be letters/digits/dash/underscore');
      }
      const src = typeof source === 'string' ? source.trim() : '';
      if (src && !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(src)) {
        throw httpError(400, "source must look like 'owner/repo'");
      }
      if ((manifest.skills || []).some(s => s.name === name)
          || state.custom.skills.some(s => s.name === name)) {
        throw httpError(409, `skill '${name}' already in catalog`);
      }
      // Best-effort reachability check: does the source repo exist?
      const check = { ok: null, detail: 'no source given — repo check skipped' };
      if (src) {
        const probe = spawnSync('git',
          ['ls-remote', '--exit-code', `https://github.com/${src}.git`, 'HEAD'],
          { timeout: 15000, encoding: 'utf8' });
        check.ok = !probe.error && probe.status === 0;
        check.detail = probe.error
          ? `git ls-remote failed: ${probe.error.message}`
          : probe.status === 0
            ? `github.com/${src} reachable`
            : `github.com/${src} not reachable (exit ${probe.status})`;
      }
      const entry = {
        name,
        source: src,
        skill: typeof skill === 'string' && skill.trim() ? skill.trim() : name,
        category: typeof body.category === 'string' ? body.category : 'custom',
      };
      state.custom.skills.push(entry);
      saveProfilesState(state);
      sendJson(res, 201, { skill: entry, check });
      return;
    }

    // POST /api/catalog/mcp {name, command, args?, env?, tier?} - declare a
    // custom MCP server; profiles can reference it and emitters write the
    // config into profile destinations.
    if (method === 'POST' && pathname === '/api/catalog/mcp') {
      const body = await readJsonBody(req);
      const manifest = loadManifest();
      const state = loadProfilesState();
      const { name, command } = body;
      if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-_]*$/i.test(name)) {
        throw httpError(400, 'name must be letters/digits/dash/underscore');
      }
      if (typeof command !== 'string' || !command.trim()) {
        throw httpError(400, 'command is required');
      }
      if ((manifest.mcpServers || []).some(s => s.name === name)
          || state.custom.mcpServers.some(s => s.name === name)) {
        throw httpError(409, `mcp server '${name}' already exists`);
      }
      const entry = {
        name,
        tier: body.tier === 'core' ? 'core' : 'specialist',
        hint: typeof body.hint === 'string' ? body.hint : 'user-declared server',
        config: {
          command: command.trim(),
          args: Array.isArray(body.args)
            ? body.args.map(String) : [],
          env: isObject(body.env)
            ? Object.fromEntries(Object.entries(body.env).map(([k, v]) => [k, String(v)]))
            : {},
        },
      };
      // Sanity check: is the launch command on PATH?
      const check = { ok: which(command.trim().split(/\s+/)[0]),
        detail: which(command.trim().split(/\s+/)[0])
          ? `'${command.trim()}' found on PATH`
          : `'${command.trim()}' NOT on PATH on this machine — profile destinations will still be written, but the server may not launch here` };
      state.custom.mcpServers.push(entry);
      saveProfilesState(state);
      sendJson(res, 201, { mcpServer: entry, check });
      return;
    }

    // DELETE /api/catalog/mcp?name= - remove a custom server (refused while
    // any profile still references it).
    if (method === 'DELETE' && pathname === '/api/catalog/mcp') {
      const name = searchParams.get('name');
      if (!name) throw httpError(400, 'missing required query param: name');
      const state = loadProfilesState();
      const idx = state.custom.mcpServers.findIndex(s => s.name === name);
      if (idx === -1) throw httpError(404, `unknown custom server: ${name}`);
      const refs = effectiveProfiles(loadManifest(), state)
        .filter(p => (p.mcpServers || []).includes(name)).map(p => p.id);
      if (refs.length) {
        throw httpError(409,
          `server '${name}' is referenced by profiles: ${refs.join(', ')}`);
      }
      state.custom.mcpServers.splice(idx, 1);
      saveProfilesState(state);
      sendJson(res, 200, { removed: name });
      return;
    }

    // DELETE /api/catalog/skill?name= - remove a custom skill ref.
    if (method === 'DELETE' && pathname === '/api/catalog/skill') {
      const name = searchParams.get('name');
      if (!name) throw httpError(400, 'missing required query param: name');
      const state = loadProfilesState();
      const idx = state.custom.skills.findIndex(s => s.name === name);
      if (idx === -1) throw httpError(404, `unknown custom skill: ${name}`);
      const refs = effectiveProfiles(loadManifest(), state)
        .filter(p => (p.skills || []).includes(name)).map(p => p.id);
      if (refs.length) {
        throw httpError(409,
          `skill '${name}' is referenced by profiles: ${refs.join(', ')}`);
      }
      state.custom.skills.splice(idx, 1);
      saveProfilesState(state);
      sendJson(res, 200, { removed: name });
      return;
    }

    // POST /api/profiles/:id/rename {newId} - rename a user profile and
    // rekey its recorded artifacts (kit profiles are read-only names).
    const renameMatch = /^\/api\/profiles\/([^/]+)\/rename$/.exec(pathname);
    if (renameMatch && method === 'POST') {
      const id = decodeURIComponent(renameMatch[1]);
      const body = await readJsonBody(req);
      const newId = body.newId;
      if (typeof newId !== 'string' || !PROFILE_ID_RE.test(newId)) {
        throw httpError(400, 'newId must match /^[a-z0-9][a-z0-9-]*$/');
      }
      const manifest = loadManifest();
      const state = loadProfilesState();
      if (!isObject(state.profiles[id])) {
        if ((manifest.profiles || []).some(p => p.id === id)) {
          throw httpError(400,
            'kit profiles cannot be renamed — create a user profile instead');
        }
        throw httpError(404, `unknown profile: ${id}`);
      }
      if (isObject(state.profiles[newId])
          || (manifest.profiles || []).some(p => p.id === newId)) {
        throw httpError(409, `profile '${newId}' already exists`);
      }
      state.profiles[newId] = state.profiles[id];
      delete state.profiles[id];
      const rekeyed = {};
      for (const [k, v] of Object.entries(state.artifacts)) {
        rekeyed[k.startsWith(`${id}:`) ? `${newId}:${k.slice(id.length + 1)}` : k] = v;
      }
      state.artifacts = rekeyed;
      saveProfilesState(state);
      sendJson(res, 200, { renamed: { from: id, to: newId } });
      return;
    }

    // GET /api/doctor - per-project health findings (doctor.checkProject).
    if (method === 'GET' && pathname === '/api/doctor') {
      const manifest = loadManifest();
      const manifestPath = resolveManifestPath(undefined);
      const ctx = {
        manifest,
        manifestPath,
        manifestRoot: path.dirname(manifestPath),
        plan: buildManagedPlan(manifest),
        kitCommit: getKitCommit(),
        staleDays: 30,
      };
      const reg = loadRegistry();
      sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        kitCommit: ctx.kitCommit,
        projects: reg.projects.map(e => checkProject(e, ctx)),
      });
      return;
    }

    // GET /api/project/detail?path= - agents, config files present, kit vs
    // project skill status, profile artifacts touching this project.
    if (method === 'GET' && pathname === '/api/project/detail') {
      const raw = searchParams.get('path');
      if (!raw) throw httpError(400, 'missing required query param: path');
      const projectRoot = resolveProjectParam(raw);
      if (!fs.existsSync(projectRoot)) {
        throw httpError(400, `project path does not exist: ${projectRoot}`);
      }
      const manifest = loadManifest();
      const profiles = manifest.agentProfiles || {};
      const reg = loadRegistry();
      const entry = reg.projects.find(p => path.resolve(p.path) === projectRoot);
      const agents = (entry?.agents || []).map(name => {
        const ap = profiles[name] || {};
        const files = [ap.instructionsFile, ap.mcpConfigPath,
          ap.hooksConfigPath, ap.rulesDir]
          .filter(Boolean)
          .map(rel => ({ rel, exists: fs.existsSync(path.join(projectRoot, rel)) }));
        return {
          name,
          files,
          specialist: ap.specialist?.kind || 'none',
          mcpConfigPath: ap.mcpConfigPath || null,
          rulesDir: ap.rulesDir || null,
          skillDirs: ap.skillDirs || [],
        };
      });
      // MCP servers actually present per agent config file.
      const mcpPresent = {};
      for (const [name, ap] of Object.entries(profiles)) {
        if (!ap.mcpConfigPath || !(entry?.agents || []).includes(name)) continue;
        const p = path.join(projectRoot, ap.mcpConfigPath);
        try {
          const j = readJson(p);
          mcpPresent[name] = Object.keys(j?.[ap.mcpConfigKey || 'mcpServers'] || {});
        } catch { mcpPresent[name] = []; }
      }
      // Specialist profile artifacts planned for this project.
      const state = loadProfilesState();
      const profs = effectiveProfiles(manifest, state).map(p => {
        const plan = planProfile(p, manifest, projectRoot, { home });
        return {
          id: p.id, origin: p.origin,
          artifacts: plan.artifacts.map(a => ({
            harness: a.harness, dest: a.dest,
            exists: fs.existsSync(a.absPath),
          })),
        };
      });
      sendJson(res, 200, {
        path: projectRoot,
        name: entry?.name || path.basename(projectRoot),
        agents,
        mcpPresent,
        profiles: profs,
        requiredSkills: (manifest.skills || [])
          .filter(s => s.required)
          .map(s => ({
            name: s.name,
            installed: skillStatus({ skills: [s.name] }, { home })[0].present,
          })),
      });
      return;
    }

    // GET /api/history?project=<path>
    if (method === 'GET' && pathname === '/api/history') {
      const raw = searchParams.get('project');
      if (!raw) throw httpError(400, 'missing required query param: project');
      const projectRoot = resolveProjectParam(raw);
      const entry = loadRegistry().projects
        .find(p => path.resolve(p.path) === projectRoot);
      let history = [];
      if (entry) {
        if (Array.isArray(entry.history) && entry.history.length) {
          history = entry.history;
        } else if (entry.lastSyncResult) {
          history = [entry.lastSyncResult];
        }
      }
      sendJson(res, 200, { project: projectRoot, history });
      return;
    }

    // GET /api/onboard/agents - runner table for the view's --agent picker
    // plus bootstrap harnesses (agentProfiles) with PATH detection.
    if (method === 'GET' && pathname === '/api/onboard/agents') {
      const manifest = loadManifest();
      const harnesses = Object.keys(manifest.agentProfiles || {}).map(name => {
        // Same-name runner binary detects the harness CLI (devin->devin,
        // omp->omp, claude-code->claude, cursor->cursor-agent, etc.).
        const runner = manifest.onboardingAgents?.[name];
        const binary = runner?.detect ?? name;
        return { name, binary, available: which(binary),
          specialist: !!manifest.agentProfiles[name]?.specialist };
      });
      sendJson(res, 200, { agents: listRunners(), harnesses });
      return;
    }

    // POST /api/onboard/plans {target, profile?, agent?, installSkills?}
    if (method === 'POST' && pathname === '/api/onboard/plans') {
      const body = await readJsonBody(req);
      if (typeof body.target !== 'string' || !body.target) {
        throw httpError(400, 'target must be a non-empty string');
      }
      const projectRoot = path.resolve(body.target);
      if (!fs.existsSync(projectRoot)) {
        throw httpError(400, `target path does not exist: ${projectRoot}`);
      }
      const rows = buildOnboardRows(projectRoot, {
        profile: body.profile || 'devin',
      }).rows;
      // Shell fact rows - same call the CLI makes (never writes).
      const factRows = await scaffoldFacts(projectRoot, body.profile || 'devin', !!body.installSkills);
      const plan = mergeFactRows(rows, factRows);
      const byAction = {};
      for (const r of plan) byAction[r.action] = (byAction[r.action] || 0) + 1;
      const planId = crypto.randomUUID();
      const record = {
        id: planId,
        kind: 'onboard',
        createdAt: new Date().toISOString(),
        target: projectRoot,
        profile: body.profile || 'devin',
        agent: body.agent || 'devin',
        resolveWith: body.resolveWith || null,
        installSkills: !!body.installSkills,
        plan,
        summary: { total: plan.length, byAction },
      };
      putOnboardPlan(planId, record);
      sendJson(res, 200, { planId, ...record });
      return;
    }

    // /api/onboard/plans/:id[/apply|/resolve]
    const onbMatch = /^\/api\/onboard\/plans\/([^/]+)(\/(apply|resolve))?$/.exec(pathname);
    if (onbMatch) {
      const plan = getOnboardPlan(onbMatch[1]);
      const sub = onbMatch[3];

      if (!sub && method === 'GET') {
        sendJson(res, 200, plan);
        return;
      }

      // POST /apply {accepted: string[], content?: {<artifact>: text}}
      // Runs the real scaffold with an --only allowlist of the accepted
      // artifacts; `content` (agent-resolved or edited text) is written to
      // the artifact's file first, guarded by the marker scan.
      if (sub === 'apply' && method === 'POST') {
        const body = await readJsonBody(req);
        if (!Array.isArray(body.accepted)) {
          throw httpError(400, 'accepted must be an array of artifact names');
        }
        const valid = new Set(plan.plan.map(r => r.artifact));
        for (const a of body.accepted) {
          if (!valid.has(a)) throw httpError(400, `artifact not in plan: ${a}`);
        }
        // Write accepted content edits before the scaffold run so
        // record-state captures the resolved bytes. File artifacts only -
        // region keys map to their file; (project) is bookkeeping.
        if (isObject(body.content)) {
          for (const [artifact, text] of Object.entries(body.content)) {
            if (typeof text !== 'string') {
              throw httpError(400, `content for ${artifact} must be a string`);
            }
            if (!valid.has(artifact)) {
              throw httpError(400, `content artifact not in plan: ${artifact}`);
            }
            const dest = artifact.split(':')[0];
            // Region artifacts keep their markers: a resolved file whose
            // markers vanished would desync the region record (sync could
            // no longer locate the managed block).
            const regionId = artifact.includes(':') ? artifact.split(':')[1] : null;
            if (regionId && extractRegion(text, regionId) === null) {
              throw httpError(400,
                `resolved content for ${artifact} dropped the ${regionId} markers - the kit-managed region must survive`);
            }
            writeFileAtomic(path.join(plan.target, dest), text);
          }
        }
        const files = body.accepted.filter(a => a !== '(project)');
        const result = await scaffoldApply(plan.target, plan.profile, files, plan.installSkills);
        sendJson(res, result.ok ? 200 : 500, {
          ok: result.ok,
          applied: body.accepted,
          error: result.error || null,
        });
        return;
      }

      // POST /resolve {artifact, runner?} - agent-assisted resolution.
      // Spawns the runner with a resolve prompt; returns its stdout. The
      // caller then applies via /apply's content path (marker scan runs
      // there for region artifacts).
      if (sub === 'resolve' && method === 'POST') {
        const body = await readJsonBody(req);
        const row = plan.plan.find(r => r.artifact === body.artifact);
        if (!row) throw httpError(400, `artifact not in plan: ${body.artifact}`);
        const runnerKey = body.runner || plan.resolveWith || plan.agent;
        const dest = row.artifact.split(':')[0];
        const destAbs = path.join(plan.target, dest);
        const current = fs.existsSync(destAbs) ? fs.readFileSync(destAbs, 'utf8') : '';
        const prompt = [
          `You are resolving an onboarding conflict in project ${plan.target}.`,
          `Artifact: ${row.artifact}`,
          '',
          '## Planned change (diff)',
          row.diff || '(no diff)',
          '',
          '## Current file content',
          current || '(file does not exist)',
          '',
          'Output the resolved file content ONLY - no commentary, no markdown fences.',
        ].join('\n');
        const res2 = spawnRunner(runnerKey, prompt, { cwd: plan.target });
        if (!res2.ok) throw httpError(400, res2.error || 'runner failed');
        sendJson(res, 200, {
          artifact: row.artifact,
          runner: runnerKey,
          content: res2.stdout,
        });
        return;
      }

      throw httpError(405, 'method not allowed');
    }


    if (pathname === '/api/projects' || pathname === '/api/history'
        || pathname === '/api/dry-run' || pathname === '/api/onboard/agents'
        || pathname.startsWith('/api/profiles')
        || pathname.startsWith('/api/plans/')
        || pathname.startsWith('/api/onboard/plans')) {
      throw httpError(405, 'method not allowed');
    }
    throw httpError(404, 'not found');
  }

  const server = http.createServer((req, res) => {
    (async () => {
      const bound = server.address()?.port;
      if (!hostAllowed(req, bound)) {
        sendError(res, httpError(403, 'forbidden host'));
        return;
      }
      if (!originAllowed(req, bound)) {
        sendError(res, httpError(403, 'forbidden origin'));
        return;
      }
      let url;
      try {
        url = new URL(req.url, 'http://x');
      } catch {
        sendError(res, httpError(400, 'bad request URL'));
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, httpError(405, 'method not allowed'));
        return;
      }
      serveStatic(req, res, url.pathname);
    })().catch(err => sendError(res, err));
  });

  return { server, plans, onboardPlans };
}

/**
 * Start the server on 127.0.0.1. Resolves with {server, plans, port, url}.
 *
 * @param {object} opts {port?, uiDir?, maxPlans?, planTtlMs?}
 */
export async function startUiServer(opts = {}) {
  const { server, plans, onboardPlans } = createUiServer(opts);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4173, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return { server, plans, onboardPlans, port, url: `http://127.0.0.1:${port}` };
}
