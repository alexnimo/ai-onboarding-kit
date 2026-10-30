/**
 * onboard-plan.test.mjs - tests for node-side onboarding plan rows
 * (spec: 2026-10-23-interactive-onboarding-design, module 2).
 *
 * P1: foreign AGENTS.md -> exists-skip + inject-region row with a diff
 *     that adds markers and preserves project text.
 * P2: fresh dir -> template create rows only; no inject-region.
 * P3: claude-code profile -> single merge-keys row covering MCP + hooks
 *     in the shared .claude/settings.json, plus CLAUDE.md create stub.
 * P4: existing config -> merge-keys adds only missing servers.
 * P5: mergeFactRows dedups node/fact rows on artifact+action.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildOnboardRows, mergeFactRows } = await import(
  pathToFileURL(path.join(ROOT, 'bin/lib/onboard-plan.mjs')).href);

const scratch = [];
function dir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'onbplan-'));
  scratch.push(d);
  return d;
}
after(() => scratch.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

test('P1: foreign AGENTS.md -> exists-skip + inject-region diff', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, 'AGENTS.md'), '# Legacy\n\nour rules\n');
  const { rows } = buildOnboardRows(d);
  const skip = rows.find(r => r.artifact === 'AGENTS.md');
  assert.equal(skip.action, 'exists-skip');
  const inj = rows.find(r => r.artifact === 'AGENTS.md:kit-region');
  assert.equal(inj.action, 'inject-region');
  assert.match(inj.diff, /BEGIN ai-onboarding-kit:kit-region/);
  assert.match(inj.diff, /our rules/); // project text visible in diff
});

test('P2: fresh dir -> create rows, no inject-region', () => {
  const d = dir();
  const { rows } = buildOnboardRows(d);
  const agent = rows.find(r => r.artifact === 'AGENTS.md');
  assert.equal(agent.action, 'create');
  assert.match(agent.diff, /BEGIN ai-onboarding-kit:kit-region/); // expanded inline
  assert.ok(!rows.some(r => r.action === 'inject-region'));
  assert.ok(rows.some(r => r.artifact === '(project)' && r.action === 'register'));
  assert.ok(rows.some(r => r.artifact === '.agents/onboarding-state.json'));
});

test('P3: claude-code -> shared merge-keys + CLAUDE.md stub', () => {
  const d = dir();
  const { rows } = buildOnboardRows(d, { profile: 'claude-code' });
  const mk = rows.filter(r => r.action === 'merge-keys');
  assert.equal(mk.length, 1);
  assert.equal(mk[0].artifact, '.claude/settings.json');
  assert.match(mk[0].detail, /server/);
  assert.match(mk[0].detail, /hooks/);
  const stub = rows.find(r => r.artifact === 'CLAUDE.md');
  assert.equal(stub.action, 'create');
  assert.match(stub.diff, /@AGENTS\.md/);
});

test('P4: existing config -> only missing servers added', () => {
  const d = dir();
  const cfg = path.join(d, '.devin', 'config.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { semble: { command: 'x' }, mine: { y: 1 } } }));
  const { rows } = buildOnboardRows(d);
  const mk = rows.find(r => r.artifact === '.devin/config.json');
  assert.equal(mk.action, 'merge-keys');
  assert.doesNotMatch(mk.detail, /\bsemble\b/); // existing server not re-added
  assert.ok(mk.diff.includes('code-review-graph')); // missing server added
  assert.ok(mk.diff.includes('mine')); // project-owned key survives the merge
});

test('P5: mergeFactRows dedups on artifact+action, keeps distinct rows', () => {
  const node = [{ artifact: 'AGENTS.md', action: 'exists-skip' }];
  const facts = [
    { artifact: 'AGENTS.md', action: 'exists-skip' },            // dup - dropped
    { artifact: 'some-skill', action: 'missing-skill' },          // kept
    { artifact: 'AGENTS.md', action: 'inject-region' },           // distinct - kept
  ];
  const out = mergeFactRows(node, facts);
  assert.equal(out.length, 3);
  assert.equal(out.filter(r => r.artifact === 'AGENTS.md').length, 2);
});
