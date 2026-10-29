/** dashboard.mjs - project cards: agents, last sync time, last sync result. */
import { api } from '../api.mjs';
import { el, basename, formatTime } from '../dom.mjs';
import { describeLastResult } from '../model.mjs';

/** @returns {Promise<HTMLElement>} */
export async function renderDashboard() {
  const { projects } = await api.projects();
  const root = el('section', { class: 'dashboard', 'aria-labelledby': 'dash-title' },
    el('h1', { id: 'dash-title', tabindex: '-1' }, 'Projects'),
    el('p', { class: 'muted' },
      'Dry run is the default. Nothing is written to a project until you press Apply on its sync page.'));
  if (!projects.length) {
    root.append(el('p', { class: 'empty' },
      'No projects registered. Register one with ',
      el('code', {}, 'node bin/onboard.mjs register --path <dir>'), '.'));
    return root;
  }
  root.append(el('ul', { class: 'cards' }, projects.map(projectCard)));
  return root;
}

function projectCard(p) {
  const name = p.name || basename(p.path);
  const result = describeLastResult(p.lastSyncResult);
  const agents = Array.isArray(p.agents) ? p.agents : [];
  const href = `#/sync?path=${encodeURIComponent(p.path)}`;
  const historyHref = `#/history?path=${encodeURIComponent(p.path)}`;
  return el('li', { class: 'card' },
    el('h2', {}, name),
    el('p', { class: 'path muted' }, el('code', {}, p.path)),
    el('ul', { class: 'chips', 'aria-label': 'Agents' },
      agents.length
        ? agents.map(a => el('li', {}, el('span', { class: 'badge badge-neutral' }, a)))
        : el('li', { class: 'muted' }, 'No agents')),
    p.missing ? el('p', { class: 'bad' }, 'Project path is missing on disk.') : null,
    el('p', {}, 'Last sync: ', formatTime(p.lastSyncAt)),
    el('p', {}, el('span', { class: `badge badge-${result.tone}` }, result.label)),
    p.unresolvedCount
      ? el('p', { class: 'warn' }, `${p.unresolvedCount} unresolved from a previous sync`)
      : null,
    el('div', { class: 'card-actions' },
      p.missing ? null : el('a', { class: 'button primary', href, 'aria-label': `Sync ${name}` }, 'Sync'),
      el('a', { class: 'button', href: historyHref, 'aria-label': `History for ${name}` }, 'History')));
}
