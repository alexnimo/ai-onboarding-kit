/**
 * skills.mjs - kit skills console (#/skills): manifest skills grouped by
 * category with install/update actions (npx skills add/update via the
 * server), CLI tool install hints, and the MCP server catalog. Install
 * buttons run real commands server-side; output is shown per row.
 */
import { api } from '../api.mjs';
import { el } from '../dom.mjs';
import { toast } from '../toast.mjs';

/** @returns {Promise<HTMLElement>} */
export async function renderSkills() {
  const { skills, cliTools, mcpServers } = await api.skills();
  const state = { results: new Map(), busy: null };

  function rerun(name, action) {
    return async () => {
      if (state.busy) return;
      state.busy = name;
      const cell = state.results;
      cell.set(name, el('p', { class: 'muted', role: 'status' }, `Running ${action}...`));
      refresh(name);
      try {
        const res = action === 'install' ? await api.skillInstall(name) : await api.skillUpdate(name);
        cell.set(name, el('div', {},
          el('p', {}, el('code', {}, res.command)),
          res.output ? el('pre', { class: 'cmd-output' }, res.output) : null));
        toast(`${action} finished: ${name}`);
      } catch (err) {
        cell.set(name, el('p', { class: 'bad', role: 'alert' },
          `${action} failed: ${err.message}`));
        toast(`${action} failed: ${err.message}`, 'error');
      }
      state.busy = null;
      refresh(name);
    };
  }

  function refresh(name) {
    const td = root.querySelector(`[data-skill-result="${name}"]`);
    if (td && state.results.has(name)) td.replaceChildren(state.results.get(name));
    const btn = root.querySelector(`[data-skill-btn="${name}"]`);
    if (btn) btn.setAttribute('aria-disabled', String(!!state.busy));
  }

  const byCategory = new Map();
  for (const s of skills) {
    const cat = s.category || 'other';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(s);
  }

  function skillRow(s) {
    const action = s.installed ? 'update' : 'install';
    return el('tr', {},
      el('td', {}, el('code', {}, s.name),
        s.source && s.source !== 'kit template'
          ? el('div', { class: 'hint' }, `${s.source}@${s.skill}`)
          : null),
      el('td', {}, s.required
        ? el('span', { class: 'badge badge-conflict' }, 'required')
        : el('span', { class: 'badge badge-neutral' }, 'optional')),
      el('td', {}, s.installed
        ? el('span', { class: 'badge badge-ok' }, '✓ installed')
        : el('span', { class: 'badge badge-warn' }, '✗ missing')),
      el('td', {}, el('button', {
        type: 'button', class: 'button',
        dataset: { skillBtn: s.name },
        'aria-disabled': String(!!state.busy),
        onclick: rerun(s.name, action),
      }, action === 'install' ? 'Install' : 'Update')),
      el('td', { dataset: { skillResult: s.name } }));
  }

  const root = el('section', { class: 'skills-view', 'aria-labelledby': 'skills-title' },
    el('header', { class: 'toolbar' },
      el('div', {},
        el('h1', { id: 'skills-title', tabindex: '-1' }, 'Skills'),
        el('p', { class: 'muted' },
          'Skills run npx skills add/update on the server host; results appear under each row.')),
      el('div', { class: 'toolbar-actions' },
        el('a', { class: 'button', href: '#/' }, 'Overview'))),
    el('h2', {}, 'Skills'),
    skills.length
      ? el('table', { class: 'classify' },
          el('caption', { class: 'sr-only' }, 'Kit skills by category'),
          el('thead', {}, el('tr', {},
            el('th', { scope: 'col' }, 'Skill'),
            el('th', { scope: 'col' }, 'Required'),
            el('th', { scope: 'col' }, 'Status'),
            el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, 'Action')),
            el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, 'Output')))),
          el('tbody', {}, [...byCategory.entries()].flatMap(([cat, list]) => [
            el('tr', { class: 'category-row' },
              el('td', { colspan: '5' }, el('strong', {}, cat))),
            ...list.map(skillRow),
          ])))
      : el('p', { class: 'empty' }, 'No skills in the kit manifest.'),
    el('h2', {}, 'CLI tools'),
    (cliTools || []).length
      ? el('table', { class: 'classify' },
          el('caption', { class: 'sr-only' }, 'Recommended CLI tools'),
          el('thead', {}, el('tr', {},
            el('th', { scope: 'col' }, 'Tool'),
            el('th', { scope: 'col' }, 'Install'),
            el('th', { scope: 'col' }, 'Hint'))),
          el('tbody', {}, cliTools.map(t => el('tr', {},
            el('td', {}, t.name,
              t.required ? el('span', { class: 'badge badge-conflict' }, 'required') : null),
            el('td', {}, t.install
              ? el('button', {
                type: 'button', class: 'button',
                title: 'Copy install command',
                onclick: () => copyText(t.install),
              }, el('code', {}, t.install))
              : el('span', { class: 'muted' }, '—')),
            el('td', { class: 'muted' }, t.hint || '')))))
      : el('p', { class: 'empty' }, 'No CLI tools in the manifest.'),
    el('h2', {}, 'MCP servers'),
    (mcpServers || []).length
      ? el('table', { class: 'classify' },
          el('caption', { class: 'sr-only' }, 'MCP server catalog'),
          el('thead', {}, el('tr', {},
            el('th', { scope: 'col' }, 'Server'),
            el('th', { scope: 'col' }, 'Tier'),
            el('th', { scope: 'col' }, 'Required'),
            el('th', { scope: 'col' }, 'Hint'))),
          el('tbody', {}, mcpServers.map(s => el('tr', {},
            el('td', {}, el('code', {}, s.name)),
            el('td', {}, el('span', { class: 'badge badge-neutral' }, s.tier)),
            el('td', {}, s.required ? 'required' : 'optional'),
            el('td', { class: 'muted' }, s.hint || '')))))
      : el('p', { class: 'empty' }, 'No MCP servers in the manifest.'));
  return root;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast('Copy failed - clipboard unavailable', 'error');
  }
}
