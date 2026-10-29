/**
 * common.mjs - shared helpers for the onboarding kit CLI. Node >=18, stdlib only.
 *
 * Hosts the filesystem/JSON/registry primitives shared by bin/onboard.mjs
 * (registry + state commands) and bin/lib/sync.mjs (the sync engine).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MANIFEST_PATH = path.join(KIT_ROOT, 'onboard.manifest.json');
export const REGISTRY_PATH = path.join(KIT_ROOT, 'projects.registry.json');
export const REGISTRY_LOCK_PATH = `${REGISTRY_PATH}.lock`;
export const STATE_REL_PATH = '.agents/onboarding-state.json';
export const SCHEMA_VERSION = 1;
export const LOCK_TIMEOUT_MS = 10_000;
export const LOCK_STALE_MS = 30_000;
export const LOCK_POLL_MS = 50;

/**
 * Parse argv-style flags into an options object.
 *
 * Supports `--key value`, `--key=value`, and bare boolean flags (`--json`).
 * Positional args land in `_`.
 *
 * @param {string[]} argv Raw argv slice.
 * @returns {Record<string, string|boolean|string[]>} Parsed options.
 */
export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { opts._.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq !== -1) { opts[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { opts[key] = next; i++; }
    else { opts[key] = true; }
  }
  return opts;
}

/**
 * Compute the sha256 hex digest of raw bytes.
 *
 * @param {Buffer|string} data Bytes to hash.
 * @returns {string} Hex digest.
 */
export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Compute the sha256 hex digest of a file's raw bytes.
 *
 * @param {string} filePath Absolute path to the file.
 * @returns {string} Hex digest.
 */
export function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

/**
 * Read and parse a JSON file. Throws on missing, unreadable, or invalid files.
 *
 * @param {string} filePath Absolute path.
 * @returns {*} Parsed JSON.
 */
export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/** fs error codes that are transient file-lock races worth retrying. */
export const RETRYABLE_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Sleep synchronously (used for lock polling). Safe on the Node main thread.
 *
 * @param {number} ms Milliseconds.
 */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, ms);
}

/**
 * Write file contents atomically: write a unique sibling .tmp file, then rename
 * over the target. A crash mid-write leaves either the old file or nothing -
 * never a truncated target - and the unique tmp name keeps concurrent writers
 * from clobbering each other. The tmp file is removed on any failure.
 *
 * @param {string} filePath Absolute target path.
 * @param {string|Buffer} data File contents.
 */
export function writeFileAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpPath, data);
    // Rename-over is atomic, but Windows briefly returns EPERM/EACCES while a
    // concurrent reader/writer has the target open - retry briefly, then give
    // up so a persistent failure propagates (and the tmp gets cleaned below)
    // instead of hanging the CLI.
    const deadline = Date.now() + 2_000;
    for (;;) {
      try { fs.renameSync(tmpPath, filePath); return; }
      catch (err) {
        if (!RETRYABLE_FS_CODES.has(err.code) || Date.now() >= deadline) throw err;
        sleepSync(25);
      }
    }
  } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore cleanup errors */ }
    throw err;
  }
}

/**
 * Write JSON to disk atomically (see writeFileAtomic).
 *
 * @param {string} filePath Absolute target path.
 * @param {*} data JSON-serializable value.
 */
export function writeJsonAtomic(filePath, data) {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Load the kit-side registry. Only a missing file initializes an empty
 * registry; corrupt JSON or an invalid shape throws before any write can
 * clobber the existing inventory.
 *
 * @returns {{schemaVersion: number, projects: Array}} Registry object.
 */
export function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { schemaVersion: SCHEMA_VERSION, projects: [] };
  }
  const reg = readJson(REGISTRY_PATH);
  if (typeof reg !== 'object' || reg === null || !Array.isArray(reg.projects)) {
    throw new Error(`Invalid registry shape in ${REGISTRY_PATH}`);
  }
  reg.schemaVersion = SCHEMA_VERSION;
  return reg;
}

/**
 * Persist the registry atomically.
 *
 * @param {{schemaVersion: number, projects: Array}} reg Registry object.
 */
export function saveRegistry(reg) {
  reg.schemaVersion = SCHEMA_VERSION;
  writeJsonAtomic(REGISTRY_PATH, reg);
}

/**
 * Acquire the registry lockfile (exclusive create). Polls until the lock is
 * free; a lock older than LOCK_STALE_MS is treated as orphaned and removed.
 *
 * @returns {void}
 */
export function acquireRegistryLock() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(REGISTRY_LOCK_PATH, 'wx');
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST' && !RETRYABLE_FS_CODES.has(err.code)) throw err;
      try {
        if (Date.now() - fs.statSync(REGISTRY_LOCK_PATH).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(REGISTRY_LOCK_PATH, { force: true });
          continue;
        }
      } catch { /* lock vanished or still settling - retry */ }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for registry lock: ${REGISTRY_LOCK_PATH}`);
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
}

/**
 * Run `mutate(reg)` while holding the registry lockfile, persisting the
 * result. Serializes read-modify-write updates so concurrent scaffolds cannot
 * lose entries.
 *
 * @param {(reg: {schemaVersion: number, projects: Array}) => *} mutator
 * @returns {*} The mutator's return value.
 */
export function updateRegistry(mutator) {
  acquireRegistryLock();
  try {
    const reg = loadRegistry();
    const result = mutator(reg);
    saveRegistry(reg);
    return result;
  } finally {
    for (let i = 0; i < 20; i++) {
      try { fs.rmSync(REGISTRY_LOCK_PATH, { force: true }); break; }
      catch { sleepSync(LOCK_POLL_MS); }
    }
  }
}

/**
 * Resolve a user-supplied project path to an absolute path (registry key).
 *
 * @param {string} p Raw --path value.
 * @returns {string} Resolved absolute path.
 */
export function resolveProjectPath(p) {
  if (!p || typeof p !== 'string') {
    throw new Error('Missing required --path <dir>');
  }
  return path.resolve(p);
}

/**
 * Resolve the manifest to use. Defaults to the kit manifest next to bin/;
 * --manifest lets callers (both scaffolders support custom manifests)
 * record/sync state for an alternate manifest.
 *
 * @param {string|boolean|undefined} raw Raw flag value.
 * @returns {string} Resolved absolute manifest path.
 */
export function resolveManifestPath(raw) {
  const p = raw === undefined || raw === true ? MANIFEST_PATH : path.resolve(String(raw));
  if (!fs.existsSync(p)) {
    throw new Error(`Manifest not found: ${p}`);
  }
  return p;
}

/**
 * Get the kit's current git commit (used as kitCommit in state files).
 *
 * @returns {string} Full commit sha, or 'unknown' when unavailable.
 */
export function getKitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: KIT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Parse a comma-separated --agents value into a trimmed list.
 *
 * @param {string|boolean|undefined} raw Raw flag value.
 * @returns {string[]} Agent names.
 */
export function parseAgents(raw) {
  if (!raw || raw === true) return [];
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
}
