/**
 * sync-spa-model.test.mjs - the Apply gate is the only thing standing between
 * a click and a disk write in the SPA, so its rules are pinned here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupPlan, initialDispositions, applyGate, buildPayload, tallyDispositions,
} from '../bin/ui/js/model.mjs';

const plan = [
  { artifact: 'AGENTS.md:body', action: 'fast-forward' },
  { artifact: 'notes.md:body', action: 'conflict' },
  { artifact: 'skills.json:key', action: 'skip' },
];

test('conflict rows have no default and block Apply until each one is chosen', () => {
  const files = groupPlan(plan);
  const disp = initialDispositions(files);
  assert.equal(disp['notes.md'], undefined);
  assert.deepEqual(applyGate(files, disp).files.map(f => f.dest), ['notes.md']);
  assert.equal(applyGate(files, disp).ok, false);

  disp['notes.md'] = 'reverted';
  assert.equal(applyGate(files, disp).ok, true);
});

test('fast-forward defaults to accepted; skip rows never enter the payload', () => {
  const files = groupPlan(plan);
  const disp = initialDispositions(files);
  disp['notes.md'] = 'kit';
  assert.deepEqual(buildPayload(files, disp), {
    'AGENTS.md': 'accepted',
    'notes.md': 'kit',
  });
});

test('gate reports nothing-to-apply when only skip rows exist', () => {
  const files = groupPlan([{ artifact: 'x.md:body', action: 'skip' }]);
  assert.deepEqual(applyGate(files, {}), { ok: false, reason: 'nothing-to-apply', files: [] });
});

test('tally counts only actionable files by disposition', () => {
  const files = groupPlan(plan);
  const disp = { 'AGENTS.md': 'accepted', 'notes.md': 'reverted' };
  assert.deepEqual(tallyDispositions(files, disp), {
    accepted: 1, reverted: 1, kit: 0, total: 2,
  });
});

test('config key rows survive grouping so the classify table can show each key', () => {
  const files = groupPlan([
    { artifact: '.mcp.json:mcpServers.alpha', action: 'skip', detail: 'pinned' },
    { artifact: '.mcp.json:mcpServers.beta', action: 'conflict', detail: 'both changed' },
  ]);
  assert.equal(files.length, 1);
  assert.equal(files[0].action, 'conflict');
  assert.deepEqual(files[0].rows.map(r => r.action), ['skip', 'conflict']);
});
