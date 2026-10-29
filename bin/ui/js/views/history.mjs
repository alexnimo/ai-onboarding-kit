/** history.mjs - past syncs for one project, with per-file dispositions. */
import { api } from '../api.mjs';
import { el, basename, formatTime } from '../dom.mjs';
import { describeLastResult } from '../model.mjs';

const LISTS = [['accepted', 'Accepted'], ['reverted', 'Reverted'], ['kit', 'Kit']];

/** @returns {Promise<HTMLElement>} */
export async function renderHistory(projectPath) {
  const [{ projects }, { history }] = await Promise.all([
    api.projects(),
    api.history(projectPath),
  ]);
  const entry = projects.find(p => p.path === projectPath);
  const name = entry?.name || basename(projectPath);
  const entries = Array.isArray(history) ? [...history].reverse() : [];
  return el('section', { class: 'history-view', 'aria-labelledby': 'history-title' },
    el('header', { class: 'toolbar' },
      el('div', {},
        el('h1', { id: 'history-title', tabindex: '-1' }, `History: ${name}`),
        el('p', { class: 'path muted' }, el('code', {}, projectPath))),
      el('div', { class: 'toolbar-actions' },
        el('a', { class: 'button', href: `#/sync?path=${encodeURIComponent(projectPath)}` }, 'Sync'),
        el('a', { class: 'button', href: '#/' }, 'All projects'))),
    entries.length
      ? el('ol', { class: 'history', 'aria-label': 'Past syncs, newest first' }, entries.map(historyEntry))
      : el('p', { class: 'empty' }, 'No syncs recorded for this project yet.'));
}

function historyEntry(e) {
  const result = describeLastResult(e);
  const isApply = Array.isArray(e.accepted);
  return el('li', { class: 'history-entry' },
    el('h2', {}, formatTime(e.at)),
    el('p', {}, el('span', { class: `badge badge-${result.tone}` }, result.label)),
    isApply
      ? el('p', { class: 'note' }, `Action: ${e.action || 'apply'}`)
      : el('p', { class: 'note' }, `Actions: ${e.actions ?? 0}, conflicts: ${e.conflicts ?? 0}`),
    dispositionList(e));
}

function dispositionList(e) {
  const rows = [];
  for (const [key, label] of LISTS) {
    const files = Array.isArray(e[key]) ? e[key] : [];
    for (const dest of files) {
      rows.push(el('li', {}, el('code', {}, dest), ` - ${label}`));
    }
  }
  return rows.length
    ? el('ul', { class: 'history-files', 'aria-label': 'Per-file dispositions' }, rows)
    : null;
}
