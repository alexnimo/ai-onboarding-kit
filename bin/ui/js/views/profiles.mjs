/**
 * profiles.mjs - specialist profile management (#/profiles). Lists the
 * effective kit+user profiles, previews per-harness artifacts + invoke
 * strings (Plan), applies them (Sync), and creates/edits user profiles or
 * kit overrides through a catalog-driven form. All writes go through
 * POST/PUT/DELETE /api/profiles; this view never touches files directly.
 */
import { api } from '../api.mjs';
import { el } from '../dom.mjs';
import { toast } from '../toast.mjs';

/** Group mcpServers catalog entries by tier (core first, then others). */
function mcpGroups(catalog) {
  const byTier = new Map();
  for (const s of catalog.mcpServers || []) {
    const tier = s.tier || 'core';
    if (!byTier.has(tier)) byTier.set(tier, []);
    byTier.get(tier).push(s);
  }
  return [...byTier.entries()]
    .sort(([a], [b]) => (a === 'core' ? -1 : b === 'core' ? 1 : a.localeCompare(b)));
}

/** Checkbox group -> {checked()} accessor. */
function checkboxGroup(name, entries, checked = new Set()) {
  const boxes = entries.map(([value, label]) => {
    const box = el('input', {
      type: 'checkbox', name, value,
      checked: String(checked.has(value)),
    });
    return { box, node: el('label', {}, box, ` ${label}`) };
  });
  return {
    nodes: boxes.map(b => b.node),
    checked: () => boxes.filter(b => b.box.checked).map(b => b.box.value),
  };
}

export function renderProfiles() {
  const state = { profiles: [], catalog: null, plans: {}, busy: false, editing: null, projects: [], project: '' };
  const body = el('div', { class: 'sync-body' });
  const root = el('section', { class: 'sync-view', 'aria-labelledby': 'profiles-title' },
    el('header', { class: 'toolbar' },
      el('div', {},
        el('h1', { id: 'profiles-title', tabindex: '-1' }, 'Profiles'),
        el('p', { class: 'muted' },
          'Specialist capability bundles: skills + MCP servers materialized per harness.')),
      el('div', { class: 'toolbar-actions' },
        el('a', { class: 'button', href: '#/' }, 'All projects'))),
    body);

  async function load() {
    body.replaceChildren(el('p', { class: 'muted', role: 'status' }, 'Loading profiles...'));
    try {
      const data = await api.profiles();
      state.profiles = data.profiles || [];
      state.catalog = data.catalog;
      state.projects = (await api.projects().catch(() => ({ projects: [] }))).projects || [];
    } catch (err) {
      body.replaceChildren(el('p', { class: 'bad', role: 'alert' },
        `Profiles failed to load: ${err.message}`));
      return;
    }
    render();
  }

  function render() {
    body.replaceChildren(
      el('h2', {}, 'Installed profiles'),
      profileTable(),
      planPanel(),
      el('h2', {}, state.editing
        ? `Edit profile '${state.editing}'` : 'New profile'),
      profileForm(),
    );
  }

  function profileTable() {
    if (!state.profiles.length) {
      return el('p', { class: 'empty' }, 'No profiles yet - create one below.');
    }
    return el('table', { class: 'classify' },
      el('caption', { class: 'sr-only' }, 'Effective profiles'),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, 'Profile'),
        el('th', { scope: 'col' }, 'Origin'),
        el('th', { scope: 'col' }, 'Harnesses'),
        el('th', { scope: 'col' }, 'Skills'),
        el('th', { scope: 'col' }, 'MCP servers'),
        el('th', { scope: 'col' }, 'Invoke'),
        el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, 'Actions')))),
      el('tbody', {}, state.profiles.map(p => el('tr', {},
        el('td', {},
          el('code', {}, p.id),
          p.label && p.label !== p.id ? el('div', { class: 'hint' }, p.label) : null,
          p.description ? el('div', { class: 'hint' }, p.description) : null),
        el('td', {}, el('span', {
          class: `badge badge-${p.origin === 'kit' ? 'neutral' : 'ok'}`,
        }, p.origin)),
        el('td', {}, el('ul', { class: 'chips' },
          (p.harnesses || []).map(h => el('li', {},
            el('span', { class: 'badge badge-neutral' }, h))))),
        el('td', {}, `${(p.skills || []).length}`),
        el('td', {}, (p.mcpServers || []).join(', ') || '—'),
        el('td', {}, el('ul', { class: 'chips' },
          Object.entries(p.invoke || {}).map(([h, cmd]) => el('li', {},
            el('code', { title: cmd }, cmd))))),
        el('td', {}, el('div', { class: 'card-actions' },
          el('button', {
            type: 'button', class: 'button',
            'aria-expanded': String(!!state.plans[p.id]),
            onclick: () => togglePlan(p.id),
          }, state.plans[p.id] ? 'Hide plan' : 'Plan'),
          el('button', {
            type: 'button', class: 'button', onclick: () => editProfile(p),
          }, 'Edit'),
          el('button', {
            type: 'button', class: 'button', onclick: () => removeProfile(p),
          }, 'Delete')))))));
  }

  /** Plan/invoke panel for whichever row is expanded. */
  function planPanel() {
    const entry = Object.entries(state.plans).find(([, v]) => v);
    if (!entry) return null;
    const [id, planState] = entry;
    if (planState.error) {
      return el('div', { class: 'details' },
        el('p', { class: 'bad', role: 'alert' }, `Plan failed: ${planState.error}`));
    }
    const plan = planState.plan;
    if (!plan) {
      return el('p', { class: 'muted', role: 'status' }, `Loading plan for ${id}...`);
    }
    const missing = (planState.skills || []).filter(s => !s.present);
    return el('div', { class: 'details', 'aria-label': `Plan for ${id}` },
      el('h3', {}, `Plan: ${id}`),
      el('p', {},
        el('label', {}, 'Project ',
          el('select', {
            name: 'project',
            onchange: e => { state.project = e.target.value; },
          },
            el('option', { value: '', selected: !state.project }, 'Kit home (default)'),
            state.projects.map(p => el('option', {
              value: p.path, selected: state.project === p.path,
            }, `${p.name || p.path}`)))),
        ' ',
        el('span', { class: 'hint' }, 'plan and sync target this project')),
      (plan.warnings || []).map(w => el('p', { class: 'warn' }, `warn: ${w}`)),
      plan.artifacts.length
        ? el('table', { class: 'classify' },
            el('caption', { class: 'sr-only' }, 'Artifacts the sync would write'),
            el('thead', {}, el('tr', {},
              el('th', { scope: 'col' }, 'Harness'),
              el('th', { scope: 'col' }, 'Scope'),
              el('th', { scope: 'col' }, 'Destination'))),
            el('tbody', {}, plan.artifacts.map(a => el('tr', {},
              el('td', {}, a.harness),
              el('td', {}, a.scope),
              el('td', {}, el('code', {}, a.dest))))))
        : el('p', { class: 'muted' }, 'No artifacts (core-only harnesses or none selected).'),
      planState.results
        ? el('table', { class: 'classify' },
            el('caption', { class: 'sr-only' }, 'Sync results'),
            el('tbody', {}, planState.results.map(r => el('tr', {},
              el('td', {}, el('span', {
                class: `badge badge-${r.action === 'exists-skip' ? 'neutral' : 'ok'}`,
              }, r.action)),
              el('td', {}, el('code', {}, r.dest))))))
        : null,
      missing.length
        ? el('p', { class: 'warn' },
            `Missing skills: ${missing.map(s => s.name).join(', ')} - install via npx skills add`)
        : null,
      Object.keys(plan.invoke || {}).length
        ? el('ul', { class: 'chips', 'aria-label': 'Invocation strings' },
            Object.entries(plan.invoke).map(([h, cmd]) => el('li', {},
              el('button', {
                type: 'button', class: 'button',
                title: `Copy ${h} invocation`,
                onclick: () => copyText(cmd),
              }, el('code', {}, cmd)))))
        : null,
      el('div', { class: 'apply-bar' },
        el('button', {
          type: 'button', class: 'button primary',
          'aria-disabled': String(state.busy),
          onclick: () => syncProfile(id),
        }, state.busy ? 'Syncing...' : 'Sync')));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard');
    } catch {
      toast('Copy failed - clipboard unavailable', 'error');
    }
  }

  async function togglePlan(id) {
    if (state.plans[id]) {
      state.plans[id] = null;
      render();
      return;
    }
    state.plans = { [id]: {} };
    render();
    try {
      const plan = await api.profilePlan(id, state.project || undefined);
      state.plans[id] = { plan };
    } catch (err) {
      state.plans[id] = { error: err.message };
    }
    render();
  }

  async function syncProfile(id) {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      const res = await api.profileSync(id, state.project || undefined);
      const cur = state.plans[id] || {};
      state.plans[id] = { ...cur, results: res.results, skills: res.skills };
      toast(`Synced profile '${id}'`);
    } catch (err) {
      toast(`Sync failed: ${err.message}`, 'error');
    }
    state.busy = false;
    render();
  }

  async function removeProfile(p) {
    if (!confirm(`Delete profile '${p.id}' and its generated artifacts?`)) return;
    try {
      const res = await api.profileDelete(p.id);
      const kept = (res.removed || []).filter(r => r.action === 'kept-modified');
      toast(`Deleted '${p.id}'`
        + (res.kitProfile ? ' (kit definition remains; re-enable via Edit)' : '')
        + (kept.length ? ` - kept ${kept.length} modified file(s)` : ''));
      await load();
    } catch (err) {
      toast(`Delete failed: ${err.message}`, 'error');
    }
  }

  function editProfile(p) {
    state.editing = p.id;
    state.editingOrigin = p.origin;
    render();
    const form = body.querySelector('form');
    form.elements.label.value = p.label || '';
    form.elements.description.value = p.description || '';
    if (form.elements.alias) form.elements.alias.value = p.alias || '';
    for (const name of ['skills', 'cliTools', 'mcpServers', 'harnesses']) {
      const values = new Set(
        name === 'skills'
          ? (p.skills || []).map(s => (typeof s === 'string' ? s : s.name))
          : p[name] || []);
      for (const box of form.querySelectorAll(`input[name="${name}"]`)) {
        box.checked = values.has(box.value);
      }
    }
    const disableRow = form.querySelector('[data-kit-only]');
    if (disableRow) {
      disableRow.hidden = p.origin !== 'kit';
      form.elements.disabled.checked = false;
    }
    form.scrollIntoView({ block: 'nearest' });
  }

  function profileForm() {
    const catalog = state.catalog
      || { skills: [], cliTools: [], mcpServers: [], harnesses: [] };
    const skills = checkboxGroup('skills',
      (catalog.skills || []).map(n => [n, n]));
    const cliTools = checkboxGroup('cliTools',
      (catalog.cliTools || []).map(n => [n, n]));
    const harnesses = checkboxGroup('harnesses',
      (catalog.harnesses || []).map(h => [h, h]));

    async function submit(e) {
      e.preventDefault();
      const form = e.target;
      const bodyOut = {
        label: form.elements.label.value.trim(),
        description: form.elements.description.value.trim(),
        skills: skills.checked(),
        cliTools: cliTools.checked(),
        mcpServers: [...form.querySelectorAll('input[name="mcpServers"]:checked')]
          .map(b => b.value),
        harnesses: harnesses.checked(),
        alias: form.elements.alias?.value.trim() || '',
      };
      try {
        if (state.editing) {
          if (form.elements.disabled && form.elements.disabled.checked) {
            bodyOut.disabled = true;
          }
          // User profiles can be renamed via the id field.
          const newId = form.elements.id.value.trim();
          let target = state.editing;
          if (state.editingOrigin === 'user' && newId !== state.editing) {
            await api.profileRename(state.editing, newId);
            target = newId;
            toast(`Renamed '${state.editing}' to '${newId}'`);
          }
          await api.profileUpdate(target, bodyOut);
          toast(`Updated profile '${target}'`);
        } else {
          const id = form.elements.id.value.trim();
          await api.profileCreate({ id, ...bodyOut });
          toast(`Created profile '${id}'`);
        }
        state.editing = null;
        await load();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    /** Custom catalog items with delete buttons. */
    function customList(kind) {
      const items = kind === 'mcp'
        ? (catalog.custom?.mcpServers || [])
        : (catalog.custom?.skills || []);
      if (!items.length) return null;
      return el('div', { class: 'details' },
        el('strong', {}, kind === 'mcp' ? 'Custom servers' : 'Custom skills'),
        el('ul', { class: 'chips' }, items.map(s => el('li', {},
          el('span', { class: 'badge badge-neutral' }, s.name),
          ' ',
          el('button', {
            type: 'button', class: 'button',
            onclick: async () => {
              try {
                if (kind === 'mcp') await api.catalogMcpRemove(s.name);
                else await api.catalogSkillRemove(s.name);
                toast(`Removed '${s.name}'`);
                await load();
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          }, 'remove')))));
    }

    /** Declare a custom skill (records metadata; install via npx skills add). */
    function addSkillForm() {
      const nameIn = el('input', { placeholder: 'name', size: '18' });
      const srcIn = el('input', { placeholder: 'source (owner/repo)', size: '18' });
      const slugIn = el('input', { placeholder: 'skill slug (opt)', size: '18' });
      return el('div', { class: 'details' },
        el('p', {}, 'Custom skill:',
          nameIn, ' ', srcIn, ' ', slugIn, ' ',
          el('button', {
            type: 'button', class: 'button',
            onclick: async () => {
              const name = nameIn.value.trim();
              if (!name) { toast('Skill name required', 'error'); return; }
              try {
                await api.catalogSkillAdd({
                  name,
                  source: srcIn.value.trim(),
                  skill: slugIn.value.trim() || name,
                });
                toast(`Added skill '${name}'`);
                await load();
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          }, 'Add')));
    }

    /** Declare a custom MCP server (config written into profile artifacts). */
    function addMcpForm() {
      const nameIn = el('input', { placeholder: 'name', size: '16' });
      const cmdIn = el('input', { placeholder: 'command (npx/uvx/…)', size: '14' });
      const argsIn = el('input', { placeholder: 'args (comma-separated)', size: '22' });
      const envIn = el('input', { placeholder: 'env KEY=VAL,KEY2=VAL2 (opt)', size: '24' });
      return el('div', { class: 'details' },
        el('p', {}, 'Custom MCP server:',
          nameIn, ' ', cmdIn, ' ', argsIn, ' ', envIn, ' ',
          el('button', {
            type: 'button', class: 'button',
            onclick: async () => {
              const name = nameIn.value.trim();
              const command = cmdIn.value.trim();
              if (!name || !command) {
                toast('Name and command required', 'error'); return;
              }
              const env = {};
              for (const pair of envIn.value.split(',')) {
                const [k, v] = pair.split('=');
                if (k && v !== undefined) env[k.trim()] = v.trim();
              }
              try {
                await api.catalogMcpAdd({
                  name, command,
                  args: argsIn.value.split(',').map(s => s.trim()).filter(Boolean),
                  env,
                });
                toast(`Added MCP server '${name}'`);
                await load();
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          }, 'Add')));
    }

    const editing = state.editing;
    function slugify(s) {
      return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }
    let idTouched = !!editing;
    const idInput = el('input', {
      name: 'id', required: true, pattern: '[a-z0-9][a-z0-9-]*',
      placeholder: 'my-specialist',
      disabled: !!(editing && state.editingOrigin === 'kit'),
      value: editing || '',
      oninput: () => { idTouched = true; },
    });
    const labelInput = el('input', {
      name: 'label', placeholder: 'Human-readable name',
      oninput: e => { if (!idTouched) idInput.value = slugify(e.target.value); },
    });
    return el('form', { onsubmit: submit },
      el('p', {},
        el('label', {}, 'Id ', idInput),
        ' ',
        el('span', { class: 'hint' },
          'id = the alias: omp --profile <id>, opencode run --agent <id> - auto-derived from the label, editable')),
      el('p', {},
        el('label', {}, 'Label ', labelInput),
        ' ',
        el('label', {}, 'Description ',
          el('input', { name: 'description', size: '40' }))),
      el('p', {},
        el('label', {}, 'Shell alias ',
          el('input', {
            name: 'alias', size: '14', pattern: '[a-zA-Z][a-zA-Z0-9_-]*',
            placeholder: 'e.g. o-qa (omp profiles only)',
          })),
        ' ',
        el('span', { class: 'hint' },
          'sync writes ~/.ai-onboarding-kit/aliases/<id>.sh|.ps1 and appends a managed source-block to your shell rc (bashrc/zshrc/profile/PS profile) so the alias works with no manual step; delete removes the files')),
      el('fieldset', {},
        el('legend', {}, 'Skills'),
        skills.nodes.length ? skills.nodes : el('p', { class: 'muted' }, 'None in catalog'),
        customList('skill'),
        addSkillForm()),
      el('fieldset', {},
        el('legend', {}, 'CLI tools'),
        cliTools.nodes.length ? cliTools.nodes : el('p', { class: 'muted' }, 'None in catalog')),
      el('fieldset', {},
        el('legend', {}, 'MCP servers'),
        mcpGroups(catalog).map(([tier, servers]) => el('div', {},
          el('strong', {}, `${tier}: `),
          servers.map(s => {
            const box = el('input', {
              type: 'checkbox', name: 'mcpServers', value: s.name,
            });
            return el('label', {}, box, ` ${s.name}`);
          }))),
        customList('mcp'),
        addMcpForm()),
      el('fieldset', {},
        el('legend', {}, 'Harnesses'),
        harnesses.nodes.length ? harnesses.nodes : el('p', { class: 'muted' }, 'None in catalog')),
      el('p', { dataset: { kitOnly: '' }, hidden: true },
        el('label', {},
          el('input', { type: 'checkbox', name: 'disabled' }),
          ' Disable this kit profile')),
      el('p', {},
        el('button', { type: 'submit', class: 'button primary' },
          editing ? 'Save changes' : 'Create profile'),
        editing ? el('button', {
          type: 'button', class: 'button',
          onclick: () => { state.editing = null; state.editingOrigin = null; render(); },
        }, 'Cancel') : null));
  }

  load();
  return root;
}
