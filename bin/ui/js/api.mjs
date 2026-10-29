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
};
