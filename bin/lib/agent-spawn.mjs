/**
 * agent-spawn.mjs - runner CLI detect/spawn for agent-assisted onboarding
 * steps (placeholder fill, merge resolution). Stdlib only.
 *
 * Runner entries come from manifest.onboardingAgents:
 *   { detect: "<binary>", spawn: "cmd ... {PROMPT_*}" }
 *
 * Placeholder tokens (spawned via execFile args, never a shell):
 *   {PROMPT_FILE}     -> native prompt-file flag value (path on disk)
 *   {PROMPT_FILE_ARG} -> "@<path>" positional (omp reads prompt files via @)
 *   {PROMPT_TEXT}     -> prompt contents injected as a single argument
 *
 * Missing binary = hard error naming the CLI. No silent fallback.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJson, resolveManifestPath } from './common.mjs';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min for a resolve step

function which(binary) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(cmd, [binary], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * List manifest onboardingAgents with detection status.
 *
 * @param {object} opts {manifest?}
 * @returns {{name: string, binary: string, available: boolean, spawn: string, notes?: string}[]}
 */
export function listRunners(opts = {}) {
  const manifest = readJson(resolveManifestPath(opts.manifest));
  return Object.entries(manifest.onboardingAgents || {}).map(([name, r]) => ({
    name,
    binary: r.detect,
    available: which(r.detect),
    spawn: r.spawn,
    notes: r.notes,
  }));
}

/**
 * Spawn an agent runner with `prompt` and return its stdout text.
 *
 * @param {string} runnerKey Name in manifest.onboardingAgents.
 * @param {string} prompt Prompt text (written to a temp file for
 *   {PROMPT_FILE}/{PROMPT_FILE_ARG} tokens; injected as an arg for
 *   {PROMPT_TEXT}).
 * @param {object} opts {manifest?, timeoutMs?, cwd?}
 * @returns {{stdout: string, ok: boolean, error?: string}}
 */
export function spawnRunner(runnerKey, prompt, opts = {}) {
  const manifest = readJson(resolveManifestPath(opts.manifest));
  const runner = manifest.onboardingAgents?.[runnerKey];
  if (!runner) {
    return { stdout: '', ok: false, error: `unknown runner '${runnerKey}' - available: ${Object.keys(manifest.onboardingAgents || {}).join(', ')}` };
  }
  if (!which(runner.detect)) {
    return { stdout: '', ok: false, error: `runner binary '${runner.detect}' not found on PATH (runner: ${runnerKey})` };
  }

  // Prompt-file delivery: a temp file both the {PROMPT_FILE} and
  // {PROMPT_FILE_ARG} token forms can reference.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-prompt-'));
  const promptFile = path.join(tmpDir, 'prompt.md');
  fs.writeFileSync(promptFile, prompt);
  try {
    const tokens = runner.spawn.split(/\s+/).filter(Boolean);
    const argv = tokens.map(t => {
      if (t.includes('{PROMPT_FILE_ARG}')) return t.replace('{PROMPT_FILE_ARG}', `@${promptFile}`);
      if (t.includes('{PROMPT_FILE}')) return t.replace('{PROMPT_FILE}', promptFile);
      if (t.includes('{PROMPT_TEXT}')) return t.replace('{PROMPT_TEXT}', prompt);
      return t;
    });
    const res = spawnSync(argv[0], argv.slice(1), {
      cwd: opts.cwd || process.cwd(),
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
    });
    if (res.error) return { stdout: res.stdout || '', ok: false, error: `${runner.detect}: ${res.error.message}` };
    if (res.status !== 0) {
      return { stdout: res.stdout || '', ok: false, error: `${runner.detect} exited ${res.status}${res.stderr ? `: ${res.stderr.slice(0, 400)}` : ''}` };
    }
    return { stdout: res.stdout || '', ok: true };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
