/**
 * sync-skills.mjs - skills presence check for the sync engine.
 * Node >=18, stdlib only.
 *
 * Mirrors the scaffold's 5-location check (global ~/.agents/skills, each
 * registered agent's skillDirs, project .windsurf/skills, project
 * .agents/skills, and the global skill lockfile). Presence is always
 * reported; installs run only behind --install-skills and updates behind
 * --update-skills (which updates by skill NAME - `source@skill` silently
 * matches nothing in the skills CLI).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson } from './common.mjs';
import { isObject, runNpx } from './sync-utils.mjs';

/**
 * Check (and optionally install/update) skills for a project.
 *
 * @param {object} pctx Project sync context {ctx, projectRoot, entry, pins}.
 * @returns {Array<{name:string,status:string,detail?:string}>} Skill rows.
 */
export function syncSkills(pctx) {
  const { ctx, projectRoot, entry, pins } = pctx;
  const home = os.homedir();

  const dirs = [path.join(home, '.agents', 'skills')];
  for (const a of entry.agents || []) {
    for (const d of ctx.manifest.agentProfiles?.[a]?.skillDirs || []) {
      dirs.push(d.startsWith('~') ? path.join(home, d.slice(1)) : d);
    }
  }
  dirs.push(path.join(projectRoot, '.windsurf', 'skills'));
  dirs.push(path.join(projectRoot, '.agents', 'skills'));
  const searchDirs = [...new Set(dirs.map(d => path.normalize(d)))];

  let lockNames = new Set();
  const lockPath = path.join(home, '.agents', '.skill-lock.json');
  if (fs.existsSync(lockPath)) {
    try {
      const lock = readJson(lockPath);
      if (isObject(lock?.skills)) lockNames = new Set(Object.keys(lock.skills));
    } catch { /* unreadable lock file: ignore */ }
  }

  const isPresent = name =>
    searchDirs.some(d => fs.existsSync(path.join(d, name, 'SKILL.md'))) || lockNames.has(name);

  const skillRows = [];
  for (const s of ctx.manifest.skills || []) {
    const tag = s.required ? 'required' : 'optional';
    if (pins[s.name] !== undefined) {
      skillRows.push({ name: s.name, status: 'pinned', detail: String(pins[s.name]) });
      continue;
    }
    if (isPresent(s.name)) {
      if (ctx.updateSkills) {
        if (ctx.dryRun) { skillRows.push({ name: s.name, status: 'would-update', detail: tag }); continue; }
        const r = runNpx(['skills', 'update', s.name, '-g', '-y']);
        skillRows.push({ name: s.name, status: r.ok ? 'updated' : 'update-failed', detail: r.ok ? tag : r.detail });
      } else {
        skillRows.push({ name: s.name, status: 'present', detail: tag });
      }
      continue;
    }
    if (s.required && ctx.installSkills) {
      if (ctx.dryRun) { skillRows.push({ name: s.name, status: 'would-install', detail: tag }); continue; }
      const r = runNpx(['skills', 'add', `${s.source}@${s.skill}`, '-g', '-y']);
      skillRows.push({
        name: s.name,
        status: r.ok ? (isPresent(s.name) ? 'installed' : 'install-reported-ok') : 'install-failed',
        detail: r.ok ? tag : r.detail,
      });
      continue;
    }
    skillRows.push({ name: s.name, status: 'missing', detail: `${tag}; npx skills add ${s.source}@${s.skill} -g -y` });
  }

  // Kit-bundled template skills install by directory copy (like the scaffold,
  // unconditional - they ship with the kit and are never npx-installed).
  for (const ts of ctx.manifest.templateSkills || []) {
    const destDir = path.join(home, '.agents', 'skills', ts.dest);
    if (fs.existsSync(path.join(destDir, 'SKILL.md'))) {
      skillRows.push({ name: ts.dest, status: 'present', detail: 'kit-bundled' });
      continue;
    }
    const srcAbs = path.join(ctx.manifestRoot, ts.src);
    if (!fs.existsSync(srcAbs)) {
      skillRows.push({ name: ts.dest, status: 'missing', detail: 'kit source missing' });
      continue;
    }
    if (ctx.dryRun) { skillRows.push({ name: ts.dest, status: 'would-install', detail: 'kit-bundled copy' }); continue; }
    try {
      fs.cpSync(srcAbs, destDir, { recursive: true });
      skillRows.push({ name: ts.dest, status: 'installed', detail: 'kit-bundled copy' });
    } catch (err) {
      skillRows.push({ name: ts.dest, status: 'install-failed', detail: String(err.message).split('\n')[0] });
    }
  }
  return skillRows;
}
