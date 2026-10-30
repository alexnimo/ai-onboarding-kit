/**
 * api.mjs - fetch wrappers for the UI-2 JSON API. Only the endpoints the
 * SPA needs; errors surface the server's `{error}` message.
 */

async function request(method, url, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

const enc = encodeURIComponent;

export const api = {
  projects: () => request('GET', '/api/projects'),
  history: project => request('GET', `/api/history?project=${enc(project)}`),
  dryRun: project => request('POST', '/api/dry-run', { project }),
  diff: (planId, dest) => request('GET', `/api/plans/${enc(planId)}/diff?dest=${enc(dest)}`),
  merge: (planId, dest) => request('GET', `/api/plans/${enc(planId)}/merge?dest=${enc(dest)}`),
  apply: (planId, dispositions) =>
    request('POST', `/api/plans/${enc(planId)}/apply`, { dispositions }),
  onboardAgents: () => request('GET', '/api/onboard/agents'),
  onboardPlan: (target, profile, installSkills) =>
    request('POST', '/api/onboard/plans', { target, profile, installSkills }),
  onboardGet: planId => request('GET', `/api/onboard/plans/${enc(planId)}`),
  onboardApply: (planId, accepted, content) =>
    request('POST', `/api/onboard/plans/${enc(planId)}/apply`, { accepted, content }),
  onboardResolve: (planId, artifact, runner) =>
    request('POST', `/api/onboard/plans/${enc(planId)}/resolve`, { artifact, runner }),
  profiles: () => request('GET', '/api/profiles'),
  profilePlan: (id, project) =>
    request('GET', `/api/profiles/${enc(id)}/plan${project ? `?project=${enc(project)}` : ''}`),
  profileSync: (id, project) =>
    request('POST', `/api/profiles/${enc(id)}/sync`, project ? { project } : {}),
  profileCreate: body => request('POST', '/api/profiles', body),
  profileUpdate: (id, body) => request('PUT', `/api/profiles/${enc(id)}`, body),
  profileDelete: id => request('DELETE', `/api/profiles/${enc(id)}`),
  profileRename: (id, newId) =>
    request('POST', `/api/profiles/${enc(id)}/rename`, { newId }),
  catalogSkillAdd: body => request('POST', '/api/catalog/skill', body),
  catalogSkillRemove: name => request('DELETE', `/api/catalog/skill?name=${enc(name)}`),
  catalogMcpAdd: body => request('POST', '/api/catalog/mcp', body),
  catalogMcpRemove: name => request('DELETE', `/api/catalog/mcp?name=${enc(name)}`),
  projectCreate: body => request('POST', '/api/projects', body),
  projectDelete: project => request('DELETE', `/api/projects?path=${enc(project)}`),
  projectDetail: project => request('GET', `/api/project/detail?path=${enc(project)}`),
  doctor: () => request('GET', '/api/doctor'),
  skills: () => request('GET', '/api/skills'),
  skillInstall: name => request('POST', '/api/skills/install', { name }),
  skillUpdate: name => request('POST', '/api/skills/update', { name }),
};
