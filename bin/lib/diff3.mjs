/**
 * diff3.mjs - line-oriented three-way merge. Node >=18, stdlib only.
 *
 * Implements classic diff3 semantics:
 *   1. diff base->ours and base->theirs into replacement hunks (LCS-based).
 *   2. Walk base coordinates, coalescing overlapping/adjacent hunks from both
 *      sides into merge regions.
 *   3. Per region: ours==theirs -> take it; ours==base -> theirs changed,
 *      take theirs; theirs==base -> ours changed, take ours; else conflict.
 *   4. Conflicts render as git-diff3 four-part markers:
 *        <<<<<<< <oursLabel>
 *        ||||||| <baseLabel>
 *        =======
 *        >>>>>>> <theirsLabel>
 *
 * Used by the sync engine (bin/lib/sync.mjs) to merge kit template updates
 * around project edits without silently discarding either side.
 */

/**
 * Above this many LCS matrix cells we stop fine-grained diffing and emit one
 * coarse replacement hunk (correct but less granular). Keeps memory bounded:
 * the DP table is an Int32Array, so the cap is ~16MB.
 */
const DIFF_CELL_LIMIT = 4_000_000;

/**
 * Split text into lines for merging. Handles LF and CRLF by stripping a single
 * trailing \r per line; the caller re-joins with the detected EOL.
 *
 * @param {string} text File text.
 * @returns {string[]} Line array (no line terminators).
 */
export function splitLines(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].endsWith('\r')) lines[i] = lines[i].slice(0, -1);
  }
  return lines;
}

/**
 * Shallow line-array equality.
 *
 * @param {string[]} a First lines.
 * @param {string[]} b Second lines.
 * @returns {boolean} True when same length and identical items.
 */
function linesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Diff two line arrays into replacement hunks.
 *
 * @param {string[]} o Base lines.
 * @param {string[]} x Side lines.
 * @returns {Array<{oStart:number,oEnd:number,sStart:number,sEnd:number}>}
 *   Hunks in ascending order; o[oStart:oEnd] was replaced by x[sStart:sEnd]
 *   (both ends exclusive; zero-width o range = insertion, zero-width s range
 *   = deletion).
 */
export function diffHunks(o, x) {
  // Trim common prefix/suffix - fast path and it shrinks the LCS matrix.
  const oN = o.length, xN = x.length;
  let p = 0;
  while (p < oN && p < xN && o[p] === x[p]) p++;
  let s = 0;
  while (s < oN - p && s < xN - p && o[oN - 1 - s] === x[xN - 1 - s]) s++;
  const oM = oN - p - s, xM = xN - p - s;

  if (oM === 0 && xM === 0) return [];
  if (oM === 0) return [{ oStart: p, oEnd: p, sStart: p, sEnd: p + xM }];
  if (xM === 0) return [{ oStart: p, oEnd: p + oM, sStart: p, sEnd: p }];
  if (oM * xM > DIFF_CELL_LIMIT) {
    // Huge file: one coarse hunk is still a valid diff, just less granular.
    return [{ oStart: p, oEnd: p + oM, sStart: p, sEnd: p + xM }];
  }

  // LCS length table over the differing middles (suffix formulation).
  const W = xM + 1;
  const dp = new Int32Array((oM + 1) * (xM + 1));
  for (let i = oM - 1; i >= 0; i--) {
    const row = i * W, next = (i + 1) * W;
    for (let j = xM - 1; j >= 0; j--) {
      dp[row + j] = o[p + i] === x[p + j]
        ? dp[next + j + 1] + 1
        : Math.max(dp[next + j], dp[row + j + 1]);
    }
  }

  // Backtrack the LCS: gaps between consecutive matched pairs are hunks.
  const hunks = [];
  let i = 0, j = 0, oC = p, xC = p;
  const flush = (oT, xT) => {
    if (oT > oC || xT > xC) hunks.push({ oStart: oC, oEnd: oT, sStart: xC, sEnd: xT });
  };
  while (i < oM && j < xM) {
    if (o[p + i] === x[p + j]) {
      flush(p + i, p + j);
      i++; j++; oC = p + i; xC = p + j;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  flush(p + oM, p + xM);
  return hunks;
}

/**
 * Weave two hunks lists (base->ours, base->theirs) into merge chunks.
 *
 * @param {Array} hunksA diffHunks(base, ours) output.
 * @param {Array} hunksB diffHunks(base, theirs) output.
 * @param {string[]} o Base lines.
 * @param {string[]} a Ours lines.
 * @param {string[]} b Theirs lines.
 * @returns {Array} Ordered chunks: {type:'stable',lines} | {type:'conflict',o,a,b}.
 */
function weave(hunksA, hunksB, o, a, b) {
  const chunks = [];
  let pos = 0, iA = 0, iB = 0;

  while (iA < hunksA.length || iB < hunksB.length) {
    const nA = hunksA[iA], nB = hunksB[iB];
    const rStart = Math.min(nA ? nA.oStart : Infinity, nB ? nB.oStart : Infinity);
    if (rStart > pos) chunks.push({ type: 'stable', lines: o.slice(pos, rStart) });

    // Grow the region while either side has hunks overlapping/adjacent to it
    // (hunk.oStart <= rEnd). This coalesces touching changes into one region,
    // matching diff3 behavior.
    let rEnd = rStart;
    const regA = [], regB = [];
    for (;;) {
      let grew = false;
      while (iA < hunksA.length && hunksA[iA].oStart <= rEnd) {
        const h = hunksA[iA++];
        rEnd = Math.max(rEnd, h.oEnd);
        regA.push(h); grew = true;
      }
      while (iB < hunksB.length && hunksB[iB].oStart <= rEnd) {
        const h = hunksB[iB++];
        rEnd = Math.max(rEnd, h.oEnd);
        regB.push(h); grew = true;
      }
      if (!grew) break;
    }

    // Slice each side's version of [rStart, rEnd). A side with no hunks in the
    // region is unchanged there: its version is the base slice. Otherwise the
    // slice spans the first hunk's start to the last hunk's end, extended by
    // the unchanged base lines at the region edges (which map 1:1 into the
    // side's line space).
    const aLines = regA.length
      ? a.slice(
          regA[0].sStart - (regA[0].oStart - rStart),
          regA[regA.length - 1].sEnd + (rEnd - regA[regA.length - 1].oEnd))
      : o.slice(rStart, rEnd);
    const bLines = regB.length
      ? b.slice(
          regB[0].sStart - (regB[0].oStart - rStart),
          regB[regB.length - 1].sEnd + (rEnd - regB[regB.length - 1].oEnd))
      : o.slice(rStart, rEnd);
    const oLines = o.slice(rStart, rEnd);

    if (linesEqual(aLines, bLines) || linesEqual(aLines, oLines)) {
      // Both sides agree, or only theirs changed -> take theirs? No: if
      // a==o then a didn't change, so take b. Note a==b covers both-equal.
      chunks.push({ type: 'stable', lines: linesEqual(aLines, bLines) ? aLines : bLines });
    } else if (linesEqual(bLines, oLines)) {
      chunks.push({ type: 'stable', lines: aLines });
    } else {
      chunks.push({ type: 'conflict', o: oLines, a: aLines, b: bLines });
    }
    pos = rEnd;
  }
  if (pos < o.length) chunks.push({ type: 'stable', lines: o.slice(pos) });
  return chunks;
}

/**
 * Three-way merge of text.
 *
 * @param {string} baseText Recorded base content.
 * @param {string} oursText Current project content (a side).
 * @param {string} theirsText New kit content (b side).
 * @param {{ours?: string, base?: string, theirs?: string, eol?: string}} labels
 *   Marker labels and output line ending.
 * @returns {{text: string, conflicts: number}} Merged text (markers included
 *   when conflicts > 0) and the conflict region count.
 */
export function merge3(baseText, oursText, theirsText, labels = {}) {
  const { ours = 'project', base = 'base', theirs = 'kit', eol = '\n' } = labels;
  const o = splitLines(baseText);
  const a = splitLines(oursText);
  const b = splitLines(theirsText);

  const chunks = weave(diffHunks(o, a), diffHunks(o, b), o, a, b);

  const out = [];
  let conflicts = 0;
  for (const chunk of chunks) {
    if (chunk.type === 'stable') {
      out.push(...chunk.lines);
      continue;
    }
    conflicts++;
    out.push(`<<<<<<< ${ours}`);
    out.push(...chunk.a);
    out.push(`||||||| ${base}`);
    out.push(...chunk.o);
    out.push('=======');
    out.push(...chunk.b);
    out.push(`>>>>>>> ${theirs}`);
  }
  return { text: out.join(eol), conflicts };
}
