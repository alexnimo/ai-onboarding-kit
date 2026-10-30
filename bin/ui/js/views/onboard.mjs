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

    // Runner picker for resolve rows.
    if (state.agents.length) {
      const select = el('select', {
        'aria-label': 'Runner for agent-assisted resolution',
        dataset: { key: 'runner' },
        onchange: e => { state.runner = e.target.value; },
      }, state.agents.map(a => el('option', {
        value: a.name,
        selected: a.name === state.runner,
        disabled: !a.available,
      }, `${a.name}${a.available ? '' : ' (not found)'}`)));
      nodes.push(el('p', {}, 'Resolve with: ', select));
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
      banner.replaceChildren(el('div', { class: `toast toast-${res.ok ? 'ok' : 'error'}`, role: 'status' },
        el('p', {}, res.ok
          ? `Applied ${res.applied.length} artifact(s). Fill {{placeholders}} in the generated files.`
          : `Apply failed: ${res.error}`)));
    } catch (err) {
      banner.replaceChildren(el('div', { class: 'toast toast-error', role: 'alert' },
        el('p', {}, `Apply failed: ${err.message}`)));
    } finally {
      state.busy = false;
    }
    render();
  }

  load();
  return root;
}
