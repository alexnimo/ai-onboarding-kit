/**
 * sync-engine.test.mjs - acceptance tests for the sync-engine library facade
 * (bin/lib/sync-engine.mjs, card t_726e0771 / POR-109 UI-1).
 *
 * AC1: dryRun() rows == `sync --dry-run --json` rows, zero disk writes.
 * AC2: mergeFile() exposes rendered base + merged output + conflict flag.
 * AC3: applyDisposition accepted/reverted/kit semantics.
 * AC5: two dryRun() calls in one process produce identical plans.
 *
 * Self-contained: builds a scratch kit + projects under os.tmpdir().
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-engine-'));
const KIT = path.join(TMP, 'kit');
const HOME_DIR = path.join(TMP, 'home');
const PROJ_DIR = path.join(TMP, 'projects');
const CLI = path.join(KIT, 'bin', 'onboard.mjs');
const REGISTRY = path.join(KIT, 'projects.registry.json');
// The facade runs INSIDE this process against the scratch kit: kit paths
// resolve from the copied lib's location, so import the scratch copy.
const ENGINE = pathToFileURL(path.join(KIT, 'bin', 'lib', 'sync-engine.mjs')).href;

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

const MANIFEST = {
  version: '1.0.0-test',
  directories: ['.agents'],
  templates: [{ src: 'templates/AGENTS.md.tmpl', dest: 'AGENTS.md', overwrite: false }],
  rules: [{ src: 'templates/rules/dev-env.md.tmpl', dest: 'dev-env.md', overwrite: false }],
  skills: [],
  templateSkills: [],
  cliTools: [],
  placeholders: [{ key: 'PROJECT_NAME' }],
  mcpServers: [
    { name: 'semble', required: true, config: { command: 'npx', args: ['-y', '@semblemcp/server@1'], env: {} } },
    { name: 'devtools', required: false, config: { command: 'npx', args: ['-y', 'devtools-mcp@1'], env: {} } },
  ],
  hooks: [
    { event: 'PreToolUse', matcher: 'exec', type: 'command', command: 'ctx pretooluse', required: false },
  ],
  agentProfiles: {
    devin: {
      instructionsFile: 'AGENTS.md',
      mcpConfigPath: '.devin/config.json',
      mcpConfigKey: 'mcpServers',
      hooksConfigPath: '.devin/hooks.v1.json',
      hooksConfigFormat: 'standalone',
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
const kitCommit = () => git(['rev-parse', 'HEAD']);
const curTmpl = () => fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8');

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
const readState = dir =>
  JSON.parse(fs.readFileSync(path.join(dir, '.agents/onboarding-state.json'), 'utf8'));

let engine;
before(async () => {
  fs.mkdirSync(KIT, { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'bin'), path.join(KIT, 'bin'), { recursive: true });
  writeKit('onboard.manifest.json', JSON.stringify(MANIFEST, null, 2) + '\n');
  writeKit('templates/AGENTS.md.tmpl', AGENTS_TMPL);
  writeKit('templates/rules/dev-env.md.tmpl', '# dev env rules\n');
  writeKit('.gitignore', 'projects.registry.json\nprojects.registry.json.lock\n');
  fs.mkdirSync(HOME_DIR, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  commitKit();
  engine = await import(ENGINE);
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

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

// AC1 + AC5: dryRun() matches the CLI plan and writes nothing; repeat is
// identical (no leaked module-level state).
test('AC1+AC5: dryRun plan matches CLI dry-run; zero writes; deterministic', () => {
  const dir = makeProject('ff');
  writeProj(dir, 'AGENTS.md', curTmpl());
  recordState(dir);

  // kit edit pending
  writeKit('templates/AGENTS.md.tmpl', curTmpl().replace('- rule two', '- rule two v2'));
  commitKit();

  const before = {
    proj: treeHashes(dir),
    reg: fs.existsSync(REGISTRY) ? sha(REGISTRY) : null,
  };

  const r1 = engine.dryRun(dir);
  const r2 = engine.dryRun(dir); // AC5: same process, identical plans
  assert.deepEqual(r2.plan, r1.plan);

  const r = cli(['sync', '--dry-run', '--json', '--project', 'ff']);
  assert.equal(r.code, 0, r.err);
  const cliRows = JSON.parse(r.out).projects.find(p => p.name === 'ff').files;
  assert.deepEqual(r1.plan.map(x => ({ artifact: x.artifact, action: x.action, detail: x.detail })),
    cliRows.map(x => ({ artifact: x.artifact, action: x.action, detail: x.detail })));

  const row = r1.plan.find(x => x.artifact === 'AGENTS.md');
  assert.equal(row.action, 'fast-forward');
  assert.match(row.diff, /^--- a\/AGENTS\.md\n\+\+\+ b\/AGENTS\.md\n@@/m);
  assert.match(row.diff, /^-- rule two$/m);
  assert.match(row.diff, /^\+- rule two v2$/m);

  // zero disk writes anywhere
  assert.deepEqual(treeHashes(dir), before.proj);
  assert.equal(fs.existsSync(REGISTRY) ? sha(REGISTRY) : null, before.reg);
});

// AC2: mergeFile materializes rendered base + merge output with conflict.
test('AC2: mergeFile returns rendered base, kit, merged, conflict flag', () => {
  const dir = makeProject('conf');
  // project file installed at the CURRENT template, recorded, then edited
  const baseTmpl = curTmpl();
  writeProj(dir, 'AGENTS.md', baseTmpl);
  recordState(dir);
  const recCommit = readState(dir).artifacts['AGENTS.md'].kitCommit;

  // kit edits the footer region; project edits the rules region (disjoint)
  const kitEdit = baseTmpl.replace('- tail', '- tail v2');
  writeKit('templates/AGENTS.md.tmpl', kitEdit);
  commitKit();
  const localEdit = baseTmpl.replace('- rule two', '- rule two (local)');
  writeProj(dir, 'AGENTS.md', localEdit);

  const m = engine.mergeFile(dir, 'AGENTS.md');
  // base = raw template bytes at the dest's recorded kitCommit (no
  // placeholder values were recorded, so rendering is identity here);
  // verify it comes from history, not the current (edited) source.
  assert.equal(m.base, baseTmpl);
  assert.ok(recCommit, 'recorded kitCommit present');
  assert.equal(m.kit, kitEdit);
  assert.equal(m.project, localEdit);
  assert.equal(m.conflict, false);
  assert.ok(m.merged.includes('- rule two (local)'), 'local edit survives');
  assert.ok(m.merged.includes('- tail v2'), 'kit edit applied');
  assert.equal(m.needsFill, true); // {{PROJECT_NAME}} never recorded -> unfilled

  // same-region edits -> conflict flagged, merged carries markers
  const dir2 = makeProject('conf2');
  const tmpl2 = curTmpl();
  writeProj(dir2, 'AGENTS.md', tmpl2);
  recordState(dir2);
  writeKit('templates/AGENTS.md.tmpl', tmpl2.replace('- tail', '- tail kit2'));
  commitKit();
  writeProj(dir2, 'AGENTS.md', tmpl2.replace('- tail', '- tail proj2'));
  const m2 = engine.mergeFile(dir2, 'AGENTS.md');
  assert.equal(m2.conflict, true);
  assert.match(m2.merged, /^<{7} /m);
});

// AC3: applyDisposition accepted/reverted/kit.
test('AC3: applyDisposition accepted / reverted / kit', () => {
  const dir = makeProject('disp');
  const baseTmpl = curTmpl();
  writeProj(dir, 'AGENTS.md', baseTmpl);
  recordState(dir);
  const kitEdit = baseTmpl.replace('- tail', '- tail v9');
  writeKit('templates/AGENTS.md.tmpl', kitEdit);
  commitKit();
  const localEdit = baseTmpl.replace('- rule two', '- rule two (local)');
  writeProj(dir, 'AGENTS.md', localEdit);
  const before = readState(dir);

  // accepted: engine merge result written, record advanced
  const merged = engine.mergeFile(dir, 'AGENTS.md').merged;
  const ra = engine.applyDisposition(dir, 'AGENTS.md', 'accepted');
  assert.equal(ra.changed, true);
  assert.equal(ra.conflict, false);
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), merged);
  const after = readState(dir);
  assert.equal(after.artifacts['AGENTS.md'].kitCommit, kitCommit());
  assert.notEqual(after.artifacts['AGENTS.md'].kitCommit, before.artifacts['AGENTS.md'].kitCommit);

  // reverted: nothing moves
  writeProj(dir, 'AGENTS.md', localEdit + '# again\n');
  const hashBefore = sha(path.join(dir, 'AGENTS.md'));
  const stateBefore = sha(path.join(dir, '.agents/onboarding-state.json'));
  const rr = engine.applyDisposition(dir, 'AGENTS.md', 'reverted');
  assert.equal(rr.changed, false);
  assert.equal(sha(path.join(dir, 'AGENTS.md')), hashBefore);
  assert.equal(sha(path.join(dir, '.agents/onboarding-state.json')), stateBefore);

  // kit: current kit render lands
  const rk = engine.applyDisposition(dir, 'AGENTS.md', 'kit');
  assert.equal(rk.changed, true);
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), kitEdit);
  assert.equal(readState(dir).artifacts['AGENTS.md'].hash, sha(kitPath('templates/AGENTS.md.tmpl')));
});

// Per-key bases: 'kit' on a config dest resolves only non-deferred keys.
test('kit disposition on config resolves non-deferred keys only', () => {
  const dir = makeProject('cfg');
  writeProj(dir, 'AGENTS.md', curTmpl());
  writeProj(dir, '.devin/config.json', JSON.stringify({
    mcpServers: {
      semble: { command: 'npx', args: ['-y', '@semblemcp/server@1'], env: {} },
      devtools: { command: 'npx', args: ['-y', 'devtools-mcp@1'], env: {} },
    },
  }) + '\n');
  recordState(dir);

  // kit updates BOTH server configs; project pins one key
  writeKit('onboard.manifest.json', JSON.stringify({
    ...MANIFEST,
    mcpServers: [
      { name: 'semble', required: true, config: { command: 'npx', args: ['-y', '@semblemcp/server@2'], env: {} } },
      { name: 'devtools', required: false, config: { command: 'npx', args: ['-y', 'devtools-mcp@2'], env: {} } },
    ],
  }, null, 2) + '\n');
  commitKit();
  const curCommit = kitCommit();

  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const e = reg.projects.find(p => p.name === 'cfg');
  e.overrides = { pins: { '.devin/config.json:mcpServers.semble': 'team-frozen' } };
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + '\n');

  const prevBase = readState(dir).artifacts['.devin/config.json'].kitCommit;
  const rk = engine.applyDisposition(dir, '.devin/config.json', 'kit');
  assert.equal(rk.changed, true);

  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.devin/config.json'), 'utf8'));
  // resolved key follows the kit, deferred key keeps the project's bytes
  assert.equal(cfg.mcpServers.devtools.args[1], 'devtools-mcp@2');
  assert.equal(cfg.mcpServers.semble.args[1], '@semblemcp/server@1');

  // file-level commit advanced (a key was resolved); deferred key's base
  // stays frozen at the previous commit via keyCommits
  const rec = readState(dir).artifacts['.devin/config.json'];
  assert.equal(rec.kitCommit, curCommit);
  assert.equal(rec.keyCommits['.devin/config.json:mcpServers.semble'], prevBase);
});

// Finding (review r1): accepted content must pass the same guards the
// engine applies - no overwriting pinned/exempt dests or foreign files.
test('accepted content respects pins and foreign-file guard', () => {
  const dir = makeProject('guarded');
  writeProj(dir, 'AGENTS.md', curTmpl());
  recordState(dir);

  // foreign file at a managed dest: delete the recorded artifact so the
  // on-disk file has no recorded base
  const stPath = path.join(dir, '.agents', 'onboarding-state.json');
  const st = JSON.parse(fs.readFileSync(stPath, 'utf8'));
  delete st.artifacts['AGENTS.md'];
  fs.writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n');
  const foreign = '# totally custom\n';
  writeProj(dir, 'AGENTS.md', foreign);
  assert.throws(
    () => engine.applyDisposition(dir, 'AGENTS.md', 'accepted', { content: '# hijack\n' }),
    /unmanaged file/);
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), foreign);

  // pinned dest
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const e = reg.projects.find(p => p.name === 'guarded');
  e.overrides = { pins: { 'AGENTS.md': 'frozen' } };
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + '\n');
  const st2 = JSON.parse(fs.readFileSync(stPath, 'utf8'));
  st2.artifacts['AGENTS.md'] = { hash: 'x', source: 'templates/AGENTS.md.tmpl' };
  fs.writeFileSync(stPath, JSON.stringify(st2, null, 2) + '\n');
  assert.throws(
    () => engine.applyDisposition(dir, 'AGENTS.md', 'accepted', { content: '# hijack\n' }),
    /pinned\/exempt/);
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), foreign);
});

// Finding (review r1): accepting edited config content reconciles per-key
// bases - keys at the kit value re-base to this run's commit, differing and
// deferred keys keep frozen bases.
test('accepted config content reconciles per-key bases', () => {
  const dir = makeProject('cfgacc');
  writeProj(dir, 'AGENTS.md', curTmpl());
  writeProj(dir, '.devin/config.json', JSON.stringify({
    mcpServers: {
      semble: { command: 'npx', args: ['-y', '@semblemcp/server@1'], env: {} },
      devtools: { command: 'npx', args: ['-y', 'devtools-mcp@1'], env: {} },
    },
  }) + '\n');
  recordState(dir);
  const prevBase = readState(dir).artifacts['.devin/config.json'].kitCommit;

  // kit bumps both servers past the @2 bump an earlier test left behind
  writeKit('onboard.manifest.json', JSON.stringify({
    ...MANIFEST,
    mcpServers: [
      { name: 'semble', required: true, config: { command: 'npx', args: ['-y', '@semblemcp/server@3'], env: {} } },
      { name: 'devtools', required: false, config: { command: 'npx', args: ['-y', 'devtools-mcp@3'], env: {} } },
    ],
  }, null, 2) + '\n');
  commitKit();
  const curCommit = kitCommit();
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  reg.projects.find(p => p.name === 'cfgacc')
    .overrides = { pins: { '.devin/config.json:mcpServers.semble': 'frozen' } };
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + '\n');

  // Accept content: devtools custom (differs from kit), semble attempt to
  // override the pin (must be neutralized back to on-disk value).
  engine.applyDisposition(dir, '.devin/config.json', 'accepted', {
    content: JSON.stringify({
      mcpServers: {
        semble: { command: 'npx', args: ['-y', '@semblemcp/server@9'], env: {} },
        devtools: { command: 'npx', args: ['-y', 'devtools-mcp@1-custom'], env: { X: '1' } },
      },
    }),
  });
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.devin/config.json'), 'utf8'));
  assert.equal(cfg.mcpServers.semble.args[1], '@semblemcp/server@1', 'pinned key kept on-disk value');
  assert.equal(cfg.mcpServers.devtools.args[1], 'devtools-mcp@1-custom', 'resolved key accepted');

  const rec = readState(dir).artifacts['.devin/config.json'];
  // file-level commit advanced to this run (a write happened); the deferred
  // pin and the still-differing key keep frozen bases via keyCommits so a
  // later sync never evaluates them against a stale file-level base
  assert.equal(rec.kitCommit, curCommit);
  assert.equal(rec.keyCommits['.devin/config.json:mcpServers.semble'], prevBase);
  assert.equal(rec.keyCommits['.devin/config.json:mcpServers.devtools'], prevBase);

  // And a later dryRun does not report a stale-base false conflict for the
  // deferred key - it reports the pin, nothing more.
  const plan = engine.dryRun(dir).plan;
  const sembleRow = plan.find(r => r.artifact === '.devin/config.json:mcpServers.semble');
  assert.equal(sembleRow.action, 'skip');
  const devRow = plan.find(r => r.artifact === '.devin/config.json:mcpServers.devtools');
  assert.equal(devRow.action, 'conflict'); // customized + kit changed: real conflict
});

// Finding (review r1): grouped hunks must not double-count the new-file
// start offset in unified @@ headers.
test('unifiedDiff: multi-edit group emits correct x-range start', () => {
  const old_ = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n';
  const new_ = 'l1\nl2\nl3\nINS\nl4\nl5\nl6\nl7\nEDIT\nl9\n';
  const d = engine.unifiedDiff('f.md', old_, new_);
  const header = d.split('\n').find(l => l.startsWith('@@'));
  // old: lines 1..9 all shown (context) -> -1,9; new: +1,10
  assert.equal(header, '@@ -1,10 +1,11 @@');
  assert.match(d, /^\+INS$/m);
  assert.match(d, /^-l8$/m);
  assert.match(d, /^\+EDIT$/m);

  // second group offset: edit at old line 2 + edit at old line 12 (separate groups)
  const old2 = Array.from({ length: 20 }, (_, i) => `a${i + 1}`).join('\n');
  const new2 = old2.replace('a2', 'A2').replace('a12', 'A12');
  const d2 = engine.unifiedDiff('f.md', old2 + '\n', new2 + '\n');
  const headers = d2.split('\n').filter(l => l.startsWith('@@'));
  assert.equal(headers.length, 2);
  assert.match(headers[0], /^@@ -1,\d+ \+1,\d+ @@/);
  assert.match(headers[1], /^@@ -9,7 \+9,7 @@/);
});

// Finding (code_review r1 F1): config dests are NOT foreign files - the
// engine merges managed keys into unrecorded config files for registered
// agents. 'kit' on such a file applies entries instead of throwing.
test('kit applies entries to unrecorded but agent-relevant config', () => {
  const dir = makeProject('cfgnew');
  writeProj(dir, 'AGENTS.md', curTmpl());
  recordState(dir); // state recorded BEFORE the config file exists
  // foreign-but-parseable config appears afterwards (never recorded)
  writeProj(dir, '.devin/config.json', JSON.stringify({
    mcpServers: { 'my-own': { command: 'custom', args: [] } },
  }) + '\n');

  const r = engine.applyDisposition(dir, '.devin/config.json', 'kit');
  assert.equal(r.changed, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.devin/config.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
  assert.deepEqual(cfg.mcpServers.semble,
    manifest.mcpServers.find(x => x.name === 'semble').config);
  assert.deepEqual(cfg.mcpServers['my-own'], { command: 'custom', args: [] });
  assert.ok(readState(dir).artifacts['.devin/config.json'], 'record created');
});

// Finding (code_review r1 F2): agent-scoped dests must not materialize for
// projects that never registered the agent (kit AND accepted-content).
test('dispositions honor agent scoping for new files', () => {
  const dir = makeProject('noagent', { agents: [] });
  writeProj(dir, 'AGENTS.md', curTmpl());
  recordState(dir);
  assert.throws(
    () => engine.applyDisposition(dir, '.windsurf/rules/dev-env.md', 'kit'),
    /agent/);
  assert.throws(
    () => engine.applyDisposition(dir, '.windsurf/rules/dev-env.md', 'accepted',
      { content: '# manual\n' }),
    /agent/);
  assert.equal(fs.existsSync(path.join(dir, '.windsurf/rules/dev-env.md')), false);
});

// Finding (code_review r1 F3): invalid JSON config is reported as a skip
// row (engine parity), not a raw parse throw.
test('invalid JSON config reports skip instead of throwing', () => {
  const dir = makeProject('cfgbad');
  writeProj(dir, 'AGENTS.md', curTmpl());
  recordState(dir);
  writeProj(dir, '.devin/config.json', '{ not json');
  const stPath = path.join(dir, '.agents', 'onboarding-state.json');
  const st = JSON.parse(fs.readFileSync(stPath, 'utf8'));
  st.artifacts['.devin/config.json'] = { hash: 'x', source: 'agentProfiles.devin.mcpConfigPath' };
  fs.writeFileSync(stPath, JSON.stringify(st, null, 2) + '\n');

  const r = engine.applyDisposition(dir, '.devin/config.json', 'kit');
  assert.equal(r.changed, false);
  const row = r.rows.find(x => x.artifact === '.devin/config.json');
  assert.equal(row.action, 'skip');
  assert.match(row.detail, /invalid JSON/);
  assert.equal(fs.readFileSync(path.join(dir, '.devin/config.json'), 'utf8'), '{ not json');
});

// Finding (review r2): accepting content that resolves a key to the CURRENT
// kit entry must clear an older stale sidecar proposal for that key.
test('accepted content at current kit value clears stale sidecar proposal', () => {
  const dir = makeProject('cfgstale');
  writeProj(dir, 'AGENTS.md', curTmpl());
  writeProj(dir, '.devin/config.json', JSON.stringify({
    mcpServers: {
      semble: { command: 'npx', args: ['-y', '@semblemcp/server@1'], env: {} },
      devtools: { command: 'npx', args: ['-y', 'devtools-mcp@1'], env: {} },
    },
  }) + '\n');
  recordState(dir);

  // stale proposal: v9 predates the current manifest entry
  const stale = { command: 'npx', args: ['-y', '@semblemcp/server@9'], env: {} };
  const manifest = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
  const current = manifest.mcpServers.find(x => x.name === 'semble').config;
  assert.notDeepEqual(stale, current);
  writeProj(dir, '.devin/config.json.kit-incoming.json',
    JSON.stringify({ 'mcpServers.semble': stale }) + '\n');

  engine.applyDisposition(dir, '.devin/config.json', 'accepted', {
    content: JSON.stringify({ mcpServers: { semble: current, devtools: manifest.mcpServers.find(x => x.name === 'devtools').config } }),
  });
  assert.equal(fs.existsSync(path.join(dir, '.devin/config.json.kit-incoming.json')), false,
    'stale proposal cleared once key resolved to current kit entry');

  // a proposal for a key the accepted content did NOT resolve survives,
  // while the resolved key is still dropped
  writeProj(dir, '.devin/config.json.kit-incoming.json', JSON.stringify({
    'mcpServers.semble': stale,
    'mcpServers.devtools': { command: 'npx', args: ['-y', 'devtools-mcp@99'], env: {} },
  }) + '\n');
  engine.applyDisposition(dir, '.devin/config.json', 'accepted', {
    content: JSON.stringify({
      mcpServers: {
        semble: current, // resolves this key
        devtools: { command: 'npx', args: ['-y', 'devtools-custom'], env: {} }, // still differs
      },
    }),
  });
  const sidecar = JSON.parse(fs.readFileSync(path.join(dir, '.devin/config.json.kit-incoming.json'), 'utf8'));
  assert.equal(sidecar['mcpServers.semble'], undefined, 'resolved key dropped');
  assert.deepEqual(sidecar['mcpServers.devtools'],
    { command: 'npx', args: ['-y', 'devtools-mcp@99'], env: {} },
    'unresolved proposal survives');
});
