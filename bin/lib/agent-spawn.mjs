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

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KIT_ROOT, readJson, resolveManifestPath } from './common.mjs';
import { unifiedDiff } from './sync-engine.mjs';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min for a resolve step
const CONVERGE_TIMEOUT_MS = 20 * 60 * 1000; // converge agents edit many files
const LOG_CAP = 256 * 1024; // tail bytes kept per job

/** Directories never mirrored into the converge staging copy. */
const STAGE_EXCLUDES = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.worktrees',
]);
const DIFF_CAP = 200 * 1024; // per-file diff text cap

export function which(binary) {
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
  const prep = prepareRunner(runnerKey, prompt, opts);
  if (!prep.ok) return { stdout: '', ok: false, error: prep.error };
  try {
    const res = spawnSync(prep.argv[0], prep.argv.slice(1), {
      cwd: opts.cwd || process.cwd(),
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
    });
    if (res.error) return { stdout: res.stdout || '', ok: false, error: `${prep.binary}: ${res.error.message}` };
    if (res.status !== 0) {
      return { stdout: res.stdout || '', ok: false, error: `${prep.binary} exited ${res.status}${res.stderr ? `: ${res.stderr.slice(0, 400)}` : ''}` };
    }
    return { stdout: res.stdout || '', ok: true };
  } finally {
    fs.rmSync(prep.tmpDir, { recursive: true, force: true });
  }
}

/**
 * Resolve runner + build argv + stage the prompt file. Shared by the sync
 * spawn (per-artifact resolve) and the async job spawn (converge).
 */
function prepareRunner(runnerKey, prompt, opts = {}) {
  const manifest = readJson(resolveManifestPath(opts.manifest));
  const runner = manifest.onboardingAgents?.[runnerKey];
  if (!runner) {
    return { ok: false, error: `unknown runner '${runnerKey}' - available: ${Object.keys(manifest.onboardingAgents || {}).join(', ')}` };
  }
  if (!which(runner.detect)) {
    return { ok: false, error: `runner binary '${runner.detect}' not found on PATH (runner: ${runnerKey})` };
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-prompt-'));
  const promptFile = path.join(tmpDir, 'prompt.md');
  fs.writeFileSync(promptFile, prompt);
  const argv = runner.spawn.split(/\s+/).filter(Boolean).map(t => {
    if (t.includes('{PROMPT_FILE_ARG}')) return t.replace('{PROMPT_FILE_ARG}', `@${promptFile}`);
    if (t.includes('{PROMPT_FILE}')) return t.replace('{PROMPT_FILE}', promptFile);
    if (t.includes('{PROMPT_TEXT}')) return t.replace('{PROMPT_TEXT}', prompt);
    return t;
  });
  return { ok: true, argv, binary: runner.detect, tmpDir };
}

/**
 * Spawn a runner without blocking the event loop — the converge job runs
 * for minutes while the UI polls status.
 *
 * @param {object} opts {manifest?, timeoutMs?, cwd?, onData?} onData(chunk)
 *   receives combined stdout+stderr as it arrives.
 * @returns {{ok:true, done:Promise, kill:()=>void}|{ok:false,error:string}}
 */
export function spawnRunnerAsync(runnerKey, prompt, opts = {}) {
  const prep = prepareRunner(runnerKey, prompt, opts);
  if (!prep.ok) return { ok: false, error: prep.error };
  const child = spawn(prep.argv[0], prep.argv.slice(1), {
    cwd: opts.cwd || process.cwd(),
    shell: false,
    windowsHide: true,
  });
  const cleanup = () => fs.rmSync(prep.tmpDir, { recursive: true, force: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref();
  }, opts.timeoutMs ?? CONVERGE_TIMEOUT_MS);
  const onData = opts.onData || (() => {});
  child.stdout?.on('data', d => onData(String(d)));
  child.stderr?.on('data', d => onData(String(d)));
  const done = new Promise(resolve => {
    child.on('error', err => {
      clearTimeout(timer); cleanup();
      resolve({ status: null, signal: null, timedOut, error: err.message });
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer); cleanup();
      resolve({ status, signal, timedOut });
    });
  });
  return {
    ok: true, done,
    kill: () => { try { child.kill('SIGTERM'); } catch {} },
  };
}

/**
 * The converge prompt sent to the onboarding agent after the scaffold
 * applied. Reuses prompts/onboard-fill.md verbatim (single source of the
 * fill contract), preceded by a non-interactive preamble: the runner is
 * unattended, so "ask the user" resolves to TBD instead of blocking, and
 * the kit-managed region stays off-limits.
 */
export function buildConvergePrompt({ target, runner, applied = [] } = {}) {
  const fillPath = path.join(KIT_ROOT, 'prompts', 'onboard-fill.md');
  const body = fs.readFileSync(fillPath, 'utf8')
    .replace(/^#[^\n]*\n(?:>[^\n]*\n)*\n?/, ''); // strip the human-paste header
  const fileList = applied.filter(a => !a.includes(':'));
  return [
    `# AI onboarding converge — ${runner}`,
    '',
    `Working directory (TARGET): ${target}`,
    '',
    'You run unattended inside the project that was just scaffolded. The',
    'scaffold, skill installs, and config merges are already applied — do',
    'NOT run scaffold scripts or `npx skills add`.',
    '',
    'Scope — you may ONLY modify:',
    '- `{{placeholders}}` in files the scaffold wrote/merged (listed below),',
    '- content OUTSIDE the `<!-- BEGIN/END ai-onboarding-kit:* -->` markers',
    '  (inside markers is kit-managed; edits there conflict with sync).',
    'Never restructure, rename, or delete project files.',
    '',
    'This session is NON-INTERACTIVE: wherever the instructions say "ask',
    'the user", resolve it yourself if inferable, otherwise fill TBD with',
    'a `<!-- TODO: fill when known -->` comment. Never block on input.',
    '',
    fileList.length
      ? `Applied artifacts (fill these): ${fileList.join(', ')}`
      : 'Fill every generated file that still contains {{placeholders}}.',
    '',
    '---',
    '',
    body,
  ].join('\n');
}

// ---------- staged converge (dry-run first) ----------

/**
 * Mirror `root` into a fresh staging dir, excluding noise dirs. The
 * converge agent runs here: the real project is never touched until the
 * user approves the diff.
 */
export function stageTree(root) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-converge-'));
  fs.cpSync(root, dest, {
    recursive: true,
    filter: src => !STAGE_EXCLUDES.has(path.basename(src)),
  });
  return dest;
}

/**
 * All file paths (POSIX-relative) under root, skipping stage excludes.
 */
function relFiles(root) {
  const out = new Set();
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!STAGE_EXCLUDES.has(e.name)) walk(path.join(d, e.name));
      } else {
        out.add(path.join(d, e.name).slice(root.length + 1)
          .split(path.sep).join('/'));
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

/**
 * Files under root that still contain {{PLACEHOLDER}} tokens.
 */
export function placeholdersLeft(root) {
  const out = [];
  for (const rel of relFiles(root)) {
    if (!/\.(md|txt|json|ya?ml)$/.test(rel)) continue;
    const hits = (fs.readFileSync(path.join(root, rel), 'utf8')
      .match(/\{\{[A-Z0-9_]+\}\}/g) || []).length;
    if (hits) out.push(rel);
  }
  return out.sort();
}

/**
 * Diff staged tree vs the real project. Per-file rows:
 * {file, action: modified|created|deleted, diffText} (diff capped).
 */
export function diffStagedTree(staging, target) {
  const rows = [];
  const staged = relFiles(staging);
  const current = relFiles(target);
  for (const rel of [...staged].sort()) {
    const s = fs.readFileSync(path.join(staging, rel));
    const curPath = path.join(target, rel);
    const exists = current.has(rel);
    if (exists && fs.readFileSync(curPath).equals(s)) continue;
    const newText = s.toString('utf8');
    const oldText = exists ? fs.readFileSync(curPath, 'utf8') : '';
    const diff = unifiedDiff(rel, oldText, newText);
    rows.push({
      file: rel,
      action: exists ? 'modified' : 'created',
      diffText: diff.length > DIFF_CAP
        ? diff.slice(0, DIFF_CAP) + '\n... diff truncated ...'
        : diff,
    });
  }
  for (const rel of [...current].sort()) {
    if (staged.has(rel)) continue;
    rows.push({
      file: rel, action: 'deleted',
      diffText: unifiedDiff(rel, fs.readFileSync(path.join(target, rel), 'utf8'), ''),
    });
  }
  return rows;
}

/**
 * Write a staged change back into the project (atomic). `file` must be a
 * staged relative path — no traversal.
 */
export function applyStagedFile(staging, target, rel) {
  if (rel.includes('..') || path.isAbsolute(rel)) {
    throw new Error(`unsafe staged path: ${rel}`);
  }
  const src = path.join(staging, rel);
  const dst = path.join(target, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.converge-tmp`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dst);
}

export function rmStaging(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Tail-cap helper for job logs. */
export function capLog(buf, chunk, cap = LOG_CAP) {
  const next = buf + chunk;
  return next.length > cap ? next.slice(next.length - cap) : next;
}
