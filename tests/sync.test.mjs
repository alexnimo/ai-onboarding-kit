/**
 * sync.test.mjs - acceptance + unit tests for the sync engine.
 *
 * Runs the real CLI (`node bin/onboard.mjs ...`) against a hermetic kit: a
 * tmp copy of bin/ + a small manifest + templates, git-initialized so the
 * engine can reconstruct recorded bases via `git show <kitCommit>:<path>`.
 * HOME/USERPROFILE are redirected so the skills check never touches the real
 * user profile.
 *
 *   node --test tests/sync.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { merge3 } from '../bin/lib/diff3.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-sync-'));
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
  version: '1.0.0-test',
  directories: ['.agents'],
  templates: [
    { src: 'templates/AGENTS.md.tmpl', dest: 'AGENTS.md', overwrite: false },
    { src: 'templates/SYSTEM.md.tmpl', dest: '.agents/SYSTEM.md', overwrite: false },
  ],
  rules: [
    { src: 'templates/rules/dev-env.md.tmpl', dest: 'dev-env.md', overwrite: false },
  ],
  skills: [
    { name: 'already-there-skill', source: 'acme/skills', skill: 'already-there-skill', required: true },
    { name: 'missing-optional-skill', source: 'acme/skills', skill: 'missing-optional-skill', required: false },
  ],
  templateSkills: [
    { src: 'templates/skills/bundled-skill', dest: 'bundled-skill', required: true },
  ],
  cliTools: [],
  placeholders: [{ key: 'PROJECT_NAME' }, { key: 'PROJECT_DESCRIPTION' }, { key: 'STACK_NOTES' }],
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

const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
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
const readState = dir => JSON.parse(fs.readFileSync(projFile(dir, '.agents/onboarding-state.json'), 'utf8'));

/** Rows for one project from a --json sync run. */
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
  writeKit('templates/rules/dev-env.md.tmpl', '# dev env rules\n');
  writeKit('templates/skills/bundled-skill/SKILL.md', '# bundled\n');
  writeKit('.gitignore', 'projects.registry.json\nprojects.registry.json.lock\n');
  fs.mkdirSync(path.join(HOME_DIR, '.agents', 'skills', 'already-there-skill'), { recursive: true });
  fs.writeFileSync(path.join(HOME_DIR, '.agents', 'skills', 'already-there-skill', 'SKILL.md'), '# x\n');
  git(['init', '-q', '-b', 'main']);
  commitKit();
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------- merge3 unit tests ----------

test('merge3: ours-only change applies cleanly', () => {
  const { text, conflicts } = merge3('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nc\n');
  assert.equal(conflicts, 0);
  assert.equal(text, 'a\nB\nc\n');
});

test('merge3: theirs-only change applies cleanly', () => {
  const { text, conflicts } = merge3('a\nb\nc\n', 'a\nb\nc\n', 'a\nb\nC\n');
  assert.equal(conflicts, 0);
  assert.equal(text, 'a\nb\nC\n');
});

test('merge3: disjoint changes merge without conflict', () => {
  const { text, conflicts } = merge3('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n');
  assert.equal(conflicts, 0);
  assert.equal(text, 'A\nb\nc\nd\nE\n');
});

test('merge3: same-line change conflicts with diff3 markers', () => {
  const { text, conflicts } = merge3('a\nb\nc\n', 'a\nOURS\nc\n', 'a\nTHEIRS\nc\n',
    { ours: 'project', base: 'kit base abc', theirs: 'kit v2' });
  assert.equal(conflicts, 1);
  assert.match(text, /<<<<<<< project\n/);
  assert.match(text, /\|\|\|\|\|\|\| kit base abc\n/);
  assert.match(text, /=======\n/);
  assert.match(text, />>>>>>> kit v2\n?/);
  assert.match(text, /OURS/);
  assert.match(text, /THEIRS/);
});

test('merge3: identical edits on both sides stay clean', () => {
  const { conflicts } = merge3('a\nb\n', 'a\nX\n', 'a\nX\n');
  assert.equal(conflicts, 0);
});

// ---------- sync ACs ----------

// AC1 (+AC5): project at recorded base -> kit edit fast-forwards; re-sync is a no-op.
test('AC1+AC5: untouched project fast-forwards; second run is zero-action', () => {
  const p = makeProject('P1');
  writeProj(p, 'AGENTS.md', AGENTS_TMPL);
  writeProj(p, '.agents/SYSTEM.md', '# SYSTEM - {{PROJECT_NAME}}\n\nsystem body\n');
  recordState(p);

  const newTmpl = AGENTS_TMPL.replace('- rule one', '- rule one (kit v2)');
  writeKit('templates/AGENTS.md.tmpl', newTmpl);
  commitKit();

  const r = cli(['sync', '--project', 'P1', '--json']);
  assert.equal(r.code, 0, r.err);
  const rep = JSON.parse(r.out);
  const row = rowFor(projectRows(rep, 'P1'), 'AGENTS.md');
  assert.equal(row.action, 'fast-forward');
  assert.equal(fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8'), newTmpl);
  // recorded base refreshed to the new kit source
  assert.equal(readState(p).artifacts['AGENTS.md'].hash, sha(kitPath('templates/AGENTS.md.tmpl')));

  // AC5: second sync on P1 is a no-op (zero actions, exit 0).
  const r2 = cli(['sync', '--project', 'P1', '--json']);
  assert.equal(r2.code, 0, r2.err);
  const rep2 = JSON.parse(r2.out);
  assert.equal(projectRows(rep2, 'P1').length, 0, JSON.stringify(projectRows(rep2, 'P1')));
});

// AC2: project edited after state, kit unchanged -> project-only, untouched.
test('AC2: local-only edits keep project content byte-identical', () => {
  const p = makeProject('P2');
  writeProj(p, 'AGENTS.md', fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8'));
  recordState(p);
  const edited = fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8')
    .replace('- route beta', '- route beta (project edit)');
  writeProj(p, 'AGENTS.md', edited);

  const before = sha(projFile(p, 'AGENTS.md'));
  const r = cli(['sync', '--project', 'P2', '--json']);
  assert.equal(r.code, 0, r.err);
  const row = rowFor(projectRows(JSON.parse(r.out), 'P2'), 'AGENTS.md');
  assert.ok(['project-only', 'skip'].includes(row.action), JSON.stringify(row));
  assert.equal(sha(projFile(p, 'AGENTS.md')), before);
  assert.equal(fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8'), edited);
});

// AC3 (+AC6): disjoint kit/project edits merge cleanly; --project scoping.
test('AC3+AC6: disjoint edits merge; --project touches only that project', () => {
  const p3 = makeProject('P3');
  const p2 = path.join(PROJ_DIR, 'P2');
  writeProj(p3, 'AGENTS.md', fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8'));
  recordState(p3);
  writeProj(p3, 'AGENTS.md', fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8')
    .replace('- run the tests', '- run the tests (project says so)'));
  const beforeP2 = sha(projFile(p2, 'AGENTS.md'));

  const newTmpl = fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8')
    .replace('## Core rules', '## Core rules (kit v3)');
  writeKit('templates/AGENTS.md.tmpl', newTmpl);
  commitKit();

  const r = cli(['sync', '--project', 'P3', '--json']);
  assert.equal(r.code, 0, r.err);
  const row = rowFor(projectRows(JSON.parse(r.out), 'P3'), 'AGENTS.md');
  assert.equal(row.action, 'merged');
  const merged = fs.readFileSync(projFile(p3, 'AGENTS.md'), 'utf8');
  assert.match(merged, /## Core rules \(kit v3\)/);
  assert.match(merged, /- run the tests \(project says so\)/);
  assert.ok(!/^<{7}/m.test(merged));

  // AC6: --project P3 did not touch P2's file.
  assert.equal(sha(projFile(p2, 'AGENTS.md')), beforeP2);
});

// AC4: kit + project edited the SAME region -> conflict markers + exit 2.
test('AC4: same-region edits produce conflict markers and exit 2', () => {
  const p = makeProject('P4');
  writeProj(p, 'AGENTS.md', fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8'));
  recordState(p);
  writeProj(p, 'AGENTS.md', fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8')
    .replace('- route alpha', '- route alpha (project version)'));
  const newTmpl = fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8')
    .replace('- route alpha', '- route alpha (kit version)');
  writeKit('templates/AGENTS.md.tmpl', newTmpl);
  commitKit();

  const r = cli(['sync', '--project', 'P4', '--json']);
  assert.equal(r.code, 2, `expected exit 2, got ${r.code}: ${r.out}`);
  const rep = JSON.parse(r.out);
  const row = rowFor(projectRows(rep, 'P4'), 'AGENTS.md');
  assert.equal(row.action, 'conflict');
  const text = fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8');
  assert.match(text, /<<<<<<< project/);
  assert.match(text, /\|\|\|\|\|\|\| kit base [0-9a-f]{7}/);
  assert.match(text, />>>>>>> kit v1\.0\.0-test/);
  assert.match(text, /- route alpha \(project version\)/);
  assert.match(text, /- route alpha \(kit version\)/);
  // state tracks the unresolved file
  assert.ok(readState(p).unresolved.includes('AGENTS.md'));
});

// Regression for review finding F2: markers still on disk + kit unchanged
// must keep reporting conflict + exit 2 (not a masking 'project-only').
test('F2: lingering conflict markers re-report conflict on next sync', () => {
  const p = path.join(PROJ_DIR, 'P4'); // markers still on disk from AC4
  const r = cli(['sync', '--project', 'P4', '--json']);
  assert.equal(r.code, 2, `expected exit 2, got ${r.code}`);
  const row = rowFor(projectRows(JSON.parse(r.out), 'P4'), 'AGENTS.md');
  assert.equal(row.action, 'conflict');
  assert.match(row.detail, /unresolved conflict markers/);
  assert.ok(readState(p).unresolved.includes('AGENTS.md'));
  // markers still present on disk - nothing was silently resolved
  assert.match(fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8'), /<<<<<<< project/);
});

// AC7: dry-run on a conflicting project writes nothing, still exits 2.
test('AC7: --dry-run reports the conflict but modifies nothing', () => {
  const p = makeProject('P7');
  writeProj(p, 'AGENTS.md', fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8'));
  recordState(p);
  writeProj(p, 'AGENTS.md', fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8')
    .replace('{{STACK_NOTES}}', 'project invariants'));
  const newTmpl = fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8')
    .replace('{{STACK_NOTES}}', 'kit invariants v2');
  writeKit('templates/AGENTS.md.tmpl', newTmpl);
  commitKit();

  const fileBefore = sha(projFile(p, 'AGENTS.md'));
  const stateBefore = sha(projFile(p, '.agents/onboarding-state.json'));
  const r = cli(['sync', '--project', 'P7', '--dry-run', '--json']);
  assert.equal(r.code, 2);
  const row = rowFor(projectRows(JSON.parse(r.out), 'P7'), 'AGENTS.md');
  assert.equal(row.action, 'conflict');
  assert.equal(sha(projFile(p, 'AGENTS.md')), fileBefore);
  assert.equal(sha(projFile(p, '.agents/onboarding-state.json')), stateBefore);
  assert.ok(!fs.existsSync(projFile(p, 'AGENTS.md.kit-incoming.json')));
});

// AC8: filled placeholder values survive a kit edit elsewhere.
test('AC8: filled {{PLACEHOLDER}} values are preserved by merge', () => {
  const p = makeProject('P8');
  const cur = fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8');
  writeProj(p, 'AGENTS.md', cur);
  recordState(p);
  // Fill the surviving token + personalize the invariants line (kit invariants
  // line was already substituted by the AC7 kit change, so edit it in place).
  writeProj(p, 'AGENTS.md', cur
    .replace('{{PROJECT_NAME}}', 'RocketApp')
    .replace('kit invariants v2', 'node22, pnpm, no tests yet'));
  const newTmpl = cur.replace('## Testing', '## Testing (kit expanded)');
  writeKit('templates/AGENTS.md.tmpl', newTmpl);
  commitKit();

  const r = cli(['sync', '--project', 'P8', '--json']);
  assert.equal(r.code, 0, r.err);
  const out = fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8');
  assert.match(out, /RocketApp/);
  assert.match(out, /node22, pnpm/);
  assert.match(out, /## Testing \(kit expanded\)/);
});

// AC9: unchanged-vs-base MCP entry follows the kit; self-added untouched.
test('AC9: unmodified managed MCP entry follows kit update', () => {
  const p = makeProject('P9', { agents: ['devin'] });
  writeProj(p, '.devin/config.json', JSON.stringify({
    mcpServers: {
      semble: MANIFEST.mcpServers[0].config,
      devtools: MANIFEST.mcpServers[1].config,
    },
  }, null, 2));
  recordState(p);
  const cfg = JSON.parse(fs.readFileSync(projFile(p, '.devin/config.json'), 'utf8'));
  cfg.mcpServers['my-own-server'] = { command: 'mine', args: [], env: {} };
  writeProj(p, '.devin/config.json', JSON.stringify(cfg, null, 2));

  const newManifest = JSON.parse(JSON.stringify(MANIFEST));
  newManifest.mcpServers[0].config.args = ['-y', '@semblemcp/server@2'];
  writeKit('onboard.manifest.json', JSON.stringify(newManifest, null, 2) + '\n');
  commitKit();

  const r = cli(['sync', '--project', 'P9', '--json']);
  assert.equal(r.code, 0, r.err);
  const afterCfg = JSON.parse(fs.readFileSync(projFile(p, '.devin/config.json'), 'utf8'));
  assert.deepEqual(afterCfg.mcpServers.semble.args, ['-y', '@semblemcp/server@2']);
  assert.deepEqual(afterCfg.mcpServers['my-own-server'], { command: 'mine', args: [], env: {} });
  const rows = projectRows(JSON.parse(r.out), 'P9');
  assert.equal(rowFor(rows, '.devin/config.json:mcpServers.semble').action, 'fast-forward');
  assert.equal(rowFor(rows, '.devin/config.json:mcpServers.my-own-server').action, 'project-only');
});

// AC10: customized managed entry preserved + reported as conflict + sidecar.
test('AC10: customized MCP entry is preserved and reported', () => {
  const p = makeProject('P10', { agents: ['devin'] });
  // Install the CURRENT committed manifest's config (v2 after AC9's commit),
  // then customize - so the recorded base differs from the local entry.
  const curManifest = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
  writeProj(p, '.devin/config.json', JSON.stringify({
    mcpServers: { semble: curManifest.mcpServers[0].config },
  }, null, 2));
  recordState(p);
  const cfg = JSON.parse(fs.readFileSync(projFile(p, '.devin/config.json'), 'utf8'));
  cfg.mcpServers.semble = { command: 'custom-semble', args: ['--local'], env: {} };
  writeProj(p, '.devin/config.json', JSON.stringify(cfg, null, 2));

  const newManifest = JSON.parse(JSON.stringify(MANIFEST));
  newManifest.mcpServers[0].config.args = ['-y', '@semblemcp/server@4'];
  writeKit('onboard.manifest.json', JSON.stringify(newManifest, null, 2) + '\n');
  commitKit();

  const r = cli(['sync', '--project', 'P10', '--json']);
  assert.equal(r.code, 2, `expected exit 2 (conflict-class), got ${r.code}`);
  const rows = projectRows(JSON.parse(r.out), 'P10');
  assert.equal(rowFor(rows, '.devin/config.json:mcpServers.semble').action, 'conflict');
  const afterCfg = JSON.parse(fs.readFileSync(projFile(p, '.devin/config.json'), 'utf8'));
  assert.equal(afterCfg.mcpServers.semble.command, 'custom-semble');
  const sidecar = JSON.parse(fs.readFileSync(projFile(p, '.devin/config.json.kit-incoming.json'), 'utf8'));
  assert.deepEqual(sidecar['mcpServers.semble'].args, ['-y', '@semblemcp/server@4']);
});

// AC11: overrides.skip exempts a managed path entirely.
test('AC11: overrides.skip leaves the file untouched and reports exempt', () => {
  const p = makeProject('P11');
  writeProj(p, 'AGENTS.md', fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8'));
  recordState(p);
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  reg.projects.find(e => e.name === 'P11').overrides.skip.push('AGENTS.md');
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2));
  const before = sha(projFile(p, 'AGENTS.md'));

  writeKit('templates/AGENTS.md.tmpl', fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8') + '\n## New kit section\n');
  commitKit();

  const r = cli(['sync', '--project', 'P11', '--json']);
  assert.equal(r.code, 0, r.err);
  const row = rowFor(projectRows(JSON.parse(r.out), 'P11'), 'AGENTS.md');
  assert.equal(row.action, 'skip');
  assert.match(row.detail, /exempt|overrides\.skip/);
  assert.equal(sha(projFile(p, 'AGENTS.md')), before);
});

// AC12: registered project without state file -> unadopted, untouched.
test('AC12: project without state file is reported unadopted', () => {
  const p = makeProject('P12');
  writeProj(p, 'AGENTS.md', '# hand-written agents file\n');
  const before = sha(projFile(p, 'AGENTS.md'));

  const r = cli(['sync', '--project', 'P12', '--json']);
  assert.equal(r.code, 0, r.err);
  const rep = JSON.parse(r.out);
  const p12 = rep.projects.find(x => x.name === 'P12');
  assert.equal(p12.status, 'unadopted');
  assert.equal(rowFor(p12.files, '(project)').action, 'unadopted');
  assert.equal(sha(projFile(p, 'AGENTS.md')), before);
  assert.ok(!fs.existsSync(projFile(p, '.agents/onboarding-state.json')));
});

// AC13: --json emits valid JSON whose actions mirror the human report.
// Compare two --dry-run invocations: dry-runs mutate nothing, so both runs
// see identical inputs (a real sync would change state between the runs).
test('AC13: --json report matches the human report', () => {
  const human = cli(['sync', '--dry-run']);
  const json = cli(['sync', '--dry-run', '--json']);
  const rep = JSON.parse(json.out); // valid JSON across the whole battery
  assert.ok(Array.isArray(rep.projects) && rep.projects.length >= 5);
  const VOCAB = ['fast-forward', 'merged', 'conflict', 'skip', 'project-only',
    'unadopted', 'retired', 'adopted'];
  for (const a of rep.actions) {
    assert.ok(VOCAB.includes(a.action), `unexpected action ${a.action}`);
    assert.ok(a.artifact && a.project);
  }
  // Every JSON row appears verbatim in the human report.
  for (const p of rep.projects) {
    for (const f of p.files) {
      assert.ok(human.out.includes(f.artifact), `human report missing ${f.artifact}`);
      assert.ok(human.out.includes(f.action), `human report missing action ${f.action}`);
    }
  }
  // Exit codes match between the two report modes (P4/P7 conflicts -> 2).
  assert.equal(json.code, human.code);
});

// Skills: presence reported via the same 5-location check as the scaffold.
test('skills: presence report + kit-bundled skill install', () => {
  const p = makeProject('P13', { agents: ['devin'] });
  writeProj(p, 'AGENTS.md', fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8'));
  recordState(p);

  const r = cli(['sync', '--project', 'P13', '--json']);
  assert.equal(r.code, 0, r.err);
  const p13 = JSON.parse(r.out).projects.find(x => x.name === 'P13');
  assert.equal(p13.skills.find(s => s.name === 'already-there-skill').status, 'present');
  assert.equal(p13.skills.find(s => s.name === 'missing-optional-skill').status, 'missing');
  // templateSkills copy into the (fake) global skills dir, like the scaffold
  // (earlier project syncs may have installed it already -> either status ok)
  const bundled = p13.skills.find(s => s.name === 'bundled-skill');
  assert.ok(['installed', 'present'].includes(bundled.status), bundled.status);
  assert.ok(fs.existsSync(path.join(HOME_DIR, '.agents', 'skills', 'bundled-skill', 'SKILL.md')));
});

// Regression for review finding F4: kit templates added to the manifest after
// a project was onboarded propagate on the next sync (never overwriting -
// absent dest + no recorded base = nothing local exists to lose).
test('F4: new managed template propagates; agent-scoped dests stay gated', () => {
  const p = makeProject('P14'); // agents: [] - no agent-scoped dests may appear
  writeProj(p, 'AGENTS.md', fs.readFileSync(kitPath('templates/AGENTS.md.tmpl'), 'utf8'));
  recordState(p);

  writeKit('templates/EXTRA.md.tmpl', '# extra kit doc\n');
  const m = JSON.parse(fs.readFileSync(kitPath('onboard.manifest.json'), 'utf8'));
  m.templates.push({ src: 'templates/EXTRA.md.tmpl', dest: 'EXTRA.md', overwrite: false });
  writeKit('onboard.manifest.json', JSON.stringify(m, null, 2) + '\n');
  commitKit();

  const r = cli(['sync', '--project', 'P14', '--json']);
  assert.equal(r.code, 0, r.err);
  const rows = projectRows(JSON.parse(r.out), 'P14');
  const row = rowFor(rows, 'EXTRA.md');
  assert.equal(row.action, 'fast-forward');
  assert.match(row.detail, /new managed file/);
  assert.equal(fs.readFileSync(projFile(p, 'EXTRA.md'), 'utf8'), '# extra kit doc\n');
  // recorded as managed from now on
  assert.equal(readState(p).artifacts['EXTRA.md'].hash, sha(kitPath('templates/EXTRA.md.tmpl')));
  // agent-scoped rules dest must NOT be created for an agents=[] project
  assert.ok(!fs.existsSync(projFile(p, '.windsurf/rules/dev-env.md')));
});

// Review-round-2 regressions (per-artifact kitCommit + --force/marker
// semantics) live in tests/sync-r2.test.mjs against a fresh, self-contained
// kit - they must not depend on the cumulative template mutations above.
