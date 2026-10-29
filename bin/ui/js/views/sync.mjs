/**
 * sync.mjs - dry-run classify table with per-file dispositions, unified diff
 * and three-pane expansion, and the Apply gate.
 *
 * The only write path in the SPA is `apply()`, which runs on an explicit
 * Apply click. Dry run, diff, and merge views are read-only API calls.
 */
import { api } from '../api.mjs';
import { el, basename } from '../dom.mjs';
import { toast } from '../toast.mjs';
import { renderDiff, renderThreePane } from './diffview.mjs';
import {
  groupPlan, initialDispositions, applyGate, buildPayload, tallyDispositions,
  countByAction, resultCounts, describeLastResult,
} from '../model.mjs';

const DISP_LABELS = [['accepted', 'Accept'], ['reverted', 'Revert'], ['kit', 'Kit']];
const ACTION_LABEL = {
  'fast-forward': 'Fast-forward', merged: 'Merged', conflict: 'Conflict',
  skip: 'Skip', retired: 'Retired',
};
const MERGE_ACTIONS = new Set(['merged', 'conflict']);

function toneOf(action) {
  if (action === 'conflict') return 'conflict';
  if (action === 'merged' || action === 'fast-forward') return 'ok';
  return 'neutral';
}

/**
 * @param {string} projectPath Registered project path (from the route).
 * @returns {HTMLElement} Sync view; the dry run starts immediately.
 */
export function renderSync(projectPath) {
  const state = {
    planId: null,
    notes: [],
    files: [],
    disp: {},
    blocked: false,
    busy: false,
    focusKey: null, // data-key of the control to focus after the next render
    open: new Map(), // dest -> 'diff' | 'pane'
    diffs: new Map(), // dest -> unified diff text
    merges: new Map(), // dest -> {data} | {error}
  };
  const banner = el('div', { class: 'banner-region' });
  const body = el('div', { class: 'sync-body' });

  const root = el('section', { class: 'sync-view', 'aria-labelledby': 'sync-title' },
    el('header', { class: 'toolbar' },
      el('div', {},
        el('h1', { id: 'sync-title', tabindex: '-1' }, `Sync: ${basename(projectPath)}`),
        el('p', { class: 'path muted' }, el('code', {}, projectPath))),
      el('div', { class: 'toolbar-actions' },
        el('button', { type: 'button', class: 'button', onclick: () => dryRun() }, 'Re-run dry run'),
        el('a', { class: 'button', href: `#/history?path=${encodeURIComponent(projectPath)}` }, 'History'),
        el('a', { class: 'button', href: '#/' }, 'All projects'))),
    el('p', { class: 'muted' }, 'Dry run only. Nothing is written until you press Apply.'),
    banner,
    body);

  async function dryRun() {
    state.planId = null;
    state.blocked = false;
    state.open.clear();
    state.diffs.clear();
    state.merges.clear();
    body.replaceChildren(el('p', { class: 'muted', role: 'status' }, 'Running dry run...'));
    let res;
    try {
      res = await api.dryRun(projectPath);
    } catch (err) {
      body.replaceChildren(el('p', { class: 'bad', role: 'alert' }, `Dry run failed: ${err.message}`));
      return;
    }
    state.planId = res.planId;
    state.notes = res.plan.filter(r => r.artifact === '(project)');
    state.files = groupPlan(res.plan);
    state.disp = initialDispositions(state.files);
    render();
  }

  /** Re-render, keeping focus on whichever control had it (async loads). */
  function rerender() {
    const active = document.activeElement;
    if (active && body.contains(active) && active.dataset.key) {
      state.focusKey = active.dataset.key;
    }
    render();
  }

  function choose(dest, disp, key) {
    state.disp[dest] = disp;
    state.focusKey = key;
    render();
  }

  function render() {
    const nodes = [];
    for (const note of state.notes) {
      nodes.push(el('p', { class: 'note' }, note.detail || 'Project note'));
    }

    const actionable = state.files.filter(f => f.actionable).length;
    if (!state.files.length) {
      nodes.push(el('div', { class: 'empty-state' },
        el('h2', {}, 'Up to date'),
        el('p', {}, 'The plan has no files for this project.')));
    } else if (!actionable) {
      nodes.push(el('div', { class: 'empty-state' },
        el('h2', {}, 'Up to date'),
        el('p', {}, 'No pending kit changes for this project.')));
    }

    const counts = countByAction(state.files);
    if (state.files.length) {
      nodes.push(el('ul', { class: 'chips', 'aria-label': 'Plan summary' },
        Object.entries(counts).map(([action, n]) => el('li', {},
          el('span', { class: `badge badge-${toneOf(action)}` },
            `${ACTION_LABEL[action] ?? action}: ${n}`)))));
    }

    const gate = applyGate(state.files, state.disp);
    if (state.blocked && gate.reason === 'unresolved-conflicts') {
      nodes.push(el('p', { class: 'bad', role: 'alert' },
        `Apply blocked: choose a disposition for ${gate.files.length} conflict file(s): `
        + gate.files.map(f => f.dest).join(', ') + '.'));
    }

    if (state.files.length) {
      nodes.push(el('table', { class: 'classify' },
        el('caption', { class: 'sr-only' }, 'Planned changes for this project'),
        el('thead', {}, el('tr', {},
          el('th', { scope: 'col' }, 'File'),
          el('th', { scope: 'col' }, 'Change'),
          el('th', { scope: 'col' }, 'Disposition'),
          el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, 'Details')))),
        el('tbody', {}, state.files.flatMap((file, i) => fileRows(file, i)))));
    }

    const tally = tallyDispositions(state.files, state.disp);
    nodes.push(el('div', { class: 'apply-bar' },
      el('p', { class: 'tally', role: 'status' },
        `Accept ${tally.accepted} · Revert ${tally.reverted} · Kit ${tally.kit} of ${tally.total} file(s)`),
      el('button', {
        type: 'button', class: 'button primary',
        'aria-disabled': String(!gate.ok || state.busy),
        dataset: { key: 'apply' },
        onclick: apply,
      }, state.busy ? 'Applying...' : 'Apply')));

    body.replaceChildren(...nodes);
    if (state.focusKey) {
      const target = [...body.querySelectorAll('[data-key]')]
        .find(node => node.dataset.key === state.focusKey);
      target?.focus();
      state.focusKey = null;
    }
  }

  function fileRows(file, i) {
    const open = state.open.get(file.dest);
    const blocked = state.blocked && file.action === 'conflict' && !state.disp[file.dest];
    const rowClass = [
      file.action === 'conflict' ? 'row-conflict' : '',
      blocked ? 'row-blocked' : '',
    ].join(' ').trim();
    const detailsId = `details-${i}`;
    const rows = [el('tr', { class: rowClass, 'data-dest': file.dest },
      el('td', {}, el('code', {}, file.dest)),
      el('td', {}, el('span', { class: `badge badge-${toneOf(file.action)}` },
        ACTION_LABEL[file.action] ?? file.action)),
      el('td', {}, file.actionable
        ? dispCell(file)
        : el('span', { class: 'muted' }, file.action === 'skip' ? 'Skipped' : 'No action')),
      el('td', {}, file.action !== 'skip'
        ? el('button', {
          type: 'button', class: 'button',
          'aria-expanded': String(!!open),
          'aria-controls': open ? detailsId : null,
          'aria-label': `${open ? 'Hide' : 'Show'} details for ${file.dest}`,
          dataset: { key: `expand:${file.dest}` },
          onclick: () => (open ? collapse(file) : expand(file)),
        }, open ? 'Hide' : 'Details')
        : null)),
    ];
    if (file.rows.length > 1) {
      for (const row of file.rows.filter(r => r.artifact.startsWith(`${file.dest}:`))) {
        rows.push(el('tr', { class: 'key-row', 'data-key-row': row.artifact },
          el('td', {}, el('code', {}, row.artifact.slice(file.dest.length + 1))),
          el('td', {}, el('span', { class: `badge badge-${toneOf(row.action)}` },
            ACTION_LABEL[row.action] ?? row.action)),
          el('td', { class: 'muted' }, row.detail ?? ''),
          el('td', {})));
      }
    }
    if (open) {
      rows.push(el('tr', { class: 'details-row', id: detailsId },
        el('td', { colspan: '4' }, detailBody(file, open))));
    }
    return rows;
  }

  function dispCell(file) {
    const current = state.disp[file.dest];
    return el('div', {},
      el('div', { class: 'segmented', role: 'group', 'aria-label': `Disposition for ${file.dest}` },
        DISP_LABELS.map(([disp, label]) => el('button', {
          type: 'button',
          class: 'seg',
          'aria-pressed': String(current === disp),
          dataset: { key: `disp:${file.dest}:${disp}` },
          onclick: () => choose(file.dest, disp, `disp:${file.dest}:${disp}`),
        }, label))),
      file.action === 'conflict'
        ? el('p', { class: 'hint' },
          'Accept = merged result (may contain conflict markers). Revert = keep project file. Kit = take kit file.')
        : null);
  }

  function detailBody(file, mode) {
    const tabs = MERGE_ACTIONS.has(file.action)
      ? el('div', { class: 'tabs', role: 'group', 'aria-label': `View for ${file.dest}` },
        [['diff', 'Unified diff'], ['pane', 'Three-pane']].map(([m, label]) => el('button', {
          type: 'button',
          class: 'seg',
          'aria-pressed': String(mode === m),
          dataset: { key: `tab:${file.dest}:${m}` },
          onclick: () => setTab(file, m),
        }, label)))
      : null;
    return el('div', { class: 'details' },
      tabs,
      mode === 'pane' ? paneView(file) : diffView(file));
  }

  function diffView(file) {
    if (!state.diffs.has(file.dest)) {
      return el('p', { class: 'muted', role: 'status' }, 'Loading diff...');
    }
    const text = state.diffs.get(file.dest);
    return text
      ? renderDiff(text)
      : el('p', { class: 'muted' }, 'No textual diff for this file.');
  }

  function paneView(file) {
    const m = state.merges.get(file.dest);
    if (!m) return el('p', { class: 'muted', role: 'status' }, 'Loading three files...');
    if (m.error) {
      return el('p', { class: 'bad', role: 'alert' }, `Could not load three-pane view: ${m.error}`);
    }
    return renderThreePane(m.data, {
      choice: state.disp[file.dest],
      readOnly: !file.actionable,
      keyPrefix: `pane:${file.dest}`,
      onChoose: disp => choose(file.dest, disp, `pane:${file.dest}:${disp}`),
    });
  }

  function collapse(file) {
    state.open.delete(file.dest);
    state.focusKey = `expand:${file.dest}`;
    render();
  }

  /** Conflicts open on the three-pane viewer (AC3); other rows open the diff. */
  function expand(file) {
    setTab(file, file.action === 'conflict' ? 'pane' : 'diff', `expand:${file.dest}`);
  }

  async function setTab(file, mode, focus = `tab:${file.dest}:${mode}`) {
    state.open.set(file.dest, mode);
    state.focusKey = focus;
    render();
    if (mode === 'diff' && !state.diffs.has(file.dest)) await loadDiff(file);
    if (mode === 'pane' && !state.merges.has(file.dest)) await loadMerge(file);
  }

  async function loadDiff(file) {
    const planId = state.planId;
    let text;
    try {
      text = (await api.diff(planId, file.dest)).diff;
    } catch (err) {
      toast(`Could not load diff for ${file.dest}: ${err.message}`, 'error');
      text = '';
    }
    if (planId !== state.planId) return;
    state.diffs.set(file.dest, text);
    if (state.open.get(file.dest) === 'diff') rerender();
  }

  async function loadMerge(file) {
    const planId = state.planId;
    let entry;
    try {
      entry = { data: await api.merge(planId, file.dest) };
    } catch (err) {
      entry = { error: err.message };
    }
    if (planId !== state.planId) return;
    state.merges.set(file.dest, entry);
    if (state.open.get(file.dest) === 'pane') rerender();
  }

  function apply() {
    if (state.busy) return;
    const gate = applyGate(state.files, state.disp);
    if (gate.reason === 'unresolved-conflicts') {
      state.blocked = true;
      state.focusKey = `disp:${gate.files[0].dest}:accepted`;
      render();
      return;
    }
    if (!gate.ok) {
      toast('Nothing to apply: no pending kit changes.', 'error');
      return;
    }
    runApply(buildPayload(state.files, state.disp));
  }

  async function runApply(payload) {
    state.busy = true;
    state.blocked = false;
    banner.replaceChildren();
    render();
    try {
      const res = await api.apply(state.planId, payload);
      banner.replaceChildren(resultBanner(res));
    } catch (err) {
      banner.replaceChildren(el('div', { class: 'toast toast-error', role: 'alert' },
        el('p', {}, `Apply failed: ${err.message}`)));
    } finally {
      state.busy = false;
    }
    await dryRun();
  }

  function resultBanner(res) {
    const counts = resultCounts(res.results);
    const failures = (res.results || []).filter(r => !r.ok);
    const recorded = res.lastSyncResult ? describeLastResult(res.lastSyncResult).label : null;
    return el('div', { class: `toast toast-${failures.length ? 'error' : 'ok'}`, role: 'status' },
      el('div', {},
        el('p', {},
          `Applied: ${counts.accepted} accepted, ${counts.reverted} reverted, ${counts.kit} kit`
          + (counts.failed ? `, ${counts.failed} failed` : '') + '.'),
        failures.length
          ? el('ul', {}, failures.map(f => el('li', {}, `${f.dest}: ${f.error}`)))
          : null,
        recorded ? el('p', {}, `Recorded in history: ${recorded}.`) : null,
        res.historyError ? el('p', { class: 'warn' }, `History not saved: ${res.historyError}`) : null),
      el('a', { href: `#/history?path=${encodeURIComponent(projectPath)}` }, 'View history'));
  }

  dryRun();
  return root;
}
