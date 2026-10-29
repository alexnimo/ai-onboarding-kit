/**
 * governance.test.mjs - T4 acceptance tests: adopt, prune, doctor.
 *
 * Runs the real CLI against a hermetic git-backed kit (same harness shape as
 * sync.test.mjs). Retirement is exercised with a manifest variant that drops
 * a template, passed via --manifest, so no kit re-commit gymnastics are
 * needed.
 *
 *   node --test tests/governance.test.mjs
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-gov-'));
const KIT = path.join(TMP, 'kit');
const HOME_DIR = path.join(TMP, 'home');
const PROJ_DIR = path.join(TMP, 'projects');
const CLI = path.join(KIT, 'bin', 'onboard.mjs');

const AGENTS_TMPL = '# AGENTS - {{PROJECT_NAME}}\n\n> {{PROJECT_DESCRIPTION}}\n\nbody\n';
const SYSTEM_TMPL = '# SYSTEM - {{PROJECT_NAME}}\n\nsystem body\n';

const MANIFEST = {
  version: '1.0.0-gov',
  directories: ['.agents'],
  templates: [
    { src: 'templates/AGENTS.md.tmpl', dest: 'AGENTS.md', overwrite: false },
    { src: 'templates/SYSTEM.md.tmpl', dest: '.agents/SYSTEM.md', overwrite: false },
  ],
  rules: [
    { src: 'templates/rules/dev-env.md.tmpl', dest: 'dev-env.md', overwrite: false },
  ],
  skills: [
    { name: 'installed-skill', source: 'acme/skills', skill: 'installed-skill', required: true },
    { name: 'missing-optional-skill', source: 'acme/skills', skill: 'missing-optional-skill', required: false },
  ],
  templateSkills: [
    { src: 'templates/skills/bundled-skill', dest: 'bundled-skill', required: true },
  ],
  cliTools: [],
  placeholders: [{ key: 'PROJECT_NAME' }, { key: 'PROJECT_DESCRIPTION' }],
  mcpServers: [
    { name: 'semble', required: true, config: { command: 'npx', args: ['-y', '@semblemcp/server@1'], env: {} } },
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
    // Second profile: config adoption must stay agent-gated (F3).
    pi: {
      instructionsFile: 'AGENTS.md',
      mcpConfigPath: '.pi/mcp.json',
      mcpConfigKey: 'mcp',
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
const kitHead = () => git(['rev-parse', 'HEAD']);

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
const readState = dir => JSON.parse(fs.readFileSync(projFile(dir, '.agents/onboarding-state.json'), 'utf8'));
const recordState = dir => {
  const r = cli(['record-state', '--path', dir]);
  assert.equal(r.code, 0, `record-state failed: ${r.err}`);
};
const parseJson = r => JSON.parse(r.out);

// ---------- fixtures ----------

let PRUNED_MANIFEST; // manifest without the SYSTEM.md template

before(() => {
  fs.mkdirSync(KIT, { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'bin'), path.join(KIT, 'bin'), { recursive: true });
  writeKit('onboard.manifest.json', JSON.stringify(MANIFEST, null, 2) + '\n');
  writeKit('templates/AGENTS.md.tmpl', AGENTS_TMPL);
  writeKit('templates/SYSTEM.md.tmpl', SYSTEM_TMPL);
  writeKit('templates/rules/dev-env.md.tmpl', '# dev env rules\n');
  writeKit('templates/skills/bundled-skill/SKILL.md', '# bundled\n');
  writeKit('.gitignore', 'projects.registry.json\nprojects.registry.json.lock\n');
  fs.mkdirSync(path.join(HOME_DIR, '.agents', 'skills', 'installed-skill'), { recursive: true });
  fs.writeFileSync(path.join(HOME_DIR, '.agents', 'skills', 'installed-skill', 'SKILL.md'), '# x\n');
  fs.mkdirSync(path.join(HOME_DIR, '.agents', 'skills', 'bundled-skill'), { recursive: true });
  fs.writeFileSync(path.join(HOME_DIR, '.agents', 'skills', 'bundled-skill', 'SKILL.md'), '# bundled\n');
  git(['init', '-q', '-b', 'main']);
  commitKit();

  const pruned = { ...MANIFEST, templates: MANIFEST.templates.filter(t => t.dest !== '.agents/SYSTEM.md') };
  PRUNED_MANIFEST = kitPath('manifest-no-system.json');
  writeKit('manifest-no-system.json', JSON.stringify(pruned, null, 2) + '\n');
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------- AC1: adoption of a legacy project ----------

test('AC1: sync --adopt baselines config only; zero template/rule writes', () => {
  const p = makeProject('ADOPT1', { agents: ['devin'] });
  // Legacy project: AGENTS.md + .agents/ exist, NO state file, no MCP config.
  writeProj(p, 'AGENTS.md', '# hand-written agents\n');
  writeProj(p, '.agents/NOTES.md', 'legacy notes\n');
  const agentsHash = crypto.createHash('sha256')
    .update(fs.readFileSync(projFile(p, 'AGENTS.md'))).digest('hex');

  const r = cli(['sync', '--project', 'ADOPT1', '--adopt', '--json']);
  assert.equal(r.code, 0, r.err);
  const rep = parseJson(r);
  const pr = rep.projects.find(x => x.name === 'ADOPT1');
  assert.equal(pr.status, 'adopted');
  assert.ok(pr.files.some(f => f.action === 'adopted'));

  // MCP/hooks synced per managed-key policy: config files created + keys added.
  const mcp = JSON.parse(fs.readFileSync(projFile(p, '.devin/config.json'), 'utf8'));
  assert.ok(mcp.mcpServers.semble, 'semble key should be added on adopt');
  const hooks = JSON.parse(fs.readFileSync(projFile(p, '.devin/hooks.v1.json'), 'utf8'));
  assert.ok(hooks.PreToolUse, 'PreToolUse hooks should be added on adopt');
  assert.ok(pr.files.some(f => f.artifact.includes('mcpServers.semble') && f.action === 'fast-forward'));

  // ZERO template/rule files modified: AGENTS.md untouched, none created.
  assert.equal(crypto.createHash('sha256')
    .update(fs.readFileSync(projFile(p, 'AGENTS.md'))).digest('hex'), agentsHash);
  assert.ok(!fs.existsSync(projFile(p, '.agents/SYSTEM.md')));
  assert.ok(!fs.existsSync(projFile(p, '.windsurf/rules/dev-env.md')));

  // State file created recording post-adoption hashes (config artifacts only).
  const state = readState(p);
  assert.ok(state.artifacts['.devin/config.json'], 'config artifact recorded');
  assert.equal(state.artifacts['.devin/config.json'].hash,
    crypto.createHash('sha256').update(fs.readFileSync(projFile(p, '.devin/config.json'))).digest('hex'));
  assert.ok(!state.artifacts['AGENTS.md'], 'templates stay unrecorded (foreign)');
});

// ---------- AC7: --adopt with existing state is a normal sync ----------

test('AC7: --adopt on a project WITH state behaves as normal sync', () => {
  const p = makeProject('ADOPT7');
  writeProj(p, 'AGENTS.md', AGENTS_TMPL);
  recordState(p);

  // Project edited the file; adopt flag must be a harmless no-op.
  writeProj(p, 'AGENTS.md', AGENTS_TMPL + '\nproject addition\n');
  const r = cli(['sync', '--project', 'ADOPT7', '--adopt', '--json']);
  assert.equal(r.code, 0, r.err);
  const pr = parseJson(r).projects.find(x => x.name === 'ADOPT7');
  assert.equal(pr.status, 'ok', 'with state present adopt is not adopted');
  assert.ok(pr.files.some(f => f.artifact === 'AGENTS.md' && f.action === 'project-only'));
  assert.ok(fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8').includes('project addition'));
});

// ---------- AC2 + AC8: retired reporting and prune safety ----------

test('AC2: retired file reported, kept; --prune deletes only pristine copies', () => {
  const p = makeProject('PRUNE1');
  writeProj(p, 'AGENTS.md', AGENTS_TMPL);
  writeProj(p, '.agents/SYSTEM.md', SYSTEM_TMPL);
  recordState(p);

  // Manifest no longer ships SYSTEM.md -> reported retired, file kept.
  const r1 = cli(['sync', '--project', 'PRUNE1', '--manifest', PRUNED_MANIFEST, '--json']);
  assert.equal(r1.code, 0, r1.err);
  const sysRow = parseJson(r1).projects[0].files.find(f => f.artifact === '.agents/SYSTEM.md');
  assert.equal(sysRow.action, 'retired');
  assert.ok(fs.existsSync(projFile(p, '.agents/SYSTEM.md')), 'retired file kept without --prune');

  // --prune: project content == recorded base -> deleted + state entry gone.
  const r2 = cli(['sync', '--project', 'PRUNE1', '--manifest', PRUNED_MANIFEST, '--prune', '--json']);
  assert.equal(r2.code, 0, r2.err);
  assert.ok(!fs.existsSync(projFile(p, '.agents/SYSTEM.md')), 'pristine retired file pruned');
  assert.ok(!readState(p).artifacts['.agents/SYSTEM.md'], 'state record removed by prune');
});

test('AC8: --prune never deletes a project-modified retired file', () => {
  const p = makeProject('PRUNE2');
  writeProj(p, 'AGENTS.md', AGENTS_TMPL);
  writeProj(p, '.agents/SYSTEM.md', SYSTEM_TMPL);
  recordState(p);
  writeProj(p, '.agents/SYSTEM.md', SYSTEM_TMPL + '\ncustomized by project\n');

  const r = cli(['sync', '--project', 'PRUNE2', '--manifest', PRUNED_MANIFEST, '--prune', '--json']);
  assert.equal(r.code, 0, r.err);
  const sysRow = parseJson(r).projects[0].files.find(f => f.artifact === '.agents/SYSTEM.md');
  assert.equal(sysRow.action, 'retired');
  assert.match(sysRow.detail, /differs|kept/);
  assert.ok(fs.existsSync(projFile(p, '.agents/SYSTEM.md')), 'modified retired file kept under --prune');
  assert.ok(fs.readFileSync(projFile(p, '.agents/SYSTEM.md'), 'utf8').includes('customized by project'));
});

// ---------- AC3: healthy fleet exits 0 ----------

test('AC3: doctor on a healthy fleet exits 0 with a clean report', () => {
  const p = makeProject('HEALTHY', { agents: ['devin'] });
  writeProj(p, 'AGENTS.md', AGENTS_TMPL);
  writeProj(p, '.agents/SYSTEM.md', SYSTEM_TMPL);
  writeProj(p, '.windsurf/rules/dev-env.md', '# dev env rules\n');
  writeProj(p, '.devin/config.json', JSON.stringify({ mcpServers: MANIFEST.mcpServers
    .reduce((o, s) => ({ ...o, [s.name]: s.config }), {}) }, null, 2) + '\n');
  writeProj(p, '.devin/hooks.v1.json', JSON.stringify({
    PreToolUse: [{ matcher: 'exec', hooks: [{ type: 'command', command: 'ctx pretooluse' }] }],
  }, null, 2) + '\n');
  recordState(p);

  const r = cli(['doctor', '--project', 'HEALTHY']);
  assert.equal(r.code, 0, `doctor should be clean: ${r.out}\n${r.err}`);
  assert.match(r.out, /clean/);
});

// ---------- AC4: dead path -> exit 3, suggests --remove ----------

test('AC4: doctor reports dead path, exit 3, suggests --remove', () => {
  const p = makeProject('DEAD');
  fs.rmSync(p, { recursive: true, force: true });
  const r = cli(['doctor', '--project', 'DEAD']);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /--remove/);
});

// ---------- AC5: missing state -> exit 3, suggests --adopt ----------

test('AC5: doctor reports missing state file, exit 3, suggests --adopt', () => {
  makeProject('NOSTATE');
  const r = cli(['doctor', '--project', 'NOSTATE']);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /--adopt/);
});

// ---------- AC6: drift counts + JSON ----------

test('AC6: doctor drift counts are correct and --json parses', () => {
  const p = makeProject('DRIFT');
  writeProj(p, 'AGENTS.md', AGENTS_TMPL);
  writeProj(p, '.agents/SYSTEM.md', SYSTEM_TMPL);
  writeProj(p, '.windsurf/rules/dev-env.md', '# dev env rules\n');
  recordState(p);

  // project-only: local edit, kit unchanged.
  writeProj(p, '.windsurf/rules/dev-env.md', '# dev env rules\n+ project line\n');
  // kit-ahead: kit edit on SYSTEM.md, project untouched.
  writeKit('templates/SYSTEM.md.tmpl', SYSTEM_TMPL + '\nkit v2\n');
  commitKit();
  // would-be-conflict: both sides edit AGENTS.md.
  writeKit('templates/AGENTS.md.tmpl', '# AGENTS - {{PROJECT_NAME}}\n\n> {{PROJECT_DESCRIPTION}}\n\nbody CHANGED BY KIT\n');
  commitKit();
  writeProj(p, 'AGENTS.md', '# AGENTS - {{PROJECT_NAME}}\n\n> {{PROJECT_DESCRIPTION}}\n\nbody changed by project\n');

  const r = cli(['doctor', '--project', 'DRIFT', '--json']);
  assert.equal(r.code, 3, 'conflict finding -> exit 3');
  const rep = parseJson(r);
  const pr = rep.projects.find(x => x.name === 'DRIFT');
  assert.equal(pr.drift.projectOnly, 1, `drift: ${JSON.stringify(pr.drift)}`);
  assert.equal(pr.drift.kitAhead, 1, `drift: ${JSON.stringify(pr.drift)}`);
  assert.equal(pr.drift.wouldBeConflicts, 1, `drift: ${JSON.stringify(pr.drift)}`);
  assert.ok(pr.findings.some(f => f.check === 'drift' && f.level === 'error'));

  // Dry-run nature: nothing was actually merged - file still project-side.
  assert.ok(fs.readFileSync(projFile(p, 'AGENTS.md'), 'utf8').includes('changed by project'));
});

// ---------- review r1 regressions ----------

// F1: record-state's fallback stores the project file's own hash when it
// never matched the kit source. --prune must NOT delete such a file: the
// recorded base was never shipped by the kit.
test('F1: --prune keeps retired file whose recorded base is project content', () => {
  const p = makeProject('F1');
  writeProj(p, 'AGENTS.md', AGENTS_TMPL);
  // Customized BEFORE recording: its own hash becomes the recorded base.
  writeProj(p, '.agents/SYSTEM.md', '# my own system doc, never from the kit\n');
  recordState(p);

  const r = cli(['sync', '--project', 'F1', '--manifest', PRUNED_MANIFEST, '--prune', '--json']);
  assert.equal(r.code, 0, r.err);
  const row = parseJson(r).projects[0].files.find(f => f.artifact === '.agents/SYSTEM.md');
  assert.equal(row.action, 'retired');
  assert.ok(fs.existsSync(projFile(p, '.agents/SYSTEM.md')),
    'file whose base was never kit-shipped must survive --prune');
});

// F2: under doctor's dry-run a missing REQUIRED bundled template skill
// reports 'would-install' - it must still surface as a skills finding.
test('F2: doctor flags a missing required kit-bundled skill', () => {
  const p = makeProject('F2');
  writeProj(p, 'AGENTS.md', AGENTS_TMPL);
  writeProj(p, '.agents/SYSTEM.md', SYSTEM_TMPL);
  writeProj(p, '.windsurf/rules/dev-env.md', '# dev env rules\n');
  recordState(p);

  // Manifest variant whose bundled skill is not installed in test HOME.
  const variant = {
    ...MANIFEST,
    templateSkills: [{ src: 'templates/skills/bundled-skill', dest: 'never-installed-skill', required: true }],
  };
  writeKit('manifest-uninstalled-skill.json', JSON.stringify(variant, null, 2) + '\n');

  const r = cli(['doctor', '--project', 'F2', '--manifest', kitPath('manifest-uninstalled-skill.json'), '--json']);
  assert.equal(r.code, 3, r.out);
  const pr = parseJson(r).projects.find(x => x.name === 'F2');
  assert.ok(pr.skills.requiredMissing.includes('never-installed-skill'),
    `requiredMissing: ${JSON.stringify(pr.skills)}`);
  assert.ok(pr.findings.some(f => f.check === 'skills'));
});

// F3: adoption must not record/manage configs for unregistered agents.
test('F3: adopt ignores config files of unregistered agent profiles', () => {
  const p = makeProject('F3', { agents: ['devin'] });
  writeProj(p, 'AGENTS.md', '# legacy\n');
  // A config file for the 'pi' profile that this project never registered.
  writeProj(p, '.pi/mcp.json', JSON.stringify({ mcp: { custom: { command: 'x' } } }) + '\n');

  const r = cli(['sync', '--project', 'F3', '--adopt', '--json']);
  assert.equal(r.code, 0, r.err);
  const pr = parseJson(r).projects[0];
  assert.equal(pr.status, 'adopted');
  assert.ok(!pr.files.some(f => f.artifact.startsWith('.pi/')),
    'pi config must not be touched: ' + JSON.stringify(pr.files));
  // The file keeps its foreign key and gains no managed keys.
  const mcp = JSON.parse(fs.readFileSync(projFile(p, '.pi/mcp.json'), 'utf8'));
  assert.ok(mcp.mcp.custom && !mcp.mcp.semble, 'pi config untouched');
  assert.ok(!readState(p).artifacts['.pi/mcp.json'], 'unregistered-agent config not adopted');
});

// review r1 (verify): a crafted state key that escapes the project root
// must never be hashed or deleted, even under --prune.
test('F-traversal: --prune never touches dests outside the project root', () => {
  const p = makeProject('TRAV');
  writeProj(p, 'AGENTS.md', AGENTS_TMPL);
  recordState(p);

  // Craft a state entry whose key escapes the project; the file outside
  // contains content identical to a kit source so every other gate passes.
  const outside = path.join(PROJ_DIR, 'outside-TRAV.md');
  fs.writeFileSync(outside, SYSTEM_TMPL);
  const state = readState(p);
  state.artifacts['../outside-TRAV.md'] = {
    hash: crypto.createHash('sha256').update(SYSTEM_TMPL).digest('hex'),
    source: 'templates/SYSTEM.md.tmpl',
    syncedAt: new Date().toISOString(),
    kitCommit: state.kitCommit,
  };
  fs.writeFileSync(projFile(p, '.agents/onboarding-state.json'), JSON.stringify(state, null, 2) + '\n');

  const r = cli(['sync', '--project', 'TRAV', '--manifest', PRUNED_MANIFEST, '--prune', '--json']);
  assert.equal(r.code, 0, r.err);
  const row = parseJson(r).projects[0].files.find(f => f.artifact === '../outside-TRAV.md');
  assert.ok(row && row.action === 'retired', `row: ${JSON.stringify(row)}`);
  assert.ok(fs.existsSync(outside), 'file outside the project must survive --prune');
});

// review r1 (verify): a template installed BY SYNC with placeholder values
// filled has bytes != raw kit source while rec.hash is the raw source hash;
// it is still a pristine kit artifact and must be prunable.
test('F-render: --prune removes a placeholder-filled retired install', () => {
  const p = makeProject('REND');
  writeProj(p, 'AGENTS.md', AGENTS_TMPL);
  recordState(p); // SYSTEM.md absent -> not recorded
  // Record placeholder fills like the scaffold does, then let sync install
  // the template rendered with them (rec.hash = raw source hash).
  const state = readState(p);
  state.placeholders = { PROJECT_NAME: 'REND', PROJECT_DESCRIPTION: 'd', STACK_NOTES: 's' };
  fs.writeFileSync(projFile(p, '.agents/onboarding-state.json'), JSON.stringify(state, null, 2) + '\n');
  const inst = cli(['sync', '--project', 'REND']);
  assert.equal(inst.code, 0, inst.err);
  const onDisk = fs.readFileSync(projFile(p, '.agents/SYSTEM.md'), 'utf8');
  assert.ok(onDisk.includes('- REND'), 'install should be placeholder-rendered');
  assert.notEqual(crypto.createHash('sha256').update(onDisk).digest('hex'),
    crypto.createHash('sha256').update(SYSTEM_TMPL).digest('hex'),
    'rendered bytes must differ from raw source');

  const r = cli(['sync', '--project', 'REND', '--manifest', PRUNED_MANIFEST, '--prune', '--json']);
  assert.equal(r.code, 0, r.err);
  const row = parseJson(r).projects[0].files.find(f => f.artifact === '.agents/SYSTEM.md');
  assert.match(row.detail, /pruned/, `row: ${JSON.stringify(row)}`);
  assert.ok(!fs.existsSync(projFile(p, '.agents/SYSTEM.md')),
    'placeholder-filled pristine install should be pruned');
});

// review r2: a retired dest inside a symlinked directory that resolves
// outside the project must never be hashed or deleted.
test('F-symlink: --prune refuses a dest resolving outside via symlink', (t) => {
  const p = makeProject('SYML');
  writeProj(p, 'AGENTS.md', AGENTS_TMPL);
  recordState(p);

  const outside = path.join(PROJ_DIR, 'outside-SYML.md');
  fs.writeFileSync(outside, SYSTEM_TMPL);
  // Symlink project dir -> outside location; on Windows a junction avoids
  // needing symlink privileges.
  const link = projFile(p, 'ext-link');
  try {
    fs.symlinkSync(PROJ_DIR, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    t.skip(`cannot create symlink: ${err.message}`);
    return;
  }

  const state = readState(p);
  state.artifacts['ext-link/outside-SYML.md'] = {
    hash: crypto.createHash('sha256').update(SYSTEM_TMPL).digest('hex'),
    source: 'templates/SYSTEM.md.tmpl',
    syncedAt: new Date().toISOString(),
    kitCommit: state.kitCommit,
  };
  fs.writeFileSync(projFile(p, '.agents/onboarding-state.json'), JSON.stringify(state, null, 2) + '\n');

  const r = cli(['sync', '--project', 'SYML', '--manifest', PRUNED_MANIFEST, '--prune', '--json']);
  assert.equal(r.code, 0, r.err);
  const row = parseJson(r).projects[0].files.find(f => f.artifact === 'ext-link/outside-SYML.md');
  assert.ok(row && row.action === 'retired', `row: ${JSON.stringify(row)}`);
  assert.ok(fs.existsSync(outside), 'symlinked-outside file must survive --prune');
});

// review r2: a crafted rec.source outside the kit repo must not let project
// bytes masquerade as a pristine recorded base.
test('F-source: --prune keeps a dest whose recorded source is outside the kit', () => {
  const p = makeProject('SRC');
  writeProj(p, 'AGENTS.md', AGENTS_TMPL);
  const victim = '# customized project doc\n';
  writeProj(p, 'victim.md', victim);
  recordState(p);

  // Outside-the-kit "source" whose content equals the victim file.
  const extSrc = path.join(TMP, 'external-source.tmpl');
  fs.writeFileSync(extSrc, victim);
  const state = readState(p);
  state.artifacts['victim.md'] = {
    hash: crypto.createHash('sha256').update(victim).digest('hex'),
    source: '../external-source.tmpl', // manifestRoot-relative escape
    syncedAt: new Date().toISOString(),
    kitCommit: state.kitCommit,
  };
  fs.writeFileSync(projFile(p, '.agents/onboarding-state.json'), JSON.stringify(state, null, 2) + '\n');

  const r = cli(['sync', '--project', 'SRC', '--manifest', PRUNED_MANIFEST, '--prune', '--json']);
  assert.equal(r.code, 0, r.err);
  const row = parseJson(r).projects[0].files.find(f => f.artifact === 'victim.md');
  assert.ok(row && row.action === 'retired', `row: ${JSON.stringify(row)}`);
  assert.ok(fs.existsSync(projFile(p, 'victim.md')),
    'file whose recorded source lives outside the kit must survive --prune');
});

// review r2 F1: --prune with a manifest OUTSIDE the kit repo must still
// prune retired files whose on-disk source (under that manifest's root)
// hash-matches the recorded base - external manifests have no git history
// but the user declared them, so their sources are kit content.
test('F-extmanifest: --prune works with a manifest outside the kit repo', () => {
  const extkit = path.join(TMP, 'extkit');
  fs.mkdirSync(path.join(extkit, 'templates'), { recursive: true });
  const extManifest = {
    version: '1.0.0-ext',
    directories: ['.agents'],
    templates: [
      { src: 'templates/AGENTS.md.tmpl', dest: 'AGENTS.md', overwrite: false },
    ],
    rules: [],
    skills: [],
    templateSkills: [],
    cliTools: [],
    placeholders: [],
    mcpServers: [],
    hooks: [],
    agentProfiles: {},
  };
  fs.writeFileSync(path.join(extkit, 'manifest.json'), JSON.stringify(extManifest, null, 2) + '\n');
  // This source exists on disk under the external manifest but is NOT in its
  // templates - recorded dests pointing at it retire.
  fs.writeFileSync(path.join(extkit, 'templates', 'SYSTEM.md.tmpl'), SYSTEM_TMPL);
  fs.writeFileSync(path.join(extkit, 'templates', 'AGENTS.md.tmpl'), AGENTS_TMPL);

  const p = makeProject('EXTM');
  writeProj(p, 'AGENTS.md', AGENTS_TMPL);
  writeProj(p, '.agents/SYSTEM.md', SYSTEM_TMPL);
  recordState(p); // records source templates/SYSTEM.md.tmpl + kit-source hash

  const extPath = path.join(extkit, 'manifest.json');
  const r = cli(['sync', '--project', 'EXTM', '--manifest', extPath, '--prune', '--json']);
  assert.equal(r.code, 0, r.err);
  const row = parseJson(r).projects[0].files.find(f => f.artifact === '.agents/SYSTEM.md');
  assert.match(row.detail, /pruned/, `row: ${JSON.stringify(row)}`);
  assert.ok(!fs.existsSync(projFile(p, '.agents/SYSTEM.md')),
    'external manifest must still prune a hash-matching retired file');
});

// review r1 (round 3): a retired dest reached through a symlink to a dir
// INSIDE the project resolves to a different file; deleting the resolved
// path would remove that file while the recorded (symlinked) dest survives.
test('F-alias: --prune refuses a dest that is a symlink alias within the project', (t) => {
  const p = makeProject('ALIAS');
  writeProj(p, 'AGENTS.md', AGENTS_TMPL);
  recordState(p);

  // real file at .agents/SYSTEM.md; alias dir -> .agents via symlink.
  writeProj(p, '.agents/SYSTEM.md', SYSTEM_TMPL);
  const link = projFile(p, 'alias-dir');
  try {
    fs.symlinkSync(projFile(p, '.agents'), link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    t.skip(`cannot create symlink: ${err.message}`);
    return;
  }
  const state = readState(p);
  state.artifacts['alias-dir/SYSTEM.md'] = {
    hash: crypto.createHash('sha256').update(SYSTEM_TMPL).digest('hex'),
    source: 'templates/SYSTEM.md.tmpl',
    syncedAt: new Date().toISOString(),
    kitCommit: state.kitCommit,
  };
  fs.writeFileSync(projFile(p, '.agents/onboarding-state.json'), JSON.stringify(state, null, 2) + '\n');

  const r = cli(['sync', '--project', 'ALIAS', '--manifest', PRUNED_MANIFEST, '--prune', '--json']);
  assert.equal(r.code, 0, r.err);
  const row = parseJson(r).projects[0].files.find(f => f.artifact === 'alias-dir/SYSTEM.md');
  assert.ok(row && row.action === 'retired', `row: ${JSON.stringify(row)}`);
  assert.ok(fs.existsSync(projFile(p, '.agents/SYSTEM.md')),
    'the aliased target must survive --prune');
  assert.ok(fs.existsSync(link), 'the symlink itself must survive --prune');
});

// review r2 F1 (alias baseline): a project REGISTERED via a symlinked
// parent must still prune - the comparison baseline is the real project
// root, not the lexical registered path.
test('F-realroot: --prune works when the registered path passes through a symlink', (t) => {
  const realDir = path.join(PROJ_DIR, 'real', 'VIASYM');
  fs.mkdirSync(realDir, { recursive: true });
  const linkDir = path.join(PROJ_DIR, 'via-link');
  try {
    fs.symlinkSync(path.join(PROJ_DIR, 'real'), linkDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    t.skip(`cannot create symlink: ${err.message}`);
    return;
  }
  const p = path.join(linkDir, 'VIASYM'); // registered via the symlink
  const args = ['register', '--name', 'VIASYM', '--path', p];
  assert.equal(cli(args).code, 0);
  writeProj(realDir, 'AGENTS.md', AGENTS_TMPL);
  writeProj(realDir, '.agents/SYSTEM.md', SYSTEM_TMPL);
  recordState(realDir);

  const r = cli(['sync', '--project', 'VIASYM', '--manifest', PRUNED_MANIFEST, '--prune', '--json']);
  assert.equal(r.code, 0, r.err);
  const row = parseJson(r).projects[0].files.find(f => f.artifact === '.agents/SYSTEM.md');
  assert.match(row.detail, /pruned/, `row: ${JSON.stringify(row)}`);
  assert.ok(!fs.existsSync(path.join(realDir, '.agents/SYSTEM.md')),
    'pristine retired file must be pruned even via a symlinked project path');
});

test('doctor flags stale lastSyncAt and dangling override paths', () => {
  const p = makeProject('STALE');
  writeProj(p, 'AGENTS.md', AGENTS_TMPL);
  recordState(p);

  // Backdate lastSyncAt and add a dangling skip override via the registry.
  const reg = JSON.parse(fs.readFileSync(path.join(KIT, 'projects.registry.json'), 'utf8'));
  const e = reg.projects.find(x => x.name === 'STALE');
  e.lastSyncAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
  e.overrides = { skip: ['nonexistent/path.md'], pins: {} };
  fs.writeFileSync(path.join(KIT, 'projects.registry.json'), JSON.stringify(reg, null, 2) + '\n');

  const r = cli(['doctor', '--project', 'STALE', '--json']);
  assert.equal(r.code, 3, r.out);
  const pr = parseJson(r).projects.find(x => x.name === 'STALE');
  assert.ok(pr.findings.some(f => f.check === 'stale'), `findings: ${JSON.stringify(pr.findings)}`);
  assert.ok(pr.findings.some(f => f.check === 'overrides'), `findings: ${JSON.stringify(pr.findings)}`);
});
