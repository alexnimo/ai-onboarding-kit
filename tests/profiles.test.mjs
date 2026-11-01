/**
 * profiles.test.mjs - specialist profile engine tests.
 * Run: node --test tests/profiles.test.mjs
 *
 * Covers the consumer-visible contract of bin/lib/profiles.mjs:
 * effective-profile resolution (kit + user + overrides), per-harness
 * artifact plans (each kind emits the right files with the right shape),
 * core-server inheritance, merge-vs-overwrite apply, deterministic delete,
 * and the tier filter's real effect on onboard plan rows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  effectiveProfiles,
  planProfile,
  applyProfilePlan,
  deleteProfileArtifacts,
  resolveServers,
  invokeStrings,
} from '../bin/lib/profiles.mjs';
import { mergedMcpConfig } from '../bin/lib/onboard-plan.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));

const MANIFEST = {
  mcpServers: [
    { name: 'semble', required: true, tier: 'core', config: { command: 'npx', args: ['-y', '@semblemcp/server'], env: {} } },
    { name: 'chrome-devtools', required: false, tier: 'specialist', config: { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'], env: {} } },
    { name: 'playwright', required: false, tier: 'specialist', config: { command: 'npx', args: ['@playwright/mcp@latest'], env: {} } },
  ],
  agentProfiles: {
    omp: { specialist: { kind: 'profiles', profileDir: '~/.omp/profiles/<id>/agent' } },
    opencode: { specialist: { kind: 'agents+json', agentsDir: '.opencode/agents', configPath: 'opencode.json' } },
    'claude-code': { specialist: { kind: 'mcp-config+agents', agentsDir: '.claude/agents', mcpConfigPath: '.claude/mcp-<id>.json' } },
    devin: { specialist: { kind: 'local-config+agents', agentsDir: '.devin/agents', localConfigPath: '.devin/mcp_config.local.json', serversDisabled: true } },
    cursor: { specialist: { kind: 'core-only' } },
  },
};

const PROFILE = {
  id: 'qa-agent',
  label: 'QA',
  description: 'Browser QA.',
  skills: ['browser-testing-with-devtools'],
  mcpServers: ['chrome-devtools', 'playwright'],
  agent: { file: 'templates/agents/qa-agent.md.tmpl' },
  harnesses: ['omp', 'opencode', 'claude-code', 'devin'],
  origin: 'kit',
};

function state() {
  return { schemaVersion: 1, profiles: {}, overrides: {}, artifacts: {} };
}

// ---------- effective profiles ----------

test('effectiveProfiles: kit profiles + user profiles, overrides disable', () => {
  const st = state();
  st.profiles['custom'] = { label: 'Custom', mcpServers: [], harnesses: ['omp'] };
  st.overrides['design'] = { disabled: true };
  const eff = effectiveProfiles({ profiles: [{ id: 'design' }, { id: 'qa-agent' }] }, st);
  const ids = eff.map(p => p.id).sort();
  assert.deepEqual(ids, ['custom', 'qa-agent']);
  assert.equal(eff.find(p => p.id === 'custom').origin, 'user');
});

test('effectiveProfiles: override merges fields without disabling', () => {
  const st = state();
  st.overrides['qa-agent'] = { skills: ['extra-skill'] };
  const eff = effectiveProfiles({ profiles: [{ id: 'qa-agent', skills: ['a'] }] }, st);
  assert.deepEqual(eff[0].skills, ['extra-skill']);
  assert.equal(eff[0].origin, 'kit');
});

// ---------- server resolution ----------

test('resolveServers: core servers always included + refs resolved, missing flagged', () => {
  const { servers, missing } = resolveServers({ ...PROFILE, mcpServers: ['chrome-devtools', 'nope'] }, MANIFEST);
  const names = servers.map(s => s.name);
  assert.ok(names.includes('semble'), 'core semble must flow into profiles');
  assert.ok(names.includes('chrome-devtools'));
  assert.deepEqual(missing, ['nope']);
});

// ---------- per-harness plans ----------

test('planProfile: omp emits user-scope profile mcp.json + AGENTS.md with all servers', () => {
  const home = tmp();
  const plan = planProfile({ ...PROFILE, harnesses: ['omp'] }, MANIFEST, null, { home });
  const mcp = plan.artifacts.find(a => a.dest.endsWith('mcp.json'));
  const agents = plan.artifacts.find(a => a.dest.endsWith('AGENTS.md'));
  assert.ok(mcp && agents, 'omp plan needs mcp.json + AGENTS.md');
  assert.equal(mcp.scope, 'user');
  assert.ok(mcp.absPath.startsWith(home), 'user artifact under injected home');
  const mcpJson = JSON.parse(mcp.content);
  assert.ok(mcpJson.mcpServers.semble, 'core server in profile mcp.json');
  assert.ok(mcpJson.mcpServers['chrome-devtools']);
  assert.ok(mcpJson.mcpServers.playwright);
});

test('planProfile: opencode emits opencode.json {mcp,tools} + agent md with per-server enable', () => {
  const root = tmp();
  const plan = planProfile({ ...PROFILE, harnesses: ['opencode'] }, MANIFEST, root, { home: tmp() });
  const cfg = plan.artifacts.find(a => a.dest === 'opencode.json');
  const agent = plan.artifacts.find(a => a.dest === '.opencode/agents/qa-agent.md');
  assert.ok(cfg?.mergeKeys?.mcp && cfg.mergeKeys.tools);
  const j = JSON.parse(cfg.content);
  assert.equal(j.mcp['chrome-devtools'].type, 'local');
  assert.deepEqual(j.mcp['chrome-devtools'].command, ['npx', '-y', 'chrome-devtools-mcp@latest']);
  assert.equal(j.mcp['chrome-devtools'].enabled, true);
  assert.equal(j.tools['chrome-devtools_*'], false, 'specialist globally denied');
  assert.equal(j.tools.semble, undefined, 'core servers not denied');
  assert.match(agent.content, /mode: all/);
  assert.match(agent.content, /"chrome-devtools_\*": true/, 'agent re-enables specialist');
});

test('planProfile: claude-code emits scoped mcp-<id>.json + agent with mcp__ tools', () => {
  const root = tmp();
  const plan = planProfile({ ...PROFILE, harnesses: ['claude-code'] }, MANIFEST, root, { home: tmp() });
  const mcp = plan.artifacts.find(a => a.dest === '.claude/mcp-qa-agent.json');
  const agent = plan.artifacts.find(a => a.dest === '.claude/agents/qa-agent.md');
  assert.ok(JSON.parse(mcp.content).mcpServers.playwright);
  assert.match(agent.content, /mcp__chrome-devtools__\*/);
  assert.match(agent.content, /mcp__playwright__\*/);
});

test('planProfile: devin emits disabled local config + agent file', () => {
  const root = tmp();
  const plan = planProfile({ ...PROFILE, harnesses: ['devin'] }, MANIFEST, root, { home: tmp() });
  const cfg = plan.artifacts.find(a => a.dest === '.devin/mcp_config.local.json');
  const j = JSON.parse(cfg.content);
  assert.equal(j.mcpServers['chrome-devtools'].disabled, true);
  assert.equal(j.mcpServers.semble.disabled, true, 'core server also disabled-flagged in scoped file');
  assert.ok(plan.artifacts.some(a => a.dest === '.devin/agents/qa-agent.md'));
});

test('planProfile: core-only harness emits warning, no artifacts', () => {
  const plan = planProfile({ ...PROFILE, harnesses: ['cursor'] }, MANIFEST, tmp(), { home: tmp() });
  assert.equal(plan.artifacts.length, 0);
  assert.match(plan.warnings[0], /core-only/);
});

test('invokeStrings: every supported harness has a call path', () => {
  const inv = invokeStrings(PROFILE);
  assert.match(inv.omp, /--profile qa-agent/);
  assert.match(inv.opencode, /--agent qa-agent/);
  assert.match(inv['claude-code'], /mcp-qa-agent\.json/);
  assert.match(inv.devin, /mcp enable/);
});

// ---------- apply + delete ----------

test('applyProfilePlan: writes whole-file + merges mergeKeys; delete removes only recorded', () => {
  const root = tmp();
  const home = tmp();
  const st = state();
  const profile = { ...PROFILE, harnesses: ['omp', 'opencode'] };
  const plan = planProfile(profile, MANIFEST, root, { home });
  applyProfilePlan(plan, profile, st);

  const ompMcp = path.join(home, '.omp', 'profiles', 'qa-agent', 'agent', 'mcp.json');
  assert.ok(fs.existsSync(ompMcp), 'omp profile mcp.json written');
  const ocj = JSON.parse(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8'));
  assert.ok(ocj.mcp.playwright && ocj.tools['playwright_*'] === false);

  // Merge preserves pre-existing foreign keys.
  fs.writeFileSync(path.join(root, 'opencode.json'),
    JSON.stringify({ mcp: { other: { type: 'local', command: ['x'] } }, custom: 1 }));
  const plan2 = planProfile(profile, MANIFEST, root, { home });
  applyProfilePlan(plan2, profile, st);
  const ocj2 = JSON.parse(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8'));
  assert.ok(ocj2.mcp.other, 'foreign mcp entry preserved by merge');
  assert.equal(ocj2.custom, 1, 'foreign top-level key preserved');

  // Delete removes recorded artifacts.
  const res = deleteProfileArtifacts('qa-agent', st, { home });
  assert.ok(res.some(r => r.action === 'deleted' && r.dest.includes('mcp.json')));
  assert.ok(!fs.existsSync(ompMcp), 'omp profile mcp.json deleted');
});

test('deleteProfileArtifacts: modified generated file is kept, not deleted', () => {
  const home = tmp();
  const st = state();
  const profile = { ...PROFILE, harnesses: ['omp'] };
  applyProfilePlan(planProfile(profile, MANIFEST, null, { home }), profile, st);
  const f = path.join(home, '.omp', 'profiles', 'qa-agent', 'agent', 'AGENTS.md');
  fs.writeFileSync(f, '# user edits\n');
  const res = deleteProfileArtifacts('qa-agent', st, { home });
  assert.ok(res.some(r => r.action === 'kept-modified' && path.normalize(r.dest) === path.normalize(f)));
  assert.ok(fs.existsSync(f));
});

test('applyProfilePlan: removing an mcpServer prunes it from merged files', () => {
  const root = tmp();
  const st = state();
  const profile = { ...PROFILE, harnesses: ['opencode', 'devin'] };
  applyProfilePlan(planProfile(profile, MANIFEST, root), profile, st);

  const ocPath = path.join(root, 'opencode.json');
  const dvPath = path.join(root, '.devin', 'mcp_config.local.json');
  const before = JSON.parse(fs.readFileSync(ocPath, 'utf8'));
  assert.ok(before.mcp['chrome-devtools'] && before.mcp.playwright);
  assert.equal(before.tools['chrome-devtools_*'], false);

  // Add a foreign key the kit never wrote — it must survive every merge.
  const withForeign = JSON.parse(fs.readFileSync(ocPath, 'utf8'));
  withForeign.mcp['user-server'] = { type: 'local', command: ['x'] };
  fs.writeFileSync(ocPath, JSON.stringify(withForeign));

  // Edit the profile: playwright out.
  const edited = { ...profile, mcpServers: ['chrome-devtools'] };
  applyProfilePlan(planProfile(edited, MANIFEST, root), edited, st);

  const oc = JSON.parse(fs.readFileSync(ocPath, 'utf8'));
  assert.ok(oc.mcp['chrome-devtools'], 'kept server still merged');
  assert.equal(oc.mcp.playwright, undefined, 'removed server pruned from mcp');
  assert.equal(oc.tools['playwright_*'], undefined, 'removed server pruned from tools');
  assert.equal(oc.tools['chrome-devtools_*'], false, 'kept deny entry still merged');
  assert.ok(oc.mcp['user-server'], 'foreign key preserved');

  const dv = JSON.parse(fs.readFileSync(dvPath, 'utf8'));
  assert.ok(dv.mcpServers['chrome-devtools']);
  assert.equal(dv.mcpServers.playwright, undefined, 'pruned in devin local config too');
});

test('applyProfilePlan: legacy record without managedKeys prunes catalog names', () => {
  const root = tmp();
  const st = state();
  const profile = { ...PROFILE, harnesses: ['devin'] };
  applyProfilePlan(planProfile(profile, MANIFEST, root), profile, st);
  // Simulate pre-managedKeys state: drop the field from the record.
  for (const rec of Object.values(st.artifacts)) delete rec.managedKeys;

  const edited = { ...profile, mcpServers: ['chrome-devtools'] };
  applyProfilePlan(planProfile(edited, MANIFEST, root), edited, st);

  const dv = JSON.parse(fs.readFileSync(
    path.join(root, '.devin', 'mcp_config.local.json'), 'utf8'));
  assert.equal(dv.mcpServers.playwright, undefined,
    'catalog-named stale key pruned under legacy inference');
});

test('deleteProfileArtifacts: merged file loses only kit keys, foreign content keeps the file', () => {
  const root = tmp();
  const st = state();
  const profile = { ...PROFILE, harnesses: ['devin'] };
  applyProfilePlan(planProfile(profile, MANIFEST, root), profile, st);

  const dvPath = path.join(root, '.devin', 'mcp_config.local.json');
  const cur = JSON.parse(fs.readFileSync(dvPath, 'utf8'));
  cur.mcpServers['user-server'] = { command: 'x' };
  fs.writeFileSync(dvPath, JSON.stringify(cur));

  const res = deleteProfileArtifacts('qa-agent', st);
  assert.ok(res.some(r => r.action === 'pruned' && r.dest === dvPath));
  const after = JSON.parse(fs.readFileSync(dvPath, 'utf8'));
  assert.deepEqual(Object.keys(after.mcpServers), ['user-server'],
    'only the foreign server remains');
});

test('deleteProfileArtifacts: kit-only merged file is deleted outright', () => {
  const root = tmp();
  const st = state();
  const profile = { ...PROFILE, harnesses: ['devin'] };
  applyProfilePlan(planProfile(profile, MANIFEST, root), profile, st);
  const dvPath = path.join(root, '.devin', 'mcp_config.local.json');
  const res = deleteProfileArtifacts('qa-agent', st);
  assert.ok(res.some(r => r.action === 'deleted' && r.dest === dvPath));
  assert.ok(!fs.existsSync(dvPath));
});

// ---------- tier filter on main-config merge ----------

test('mergedMcpConfig: specialist-tier servers never merge into main config', () => {
  const { out, added } = mergedMcpConfig({}, MANIFEST, 'mcpServers');
  assert.ok(out.mcpServers.semble);
  assert.equal(out.mcpServers['chrome-devtools'], undefined);
  assert.equal(out.mcpServers.playwright, undefined);
  assert.deepEqual(added, ['semble']);
});
