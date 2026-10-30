/**
 * main.mjs - SPA entry. Hash router: each route renders into #app and moves
 * focus to the view heading so keyboard and screen-reader users land on the
 * new content.
 */
import { el } from './dom.mjs';
import { parseRoute } from './model.mjs';
import { renderDashboard } from './views/dashboard.mjs';
import { renderSync } from './views/sync.mjs';
import { renderHistory } from './views/history.mjs';
import { renderOnboard } from './views/onboard.mjs';
import { renderProfiles } from './views/profiles.mjs';
import { renderProject } from './views/project.mjs';
import { renderSkills } from './views/skills.mjs';

const app = document.getElementById('app');
let generation = 0;

async function route() {
  const current = ++generation;
  const r = parseRoute(location.hash);
  app.replaceChildren(el('p', { class: 'muted', role: 'status' }, 'Loading...'));
  let view;
  try {
    if (r.name === 'onboard') view = renderOnboard(r.plan);
    else if (r.name === 'profiles') view = renderProfiles();
    else if (r.name === 'skills') view = await renderSkills();
    else if (r.name === 'project') view = await renderProject(r.path);
    else if (r.name === 'sync') view = renderSync(r.path);
    else if (r.name === 'history') view = await renderHistory(r.path);
    else view = await renderDashboard();
  } catch (err) {
    view = el('p', { class: 'bad', role: 'alert' }, `Failed to load: ${err.message}`);
  }
  if (current !== generation) return;
  app.replaceChildren(view);
  app.querySelector('h1')?.focus();
}

window.addEventListener('hashchange', route);
route();
