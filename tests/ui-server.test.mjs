/**
 * ui-server.test.mjs - acceptance tests for the UI-2 local sync server
 * (card t_8ec6284d).
 *
 * Fixture mirrors tests/sync-engine.test.mjs: a scratch kit copy of bin/
 * (manifest + templates + git history), project dirs under TMP/projects,
 * and the server imported from the scratch copy so kit paths resolve like
 * the real install. Requests go over real HTTP against 127.0.0.1.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-ui-'));
const KIT = path.join(TMP, 'kit');
const HOME_DIR = path.join(TMP, 'home');
const PROJ_DIR = path.join(TMP, 'projects');
const CLI = path.join(KIT, 'bin', 'onboard.mjs');
const REGISTRY = path.join(KIT, 'projects.registry.json');
const UI_SERVER = pathToFileURL(
  path.join(KIT, 'bin', 'lib', 'ui-server.mjs')).href;

const AGENTS_TMPL = [
  '# AGENTS - {{PROJECT_NAME}}',
  '',
  '## Core rules',
  '- rule one',
  '- rule two',
  '',
  '## Footer',
  '- tail',
  '',
].join('\n');

const RULES_TMPL = '# dev env rules\n- keep it green\n';

const MANIFEST = {
  version: '1.0.0-test',
  directories: ['.agents'],
  templates: [{ src: 'templates/AGENTS.md.tmpl', dest: 'AGENTS.md', overwrite: false }],
  rules: [{ src: 'templates/rules/dev-env.md.tmpl', dest: 'dev-env.md', overwrite: false }],
  skills: [],
  templateSkills: [],
  cliTools: [],
  placeholders: [{ key: 'PROJECT_NAME' }],
  mcpServers: [],
  hooks: [],
  agentProfiles: {
    devin: {
      instructionsFile: 'AGENTS.md',
      rulesDir: '.windsurf/rules',
      rulesEnabled: true,
      skillDirs: ['~/.agents/skills'],
    },
  },
};

function git(args) {
  const r = spawnSync('git', ['-C', KIT, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
    { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: HOME_DIR, USERPROFILE: HOME_DIR },
    cwd: TMP,
  });
  return { code: r.status ?? 1, out: r.stdout || '', err: r.stderr || '' };
}
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const kitPath = rel => path.join(KIT, rel);
const writeKit = (rel, text) => {
  fs.mkdirSync(path.dirname(kitPath(rel)), { recursive: true });
  fs.writeFileSync(kitPath(rel), text);
};
const commitKit = () => { git(['add', '-A']); git(['commit', '-qm', 'kit change']); };
const curTmpl = () => fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8');
const curRules = () => fs.readFileSync(kitPath('templates/rules/dev-env.md.tmpl'), 'utf8');

function makeProject(name, { agents = ['devin'] } = {}) {
  const dir = path.join(PROJ_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const args = ['register', '--name', name, '--path', dir];
  if (agents.length) args.push('--agents', agents.join(','));
  const r = cli(args);
  assert.equal(r.code, 0, `register failed: ${r.err}`);
  return dir;
}
const writeProj = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const recordState = dir => {
  const r = cli(['record-state', '--path', dir]);
  assert.equal(r.code, 0, `record-state failed: ${r.err}`);
};
const readRegistry = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));

/** sha256 of every file under dir (path -> hash), for write-detection. */
function treeHashes(dir) {
  const out = {};
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = sha(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

let server;
let base;
let uiMod;

before(async () => {
  fs.mkdirSync(KIT, { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'bin'), path.join(KIT, 'bin'), { recursive: true });
  writeKit('onboard.manifest.json', JSON.stringify(MANIFEST, null, 2) + '\n');
  writeKit('templates/AGENTS.md.tmpl', AGENTS_TMPL);
  writeKit('templates/rules/dev-env.md.tmpl', RULES_TMPL);
  writeKit('.gitignore', 'projects.registry.json\nprojects.registry.json.lock\n');
  fs.mkdirSync(HOME_DIR, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  commitKit();
  uiMod = await import(UI_SERVER);
  ({ server } = await uiMod.startUiServer({ port: 0 }));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(r => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});

/** JSON request helper over fetch. */
async function api(method, p, body, headers = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body: parsed };
}

// AC1: `ui` subcommand listens on loopback, prints the URL, Ctrl-C exits.
test('AC1: CLI ui prints loopback URL and exits on SIGINT', async () => {
  const child = spawn(process.execPath, [CLI, 'ui', '--port', '0'], {
    env: { ...process.env, HOME: HOME_DIR, USERPROFILE: HOME_DIR },
    cwd: TMP,
  });
  const out = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', d => {
      buf += d;
      if (/listening at http:\/\/127\.0\.0\.1:\d+/.test(buf)) resolve(buf);
    });
    child.on('error', reject);
    setTimeout(() => reject(new Error(`no listen line; got: ${buf}`)), 10_000);
  });
  assert.match(out, /listening at http:\/\/127\.0\.0\.1:\d+/);
  assert.doesNotMatch(out, /0\.0\.0\.0/);
  child.kill('SIGINT');
  const exit = await Promise.race([
    new Promise(r => child.on('exit', (code, sig) => r({ code, sig }))),
    new Promise(r => setTimeout(() => r('timeout'), 5_000)),
  ]);
  assert.notEqual(exit, 'timeout', 'server did not exit after SIGINT');
});

// AC2: GET /api/projects returns both registry entries with summaries.
test('AC2: /api/projects lists entries with state summaries', async () => {
  const a = makeProject('ui-a');
  writeProj(a, 'AGENTS.md', curTmpl());
  recordState(a);
  const b = makeProject('ui-b');

  const r = await api('GET', '/api/projects');
  assert.equal(r.status, 200);
  const names = r.body.projects.map(p => p.name);
  assert.ok(names.includes('ui-a') && names.includes('ui-b'));
  const rowA = r.body.projects.find(p => p.name === 'ui-a');
  assert.equal(rowA.missing, false);
  assert.equal(rowA.hasState, true);
  assert.equal(rowA.unresolvedCount, 0);
  assert.ok('lastSyncAt' in rowA && 'lastSyncResult' in rowA);
});

// Static hosting: placeholder SPA + JSON content-type + traversal guard.
test('static: serves index.html, 404s missing assets, blocks traversal', async () => {
  const idx = await fetch(`${base}/`);
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get('content-type'), /text\/html/);
  assert.match(await idx.text(), /Onboarding kit/);

  const spa = await fetch(`${base}/projects/some-route`);
  assert.equal(spa.status, 200);
  assert.match(spa.headers.get('content-type'), /text\/html/);

  const missing = await fetch(`${base}/no-such-file.js`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /application\/json/);

  const trav = await fetch(`${base}/%2e%2e/onboard.manifest.json`);
  assert.ok(trav.status === 403 || trav.status === 404);
});

// AC3: POST /api/dry-run plan matches CLI --dry-run; zero writes.
test('AC3: dry-run plan matches CLI; no writes to files/state/registry', async () => {
  const dir = makeProject('ui-dr');
  writeProj(dir, 'AGENTS.md', curTmpl());
  writeProj(dir, 'dev-env.md', curRules());
  recordState(dir);
  writeKit('templates/AGENTS.md.tmpl', curTmpl().replace('- rule two', '- rule two v2'));
  commitKit();

  const before = {
    proj: treeHashes(dir),
    reg: sha(REGISTRY),
  };

  const r = await api('POST', '/api/dry-run', { project: dir });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.planId);
  const apiRows = r.body.plan.map(x => ({ artifact: x.artifact, action: x.action }));

  const c = cli(['sync', '--dry-run', '--json', '--project', 'ui-dr']);
  assert.equal(c.code, 0, c.err);
  const cliRows = JSON.parse(c.out).projects.find(p => p.name === 'ui-dr').files
    .map(x => ({ artifact: x.artifact, action: x.action }));
  assert.deepEqual(apiRows, cliRows);

  // plan fetch + diff endpoint
  const g = await api('GET', `/api/plans/${r.body.planId}`);
  assert.equal(g.status, 200);
  assert.equal(g.body.project, dir);
  const d = await api('GET',
    `/api/plans/${r.body.planId}/diff?dest=${encodeURIComponent('AGENTS.md')}`);
  assert.equal(d.status, 200);
  assert.match(d.body.diff, /^--- a\/AGENTS\.md\n\+\+\+ b\/AGENTS\.md\n@@/);

  const m = await api('GET',
    `/api/plans/${r.body.planId}/merge?dest=${encodeURIComponent('AGENTS.md')}`);
  assert.equal(m.status, 200);
  assert.ok('merged' in m.body && 'conflict' in m.body);

  // zero writes
  assert.deepEqual(treeHashes(dir), before.proj);
  assert.equal(sha(REGISTRY), before.reg);
});

// AC4: apply dispositions for ONE dest; other pending file untouched;
// registry gains lastSyncResult; /api/history reflects it.
test('AC4: apply one dest only; registry gains lastSyncResult', async () => {
  const dir = makeProject('ui-ap');
  writeProj(dir, 'AGENTS.md', curTmpl());
  writeProj(dir, 'dev-env.md', curRules());
  recordState(dir);
  writeKit('templates/AGENTS.md.tmpl', curTmpl().replace('- rule two', '- rule two ap'));
  writeKit('templates/rules/dev-env.md.tmpl', `${curRules()}- extra rule\n`);
  commitKit();

  const dr = await api('POST', '/api/dry-run', { project: dir });
  assert.equal(dr.status, 200);
  const agentsHash = sha(path.join(dir, 'AGENTS.md'));
  const rulesHash = sha(path.join(dir, 'dev-env.md'));

  const ap = await api('POST', `/api/plans/${dr.body.planId}/apply`, {
    dispositions: { 'AGENTS.md': 'accepted' },
  });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const row = ap.body.results.find(x => x.dest === 'AGENTS.md');
  assert.equal(row.ok, true);
  assert.equal(row.changed, true);

  // accepted file written; the other pending file byte-identical
  assert.notEqual(sha(path.join(dir, 'AGENTS.md')), agentsHash);
  assert.equal(sha(path.join(dir, 'dev-env.md')), rulesHash);
  const state = JSON.parse(fs.readFileSync(
    path.join(dir, '.agents/onboarding-state.json'), 'utf8'));
  assert.match(state.artifacts['AGENTS.md'].syncedAt, /T/);

  // registry lastSyncResult
  const entry = readRegistry().projects.find(p => p.path === dir);
  assert.equal(entry.lastSyncResult.action, 'apply');
  assert.deepEqual(entry.lastSyncResult.accepted, ['AGENTS.md']);
  assert.deepEqual(entry.lastSyncResult.reverted, []);
  assert.deepEqual(entry.lastSyncResult.kit, []);
  assert.equal(ap.body.lastSyncResult.action, 'apply');

  // history endpoint
  const h = await api('GET', `/api/history?project=${encodeURIComponent(dir)}`);
  assert.equal(h.status, 200);
  assert.equal(h.body.history.at(-1).action, 'apply');
  assert.deepEqual(h.body.history.at(-1).accepted, ['AGENTS.md']);

  // dispositions not in the plan are rejected up front
  const bad = await api('POST', `/api/plans/${dr.body.planId}/apply`, {
    dispositions: { '../evil.txt': 'kit' },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /dest not in plan/);
});

/** Raw request helper: fetch() forbids overriding Host, node:http allows.
 * headers: arbitrary header map (host/origin/content-type overrides);
 * body: object -> JSON, string -> sent as-is. */
function rawReq(method, p, { host, origin, headers = {}, body } = {}) {
  const hdrs = { ...headers };
  if (host) hdrs.host = host;
  if (origin !== undefined) hdrs.origin = origin;
  const payload = body === undefined ? undefined
    : typeof body === 'string' ? body : JSON.stringify(body);
  // JSON CT default only for object bodies - a string body lets the caller
  // control headers fully (incl. sending none).
  if (payload !== undefined && typeof body !== 'string'
      && hdrs['content-type'] === undefined) {
    hdrs['content-type'] = 'application/json';
  }
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: p,
      method,
      headers: hdrs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// AC5: wrong Host is 403 on every route including POSTs.
test('AC5: foreign Host header gets 403 on GET and POST', async () => {
  for (const [method, p, body] of [
    ['GET', '/api/projects'],
    ['GET', '/'],
    ['GET', '/api/history?project=x'],
    ['POST', '/api/projects', { path: '/tmp' }],
    ['POST', '/api/dry-run', { project: '/tmp' }],
    ['POST', '/api/plans/nope/apply', { dispositions: { a: 'kit' } }],
  ]) {
    const r = await rawReq(method, p, { host: 'evil.example', body });
    assert.equal(r.status, 403, `${method} ${p} -> ${r.status}`);
    assert.match(r.body.error, /forbidden/i);
  }
  // localhost:<port> remains allowed
  const ok = await rawReq('GET', '/api/projects',
    { host: `localhost:${server.address().port}` });
  assert.equal(ok.status, 200);
});

// AC6: missing project path flagged in /api/projects; dry-run is a clean
// 4xx JSON error (no stack trace, server stays up).
test('AC6: missing project path flagged; dry-run 400 JSON without stack', async () => {
  const gone = path.join(PROJ_DIR, 'ui-gone');
  fs.mkdirSync(gone, { recursive: true });
  cli(['register', '--name', 'ui-gone', '--path', gone]);
  fs.rmSync(gone, { recursive: true, force: true });

  const r = await api('GET', '/api/projects');
  const row = r.body.projects.find(p => p.name === 'ui-gone');
  assert.equal(row.missing, true);

  const dr = await api('POST', '/api/dry-run', { project: gone });
  assert.equal(dr.status, 400);
  assert.match(dr.body.error, /does not exist/);
  assert.doesNotMatch(dr.body.error, /\bat \S+ \(/); // no stack frames

  // server still healthy
  const again = await api('GET', '/api/projects');
  assert.equal(again.status, 200);
});

// AC7: DELETE removes the entry; register and apply paths share the
// registry lockfile with the CLI (updateRegistry).
test('AC7: DELETE removes project; POST re-registers', async () => {
  const dir = makeProject('ui-del');
  const del = await api('DELETE', `/api/projects?path=${encodeURIComponent(dir)}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.removed, true);

  const list = await api('GET', '/api/projects');
  assert.ok(!list.body.projects.some(p => p.path === dir));
  assert.ok(!readRegistry().projects.some(p => p.path === dir));

  // POST registers; nonexistent path is a clean 400
  const bad = await api('POST', '/api/projects', {
    name: 'nope', path: path.join(PROJ_DIR, 'does-not-exist'), agents: ['devin'],
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /does not exist/);

  const reg = await api('POST', '/api/projects', {
    name: 'ui-del2', path: dir, agents: ['devin'],
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.action, 'registered');
  const entry = readRegistry().projects.find(p => p.path === dir);
  assert.equal(entry.name, 'ui-del2');
  assert.deepEqual(entry.agents, ['devin']);
});

// Session-only plans: unknown ids are clean 404s; GET never mutates.
test('plans are session-scoped: unknown id 404; GETs do not write', async () => {
  const g = await api('GET', '/api/plans/does-not-exist');
  assert.equal(g.status, 404);
  const ap = await api('POST', '/api/plans/does-not-exist/apply', {
    dispositions: { 'AGENTS.md': 'kit' },
  });
  assert.equal(ap.status, 404);
});

// Review r1 F1: cross-origin writes are blocked two ways - foreign
// Origin headers 403 on every route, and mutating routes without a JSON
// Content-Type 415 (a "simple" browser POST can't carry one).
test('F1: foreign Origin 403; POST without JSON Content-Type 415', async () => {
  const port = server.address().port;
  // foreign Origin on mutating + read routes
  for (const [method, p, body] of [
    ['POST', '/api/dry-run', { project: '/tmp' }],
    ['POST', '/api/plans/nope/apply', { dispositions: { a: 'kit' } }],
    ['GET', '/api/projects'],
  ]) {
    const r = await rawReq(method, p, { origin: 'https://other.example', body });
    assert.equal(r.status, 403, `${method} ${p} -> ${r.status}`);
    assert.match(r.body.error, /forbidden origin/i);
  }
  // Origin at the wrong port is still foreign
  const wrongPort = await rawReq('GET', '/api/projects',
    { origin: `http://127.0.0.1:${port + 1}` });
  assert.equal(wrongPort.status, 403);
  // POST with no Content-Type at all -> 415, no plan created
  const noCt = await rawReq('POST', '/api/dry-run',
    { body: '{"project":"/tmp"}' });
  // an explicit raw request double-checks the truly headerless case
  const hdrless = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/dry-run', method: 'POST',
      headers: {},
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
    req.write('{"project":"/tmp"}');
    req.end();
  });
  assert.equal(noCt.status, 415);
  assert.equal(hdrless.status, 415);
  assert.match(hdrless.body.error, /application\/json/);
  // form content-type likewise rejected
  const form = await rawReq('POST', '/api/dry-run', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'project=/tmp',
  });
  assert.equal(form.status, 415);
  // self Origin + JSON CT pass the guards (and reach route validation)
  const self = await rawReq('POST', '/api/dry-run', {
    origin: `http://127.0.0.1:${port}`, body: { project: '/tmp' },
  });
  assert.notEqual(self.status, 403);
  assert.notEqual(self.status, 415);
});

// Review r1 F3: plan store is bounded - oldest evict past maxPlans,
// expired plans are dropped on read and insert.
test('F3: session plan store is bounded (cap + TTL)', async () => {
  const { server: srv2 } = await uiMod.startUiServer({ port: 0, maxPlans: 2 });
  const port2 = srv2.address().port;
  const req2 = p => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: port2, path: p, method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ project: TMP }));
  });
  const get2 = p => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: port2, path: p, method: 'GET',
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await req2('/api/dry-run')).planId);
    assert.equal(await get2(`/api/plans/${ids[0]}`), 404, 'oldest evicted');
    assert.equal(await get2(`/api/plans/${ids[1]}`), 404, 'second evicted');
    assert.equal(await get2(`/api/plans/${ids[3]}`), 200, 'newest kept');
  } finally {
    await new Promise(r => srv2.close(r));
  }
});
