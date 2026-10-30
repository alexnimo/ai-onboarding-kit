/**
 * sync-region.test.mjs - acceptance tests for kit-managed regions inside
 * project-owned files (spec: 2026-10-23-managed-instructions-region-design).
 *
 * R1: foreign AGENTS.md + sync --adopt -> markers injected after H1, file
 *     otherwise byte-identical, region record only (no whole-file rec).
 * R2: kit block update -> region fast-forwards; outside text untouched.
 * R3: project edits outside markers + kit edits inside -> merged, no
 *     conflict, outside edits byte-preserved.
 * R4: project edits inside region + kit edits same lines -> conflict
 *     markers inside region, exit 2, outside intact.
 * R5: region keys never hit the text-dest pass: no retired row, --prune
 *     keeps the record; overrides.skip works at both 'AGENTS.md' and
 *     'AGENTS.md:kit-region' granularity.
 * R6: legacy whole-file artifacts["AGENTS.md"] migrates to region rec.
 * R7: absent file -> template render installs markers + block, region rec.
 * R8: project removes markers -> 'project-only' respected; --force re-injects.
 *
 * Self-contained: scratch kit + projects under os.tmpdir().
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-region-'));
const KIT = path.join(TMP, 'kit');
const HOME_DIR = path.join(TMP, 'home');
const PROJ_DIR = path.join(TMP, 'projects');
const CLI = path.join(KIT, 'bin', 'onboard.mjs');

const BEGIN = '<!-- BEGIN ai-onboarding-kit:kit-region -->';
const END = '<!-- END ai-onboarding-kit:kit-region -->';
const BLOCK_V1 = '## Core rules\n- rule one\n- rule two\n';
const BLOCK_V2 = '## Core rules\n- rule one\n- rule two v2\n';
const AGENTS_TMPL = [
  '# AGENTS.md — {{PROJECT_NAME}}',
  '',
  '## Project profile',
  '{{STACK_NOTES}}',
  '',
  BEGIN,
  '{{KIT_REGION}}',
  END,
  '',
].join('\n');

const MANIFEST = {
  version: '1.0.0-test',
  directories: ['.agents'],
  templates: [{ src: 'templates/AGENTS.md.tmpl', dest: 'AGENTS.md', overwrite: false }],
  managedRegions: [
    { id: 'kit-region', src: 'templates/kit-region.AGENTS.md', dests: ['AGENTS.md'] },
  ],
  rules: [],
  skills: [],
  templateSkills: [],
  cliTools: [],
  placeholders: [{ key: 'PROJECT_NAME' }, { key: 'STACK_NOTES' }],
  mcpServers: [],
  hooks: [],
  agentProfiles: {
    devin: {
      instructionsFile: 'AGENTS.md',
      mcpConfigPath: '.devin/config.json',
      mcpConfigKey: 'mcpServers',
      hooksConfigPath: '.devin/hooks.v1.json',
      hooksConfigFormat: 'standalone',
      rulesDir: null,
      rulesEnabled: false,
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
const projFile = (dir, rel) => path.join(dir, rel);

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
  fs.mkdirSync(path.dirname(projFile(dir, rel)), { recursive: true });
  fs.writeFileSync(projFile(dir, rel), text);
};
const readState = dir =>
  JSON.parse(fs.readFileSync(projFile(dir, '.agents/onboarding-state.json'), 'utf8'));
const projectRows = (rep, name) => rep.projects.find(p => p.name === name).files;
const rowFor = (files, artifact) => files.find(f => f.artifact === artifact);
const blockOf = (text) => {
  const lines = text.split('\n');
  return lines.slice(lines.indexOf(BEGIN) + 1, lines.indexOf(END)).join('\n');
};

before(() => {
  fs.mkdirSync(KIT, { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'bin'), path.join(KIT, 'bin'), { recursive: true });
  writeKit('onboard.manifest.json', JSON.stringify(MANIFEST, null, 2) + '\n');
  writeKit('templates/AGENTS.md.tmpl', AGENTS_TMPL);
  writeKit('templates/kit-region.AGENTS.md', BLOCK_V1);
  writeKit('.gitignore', 'projects.registry.json\nprojects.registry.json.lock\n');
  fs.mkdirSync(HOME_DIR, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  commitKit();
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------- R1: foreign file + adopt -> inject, record region only ----------
test('R1: foreign AGENTS.md gains kit region on --adopt', () => {
  const p = makeProject('FOREIGN1');
  const foreign = '# My Project\n\nmy custom rules\n- always do X\n';
  writeProj(p, 'AGENTS.md', foreign);
  const before = sha(projFile(p, 'AGENTS.md'));

  const r = cli(['sync', '--project', 'FOREIGN1', '--adopt', '--json']);
  assert.equal(r.code, 0, r.err);
  const row = rowFor(projectRows(JSON.parse(r.out), 'FOREIGN1'), 'AGENTS.md:kit-region');
  assert.equal(row?.action, 'injected', JSON.stringify(row));

  const text = fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8');
  assert.match(text, new RegExp(BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(text.includes('# My Project'), 'project text kept');
  assert.ok(text.indexOf('# My Project') < text.indexOf(BEGIN)
    && text.indexOf(BEGIN) < text.indexOf('my custom rules'),
    'region lands after the H1, before project content');
  // Only-inserted-lines: stripping the injected block restores the file.
  const stripped = text
    .replace(new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n\n`), '');
  assert.equal(stripped.trim(), foreign.trim());
  const st = readState(p);
  assert.ok(st.artifacts['AGENTS.md:kit-region']?.region, 'region record exists');
  assert.equal(st.artifacts['AGENTS.md'], undefined, 'no whole-file record');
});

// ---------- R7: absent file -> template render ----------
test('R7: absent AGENTS.md installs via template render', () => {
  const p = makeProject('FRESH1');
  writeProj(p, '.agents/onboarding-state.json', JSON.stringify({
    schemaVersion: 2, kitCommit: 'unknown', artifacts: {},
  }));
  const r = cli(['sync', '--project', 'FRESH1', '--json']);
  assert.equal(r.code, 0, r.err);
  const text = fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8');
  assert.ok(text.includes(BEGIN) && text.includes(END));
  assert.ok(blockOf(text).includes('- rule two'));
  assert.equal(blockOf(text).trim(), BLOCK_V1.trim());
  assert.ok(!text.includes('{{KIT_REGION}}'), 'directive expanded');
  assert.ok(readState(p).artifacts['AGENTS.md:kit-region']?.region);
});

// ---------- R2: fast-forward ----------
test('R2: kit block update fast-forwards region only', () => {
  const p = makeProject('FF1');
  writeProj(p, '.agents/onboarding-state.json', JSON.stringify({
    schemaVersion: 2, kitCommit: 'unknown', artifacts: {},
  }));
  cli(['sync', '--project', 'FF1', '--json']);
  const outsideMarker = '\n\nPROJECT SENTINEL\n';
  const cur = fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8');
  writeProj(p, 'AGENTS.md', cur + outsideMarker);

  writeKit('templates/kit-region.AGENTS.md', BLOCK_V2);
  commitKit();
  const r = cli(['sync', '--project', 'FF1', '--json']);
  assert.equal(r.code, 0, r.err);
  const text = fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8');
  assert.ok(text.endsWith(outsideMarker), 'outside untouched');
  assert.equal(blockOf(text).trim(), BLOCK_V2.trim());
  writeKit('templates/kit-region.AGENTS.md', BLOCK_V1); commitKit(); // restore
});

// ---------- R3 + R4: merge + conflict ----------
test('R3/R4: disjoint edits merge; same-line edits conflict inside region only', () => {
  const p = makeProject('MERGE1');
  writeProj(p, '.agents/onboarding-state.json', JSON.stringify({
    schemaVersion: 2, kitCommit: 'unknown', artifacts: {},
  }));
  cli(['sync', '--project', 'MERGE1', '--json']);

  // Project edits OUTSIDE markers; kit edits inside -> clean merge.
  let text = fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8');
  writeProj(p, 'AGENTS.md', text.replace('- rule one', '- rule one') + '\nlocal addition\n');
  writeKit('templates/kit-region.AGENTS.md', BLOCK_V2); commitKit();
  let r = cli(['sync', '--project', 'MERGE1', '--json']);
  assert.equal(r.code, 0, r.err);
  text = fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8');
  assert.ok(text.includes('local addition'), 'outside edit kept');
  assert.equal(blockOf(text).trim(), BLOCK_V2.trim());

  // Project edits INSIDE the region on the same line as a kit change.
  writeProj(p, 'AGENTS.md', text.replace('- rule two v2', '- rule two v2 (project)'));
  writeKit('templates/kit-region.AGENTS.md', BLOCK_V2.replace('- rule two v2', '- rule two v3'));
  commitKit();
  r = cli(['sync', '--project', 'MERGE1', '--json']);
  assert.equal(r.code, 2, `expected exit 2: ${r.out}`);
  const row = rowFor(projectRows(JSON.parse(r.out), 'MERGE1'), 'AGENTS.md:kit-region');
  assert.equal(row?.action, 'conflict');
  text = fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8');
  assert.ok(text.includes('local addition'), 'outside intact during conflict');
  assert.match(blockOf(text), /<{7} project/, 'markers inside region');
  writeKit('templates/kit-region.AGENTS.md', BLOCK_V1); commitKit(); // restore
});

// ---------- R5: region keys never hit text pass; skip granularity ----------
test('R5: region record survives --prune; skip honors both granularities', () => {
  const p = makeProject('PRUNE3');
  writeProj(p, '.agents/onboarding-state.json', JSON.stringify({
    schemaVersion: 2, kitCommit: 'unknown', artifacts: {},
  }));
  cli(['sync', '--project', 'PRUNE3', '--json']);
  const r = cli(['sync', '--project', 'PRUNE3', '--prune', '--json']);
  assert.equal(r.code, 0, r.err);
  assert.ok(readState(p).artifacts['AGENTS.md:kit-region'],
    '--prune must not delete the region record');
  assert.ok(!projectRows(JSON.parse(r.out), 'PRUNE3')
    .some(f => f.artifact === 'AGENTS.md:kit-region' && f.action === 'retired'));
});

// ---------- R6: legacy whole-file record migrates ----------
test('R6: legacy whole-file AGENTS.md record migrates to region record', () => {
  const p = makeProject('LEGACY1');
  writeProj(p, 'AGENTS.md', '# My Project\n\nlegacy kit text stays project-owned\n');
  // Simulate a v1-style whole-file record (no region flag).
  writeProj(p, '.agents/onboarding-state.json', JSON.stringify({
    schemaVersion: 2, kitCommit: 'unknown',
    artifacts: { 'AGENTS.md': { hash: sha(projFile(p, 'AGENTS.md')), source: 'templates/AGENTS.md.tmpl', syncedAt: 'x' } },
  }));
  const r = cli(['sync', '--project', 'LEGACY1', '--json']);
  assert.equal(r.code, 0, r.err);
  const st = readState(p);
  assert.equal(st.artifacts['AGENTS.md'], undefined, 'file record dropped');
  assert.ok(st.artifacts['AGENTS.md:kit-region']?.region, 'region record created');
  const text = fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8');
  assert.ok(text.includes('legacy kit text stays project-owned'));
  assert.ok(text.includes(BEGIN));
});

// ---------- R8: marker removal respected; --force re-injects ----------
test('R8: removed region stays removed unless --force', () => {
  const p = makeProject('REMOVE1');
  writeProj(p, '.agents/onboarding-state.json', JSON.stringify({
    schemaVersion: 2, kitCommit: 'unknown', artifacts: {},
  }));
  cli(['sync', '--project', 'REMOVE1', '--json']);

  let text = fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8');
  writeProj(p, 'AGENTS.md', text.split('\n').filter(l => l !== BEGIN && l !== END && !BLOCK_V1.includes(l)).join('\n'));
  // Mark rec as removal-acknowledged.
  const st = readState(p);
  st.artifacts['AGENTS.md:kit-region'].removed = true;
  writeProj(p, '.agents/onboarding-state.json', JSON.stringify(st));

  const r1 = cli(['sync', '--project', 'REMOVE1', '--json']);
  assert.equal(r1.code, 0, r1.err);
  assert.ok(!fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8').includes(BEGIN),
    'removal respected');

  const r2 = cli(['sync', '--project', 'REMOVE1', '--force', '--json']);
  assert.equal(r2.code, 0, r2.err);
  assert.ok(fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8').includes(BEGIN),
    '--force re-injects');
});
