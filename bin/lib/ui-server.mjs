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
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  STATE_REL_PATH,
  readJson,
  loadRegistry,
  updateRegistry,
  resolveProjectPath,
} from './common.mjs';
import { isObject } from './sync-utils.mjs';
import { dryRun, mergeFile, applyDisposition } from './sync-engine.mjs';

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
 * @param {object} opts {uiDir?, maxPlans?, planTtlMs?} extras are for tests.
 * @returns {{server: http.Server, plans: Map}}
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
      if (body.agents !== undefined
          && (!Array.isArray(body.agents)
              || body.agents.some(a => typeof a !== 'string'))) {
        throw httpError(400, 'agents must be an array of strings');
      }
      const agents = [...new Set(body.agents || [])];
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

    if (pathname === '/api/projects' || pathname === '/api/history'
        || pathname === '/api/dry-run' || pathname.startsWith('/api/plans/')) {
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

  return { server, plans };
}

/**
 * Start the server on 127.0.0.1. Resolves with {server, plans, port, url}.
 *
 * @param {object} opts {port?, uiDir?, maxPlans?, planTtlMs?}
 */
export async function startUiServer(opts = {}) {
  const { server, plans } = createUiServer(opts);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4173, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return { server, plans, port, url: `http://127.0.0.1:${port}` };
}
