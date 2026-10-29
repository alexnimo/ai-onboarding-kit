/**
 * sync-r2.test.mjs - review-round-2 regression tests, self-contained kit.
 *
 * Covers the two repeated-sync paths the AC battery misses:
 *   1. state.kitCommit advancing past a skipped artifact must not strand its
 *      recorded base (per-artifact kitCommit + history fallback).
 *   2. --force must never let a file still carrying conflict markers exit 0.
 *
 * Runs the real CLI against a fresh hermetic git-backed kit so results don't
 * depend on template mutations accumulated by sync.test.mjs.
 *
 *   node --test tests/sync-r2.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-sync-r2-'));
const KIT = path.join(TMP, 'kit');
const HOME_DIR = path.join(TMP, 'home');
const PROJ_DIR = path.join(TMP, 'projects');
const CLI = path.join(KIT, 'bin', 'onboard.mjs');
const REGISTRY = path.join(KIT, 'projects.registry.json');

const AGENTS_TMPL = [
  '# AGENTS - {{PROJECT_NAME}}',
  '',
  '> {{PROJECT_DESCRIPTION}}',
  '',
  '## Core rules',
  '- rule one',
  '- rule two',
  '',
  '## Routing',
  '- route alpha',
  '- route beta',
  '',
  '## Testing',
  '- run the tests',
  '',
  '## Invariants',
  '{{STACK_NOTES}}',
  '',
].join('\n');

const MANIFEST = {
  version: '1.0.0-r2',
  directories: ['.agents'],
  templates: [
    { src: 'templates/AGENTS.md.tmpl', dest: 'AGENTS.md', overwrite: false },
    { src: 'templates/SYSTEM.md.tmpl', dest: '.agents/SYSTEM.md', overwrite: false },
  ],
  rules: [],
  skills: [],
  templateSkills: [],
  cliTools: [],
  placeholders: [{ key: 'PROJECT_NAME' }, { key: 'PROJECT_DESCRIPTION' }, { key: 'STACK_NOTES' }],
  mcpServers: [
    { name: 'semble', required: true, config: { command: 'npx', args: ['-y', '@semblemcp/server@1'], env: {} } },
    { name: 'devtools', required: false, config: { command: 'npx', args: ['-y', 'devtools-mcp@1'], env: {} } },
  ],
  hooks: [],
  agentProfiles: {
    devin: {
      instructionsFile: 'AGENTS.md',
      mcpConfigPath: '.devin/config.json',
      mcpConfigKey: 'mcpServers',
    },
  },
};

// ---------- harness ----------

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

const kitPath = rel => path.join(KIT, rel);
const writeKit = (rel, text) => {
  fs.mkdirSync(path.dirname(kitPath(rel)), { recursive: true });
  fs.writeFileSync(kitPath(rel), text);
};
const commitKit = () => { git(['add', '-A']); git(['commit', '-qm', 'kit change']); };

function makeProject(name, { agents = [] } = {}) {
  const dir = path.join(PROJ_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const args = ['register', '--name', name, '--path', dir];
  if (agents.length) args.push('--agents', agents.join(','));
  const r = cli(args);
  assert.equal(r.code, 0, `register failed: ${r.err}`);
  return dir;
}

const projFile = (dir, rel) => path.join(dir, rel);
const writeProj = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(projFile(dir, rel)), { recursive: true });
  fs.writeFileSync(projFile(dir, rel), text);
};
const recordState = dir => {
  const r = cli(['record-state', '--path', dir]);
  assert.equal(r.code, 0, `record-state failed: ${r.err}`);
};
const readState = dir => JSON.parse(
  fs.readFileSync(projFile(dir, '.agents/onboarding-state.json'), 'utf8'));

function projectRows(jsonReport, name) {
  const p = jsonReport.projects.find(x => x.name === name);
  return p ? p.files : [];
}
const rowFor = (rows, artifact) => rows.find(r => r.artifact === artifact);

// ---------- fixtures ----------

before(() => {
  fs.mkdirSync(KIT, { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'bin'), path.join(KIT, 'bin'), { recursive: true });
  writeKit('onboard.manifest.json', JSON.stringify(MANIFEST, null, 2) + '\n');
  writeKit('templates/AGENTS.md.tmpl', AGENTS_TMPL);
  writeKit('templates/SYSTEM.md.tmpl', '# SYSTEM - {{PROJECT_NAME}}\n\nsystem body\n');
  writeKit('.gitignore', 'projects.registry.json\nprojects.registry.json.lock\n');
  git(['init', '-q', '-b', 'main']);
  commitKit();
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------- regression tests ----------

// Finding 1: when an artifact is skipped while OTHER artifacts advance
// state.kitCommit past it, the skipped artifact's recorded base must stay
// reconstructable (per-artifact kitCommit), so a later kit update merges
// instead of reporting 'base unreconstructable'.
test('r2: skipped artifact keeps its recorded base after kitCommit advances', () => {
  const p = makeProject('P15');
  const cur = fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8');
  writeProj(p, 'AGENTS.md', cur);
  writeProj(p, '.agents/SYSTEM.md', fs.readFileSync(kitPath('templates/SYSTEM.md.tmpl'), 'utf8'));
  recordState(p);
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const entry = reg.projects.find(e => e.name === 'P15');
  entry.overrides.skip.push('AGENTS.md');
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));

  // C1: kit edits BOTH templates in one commit. Sync skips AGENTS.md but
  // fast-forwards SYSTEM.md -> state.kitCommit = C1, past AGENTS's base.
  writeKit('templates/AGENTS.md.tmpl', cur.replace('- rule two', '- rule two (kit a)'));
  writeKit('templates/SYSTEM.md.tmpl', fs.readFileSync(kitPath('templates/SYSTEM.md.tmpl'), 'utf8') + '\nsystem v2\n');
  commitKit();
  const r1 = cli(['sync', '--project', 'P15', '--json']);
  assert.equal(r1.code, 0, r1.err);
  assert.equal(rowFor(projectRows(JSON.parse(r1.out), 'P15'), 'AGENTS.md').action, 'skip');

  // C2: kit edits AGENTS's template AGAIN; project edits it too (disjoint).
  const cur2 = fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8');
  writeKit('templates/AGENTS.md.tmpl', cur2.replace('## Invariants', '## Invariants (kit b)'));
  commitKit();
  writeProj(p, 'AGENTS.md', cur.replace('- route beta', '- route beta (project)'));
  entry.overrides.skip = [];
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));

  const r2 = cli(['sync', '--project', 'P15', '--json']);
  assert.equal(r2.code, 0, r2.err);
  const row = rowFor(projectRows(JSON.parse(r2.out), 'P15'), 'AGENTS.md');
  // Bug: 'skip' with 'base unreconstructable'. Fixed: real three-way merge.
  assert.equal(row.action, 'merged', JSON.stringify(row));
  const out = fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8');
  assert.match(out, /- rule two \(kit a\)/);
  assert.match(out, /## Invariants \(kit b\)/);
  assert.match(out, /- route beta \(project\)/);
});

// Finding 2: --force must not let a file carrying unresolved conflict markers
// be classified 'project-only' (exit 0) when the kit side hasn't moved.
// Marked files stay conflicts until a human resolves them.
test('r2: --force with lingering markers still reports conflict', () => {
  const p = makeProject('P16');
  const cur = fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8');
  writeProj(p, 'AGENTS.md', cur);
  recordState(p);
  writeProj(p, 'AGENTS.md', cur.replace('- route beta', '- route beta (project)'));
  writeKit('templates/AGENTS.md.tmpl', cur.replace('- route beta', '- route beta (kit)'));
  commitKit();

  const r1 = cli(['sync', '--project', 'P16', '--json']);
  assert.equal(r1.code, 2, r1.err);
  assert.match(fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8'), /<<<<<<< project/);

  // Forced retry while the kit hasn't moved: still a live conflict, exit 2.
  const r2 = cli(['sync', '--project', 'P16', '--force', '--json']);
  assert.equal(r2.code, 2, `expected exit 2, got ${r2.code}: ${r2.out}`);
  const row = rowFor(projectRows(JSON.parse(r2.out), 'P16'), 'AGENTS.md');
  assert.equal(row.action, 'conflict', JSON.stringify(row));
  assert.match(fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8'), /<<<<<<< project/);
});

// Finding (code-review r2 F1): a managed config key that converges to the
// current kit value without needing a write - e.g. the project accepted the
// sidecar proposal verbatim - must refresh the config artifact's recorded
// kitCommit. A stale commit makes the next baseManifest report an old
// baseEntry, misclassifying the entry as customized -> conflict.
test('r2-f1: accepted sidecar proposal stays fast-forwardable', () => {
  const p = makeProject('P17', { agents: ['devin'] });
  const bumpSemble = ver => {
    const m = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
    m.mcpServers[0].config.args = ['-y', `@semblemcp/server@${ver}`];
    writeKit('onboard.manifest.json', JSON.stringify(m, null, 2) + '\n');
    commitKit();
  };
  const cfgRel = '.devin/config.json';
  const keyRel = `${cfgRel}:mcpServers.semble`;

  // Seed the config with the CURRENT committed manifest entry (@4 after the
  // previous test's bumps) so the recorded base matches it.
  const curManifest = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
  writeProj(p, cfgRel, JSON.stringify({ mcpServers: { semble: curManifest.mcpServers[0].config } }, null, 2));
  recordState(p);

  // Kit bumps semble -> managed key fast-forwards (file written, stamped).
  bumpSemble('2');
  let r = cli(['sync', '--project', 'P17', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.equal(rowFor(projectRows(JSON.parse(r.out), 'P17'), keyRel).action, 'fast-forward');

  // Project customizes the entry AND kit bumps it -> conflict + sidecar.
  const cfg = JSON.parse(fs.readFileSync(projFile(p, cfgRel), 'utf8'));
  cfg.mcpServers.semble = { command: 'custom-semble', args: ['--local'], env: {} };
  writeProj(p, cfgRel, JSON.stringify(cfg, null, 2));
  bumpSemble('3');
  r = cli(['sync', '--project', 'P17', '--json']);
  assert.equal(r.code, 2, r.err);
  const sidecarAbs = projFile(p, `${cfgRel}.kit-incoming.json`);
  const proposal = JSON.parse(fs.readFileSync(sidecarAbs, 'utf8'))['mcpServers.semble'];

  // Human accepts the proposal verbatim -> next sync converges with no write;
  // the sidecar drops the resolved key and the base commit must refresh.
  cfg.mcpServers.semble = proposal;
  writeProj(p, cfgRel, JSON.stringify(cfg, null, 2));
  r = cli(['sync', '--project', 'P17', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.ok(!fs.existsSync(sidecarAbs), 'sidecar should be removed once resolved');
  assert.equal(readState(p).artifacts[cfgRel].kitCommit, git(['rev-parse', 'HEAD']));

  // Kit bumps the entry again: the accepted value IS the recorded base, so
  // this must fast-forward - a stale base would re-conflict it as customized.
  bumpSemble('4');
  r = cli(['sync', '--project', 'P17', '--json']);
  assert.equal(r.code, 0, r.err);
  const row = rowFor(projectRows(JSON.parse(r.out), 'P17'), keyRel);
  assert.equal(row.action, 'fast-forward', JSON.stringify(row));
  const finalCfg = JSON.parse(fs.readFileSync(projFile(p, cfgRel), 'utf8'));
  assert.deepEqual(finalCfg.mcpServers.semble.args, ['-y', '@semblemcp/server@4']);
});

// Finding (code-review r1 F1): when a managed key is deferred (pinned) while
// a SIBLING key fast-forwards (a write), the file-level kitCommit advances -
// so the deferred key's base must be frozen via a per-key override, or the
// unseen bump misclassifies it as customized once the pin lifts.
test('r2-f2: pinned config key keeps its base until the pin lifts', () => {
  const p = makeProject('P18', { agents: ['devin'] });
  const bumpServer = (name, ver) => {
    const m = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
    const s = m.mcpServers.find(x => x.name === name);
    s.config.args = [s.config.args[0], s.config.args[1].replace(/@[^@]+$/, `@${ver}`)];
    writeKit('onboard.manifest.json', JSON.stringify(m, null, 2) + '\n');
    commitKit();
  };
  const cfgRel = '.devin/config.json';
  const sembleKey = `${cfgRel}:mcpServers.semble`;
  const devtoolsKey = `${cfgRel}:mcpServers.devtools`;

  // Seed the config with the CURRENT committed manifest entries (bumped by
  // the earlier test) so the recorded base matches it.
  const curManifest = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
  writeProj(p, cfgRel, JSON.stringify({ mcpServers: {
    semble: curManifest.mcpServers[0].config,
    devtools: curManifest.mcpServers[1].config,
  } }, null, 2));
  recordState(p);
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  const entry = reg.projects.find(e => e.name === 'P18');
  entry.overrides.pins = { ...(entry.overrides.pins || {}), [sembleKey]: 'frozen by policy' };
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));

  // Kit bumps BOTH servers while semble is pinned: semble skips, devtools
  // fast-forwards (a write). The file commit may advance for devtools, but
  // semble's recorded base must freeze at the record commit.
  const commitAtRecord = git(['rev-parse', 'HEAD']);
  bumpServer('semble', '5');
  bumpServer('devtools', '2');
  let r = cli(['sync', '--project', 'P18', '--json']);
  assert.equal(r.code, 0, r.err);
  const rows = projectRows(JSON.parse(r.out), 'P18');
  const pinRow = rowFor(rows, sembleKey);
  assert.equal(pinRow.action, 'skip');
  assert.match(pinRow.detail, /pinned/);
  assert.equal(rowFor(rows, devtoolsKey).action, 'fast-forward');
  const afterPin = JSON.parse(fs.readFileSync(projFile(p, cfgRel), 'utf8'));
  assert.deepEqual(afterPin.mcpServers.semble, curManifest.mcpServers[0].config);
  assert.equal(afterPin.mcpServers.devtools.args[1], 'devtools-mcp@2');
  const recAfter = readState(p).artifacts[cfgRel];
  assert.equal(recAfter.kitCommit, git(['rev-parse', 'HEAD']));
  assert.equal(recAfter.keyCommits?.[sembleKey], commitAtRecord);

  // Pin lifted, kit bumps semble again -> the pinned value is still the
  // recorded base, so it must fast-forward, not conflict as customized.
  delete entry.overrides.pins[sembleKey];
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
  bumpServer('semble', '6');
  r = cli(['sync', '--project', 'P18', '--json']);
  assert.equal(r.code, 0, r.err);
  const row = rowFor(projectRows(JSON.parse(r.out), 'P18'), sembleKey);
  assert.equal(row.action, 'fast-forward', JSON.stringify(row));
  const finalCfg = JSON.parse(fs.readFileSync(projFile(p, cfgRel), 'utf8'));
  assert.deepEqual(finalCfg.mcpServers.semble.args, ['-y', '@semblemcp/server@6']);
  assert.equal(finalCfg.mcpServers.devtools.args[1], 'devtools-mcp@2');
});

// Finding (review r1): re-running record-state after a kit update must not
// re-base an unchanged config onto the newer commit - its managed entries
// still match the older recorded base, so stamping the current kitCommit
// makes sync misclassify them as customized -> conflict.
test('r2-r1: re-recorded state preserves unchanged config base commit', () => {
  const p = makeProject('P19', { agents: ['devin'] });
  const cfgRel = '.devin/config.json';
  const sembleKey = `${cfgRel}:mcpServers.semble`;

  // Seed the config with the current committed manifest entries and record.
  const curManifest = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
  writeProj(p, cfgRel, JSON.stringify({ mcpServers: {
    semble: curManifest.mcpServers[0].config,
    devtools: curManifest.mcpServers[1].config,
  } }, null, 2));
  recordState(p);
  const commitAtRecord = git(['rev-parse', 'HEAD']);

  // Kit bumps semble; the project does NOT receive it. Re-running
  // record-state on the unchanged file must keep the recorded base commit.
  const m = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
  m.mcpServers[0].config.args = ['-y', '@semblemcp/server@7'];
  writeKit('onboard.manifest.json', JSON.stringify(m, null, 2) + '\n');
  commitKit();
  recordState(p);
  assert.equal(readState(p).artifacts[cfgRel].kitCommit, commitAtRecord);

  const r = cli(['sync', '--project', 'P19', '--json']);
  assert.equal(r.code, 0, r.err);
  const row = rowFor(projectRows(JSON.parse(r.out), 'P19'), sembleKey);
  assert.equal(row.action, 'fast-forward', JSON.stringify(row));
  const finalCfg = JSON.parse(fs.readFileSync(projFile(p, cfgRel), 'utf8'));
  assert.deepEqual(finalCfg.mcpServers.semble.args, ['-y', '@semblemcp/server@7']);
});

// Finding (code-review r2 F1): hash-equality gating still re-based every
// managed key when the project EDITED the config (added its own key) -
// dropping prior.kitCommit/keyCommits strands untouched managed keys whose
// installed values still match the older recorded base. Preservation must
// apply whenever a prior record exists, not only on hash equality.
test('r2-r2: record-state preserves config base after project edits file', () => {
  const p = makeProject('P20', { agents: ['devin'] });
  const cfgRel = '.devin/config.json';
  const sembleKey = `${cfgRel}:mcpServers.semble`;
  const ownKey = `${cfgRel}:mcpServers.my-own-server`;

  const curManifest = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
  writeProj(p, cfgRel, JSON.stringify({ mcpServers: {
    semble: curManifest.mcpServers[0].config,
    devtools: curManifest.mcpServers[1].config,
  } }, null, 2));
  recordState(p);
  const commitAtRecord = git(['rev-parse', 'HEAD']);

  // Kit bumps semble AND the project edits the config file (adds its own
  // server) -> file hash changes. Re-recording must still preserve the
  // prior base commits for the untouched managed keys.
  const m = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
  m.mcpServers[0].config.args = ['-y', '@semblemcp/server@8'];
  writeKit('onboard.manifest.json', JSON.stringify(m, null, 2) + '\n');
  commitKit();
  const edited = JSON.parse(fs.readFileSync(projFile(p, cfgRel), 'utf8'));
  edited.mcpServers['my-own-server'] = { command: 'node', args: ['own.js'] };
  writeProj(p, cfgRel, JSON.stringify(edited, null, 2));
  recordState(p);
  assert.equal(readState(p).artifacts[cfgRel].kitCommit, commitAtRecord);

  const r = cli(['sync', '--project', 'P20', '--json']);
  assert.equal(r.code, 0, r.err);
  const rows = projectRows(JSON.parse(r.out), 'P20');
  const row = rowFor(rows, sembleKey);
  assert.equal(row.action, 'fast-forward', JSON.stringify(row));
  assert.equal(rowFor(rows, ownKey).action, 'project-only');
  const finalCfg = JSON.parse(fs.readFileSync(projFile(p, cfgRel), 'utf8'));
  assert.deepEqual(finalCfg.mcpServers.semble.args, ['-y', '@semblemcp/server@8']);
  assert.deepEqual(finalCfg.mcpServers['my-own-server'], { command: 'node', args: ['own.js'] });
});

// Finding (review r2): preserving the prior file-level base wholesale also
// freezes a managed key that the project has since updated to the CURRENT
// kit value out-of-band. Recorded at C0, installed at C1, re-recorded, kit
// at C2: sync must compare against the C1 base and fast-forward. Keys that
// match the current manifest at re-record time are rebased to it; untouched
// or customized keys keep their older bases.
test('r2-r3: re-recorded config rebases keys already at current kit value', () => {
  const p = makeProject('P21', { agents: ['devin'] });
  const cfgRel = '.devin/config.json';
  const sembleKey = `${cfgRel}:mcpServers.semble`;

  const curManifest = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
  writeProj(p, cfgRel, JSON.stringify({ mcpServers: {
    semble: curManifest.mcpServers[0].config,
    devtools: curManifest.mcpServers[1].config,
  } }, null, 2));
  recordState(p);
  const commitAtRecord = git(['rev-parse', 'HEAD']);

  // Kit bumps semble (@9, C1); the project receives it out-of-band, then
  // re-records. semble's effective base must move to C1 while the file
  // default stays at the record commit (devtools is untouched there).
  const m = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
  m.mcpServers[0].config.args = ['-y', '@semblemcp/server@9'];
  writeKit('onboard.manifest.json', JSON.stringify(m, null, 2) + '\n');
  commitKit();
  const commitAtC1 = git(['rev-parse', 'HEAD']);
  const cfg = JSON.parse(fs.readFileSync(projFile(p, cfgRel), 'utf8'));
  cfg.mcpServers.semble = m.mcpServers[0].config;
  writeProj(p, cfgRel, JSON.stringify(cfg, null, 2));
  recordState(p);
  const recAfter = readState(p).artifacts[cfgRel];
  assert.equal(recAfter.kitCommit, commitAtRecord);
  assert.equal(recAfter.keyCommits?.[sembleKey], commitAtC1);

  // Kit moves to C2 (@10) -> sync fast-forwards semble from its C1 base
  // instead of reporting it customized vs the stale C0 base.
  const m2 = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
  m2.mcpServers[0].config.args = ['-y', '@semblemcp/server@10'];
  writeKit('onboard.manifest.json', JSON.stringify(m2, null, 2) + '\n');
  commitKit();
  const r = cli(['sync', '--project', 'P21', '--json']);
  assert.equal(r.code, 0, r.err);
  const row = rowFor(projectRows(JSON.parse(r.out), 'P21'), sembleKey);
  assert.equal(row.action, 'fast-forward', JSON.stringify(row));
  const finalCfg = JSON.parse(fs.readFileSync(projFile(p, cfgRel), 'utf8'));
  assert.deepEqual(finalCfg.mcpServers.semble.args, ['-y', '@semblemcp/server@10']);
});

// Finding (review r1, fourth pass): keyCommits is rebuilt per re-record from
// CURRENT-manifest keys only, so a temporarily removed server loses its
// recorded base - when the manifest re-adds it, its older effective commit is
// gone and sync reports a false conflict instead of fast-forwarding. The
// same loss happens when a SYNC runs while the key is absent (keyCommitsOut
// drops it on any record rewrite).
test('r2-r4: temporarily removed config key keeps its base when re-added', () => {
  const p = makeProject('P22', { agents: ['devin'] });
  const cfgRel = '.devin/config.json';
  const sembleKey = `${cfgRel}:mcpServers.semble`;
  const devtoolsKey = `${cfgRel}:mcpServers.devtools`;

  // Record at C0: config seeded with the current manifest entries.
  const curManifest = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
  writeProj(p, cfgRel, JSON.stringify({ mcpServers: {
    semble: curManifest.mcpServers[0].config,
    devtools: curManifest.mcpServers[1].config,
  } }, null, 2));
  recordState(p);

  // Kit bumps semble (@11, C1); project receives it out-of-band; re-record
  // rebases semble to C1 via keyCommits (file-level base stays at C0).
  let m = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
  m.mcpServers[0].config.args = ['-y', '@semblemcp/server@11'];
  writeKit('onboard.manifest.json', JSON.stringify(m, null, 2) + '\n');
  commitKit();
  const commitAtC1 = git(['rev-parse', 'HEAD']);
  const cfg = JSON.parse(fs.readFileSync(projFile(p, cfgRel), 'utf8'));
  cfg.mcpServers.semble = m.mcpServers[0].config;
  writeProj(p, cfgRel, JSON.stringify(cfg, null, 2));
  recordState(p);
  let recAfter = readState(p).artifacts[cfgRel];
  assert.equal(recAfter.keyCommits?.[sembleKey], commitAtC1);

  // Manifest drops semble entirely (C2); re-record - the absent key must keep
  // its C1 override. A sync while the key is absent must also carry it.
  m = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
  m.mcpServers = m.mcpServers.filter(s => s.name !== 'semble');
  writeKit('onboard.manifest.json', JSON.stringify(m, null, 2) + '\n');
  commitKit();
  recordState(p);
  recAfter = readState(p).artifacts[cfgRel];
  assert.equal(recAfter.keyCommits?.[sembleKey], commitAtC1,
    're-record without the manifest entry dropped the key base');
  let r = cli(['sync', '--project', 'P22', '--json']);
  assert.equal(r.code, 0, r.err);
  recAfter = readState(p).artifacts[cfgRel];
  assert.equal(recAfter.keyCommits?.[sembleKey], commitAtC1,
    'sync while the key was absent dropped its base');

  // Manifest re-adds semble at a NEWER value (@12, C3): the installed entry
  // still matches its C1 base, so sync must fast-forward, not conflict.
  m = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
  m.mcpServers.unshift({ name: 'semble', required: true,
    config: { command: 'npx', args: ['-y', '@semblemcp/server@12'], env: {} } });
  writeKit('onboard.manifest.json', JSON.stringify(m, null, 2) + '\n');
  commitKit();
  r = cli(['sync', '--project', 'P22', '--json']);
  assert.equal(r.code, 0, r.err);
  const rows = projectRows(JSON.parse(r.out), 'P22');
  const row = rowFor(rows, sembleKey);
  assert.equal(row.action, 'fast-forward', JSON.stringify(row));
  const finalCfg = JSON.parse(fs.readFileSync(projFile(p, cfgRel), 'utf8'));
  assert.deepEqual(finalCfg.mcpServers.semble.args, ['-y', '@semblemcp/server@12']);
});
