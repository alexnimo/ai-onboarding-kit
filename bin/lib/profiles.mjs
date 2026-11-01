/**
 * profiles.mjs - specialist profile engine. Node >=18, stdlib only.
 *
 * A profile is a named capability bundle: skills + cliTools + MCP servers +
 * an agent definition, materialized per harness into the destinations that
 * harness natively supports (see manifest agentProfiles.<name>.specialist):
 *
 *   kind "profiles"          (omp)       -> ~/.omp/profiles/<id>/agent/{mcp.json,AGENTS.md}
 *   kind "agents+json"       (opencode)  -> opencode.json {mcp, tools} + .opencode/agents/<id>.md
 *   kind "mcp-config+agents" (claude)    -> .claude/mcp-<id>.json + .claude/agents/<id>.md
 *   kind "local-config+agents" (devin)   -> .devin/mcp_config.local.json + .devin/agents/<id>.md
 *   kind "core-only"         (cursor, windsurf, hermes) -> nothing emitted
 *
 * State lives in profiles.user.json (kit root, gitignored): user-created
 * profiles, overrides on kit profiles, and generated-artifact hashes so
 * removal is deterministic (only byte-identical kit output is deleted).
 *
 * Core-tier MCP servers flow into every profile destination that has its
 * own mcp file (omp profile mcp.json, claude mcp-<id>.json): those configs
 * replace the harness's default user-scope file, so omitting them would
 * silently drop code-search from the profile session.
 */

import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  KIT_ROOT,
  readJson,
  writeJsonAtomic,
  sha256,
} from './common.mjs';
import { isObject } from './sync-utils.mjs';

export const PROFILES_USER_PATH = path.join(KIT_ROOT, 'profiles.user.json');
export const CORE_MCP_TIER = 'core';

// ---------- loading ----------

/**
 * Load profiles.user.json. Missing file -> empty store.
 * `custom` holds user-declared catalog items the manifest doesn't know:
 *   custom.mcpServers: [{name, tier, config:{command,args,env}}]
 *   custom.skills:     [{name, source, skill, category}]
 * @returns {{schemaVersion:number, profiles:object, overrides:object, artifacts:object, custom:object}}
 */
export function loadProfileState() {
  if (!fs.existsSync(PROFILES_USER_PATH)) {
    return { schemaVersion: 1, profiles: {}, overrides: {}, artifacts: {},
      custom: { mcpServers: [], skills: [] } };
  }
  const s = readJson(PROFILES_USER_PATH);
  const c = isObject(s.custom) ? s.custom : {};
  return {
    schemaVersion: s.schemaVersion ?? 1,
    profiles: isObject(s.profiles) ? s.profiles : {},
    overrides: isObject(s.overrides) ? s.overrides : {},
    artifacts: isObject(s.artifacts) ? s.artifacts : {},
    custom: {
      mcpServers: Array.isArray(c.mcpServers) ? c.mcpServers : [],
      skills: Array.isArray(c.skills) ? c.skills : [],
    },
  };
}

export function saveProfileState(state) {
  writeJsonAtomic(PROFILES_USER_PATH, {
    schemaVersion: 1,
    profiles: state.profiles,
    overrides: state.overrides,
    artifacts: state.artifacts,
    custom: state.custom || { mcpServers: [], skills: [] },
  });
}

/**
 * Effective profile list = kit manifest profiles overlaid by user overrides
 * plus user-defined profiles. Disabled profiles are excluded. Custom MCP
 * servers (state.custom.mcpServers) are attached as inlineMcpServers so
 * resolveServers can bind profile refs to user-declared configs.
 *
 * @param {object} manifest Parsed onboard.manifest.json.
 * @param {object} [state] Profile state (defaults to loadProfileState()).
 * @returns {Array<object>} Effective profile definitions.
 */
export function effectiveProfiles(manifest, state = loadProfileState()) {
  const custom = state.custom?.mcpServers || [];
  const out = [];
  for (const p of manifest.profiles || []) {
    const ov = state.overrides[p.id] || {};
    if (ov.disabled) continue;
    out.push({ ...p, ...pickDefined(ov), inlineMcpServers: custom, origin: 'kit' });
  }
  for (const [id, p] of Object.entries(state.profiles)) {
    out.push({ ...p, id, inlineMcpServers: custom, origin: 'user' });
  }
  return out;
}
function pickDefined(o) {
  const r = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && k !== 'disabled') r[k] = v;
  return r;
}

// ---------- resolution ----------

/**
 * Resolve a profile's MCP server name refs against manifest.mcpServers
 * (plus inline `config` entries carried on the profile itself).
 *
 * @returns {Array<{name:string, config:object, tier:string}>} Resolved
 *   specialist servers, plus `core` entries when includeCore.
 */
export function resolveServers(profile, manifest, { includeCore = profile.includeCoreMcp !== false } = {}) {
  const byName = new Map();
  for (const s of manifest.mcpServers || []) byName.set(s.name, s);
  for (const s of profile.inlineMcpServers || []) byName.set(s.name, s);

  const out = [];
  const missing = [];
  if (includeCore) {
    for (const s of manifest.mcpServers || []) {
      if ((s.tier || CORE_MCP_TIER) === CORE_MCP_TIER) out.push(s);
    }
  }
  for (const name of profile.mcpServers || []) {
    const s = byName.get(name);
    if (s) out.push(s); else missing.push(name);
  }
  return { servers: out, missing };
}

/**
 * Compute the artifact plan for one profile: which files the kit writes per
 * harness, with content, scope, and the CLI invocation string.
 *
 * @param {object} profile Effective profile.
 * @param {object} manifest Parsed manifest.
 * @param {string|null} projectRoot Absolute project path (for project-scope
 *   artifacts). When null, project-scope artifacts are planned with
 *   '<project>' placeholders and skipped on apply.
 * @returns {{artifacts:Array, missingServers:string[], warnings:string[]}}
 */
export function planProfile(profile, manifest, projectRoot = null, { home = os.homedir() } = {}) {
  const artifacts = [];
  const warnings = [];
  const { servers, missing } = resolveServers(profile, manifest);
  if (missing.length) {
    warnings.push(`unknown mcpServers refs ignored: ${missing.join(', ')}`);
  }
  const mcpEntries = Object.fromEntries(servers.map(s => [s.name, s.config]));

  const scope = profile.scope === 'project' ? 'project' : 'global';
  for (const h of profile.harnesses || []) {
    const hp = (manifest.agentProfiles || {})[h];
    const spec = hp?.specialist;
    if (!spec) {
      warnings.push(`harness '${h}' has no agentProfiles entry — skipped`);
      continue;
    }
    if (spec.kind === 'core-only') {
      warnings.push(`harness '${h}' is core-only — no specialist artifacts`);
      continue;
    }
    if (scope === 'project' && !projectRoot) {
      warnings.push(
        `project-scope profile '${profile.id}' needs a project selected to write artifacts`);
      continue;
    }
    emitForHarness({ profile, spec, mcpEntries, servers, artifacts, projectRoot, home, scope });
  }
  return { artifacts, missingServers: missing, warnings };
}

function emitForHarness({ profile, spec, mcpEntries, servers, artifacts, projectRoot, home, scope = 'global' }) {
  const id = profile.id;
  const prj = projectRoot || '<project>';
  const at = (rel, scope) => path.normalize(scope === 'user'
    ? rel.replace(/^~/, home)
    : path.join(prj, rel));

  switch (spec.kind) {
    case 'profiles': { // omp
      // scope 'project' relocates the profile root into the repo:
      // <project>/.omp/profiles/<id>/agent — invoke via
      // PI_CONFIG_DIR=<project>/.omp omp --profile <id>
      const dir = scope === 'project'
        ? `.omp/profiles/${id}/agent`
        : spec.profileDir.replace('<id>', id);
      const artScope = scope === 'project' ? 'project' : 'user';
      artifacts.push({
        harness: 'omp', scope: artScope, dest: `${dir}/mcp.json`,
        absPath: at(`${dir}/mcp.json`, artScope),
        content: JSON.stringify({ mcpServers: mcpEntries }, null, 2) + '\n',
      });
      artifacts.push({
        harness: 'omp', scope: artScope, dest: `${dir}/AGENTS.md`,
        absPath: at(`${dir}/AGENTS.md`, artScope),
        content: renderProfileInstructions(profile, 'omp'),
      });
      // Shell alias (opt-in via profile.alias): a sourceable snippet the
      // user adds once to .bashrc/.zshrc or their PS profile.
      if (profile.alias) {
        const shDest = `~/.ai-onboarding-kit/aliases/${id}.sh`;
        artifacts.push({
          harness: 'omp', scope: 'user', dest: shDest,
          absPath: at(shDest, 'user'),
          content: `# alias for omp profile '${id}' — source this file or copy the line\n`
            + (scope === 'project'
              ? `alias ${profile.alias}='PI_CONFIG_DIR=$PWD/.omp omp --profile ${id}'\n`
              : `alias ${profile.alias}='omp --profile ${id}'\n`),
        });
        const psDest = `~/.ai-onboarding-kit/aliases/${id}.ps1`;
        artifacts.push({
          harness: 'omp', scope: 'user', dest: psDest,
          absPath: at(psDest, 'user'),
          content: `# alias for omp profile '${id}' — dot-source this file or copy the lines\n`
            + (scope === 'project'
              ? `function ${profile.alias} { $env:PI_CONFIG_DIR="$PWD\\.omp"; omp --profile ${id} @args }\n`
              : `function ${profile.alias} { omp --profile ${id} @args }\n`),
        });
      }
      break;
    }
    case 'agents+json': { // opencode
      // MCP entries in docs format: {type:'local', command:[...], enabled:true}
      const mcp = {};
      for (const s of servers) {
        mcp[s.name] = {
          type: 'local',
          command: [s.config.command, ...(s.config.args || [])],
          enabled: true,
          ...(isObject(s.config.env) && Object.keys(s.config.env).length
            ? { environment: s.config.env } : {}),
        };
      }
      // Global deny for specialist servers, per-agent re-enable.
      const tools = {};
      for (const name of profile.mcpServers || []) tools[`${name}_*`] = false;
      artifacts.push({
        harness: 'opencode', scope: 'project', dest: spec.configPath,
        absPath: at(spec.configPath, 'project'),
        content: JSON.stringify({ mcp, tools }, null, 2) + '\n',
        mergeKeys: { mcp: true, tools: true }, // merged, not whole-file
      });
      artifacts.push({
        harness: 'opencode', scope: 'project',
        dest: `${spec.agentsDir}/${id}.md`,
        absPath: at(`${spec.agentsDir}/${id}.md`, 'project'),
        content: renderOpenCodeAgent(profile),
      });
      break;
    }
    case 'mcp-config+agents': { // claude-code
      const mcpPath = spec.mcpConfigPath.replace('<id>', id);
      artifacts.push({
        harness: 'claude-code', scope: 'project', dest: mcpPath,
        absPath: at(mcpPath, 'project'),
        content: JSON.stringify({ mcpServers: mcpEntries }, null, 2) + '\n',
      });
      artifacts.push({
        harness: 'claude-code', scope: 'project',
        dest: `${spec.agentsDir}/${id}.md`,
        absPath: at(`${spec.agentsDir}/${id}.md`, 'project'),
        content: renderClaudeAgent(profile),
      });
      break;
    }
    case 'local-config+agents': { // devin
      const mcp = {};
      for (const s of servers) {
        mcp[s.name] = spec.serversDisabled
          ? { ...s.config, disabled: true }
          : s.config;
      }
      artifacts.push({
        harness: 'devin', scope: 'project', dest: spec.localConfigPath,
        absPath: at(spec.localConfigPath, 'project'),
        content: JSON.stringify({ mcpServers: mcp }, null, 2) + '\n',
        mergeKeys: { mcpServers: true },
      });
      artifacts.push({
        harness: 'devin', scope: 'project',
        dest: `${spec.agentsDir}/${id}.md`,
        absPath: at(`${spec.agentsDir}/${id}.md`, 'project'),
        content: renderDevinAgent(profile),
      });
      break;
    }
    default:
      break;
  }
}

// ---------- renderers ----------

/**
 * Profile instruction doc (omp profile AGENTS.md): the persona the
 * specialist session starts with.
 */
function renderProfileInstructions(profile, harness) {
  const lines = [
    `# ${profile.label || profile.id} (${harness} profile)`,
    '',
    profile.description || '',
    '',
    '## Scope',
    '',
    `This profile exists for **${profile.id}** work only. Coding-task rules,`,
    'core skills, and core MCP servers still apply — this file adds the',
    'specialist surface on top.',
    '',
  ];
  if (profile.skills?.length) {
    lines.push('## Skills to load for this work', '');
    for (const s of profile.skills) lines.push(`- \`${s}\``);
    lines.push('');
  }
  if (profile.mcpServers?.length) {
    lines.push('## Specialist MCP servers', '');
    for (const s of profile.mcpServers) lines.push(`- \`${s}\``);
    lines.push('');
    lines.push('Rules: use only the calls needed for the hypothesis. Capture');
    lines.push('compact evidence — no raw DOM trees, full traces, or log dumps');
    lines.push('in results. Report findings, evidence refs, and recommended');
    lines.push('action concisely.');
    lines.push('');
  }
  return lines.join('\n');
}

function loadAgentBody(profile) {
  if (!profile.agent?.file) return null;
  const p = path.join(KIT_ROOT, profile.agent.file);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function renderOpenCodeAgent(profile) {
  const enable = Object.fromEntries(
    (profile.mcpServers || []).map(n => [`${n}_*`, true]));
  const fm = [
    '---',
    `description: ${profile.label || profile.id} — ${oneLine(profile.description)}`,
    'mode: all',
    'tools:',
    ...Object.entries(enable).map(([k, v]) => `  ${JSON.stringify(k)}: ${v}`),
    '---',
    '',
  ];
  return fm.join('\n') + (loadAgentBody(profile) || defaultBody(profile));
}

function renderClaudeAgent(profile) {
  const tools = ['Read', 'Grep', 'Glob', 'Bash',
    ...(profile.mcpServers || []).map(n => `mcp__${n}__*`)];
  const fm = [
    '---',
    `name: ${profile.id}`,
    `description: ${profile.label || profile.id} — ${oneLine(profile.description)}`,
    `tools: ${tools.join(', ')}`,
    '---',
    '',
  ];
  return fm.join('\n') + (loadAgentBody(profile) || defaultBody(profile));
}

function renderDevinAgent(profile) {
  const fm = [
    '---',
    `name: ${profile.id}`,
    `description: ${profile.label || profile.id} — ${oneLine(profile.description)}`,
    '---',
    '',
  ];
  return fm.join('\n') + (loadAgentBody(profile) || defaultBody(profile));
}

function oneLine(s) {
  return (s || '').split('\n')[0].replace(/"/g, "'").trim();
}

function defaultBody(profile) {
  return [
    `You are the ${profile.id} specialist. ${profile.description || ''}`,
    '',
    'Return a concise structured result: findings, evidence references,',
    'recommended action, and open risks. Never paste raw traces, DOM',
    'snapshots, or large payloads into your report.',
    '',
  ].join('\n');
}

// ---------- invocation strings ----------

/**
 * CLI invocation strings per harness for a profile.
 * @returns {Record<string,string>}
 */
export function invokeStrings(profile) {
  const id = profile.id;
  const out = {};
  for (const h of profile.harnesses || []) {
    out[h] = {
      omp: profile.scope === 'project'
        ? `PI_CONFIG_DIR='<project>/.omp' omp --profile ${id}`
        : `omp --profile ${id}`,
      opencode: `opencode run --agent ${id} "<task>"  # or @${id} interactively`,
      'claude-code': `claude --mcp-config .claude/mcp-${id}.json --strict-mcp-config --agent ${id}`,
      devin: `devin mcp enable chrome-devtools -s local && devin  # then dispatch to ${id} agent`,
    }[h] || `${h}: no specialist route`;
  }
  return out;
}

// ---------- apply ----------

/**
 * Apply a plan: write artifacts (mergeKeys artifacts merge per top-level
 * key, others write whole-file). Records hashes into state.artifacts.
 *
 * @returns {Array<{dest:string, action:string}>}
 */
export function applyProfilePlan(plan, profile, state, { home = os.homedir(), projectRoot = null } = {}) {
  const results = [];
  for (const a of plan.artifacts) {
    if (a.absPath.includes('<project>')) {
      results.push({ dest: a.dest, action: 'skip-no-project' });
      continue;
    }
    const key = `${profile.id}:${a.absPath}`;
    if (a.mergeKeys) {
      const merged = mergeTopLevel(a.absPath, JSON.parse(a.content), a.mergeKeys);
      if (merged.changed) {
        fs.mkdirSync(path.dirname(a.absPath), { recursive: true });
        fs.writeFileSync(a.absPath, JSON.stringify(merged.data, null, 2) + '\n');
        results.push({ dest: a.dest, action: 'merged' });
      } else {
        results.push({ dest: a.dest, action: 'exists-skip' });
      }
      state.artifacts[key] = {
        // hash the bytes actually written so delete's byte-compare works
        hash: sha256(JSON.stringify(merged.data, null, 2) + '\n'),
        managed: true,
      };
    } else {
      const exists = fs.existsSync(a.absPath)
        ? fs.readFileSync(a.absPath, 'utf8') : null;
      if (exists === a.content) {
        results.push({ dest: a.dest, action: 'exists-skip' });
      } else {
        fs.mkdirSync(path.dirname(a.absPath), { recursive: true });
        fs.writeFileSync(a.absPath, a.content);
        results.push({ dest: a.dest, action: exists === null ? 'created' : 'overwritten' });
      }
      state.artifacts[key] = { hash: sha256(a.content), managed: true };
    }
  }
  // If any shell-alias artifact was written, make sure the user's rc file
  // sources the alias dir so the alias is usable without manual setup.
  if (plan.artifacts.some(a => a.absPath.includes(
      `${path.sep}.ai-onboarding-kit${path.sep}aliases`))) {
    results.push(...ensureAliasBlock({ home }));
  }
  // Opt-in: reuse the default profile's provider credentials + settings for
  // this profile (omp auth export -> --profile <id> auth import, plus
  // config.yml when absent). Off => the profile starts unauthenticated and
  // the user runs `omp --profile <id> login` themselves.
  if (profile.copyAuth && (profile.harnesses || []).includes('omp')) {
    results.push(...copyOmpAuth(profile, home, projectRoot));
  }
  return results;
}

/**
 * Copy omp provider credentials (auth export/import) and config.yml from the
 * default (unnamed) profile into `<home>/.omp/profiles/<id>/agent/`.
 * Best-effort per step; failures surface as result rows, not throws.
 */
function copyOmpAuth(profile, home, projectRoot = null) {
  const results = [];
  const isProject = profile.scope === 'project' && projectRoot;
  const agentDir = isProject
    ? path.join(projectRoot, '.omp', 'profiles', profile.id, 'agent')
    : path.join(home, '.omp', 'profiles', profile.id, 'agent');
  const configDir = isProject ? path.join(projectRoot, '.omp') : null;

  // 1. Provider credentials via the omp CLI (handles OAuth + API keys).
  const exp = spawnSync('omp', ['auth', 'export'],
    { encoding: 'utf8', timeout: 30000 });
  if (exp.error || exp.status !== 0) {
    results.push({ dest: 'omp credentials',
      action: `skip: auth export failed (${exp.error?.message || `exit ${exp.status}`})` });
  } else {
    const imp = spawnSync('omp', ['--profile', profile.id, 'auth', 'import', '-'],
      { input: exp.stdout, encoding: 'utf8', timeout: 30000,
        env: configDir ? { ...process.env, PI_CONFIG_DIR: configDir } : undefined });
    results.push({
      dest: `omp --profile ${profile.id} credentials`,
      action: imp.error || imp.status !== 0
        ? `error: ${imp.error?.message || `exit ${imp.status}`}`
        : 'imported',
    });
  }

  // 2. Provider/model settings: copy config.yml only when the profile has
  // none of its own (don't clobber customization).
  const src = path.join(home, '.omp', 'agent', 'config.yml');
  const dst = path.join(agentDir, 'config.yml');
  if (fs.existsSync(dst)) {
    results.push({ dest: dst, action: 'exists-skip' });
  } else if (!fs.existsSync(src)) {
    results.push({ dest: dst, action: 'skip: no ~/.omp/agent/config.yml to copy' });
  } else {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.copyFileSync(src, dst);
    results.push({ dest: dst, action: 'copied' });
  }
  return results;
}

/**
 * Merge per top-level key for keys flagged in mergeKeys; other keys in the
 * generated object are ignored (kit only owns flagged keys).
 */
function mergeTopLevel(absPath, generated, mergeKeys) {
  let data = {};
  let changed = false;
  if (fs.existsSync(absPath)) {
    try { data = JSON.parse(fs.readFileSync(absPath, 'utf8')) || {}; }
    catch { data = {}; }
  }
  for (const [key, flag] of Object.entries(mergeKeys)) {
    if (!flag || generated[key] === undefined) continue;
    const cur = isObject(data[key]) ? data[key] : {};
    const next = { ...cur };
    for (const [k, v] of Object.entries(generated[key])) {
      if (JSON.stringify(next[k]) !== JSON.stringify(v)) {
        next[k] = v;
        changed = true;
      }
    }
    if (isObject(data[key]) || changed || Object.keys(next).length) {
      if (JSON.stringify(data[key]) !== JSON.stringify(next)) changed = true;
      data[key] = next;
    }
  }
  return { data, changed };
}

// ---------- shell alias registration ----------

const ALIAS_BLOCK_BEGIN = '# >>> ai-onboarding-kit profile aliases >>>';
const ALIAS_BLOCK_END = '# <<< ai-onboarding-kit profile aliases <<<';

/**
 * Ensure a managed block in the user's shell rc file(s) that sources every
 * `*.sh`/`*.ps1` under `home/.ai-onboarding-kit/aliases/`. Idempotent; the
 * block is generic so new/removed alias files take effect without edits.
 *
 * @param {object} opts {home}
 * @returns {Array<{dest:string, action:string}>}
 */
export function ensureAliasBlock({ home = os.homedir() } = {}) {
  const results = [];

  // POSIX shells: bash login reads .bash_profile > .bash_login > .profile;
  // interactive non-login reads .bashrc; zsh reads .zshrc. Ensure the block
  // in every existing rc file; if none exist, create .bashrc + .bash_profile
  // so the aliases work regardless of shell/login mode.
  const posixBlock = [
    ALIAS_BLOCK_BEGIN,
    `for f in "$HOME/.ai-onboarding-kit/aliases/"*.sh; do`,
    `  [ -f "$f" ] && . "$f"`,
    `done`,
    ALIAS_BLOCK_END,
  ].join('\n');
  const posixNames = ['.bashrc', '.bash_profile', '.zshrc', '.profile'];
  let wrotePosix = false;
  for (const name of posixNames) {
    const rc = path.join(home, name);
    if (!fs.existsSync(rc)) continue;
    const cur = fs.readFileSync(rc, 'utf8');
    if (cur.includes(ALIAS_BLOCK_BEGIN)) {
      results.push({ dest: `~/${name}`, action: 'exists-skip' });
      wrotePosix = true;
      continue;
    }
    fs.writeFileSync(rc, cur.replace(/\s*$/, '\n') + posixBlock + '\n');
    results.push({ dest: `~/${name}`, action: 'appended' });
    wrotePosix = true;
  }
  if (!wrotePosix) {
    for (const name of ['.bashrc', '.bash_profile']) {
      fs.writeFileSync(path.join(home, name), posixBlock + '\n');
      results.push({ dest: `~/${name}`, action: 'created' });
    }
  }

  // PowerShell: dot-source every .ps1 in the alias dir (PS5+PS7 locations).
  const psBlock = [
    ALIAS_BLOCK_BEGIN,
    `foreach ($f in "$HOME\\.ai-onboarding-kit\\aliases\\*.ps1") { . $f }`,
    ALIAS_BLOCK_END,
  ].join('\n');
  const psTargets = process.platform === 'win32' ? [
    path.join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
    path.join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
  ] : [];
  for (const rc of psTargets) {
    if (fs.existsSync(rc)) {
      const cur = fs.readFileSync(rc, 'utf8');
      if (cur.includes(ALIAS_BLOCK_BEGIN)) {
        results.push({ dest: rc, action: 'exists-skip' });
        continue;
      }
      fs.writeFileSync(rc, cur.replace(/\s*$/, '\n') + psBlock + '\n');
      results.push({ dest: rc, action: 'appended' });
    } else {
      fs.mkdirSync(path.dirname(rc), { recursive: true });
      fs.writeFileSync(rc, psBlock + '\n');
      results.push({ dest: rc, action: 'created' });
    }
  }
  return results;
}

/**
 * Remove a profile's recorded artifacts. Byte-identical/recorded files are
 * deleted; modified files are kept and reported. User-level + project-level
 * both honored via recorded absolute paths.
 */
export function deleteProfileArtifacts(profileId, state, { home = os.homedir() } = {}) {
  const results = [];
  for (const [key, rec] of Object.entries(state.artifacts)) {
    if (!key.startsWith(`${profileId}:`)) continue;
    const abs = key.slice(profileId.length + 1);
    if (!fs.existsSync(abs)) {
      delete state.artifacts[key];
      results.push({ dest: abs, action: 'already-gone' });
      continue;
    }
    const cur = sha256(fs.readFileSync(abs));
    if (rec.managed && cur === rec.hash) {
      fs.rmSync(abs, { force: true });
      delete state.artifacts[key];
      results.push({ dest: abs, action: 'deleted' });
    } else {
      results.push({ dest: abs, action: 'kept-modified' });
    }
  }
  // Best-effort: drop now-empty dirs. rmdir is non-recursive — fails
  // harmlessly when anything remains (kept-modified files, foreign files).
  const ompAgent = path.join(home, '.omp', 'profiles', profileId, 'agent');
  const ompDir = path.dirname(ompAgent);
  for (const d of [ompAgent, ompDir]) {
    try { fs.rmdirSync(d); } catch { /* non-empty or absent — fine */ }
  }
  return results;
}

/**
 * Presence check for profile skills across the standard search dirs.
 * @returns {Array<{name:string, present:boolean}>}
 */
export function skillStatus(profile, { home = os.homedir() } = {}) {
  const dirs = [
    path.join(home, '.agents', 'skills'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.omp', 'agent', 'skills'),
  ];
  let lockNames = new Set();
  const lockPath = path.join(home, '.agents', '.skill-lock.json');
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lockNames = new Set(Object.keys(lock.skills || lock));
  } catch { /* no lockfile */ }
  return (profile.skills || []).map(name => ({
    name,
    present: dirs.some(d => fs.existsSync(path.join(d, name, 'SKILL.md')))
      || lockNames.has(name),
  }));
}
