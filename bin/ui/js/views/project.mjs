/**
 * project.mjs - project detail (#/project?path=): registered agents and
 * their config files, MCP servers actually present in each agent config
 * (cross-checked against manifest tiers to flag specialist servers in a
 * main config), required skill presence, and specialist profile artifacts
 * targeting this project. Read-only; sync is one link away.
 */
import { api } from '../api.mjs';
import { el } from '../dom.mjs';
/** @param {string} projectPath @returns {Promise<HTMLElement>} */
export async function renderProject(projectPath) {
  const [detail, catalog] = await Promise.all([
    api.projectDetail(projectPath),
    api.profiles().catch(() => null),
  ]);
  const tiers = new Map(
    (catalog?.catalog?.mcpServers || []).map(s => [s.name, s.tier || 'core']));
  const encPath = encodeURIComponent(projectPath);
  const root = el('section', { class: 'project-view', 'aria-labelledby': 'project-title' },
    el('header', { class: 'toolbar' },
      el('div', {},
        el('h1', { id: 'project-title', tabindex: '-1' }, `Project: ${detail.name}`),
        el('p', { class: 'path muted' }, el('code', {}, projectPath))),
      el('div', { class: 'toolbar-actions' },
        el('a', { class: 'button primary', href: `#/sync?path=${encPath}` }, 'Run sync'),
        el('a', { class: 'button', href: `#/history?path=${encPath}` }, 'History'),
        el('a', { class: 'button', href: '#/' }, 'All projects'))),
    el('h2', {}, 'Agents'),
    agentsTable(detail),
    el('h2', {}, 'MCP servers per agent'),
    mcpTable(detail, tiers),
    el('h2', {}, 'Required skills'),
    requiredSkills(detail),
    el('h2', {}, 'Specialist profiles'),
    profilesSection(detail));
  return root;
}

function existsMark(exists) {
  return el('span', { class: exists ? 'badge badge-ok' : 'badge badge-conflict' },
    exists ? '✓' : '✗');
}

function agentsTable(detail) {
  if (!detail.agents?.length) {
    return el('p', { class: 'empty' },
      'No agents registered for this project. Re-register with agents to see config status.');
  }
  return el('table', { class: 'classify' },
    el('caption', { class: 'sr-only' }, 'Registered agents'),
    el('thead', {}, el('tr', {},
      el('th', { scope: 'col' }, 'Agent'),
      el('th', { scope: 'col' }, 'Specialist'),
      el('th', { scope: 'col' }, 'Config files'),
      el('th', { scope: 'col' }, 'MCP config'),
      el('th', { scope: 'col' }, 'Rules dir'),
      el('th', { scope: 'col' }, 'Skill dirs'))),
    el('tbody', {}, detail.agents.map(a => el('tr', {},
      el('td', {}, el('strong', {}, a.name)),
      el('td', {}, el('span', {
        class: `badge badge-${a.specialist === 'none' ? 'neutral' : 'ok'}`,
      }, a.specialist)),
      el('td', {}, a.files?.length
        ? el('ul', { class: 'file-list' }, a.files.map(f => el('li', {},
            existsMark(f.exists), ' ', el('code', {}, f.rel))))
        : el('span', { class: 'muted' }, '—')),
      el('td', {}, a.mcpConfigPath
        ? el('code', {}, a.mcpConfigPath)
        : el('span', { class: 'muted' }, '—')),
      el('td', {}, a.rulesDir
        ? el('code', {}, a.rulesDir)
        : el('span', { class: 'muted' }, '—')),
      el('td', {}, (a.skillDirs || []).length
        ? el('ul', { class: 'file-list' },
            a.skillDirs.map(d => el('li', {}, el('code', {}, d))))
        : el('span', { class: 'muted' }, '—'))))));
}

function mcpTable(detail, tiers) {
  const entries = Object.entries(detail.mcpPresent || {});
  if (!entries.length) {
    return el('p', { class: 'empty' }, 'No agent MCP config found in this project.');
  }
  const rows = [];
  for (const [agent, servers] of entries) {
    for (const name of servers) {
      const tier = tiers.get(name);
      const leak = tier && tier !== 'core';
      rows.push(el('tr', {},
        el('td', {}, agent),
        el('td', {}, el('code', {}, name)),
        el('td', {},
          el('span', { class: 'badge badge-neutral' }, tier || 'not in manifest'),
          leak ? el('span', { class: 'badge badge-warn' }, 'specialist-in-main!') : null)));
    }
    if (!servers.length) {
      rows.push(el('tr', {},
        el('td', {}, agent),
        el('td', { class: 'muted', colspan: '2' }, 'No servers configured')));
    }
  }
  return el('table', { class: 'classify' },
    el('caption', { class: 'sr-only' }, 'MCP servers present per agent config'),
    el('thead', {}, el('tr', {},
      el('th', { scope: 'col' }, 'Agent'),
      el('th', { scope: 'col' }, 'Server'),
      el('th', { scope: 'col' }, 'Tier'))),
    el('tbody', {}, rows));
}

function requiredSkills(detail) {
  if (!detail.requiredSkills?.length) {
    return el('p', { class: 'empty' }, 'No required skills in the kit manifest.');
  }
  const missing = detail.requiredSkills.filter(s => !s.installed);
  return el('div', {},
    missing.length
      ? el('p', { class: 'warn' },
          `${missing.length} required skill(s) missing - see `,
          el('a', { href: '#/skills' }, 'Skills'), ' to install.')
      : el('p', {}, 'All required skills present.'),
    el('ul', { class: 'file-list' },
      detail.requiredSkills.map(s => el('li', {}, existsMark(s.installed), ' ', s.name))));
}

function profilesSection(detail) {
  if (!detail.profiles?.length) {
    return el('p', { class: 'empty' }, 'No specialist profiles defined.');
  }
  const rows = [];
  for (const p of detail.profiles) {
    for (const a of p.artifacts || []) {
      rows.push(el('tr', {},
        el('td', {}, el('code', {}, p.id),
          p.origin === 'user' ? el('span', { class: 'badge badge-ok' }, 'user') : null),
        el('td', {}, a.harness),
        el('td', {}, existsMark(a.exists), ' ', el('code', {}, a.dest))));
    }
    if (!(p.artifacts || []).length) {
      rows.push(el('tr', {},
        el('td', {}, el('code', {}, p.id)),
        el('td', { class: 'muted', colspan: '2' }, 'No artifacts for this project')));
    }
  }
  return el('div', {},
    el('table', { class: 'classify' },
      el('caption', { class: 'sr-only' }, 'Profile artifacts for this project'),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, 'Profile'),
        el('th', { scope: 'col' }, 'Harness'),
        el('th', { scope: 'col' }, 'Artifact'))),
      el('tbody', {}, rows)),
    el('p', {}, el('a', { href: '#/profiles' }, 'Manage profiles')));
}
