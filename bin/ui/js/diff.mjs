/**
 * diff.mjs - pure unified-diff line parser for the sync SPA. Produces data
 * only; views render it with textContent, never innerHTML.
 */

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse unified diff text (as produced by sync-engine unifiedDiff) into
 * classified lines with old/new line numbers. Body lines are only recognised
 * after a hunk header, so `---`/`+++` file headers stay meta lines.
 *
 * @param {string} text Unified diff ('' = no change).
 * @returns {{kind: 'meta'|'hunk'|'add'|'del'|'ctx', text: string,
 *   oldNo: number|null, newNo: number|null}[]}
 */
export function diffLines(text) {
  if (!text) return [];
  const raw = String(text).split('\n');
  if (raw[raw.length - 1] === '') raw.pop();
  const out = [];
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;
  for (const line of raw) {
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      out.push({ kind: 'hunk', text: line, oldNo: null, newNo: null });
    } else if (!inHunk || !/^[ +-]/.test(line)) {
      out.push({ kind: 'meta', text: line, oldNo: null, newNo: null });
    } else if (line[0] === '+') {
      out.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
    } else if (line[0] === '-') {
      out.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
    } else {
      out.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return out;
}
