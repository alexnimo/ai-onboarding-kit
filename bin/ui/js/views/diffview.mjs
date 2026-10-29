/**
 * diffview.mjs - renders a unified diff and the base / project / kit
 * three-pane for conflict files. Returns DOM nodes built with textContent.
 */
import { el } from '../dom.mjs';
import { diffLines } from '../diff.mjs';

const ROW_CLASS = { add: 'diff-add', del: 'diff-del', hunk: 'diff-hunk', meta: 'diff-meta', ctx: '' };
const SIGN = { add: '+', del: '-', ctx: ' ' };

/**
 * @param {string} text Unified diff text.
 * @returns {HTMLElement}
 */
export function renderDiff(text) {
  const rows = diffLines(text).map(line => {
    if (line.kind === 'hunk' || line.kind === 'meta') {
      return el('tr', { class: ROW_CLASS[line.kind] }, el('td', { colspan: '4' }, line.text));
    }
    return el('tr', { class: ROW_CLASS[line.kind] },
      el('td', { class: 'ln', 'aria-hidden': 'true' }, line.oldNo ?? ''),
      el('td', { class: 'ln', 'aria-hidden': 'true' }, line.newNo ?? ''),
      el('td', { class: 'sign', 'aria-hidden': 'true' }, SIGN[line.kind]),
      el('td', {}, line.text));
  });
  return el('div', { class: 'diff', role: 'region', tabindex: '0', 'aria-label': 'Unified diff' },
    el('table', { class: 'diff-table' }, el('tbody', {}, rows)));
}

/** @param {string|null|undefined} value @returns {string} Display text. */
export function displayText(value) {
  if (value === null || value === undefined) return '(absent)';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  if (value === '') return '(empty file)';
  return String(value);
}

/**
 * @param {{base: string|null, project: string|null, kit: string|null,
 *   merged: string|null, conflict: boolean, needsFill?: unknown[]}} data
 *   GET /api/plans/:id/merge payload.
 * @param {{choice?: string, readOnly: boolean, keyPrefix: string,
 *   onChoose: (disp: string) => void}} opts
 * @returns {HTMLElement}
 */
export function renderThreePane(data, { choice, readOnly, keyPrefix, onChoose }) {
  const fills = Array.isArray(data.needsFill) ? data.needsFill : [];
  const pane = (title, value) => el('section', { class: 'pane' },
    el('h4', {}, title),
    el('pre', { tabindex: '0', 'aria-label': `${title} content` }, displayText(value)));
  const choices = [
    ['reverted', 'Accept project'],
    ['kit', 'Accept kit'],
    ['accepted', 'Accept merge'],
  ];
  return el('div', { class: 'three-pane' },
    el('div', { class: 'panes' },
      pane('Base (kit at recorded sync)', data.base),
      pane('Project (local file)', data.project),
      pane('Kit (current render)', data.kit)),
    el('p', { class: data.conflict ? 'bad' : 'note' },
      data.conflict
        ? 'Conflict: pick one option per file below.'
        : 'Clean three-way merge.'),
    fills.length
      ? el('p', { class: 'warn' }, `Unfilled placeholders: ${fills.map(String).join(', ')}`)
      : null,
    el('details', {},
      el('summary', {}, 'Show merged result'),
      el('pre', { tabindex: '0', 'aria-label': 'Merged result' }, displayText(data.merged))),
    el('div', { class: 'toolbar-actions', role: 'group', 'aria-label': 'Resolve this file' },
      choices.map(([disp, label]) => el('button', {
        type: 'button', class: 'button',
        'aria-pressed': String(choice === disp),
        disabled: readOnly,
        dataset: { key: `${keyPrefix}:${disp}` },
        onclick: () => onChoose(disp),
      }, label))));
}
