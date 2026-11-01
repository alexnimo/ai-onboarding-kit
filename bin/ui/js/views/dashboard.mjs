/**
 * dashboard.mjs - Overview (#/): registered projects table with doctor
 * findings/drift per project, kit header strip, and the register-project
 * form. Doctor data is best-effort: if /api/doctor fails the table still
 * renders without health columns.
 */
import { api } from '../api.mjs';
import { el, basename, formatTime } from '../dom.mjs';
import { toast } from '../toast.mjs';
import { describeLastResult } from '../model.mjs';

const LEVEL_ICON = { error: '✗', warn: '⚠', info: 'ℹ' };

/** @returns {Promise<HTMLElement>} */
export async function renderDashboard() {
  const [{ projects }, doctor] = await Promise.all([
    api.projects(),
    api.doctor().catch(() => null),
  ]);
  const health = new Map((doctor?.projects || []).map(p => [p.path, p]));
  const root = el('section', { class: 'dashboard', 'aria-labelledby': 'dash-title' },
    el('h1', { id: 'dash-title', tabindex: '-1' }, 'Overview'),
    kitStrip(doctor),
    el('p', { class: 'muted' },
      'Dry run is the default. Nothing is written to a project until you press Apply on its sync page.'),
    projects.length ? projectTable(projects, health) : null,
    projects.length
      ? null
      : el('p', { class: 'empty' }, 'No projects registered yet.'),
    el('h2', {}, 'Register a project'),
    registerForm(),
    el('h2', {}, 'Onboard a project'),
    el('p', { class: 'muted' },
      'Runs the scaffold, then an agent fills the {{placeholders}} and converges the generated docs for the project. Works for new and existing projects.'),
    onboardForm());
  if (!doctor) {
    root.insertBefore(el('p', { class: 'warn' },
      'Doctor data unavailable - health columns hidden.'), root.children[2]);
  }
  return root;
}

function kitStrip(doctor) {
  if (!doctor) return null;
  return el('p', { class: 'kit-strip muted' },
    'Kit commit: ', el('code', {}, doctor.kitCommit || 'unknown'),
    ' · health checked ', formatTime(doctor.generatedAt));
}

function projectTable(projects, health) {
  return el('table', { class: 'classify' },
    el('caption', { class: 'sr-only' }, 'Registered projects'),
    el('thead', {}, el('tr', {},
      el('th', { scope: 'col' }, 'Project'),
      el('th', { scope: 'col' }, 'Agents'),
      el('th', { scope: 'col' }, 'Last sync'),
      el('th', { scope: 'col' }, 'Unresolved'),
      el('th', { scope: 'col' }, 'Health'),
      el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, 'Actions')))),
    el('tbody', {}, projects.flatMap(p => projectRows(p, health.get(p.path)))));
}

function projectRows(p, doc) {
  const name = p.name || basename(p.path);
  const agents = Array.isArray(p.agents) ? p.agents : [];
  const result = describeLastResult(p.lastSyncResult);
  const encPath = encodeURIComponent(p.path);
  const rows = [el('tr', {},
    el('td', {},
      el('strong', {}, name),
      el('div', { class: 'hint' }, el('code', {}, p.path)),
      p.missing ? el('div', { class: 'bad' }, 'Path missing on disk.') : null),
    el('td', {}, agents.length
      ? el('ul', { class: 'chips', 'aria-label': 'Agents' },
          agents.map(a => el('li', {}, el('span', { class: 'badge badge-neutral' }, a))))
      : el('span', { class: 'muted' }, '—')),
    el('td', {},
      formatTime(p.lastSyncAt),
      el('div', {}, el('span', { class: `badge badge-${result.tone}` }, result.label))),
    el('td', {}, p.unresolvedCount
      ? el('span', { class: 'warn' }, String(p.unresolvedCount))
      : el('span', { class: 'muted' }, '0')),
    el('td', {}, healthBadges(doc)),
    el('td', {}, el('div', { class: 'card-actions' },
      p.missing
        ? null
        : el('a', { class: 'button primary', href: `#/sync?path=${encPath}` }, 'Sync'),
      el('a', { class: 'button', href: `#/project?path=${encPath}` }, 'Detail'),
      el('a', { class: 'button', href: `#/history?path=${encPath}` }, 'History'),
      el('button', {
        type: 'button', class: 'button', onclick: () => removeProject(p),
      }, 'Remove')))),
  ];
  if (doc && (doc.findings?.length || hasDrift(doc))) {
    rows.push(el('tr', { class: 'details-row' },
      el('td', { colspan: '6' }, doctorPanel(doc))));
  }
  return rows;
}

function healthBadges(doc) {
  if (!doc) return el('span', { class: 'muted' }, '—');
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of doc.findings || []) counts[f.level] = (counts[f.level] || 0) + 1;
  const chips = [];
  if (counts.error) chips.push(el('span', { class: 'badge badge-conflict' }, `✗ ${counts.error}`));
  if (counts.warn) chips.push(el('span', { class: 'badge badge-warn' }, `⚠ ${counts.warn}`));
  if (counts.info) chips.push(el('span', { class: 'badge badge-neutral' }, `ℹ ${counts.info}`));
  if (!chips.length) return el('span', { class: 'badge badge-ok' }, 'ok');
  return el('ul', { class: 'chips' }, chips.map(c => el('li', {}, c)));
}

function hasDrift(doc) {
  const d = doc.drift || {};
  return (d.projectOnly + d.kitAhead + d.wouldBeConflicts + d.retired) > 0;
}

function doctorPanel(doc) {
  const d = doc.drift || {};
  const driftChips = [
    ['project-only', d.projectOnly], ['kit-ahead', d.kitAhead],
    ['conflicts', d.wouldBeConflicts], ['retired', d.retired],
  ].filter(([, n]) => n > 0);
  const missing = doc.skills?.requiredMissing || [];
  return el('div', { class: 'details', 'aria-label': `Doctor findings for ${doc.name}` },
    el('h3', {}, `Doctor: ${doc.name}`),
    doc.status === 'missing'
      ? el('p', { class: 'bad' }, 'Project path is missing; remaining checks skipped.')
      : null,
    driftChips.length
      ? el('ul', { class: 'chips', 'aria-label': 'Drift vs kit' },
          driftChips.map(([label, n]) => el('li', {},
            el('span', { class: 'badge badge-neutral' }, `${label}: ${n}`))))
      : null,
    missing.length
      ? el('p', { class: 'warn' },
          `Missing required skills: ${missing.join(', ')} - see `, el('a', { href: '#/skills' }, 'Skills'))
      : null,
    (doc.findings || []).length
      ? el('table', { class: 'classify' },
          el('caption', { class: 'sr-only' }, 'Findings'),
          el('thead', {}, el('tr', {},
            el('th', { scope: 'col' }, ''),
            el('th', { scope: 'col' }, 'Check'),
            el('th', { scope: 'col' }, 'Finding'),
            el('th', { scope: 'col' }, 'Suggestion'))),
          el('tbody', {}, doc.findings.map(f => el('tr', {},
            el('td', {}, el('span', {
              class: f.level === 'error' ? 'bad' : f.level === 'warn' ? 'warn' : 'muted',
            }, LEVEL_ICON[f.level] || f.level)),
            el('td', {}, el('code', {}, f.check)),
            el('td', {}, f.message),
            el('td', { class: 'muted' }, f.suggestion || '')))))
      : el('p', { class: 'muted' }, 'No findings.'));
}

async function removeProject(p) {
  const name = p.name || basename(p.path);
  if (!confirm(`Remove '${name}' from the registry? Project files are untouched.`)) return;
  try {
    await api.projectDelete(p.path);
    toast(`Removed '${name}'`);
    location.hash === '#/' ? location.reload() : (location.hash = '#/');
  } catch (err) {
    toast(`Remove failed: ${err.message}`, 'error');
  }
}

function registerForm() {
  // Bootstrap agents: fetched live, PATH availability shown.
  const runners = [];
  const agentsFieldset = el('fieldset', {},
    el('legend', {}, 'Bootstrap agents (harnesses)'),
    el('p', { class: 'muted' }, 'Loading agent detection...'));
  api.onboardAgents().then(r => {
    runners.push(...(r.harnesses || []));
    agentsFieldset.replaceChildren(
      el('legend', {}, 'Bootstrap agents (harnesses)'),
      ...(runners.length
        ? runners.map(r => el('label', { class: 'chip-check' },
            el('input', {
              type: 'checkbox', name: 'agents', value: r.name,
              checked: r.available,
              disabled: !r.available,
            }),
            ` ${r.name} `,
            el('span', { class: 'hint' },
              (r.available ? `(${r.binary} on PATH)` : `(${r.binary} not found)`)
              + (r.specialist ? ' · profiles supported' : ''))))
        : [el('p', { class: 'muted' }, 'No agents detected — check PATH')]));
  }).catch(() => {
    agentsFieldset.replaceChildren(
      el('legend', {}, 'Bootstrap agents (harnesses)'),
      el('p', { class: 'muted' }, 'Agent detection unavailable'));
  });

  async function submit(e) {
    e.preventDefault();
    const form = e.target;
    const agents = [...form.querySelectorAll('input[name="agents"]:checked')]
      .map(b => b.value);
    try {
      const res = await api.projectCreate({
        name: form.elements.name.value.trim(),
        path: form.elements.path.value.trim(),
        agents,
      });
      toast(`Registered '${res.project?.name || res.name || 'project'}'`);
      location.reload();
    } catch (err) {
      toast(`Register failed: ${err.message}`, 'error');
    }
  }
  return el('form', { onsubmit: submit },
    el('p', {},
      el('label', {}, 'Path ',
        el('input', {
          name: 'path', required: true, size: '40',
          placeholder: 'C:\\path\\to\\project or /path/to/project',
        })),
      ' ',
      el('label', {}, 'Name ',
        el('input', { name: 'name', placeholder: 'defaults to directory name' }))),
    agentsFieldset,
    el('p', {},
      el('button', { type: 'submit', class: 'button primary' }, 'Register')));
}

/**
 * Onboard form: target + bootstrap profile + converge runner + skills.
 * Creates an onboard plan and navigates to the review view; nothing is
 * written until the user applies there.
 */
function onboardForm() {
  const form = el('form', {});
  const profileSel = el('select', { name: 'profile', required: true });
  const runnerSel = el('select', { name: 'runner' });
  const skillsCheck = el('input', { type: 'checkbox', name: 'installSkills', checked: true });

  api.onboardAgents().then(r => {
    const harnesses = (r.harnesses || []);
    profileSel.replaceChildren(...harnesses.map(h =>
      el('option', { value: h.name, disabled: !h.available },
        `${h.name}${h.available ? '' : ' (not on PATH)'}`)));
    const runners = (r.agents || []);
    runnerSel.replaceChildren(
      el('option', { value: '' }, 'none - scaffold only, fill placeholders manually'),
      ...runners.map(a =>
        el('option', { value: a.name, disabled: !a.available },
          `${a.name}${a.available ? ' (on PATH)' : ' (not on PATH)'}`)));
  }).catch(() => {
    profileSel.replaceChildren(el('option', {}, 'devin'));
    runnerSel.replaceChildren(el('option', { value: '' }, 'unavailable'));
  });

  async function submit(e) {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const res = await api.onboardPlan({
        target: form.elements.target.value.trim(),
        profile: profileSel.value,
        agent: runnerSel.value || undefined,
        installSkills: skillsCheck.checked,
      });
      location.hash = `#/onboard?plan=${res.planId}`;
    } catch (err) {
      toast(`Onboard plan failed: ${err.message}`, 'error');
      btn.disabled = false;
    }
  }
  form.onsubmit = submit;
  form.append(
    el('p', {},
      el('label', {}, 'Path ',
        el('input', {
          name: 'target', required: true, size: '40',
          placeholder: 'C:\\path\\to\\project or /path/to/project',
        })),
      ' ',
      el('label', {}, 'Harness ', profileSel),
      ' ',
      el('label', {}, 'Converge agent ', runnerSel)),
    el('p', {},
      el('label', { class: 'chip-check' }, skillsCheck, ' Install required skills'),
      ' ',
      el('button', { type: 'submit', class: 'button primary' }, 'Plan onboarding')));
  return form;
}
