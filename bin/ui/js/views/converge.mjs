/**
 * converge.mjs - staged AI converge panel, shared by the onboard review
 * view and the sync view. Starts a converge job (POST /api/onboard/converge
 * with {planId} or {project}), polls it, shows per-file staged diffs, and
 * approves a subset (or all) back into the project. The agent never runs
 * against the real tree — the server stages a copy.
 */
import { api } from '../api.mjs';
import { el } from '../dom.mjs';
import { toast } from '../toast.mjs';
import { renderDiff } from './diffview.mjs';

/**
 * @param {object} opts {planId?|project?, runner?}
 * @returns {HTMLElement} Converge panel (empty section until a job runs —
 *   the start button is always rendered).
 */
export function renderConverge({ planId = null, project = null, runner = undefined } = {}) {
  const state = { job: null, jobTimer: null, approveSel: null, open: new Map() };

  async function converge() {
    if (state.job?.status === 'running') return;
    try {
      state.job = await api.onboardConverge({ planId, project, runner });
      toast(`Converge started via ${state.job.runner}`, 'ok');
      pollJob();
    } catch (err) {
      toast(`Converge failed to start: ${err.message}`, 'error');
    }
    render();
  }

  function pollJob() {
    clearTimeout(state.jobTimer);
    if (!state.job) return;
    state.jobTimer = setTimeout(async () => {
      try {
        state.job = await api.onboardJob(state.job.id);
        render();
        if (state.job.status === 'running') pollJob();
      } catch {
        state.jobTimer = null; // server restart: stop polling quietly
      }
    }, 2000);
  }

  async function cancelJob() {
    if (!state.job) return;
    try { state.job = await api.onboardJobCancel(state.job.id); }
    catch (err) { toast(`Cancel failed: ${err.message}`, 'error'); }
    render();
  }

  async function approveSelected() {
    if (!state.job || !state.approveSel?.size) return;
    try {
      const res = await api.onboardJobApprove(state.job.id, [...state.approveSel]);
      state.job = res.job;
      state.approveSel = null;
      toast(`Wrote ${res.written.length} file(s): ${res.written.slice(0, 3).join(', ')}`
        + (res.written.length > 3 ? ` +${res.written.length - 3} more` : ''), 'ok');
    } catch (err) {
      toast(`Approve failed: ${err.message}`, 'error');
    }
    render();
  }

  async function discardJob() {
    if (!state.job) return;
    try { state.job = await api.onboardJobDiscard(state.job.id); }
    catch (err) { toast(`Discard failed: ${err.message}`, 'error'); }
    render();
  }

  /** Per-file staged changes with approve/discard controls. */
  function changesTable(j) {
    const changes = j.changes || [];
    if (!changes.length) {
      return el('p', { class: 'muted' }, 'The agent produced no changes.');
    }
    state.approveSel ??= new Set(
      changes.filter(c => c.action !== 'deleted').map(c => c.file));
    const pending = changes.filter(c => !c.applied && c.action !== 'deleted');
    const rows = changes.map(c => el('tr', {},
      el('td', {}, c.applied || c.action === 'deleted'
        ? el('span', { class: 'muted' },
            c.action === 'deleted' ? '—' : '✓')
        : el('input', {
          type: 'checkbox', checked: state.approveSel.has(c.file),
          'aria-label': `Approve ${c.file}`,
          onchange: e => {
            e.target.checked
              ? state.approveSel.add(c.file)
              : state.approveSel.delete(c.file);
          },
        })),
      el('td', {}, el('code', {}, c.file)),
      el('td', {}, el('span', {
        class: `badge badge-${c.action === 'modified' ? 'conflict' : c.action === 'created' ? 'ok' : 'neutral'}`,
      }, c.action)),
      el('td', {}, c.applied
        ? el('span', { class: 'muted' }, 'applied')
        : el('button', {
          type: 'button', class: 'button',
          'aria-expanded': String(!!state.open.get(`chg:${c.file}`)),
          onclick: () => {
            const k = `chg:${c.file}`;
            state.open.get(k) ? state.open.delete(k) : state.open.set(k, true);
            render();
          },
        }, 'Diff'))));
    const body = [];
    for (const [i, c] of changes.entries()) {
      body.push(rows[i]);
      if (state.open.get(`chg:${c.file}`)) {
        body.push(el('tr', { class: 'details-row' },
          el('td', { colspan: '4' }, renderDiff(c.diffText || '(empty diff)'))));
      }
    }
    return el('div', {},
      el('p', { class: 'muted' },
        `${changes.length} staged change(s) — nothing is written until you approve.`
          + (j.placeholdersLeft?.length
            ? ` ${j.placeholdersLeft.length} file(s) keep deferred TBD placeholders.`
            : ' All placeholders resolved.')),
      el('table', { class: 'classify' },
        el('caption', { class: 'sr-only' }, 'Staged converge changes'),
        el('thead', {}, el('tr', {},
          el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, 'Approve')),
          el('th', { scope: 'col' }, 'File'),
          el('th', { scope: 'col' }, 'Change'),
          el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, 'Diff')))),
        el('tbody', {}, body)),
      el('div', { class: 'apply-bar' },
        el('p', { class: 'tally' },
          `${state.approveSel.size} of ${pending.length} selected`),
        el('button', {
          type: 'button', class: 'button primary',
          'aria-disabled': String(state.approveSel.size === 0),
          onclick: approveSelected,
        }, `Approve ${state.approveSel.size === pending.length ? 'all' : 'selected'}`),
        ' ',
        el('button', {
          type: 'button', class: 'button',
          onclick: discardJob,
        }, 'Discard all')));
  }

  function render() {
    const j = state.job;
    const kids = [el('h2', {}, 'AI converge')];
    if (!j || j.status !== 'running') {
      kids.push(el('p', {},
        el('button', {
          type: 'button', class: 'button primary',
          dataset: { key: 'converge' },
          onclick: converge,
        }, j ? 'Re-run converge' : 'Converge with agent'),
        ' ',
        el('span', { class: 'muted' },
          'Runs in a staged copy — the project is untouched until you approve the diff.')));
    }
    if (j) {
      kids.push(el('div', { class: 'details' },
        el('p', {},
          el('span', {
            class: `badge badge-${j.status === 'done' ? 'ok' : j.status === 'running' ? 'neutral' : 'conflict'}`,
          }, `converge: ${j.status}`),
          ` via ${j.runner}`,
          j.status === 'running'
            ? el('button', { type: 'button', class: 'button', onclick: cancelJob }, ' Cancel')
            : null),
        j.error ? el('p', { class: 'bad' }, j.error) : null,
        j.status === 'done' ? changesTable(j) : null,
        j.logTail ? el('details', {},
          el('summary', {}, 'Agent output'),
          el('pre', { class: 'diff' }, j.logTail)) : null));
    }
    section.replaceChildren(...kids);
  }

  const section = el('section', { class: 'converge-panel' });
  render();
  return section;
}
