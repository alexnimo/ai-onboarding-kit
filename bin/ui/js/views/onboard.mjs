/**
 * onboard.mjs - onboarding plan review view. Rows are plan artifacts
 * (files + skills + bookkeeping), each with an accept/skip toggle,
 * collapsible diff, and per-merge-row "resolve with agent". Apply writes
 * only the accepted artifacts via the scaffold --only filter.
 *
 * No dispositions vocabulary: onboard skip = not writing the artifact,
 * so a row is simply included or excluded from the --only list.
 */
import { api } from '../api.mjs';
import { el, basename } from '../dom.mjs';
import { toast } from '../toast.mjs';
import { renderDiff } from './diffview.mjs';

const ACTION_LABEL = {
  create: 'Create', 'exists-skip': 'Exists', 'inject-region': 'Inject region',
  'merge-keys': 'Merge keys', 'append-import': 'Append import',
  register: 'Register', 'missing-skill': 'Missing skill',
  'install-skill': 'Install skill', 'update-skill': 'Update skill',
  'copy-skill': 'Copy skill',
};
const RESOLVABLE = new Set(['merge-keys', 'inject-region']);
const TOGGLABLE = new Set(['create', 'inject-region', 'merge-keys', 'append-import',
  'register', 'install-skill', 'update-skill', 'copy-skill']);

function toneOf(action) {
  if (action === 'merge-keys' || action === 'inject-region') return 'conflict';
  if (action === 'create' || action === 'install-skill' || action === 'copy-skill') return 'ok';
  return 'neutral';
}

export function renderOnboard(planId) {
  const state = {
    plan: null,
    accepted: new Set(),
    busy: false,
    focusKey: null,
    open: new Map(),   // artifact -> true
    agents: [],
    runner: null,
    resolving: null,   // artifact currently being resolved
    appliedOk: false,  // apply succeeded; converge offered
    convergeRunners: [],
    job: null,         // converge job view from the server
    jobTimer: null,
  };
  const banner = el('div', { class: 'banner-region' });
  const body = el('div', { class: 'sync-body' });

  const root = el('section', { class: 'sync-view', 'aria-labelledby': 'onboard-title' },
    el('header', { class: 'toolbar' },
      el('div', {},
        el('h1', { id: 'onboard-title', tabindex: '-1' }, 'Onboarding plan'),
        el('p', { class: 'path muted' }, el('code', {}, '...'))),
      el('div', { class: 'toolbar-actions' },
        el('a', { class: 'button', href: '#/' }, 'All projects'))),
    el('p', { class: 'muted' }, 'Review only. Nothing is written until you press Apply.'),
    banner,
    body);

  async function load() {
    body.replaceChildren(el('p', { class: 'muted', role: 'status' }, 'Loading plan...'));
    try {
      const [plan, agents] = await Promise.all([api.onboardGet(planId), api.onboardAgents()]);
      state.plan = plan;
      state.agents = agents.agents || [];
      state.runner = plan.resolveWith || plan.agent || 'devin';
      for (const r of plan.plan) {
        if (TOGGLABLE.has(r.action)) state.accepted.add(r.artifact);
      }
      root.querySelector('code').textContent = plan.target;
    } catch (err) {
      body.replaceChildren(el('p', { class: 'bad', role: 'alert' }, `Plan failed to load: ${err.message}`));
      return;
    }
    render();
  }

  function render() {
    const nodes = [];
    const rows = state.plan.plan;
    const counts = {};
    for (const r of rows) counts[r.action] = (counts[r.action] || 0) + 1;

    nodes.push(el('ul', { class: 'chips', 'aria-label': 'Plan summary' },
      Object.entries(counts).map(([action, n]) => el('li', {},
        el('span', { class: `badge badge-${toneOf(action)}` },
          `${ACTION_LABEL[action] ?? action}: ${n}`)))));

    // Runner picker: which harness performs agent-assisted merges (the
    // "bootstrap" consolidation step). Options show live PATH availability;
    // if none are installed, merges still work — the Resolve button hides.
    if (state.agents.length) {
      const select = el('select', {
        'aria-label': 'Bootstrap agent for agent-assisted merges',
        dataset: { key: 'runner' },
        onchange: e => { state.runner = e.target.value; },
      }, state.agents.map(a => el('option', {
        value: a.name,
        selected: a.name === state.runner,
        disabled: !a.available,
      }, `${a.name}${a.available ? ` (${a.binary} on PATH)` : ' (not found on PATH)'}`)));
      nodes.push(el('p', {},
        'Bootstrap agent (runs agent-assisted merges): ', select,
        state.agents.every(a => !a.available)
          ? el('span', { class: 'warn' }, ' — none detected on PATH; merges apply directly without agent consolidation')
          : null));
    }

    const globals = rows.filter(r => r.global);
    const files = rows.filter(r => !r.global && r.artifact !== '(project)');
    const books = rows.filter(r => r.artifact === '(project)');

    if (files.length) {
      nodes.push(el('table', { class: 'classify' },
        el('caption', { class: 'sr-only' }, 'Files the kit would write or change'),
        el('thead', {}, el('tr', {},
          el('th', { scope: 'col' }, 'Artifact'),
          el('th', { scope: 'col' }, 'Action'),
          el('th', { scope: 'col' }, 'Include'),
          el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, 'Details')))),
        el('tbody', {}, files.flatMap(r => rowFor(r)))));
    }
    if (globals.length) {
      nodes.push(el('h2', {}, 'Global (outside the project)'));
      nodes.push(el('table', { class: 'classify' },
        el('tbody', {}, globals.flatMap(r => rowFor(r)))));
    }
    if (books.length) {
      nodes.push(el('h2', {}, 'Bookkeeping'));
      nodes.push(el('table', { class: 'classify' },
        el('tbody', {}, books.flatMap(r => rowFor(r)))));
    }

    nodes.push(el('div', { class: 'apply-bar' },
      el('p', { class: 'tally', role: 'status' },
        `${state.accepted.size} of ${rows.filter(r => TOGGLABLE.has(r.action)).length} artifacts included`),
      el('button', {
        type: 'button', class: 'button primary',
        'aria-disabled': String(state.accepted.size === 0 || state.busy),
        dataset: { key: 'apply' },
        onclick: apply,
      }, state.busy ? 'Applying...' : 'Apply')));

    const convergeNode = convergePanel();
    if (convergeNode) nodes.push(convergeNode);

    body.replaceChildren(...nodes);
    if (state.focusKey) {
      const target = [...body.querySelectorAll('[data-key]')]
        .find(n => n.dataset.key === state.focusKey);
      target?.focus();
      state.focusKey = null;
    }
  }

  function rowFor(r) {
    const togglable = TOGGLABLE.has(r.action);
    const included = state.accepted.has(r.artifact);
    const open = state.open.has(r.artifact);
    const mainRow = el('tr', {},
      el('td', {}, el('code', {}, r.artifact)),
      el('td', {}, el('span', { class: `badge badge-${toneOf(r.action)}` },
        ACTION_LABEL[r.action] ?? r.action)),
      el('td', {}, togglable
        ? el('button', {
          type: 'button', class: 'seg',
          'aria-pressed': String(included),
          dataset: { key: `toggle:${r.artifact}` },
          onclick: () => toggle(r),
        }, included ? 'Include' : 'Skip')
        : el('span', { class: 'muted' }, '—')),
      el('td', {}, el('div', {},
        r.diff ? el('button', {
          type: 'button', class: 'button',
          'aria-expanded': String(!!open),
          dataset: { key: `expand:${r.artifact}` },
          onclick: () => { open ? state.open.delete(r.artifact) : state.open.set(r.artifact, true); render(); },
        }, open ? 'Hide' : 'Diff') : null,
        RESOLVABLE.has(r.action) && state.agents.some(a => a.available)
          ? el('button', {
            type: 'button', class: 'button',
            dataset: { key: `resolve:${r.artifact}` },
            onclick: () => resolveRow(r),
          }, state.resolving === r.artifact ? 'Resolving...' : 'Resolve with agent')
          : null)));

    const rows = [mainRow];
    if (r.detail) {
      rows.push(el('tr', { class: 'key-row' },
        el('td', {}), el('td', { colspan: '3', class: 'muted' }, r.detail)));
    }
    if (open && r.diff) {
      rows.push(el('tr', { class: 'details-row' },
        el('td', { colspan: '4' }, renderDiff(r.diff))));
    }
    return rows;
  }

  function toggle(r) {
    if (state.accepted.has(r.artifact)) state.accepted.delete(r.artifact);
    else state.accepted.add(r.artifact);
    state.focusKey = `toggle:${r.artifact}`;
    render();
  }

  async function resolveRow(r) {
    state.resolving = r.artifact;
    state.focusKey = `resolve:${r.artifact}`;
    render();
    try {
      const res = await api.onboardResolve(planId, r.artifact, state.runner);
      // Hand the resolved content to apply via the content path; mark the
      // row included and annotate its diff for review.
      r.diff = `--- resolved-by ${res.runner}\n+++ resolved\n` +
        res.content.split('\n').map(l => `+${l}`).join('\n');
      state.accepted.add(r.artifact);
      r.resolvedContent = res.content;
      toast(`Resolved ${r.artifact} via ${res.runner} - review the new diff, then Apply.`, 'ok');
    } catch (err) {
      toast(`Resolve failed for ${r.artifact}: ${err.message}`, 'error');
    } finally {
      state.resolving = null;
    }
    render();
  }

  async function apply() {
    if (state.busy || state.accepted.size === 0) return;
    state.busy = true;
    banner.replaceChildren();
    render();
    const content = {};
    for (const r of state.plan.plan) {
      if (r.resolvedContent !== undefined && state.accepted.has(r.artifact)) {
        content[r.artifact] = r.resolvedContent;
      }
    }
    try {
      const res = await api.onboardApply(planId, [...state.accepted], content);
      if (res.ok) {
        state.appliedOk = true;
        state.convergeRunners = res.convergeRunners || [];
      }
      banner.replaceChildren(el('div', { class: `toast toast-${res.ok ? 'ok' : 'error'}`, role: 'status' },
        el('p', {}, res.ok
          ? `Applied ${res.applied.length} artifact(s).`
          : `Apply failed: ${res.error}`)));
    } catch (err) {
      banner.replaceChildren(el('div', { class: 'toast toast-error', role: 'alert' },
        el('p', {}, `Apply failed: ${err.message}`)));
    } finally {
      state.busy = false;
    }
    render();
  }

  async function converge() {
    if (state.job?.status === 'running') return;
    try {
      state.job = await api.onboardConverge(planId, state.runner || undefined);
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

  /** Converge panel: staged dry-run -> per-file diffs -> approve/discard. */
  function convergePanel() {
    if (!state.appliedOk && !state.job) return null;
    const j = state.job;
    const kids = [];
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
    return el('section', { class: 'converge-panel' },
      el('h2', {}, 'AI converge'),
      ...kids);
  }

  /** Per-file staged changes with approve/discard controls. */
  function changesTable(j) {
    const changes = j.changes || [];
    if (!changes.length) {
      return el('p', { class: 'muted' },
        'The agent produced no changes.');
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
        }, 'Diff')),
    ));
    // interleave expanded diff rows under their file row
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

  load();
  return root;
}
