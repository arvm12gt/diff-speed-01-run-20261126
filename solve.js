// diff-speed-01-run-20261126 entry: a faster drop-in for makefun-diff 1.0.0.
//
// Returns exactly makefun-diff 1.0.0's patch for every input: lines are cut
// after every "\n" (a "\r" is part of its line, a last line with no "\n" is a
// line too); the common prefix is kept, then the common suffix of what is
// left; between them Myers's greedy search from the first lines, keeping on
// each diagonal the path reaching furthest into the old text, deletion winning
// when deletion and insertion reach the same point, never moving past either
// text's end, no edge diagonal pruned, every run of equal lines followed as
// far as it goes; the first path to reach both ends is the script. The patch
// is then "makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I", hunks
// with 3 kept lines of context, runs at most 6 kept lines apart sharing a
// hunk, deletions before insertions in each run, and a line with no newline
// written with one and followed by "%".
//
// Speed. Lines are hashed to integer ids once (shared across both texts, so
// the inner loop compares ints), and the forward search writes each level's
// post-snake positions straight into that level's snapshot (no copy pass, no
// separate V array). The search first runs banded: a diagonal k at level d
// can still reach the end only when |k - (n-m)| <= D - d, where D is the
// edit distance, so with any upper bound Dub >= D the band
// [n-m-(Dub-d), n-m+(Dub-d)] holds the whole greedy path and the banded
// search reproduces it exactly (a banded run that finishes at d <= Dub
// proves D <= d <= Dub, so the band did hold the path). Dub comes from the
// line-multiset lower bound LB (lines that must be deleted or inserted,
// counted on the ids) times BAND_MULT; the practice sets sit at D/LB 1.67
// to 1.75, so 1.9 leaves headroom. If the banded run ever finds no path
// (Dub < D), it falls back to the full search, which is always correct.
// Diagonal reads use typed-array out-of-range (undefined) instead of
// explicit bounds checks, and the deletion source of one diagonal is the
// insertion source of the next, so each is read once.

const KEEP = '=';
const DELETE = '-';
const INSERT = '+';
const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;

/** Dub = BAND_MULT * LB, an upper bound on the edit distance D. */
const BAND_MULT = 1.9;

/** Line ids for one text's split parts. parts[last] is '' when the text ends
 *  in "\n" (no line there); otherwise it is a real line with no newline.
 *  id = baseId * 2 + (has newline ? 1 : 0), so a line "foo\n" and a last
 *  line "foo" never share an id. */
function toIds(parts, map) {
  const last = parts.length - 1;
  const n = last + (parts[last] !== '' ? 1 : 0);
  const ids = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const part = parts[i];
    let base = map.get(part);
    if (base === undefined) {
      base = map.size;
      map.set(part, base);
    }
    ids[i] = base * 2 + (i < last ? 1 : 0);
  }
  return ids;
}

/** The line-multiset lower bound on the edit distance: sum over distinct
 *  line ids of |count in a - count in b|. */
function lowerBound(a, b, distinct) {
  const cnt = new Int32Array(distinct);
  for (let i = 0; i < a.length; i++) cnt[a[i]]++;
  for (let i = 0; i < b.length; i++) cnt[b[i]]--;
  let lb = 0;
  for (let i = 0; i < distinct; i++) {
    const c = cnt[i];
    lb += c < 0 ? -c : c;
  }
  return lb;
}

/** Myers's greedy search on id arrays a, b. band(d) returns [klo, khi], the
 *  diagonals to explore at level d (klo/khi already parity-adjusted), or
 *  null when the band is empty. Returns { D, kFound, moveFound, snaps }.
 *  Throws when no path reaches both ends inside the band. */
function search(a, b, band) {
  const n = a.length;
  const m = b.length;
  const kEnd = n - m;
  // snaps[d] = Int32Array(2d+1), index k+d, the post-snake x on diagonal k
  // after d edits; -1 where no path reached that diagonal. Only the band's
  // diagonals are written; reads outside the band are out of range and come
  // back undefined, which the >= 0 tests treat as no path.
  const snaps = [];
  // d = 0: the opening snake.
  let x = 0;
  while (x < n && x < m && a[x] === b[x]) x++;
  snaps[0] = new Int32Array([x]);
  if (x === n && x === m) return { D: 0, kFound: 0, moveFound: 0, snaps };

  outer: for (let d = 1; d <= n + m; d++) {
    const prev = snaps[d - 1];
    const pd = d - 1;
    const range = band(d, kEnd);
    if (range === null) throw new Error('diff: band empty');
    let [klo, khi] = range;
    const snap = new Int32Array(2 * d + 1);
    // The deletion source of diagonal k is the insertion source of k - 2,
    // so carry it across iterations instead of reading it twice.
    let delSrc = prev[klo + pd - 1];
    for (let k = klo; k <= khi; k += 2) {
      const insSrc = prev[k + pd + 1];
      const delX = delSrc >= 0 && delSrc < n ? delSrc + 1 : -1;
      const insX = insSrc >= 0 && insSrc - 1 - k < m ? insSrc : -1;
      delSrc = insSrc;
      if (delX < 0 && insX < 0) {
        snap[k + d] = -1;
        continue;
      }
      let xx;
      let move;
      if (delX >= insX) {
        xx = delX;
        move = 1;
      } else {
        xx = insX;
        move = 2;
      }
      let y = xx - k;
      while (xx < n && y < m && a[xx] === b[y]) {
        xx++;
        y++;
      }
      snap[k + d] = xx;
      if (xx === n && y === m) {
        snaps[d] = snap;
        return { D: d, kFound: k, moveFound: move, snaps };
      }
    }
    snaps[d] = snap;
  }
  throw new Error('diff: the search ended without reaching both ends');
}

/** The full band: every diagonal. */
function fullBand(d) {
  return [-d, d];
}

/** The band for an upper bound Dub on D: diagonal k at level d can still
 *  reach the end only when |k - kEnd| <= Dub - d. Returns null when empty. */
function bandedBand(dub) {
  return (d, kEnd) => {
    let klo = Math.max(-d, kEnd - (dub - d));
    let khi = Math.min(d, kEnd + (dub - d));
    if ((klo - d) & 1) klo++;
    if ((khi - d) & 1) khi--;
    return klo > khi ? null : [klo, khi];
  };
}

/** Backtrack the search result into edit runs [{kind, count}]. */
function backtrack(a, b, res) {
  const n = a.length;
  const m = b.length;
  const { D, moveFound, snaps } = res;
  const segs = [];
  let x = n;
  let y = m;
  for (let d = D; d >= 1; d--) {
    const k = x - y;
    const prev = snaps[d - 1];
    const pd = d - 1;
    const xvDel = prev[k + pd - 1];
    const xvIns = prev[k + pd + 1];
    const delX = xvDel >= 0 && xvDel < n ? xvDel + 1 : -1;
    const insX = xvIns >= 0 && xvIns - 1 - k < m ? xvIns : -1;
    let move;
    let xPrev;
    if (d === D) {
      if (moveFound === 1) {
        move = 1;
        xPrev = xvDel;
      } else {
        move = 2;
        xPrev = xvIns;
      }
    } else if (delX >= insX) {
      move = 1;
      xPrev = xvDel;
    } else {
      move = 2;
      xPrev = xvIns;
    }
    const xAfter = move === 1 ? xPrev + 1 : xPrev;
    segs.push({ kind: KEEP, count: x - xAfter });
    segs.push({ kind: move === 1 ? DELETE : INSERT, count: 1 });
    x = xPrev;
    y = xPrev - (move === 1 ? k - 1 : k + 1);
  }
  segs.push({ kind: KEEP, count: x }); // the d = 0 snake from (0, 0)

  const runs = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (s.count === 0) continue;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === s.kind) last.count += s.count;
    else runs.push({ kind: s.kind, count: s.count });
  }
  return runs;
}

/** Edit runs [{kind, count}] of the middle region, exactly as makefun-diff
 *  finds them. a, b are Int32Array line ids; distinct is the id count. */
function editRuns(a, b, distinct) {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ kind: INSERT, count: m }];
  if (m === 0) return [{ kind: DELETE, count: n }];
  const dub = Math.ceil(lowerBound(a, b, distinct) * BAND_MULT);
  let res;
  try {
    res = search(a, b, bandedBand(dub));
  } catch {
    res = search(a, b, fullBand);
  }
  if (res.D === 0) return [{ kind: KEEP, count: n }];
  return backtrack(a, b, res);
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('diff: the input is { old, new }, two strings');
  }
  const oldParts = input.old.split('\n');
  const newParts = input.new.split('\n');
  const oldLast = oldParts.length - 1;
  const newLast = newParts.length - 1;
  const n = oldLast + (oldParts[oldLast] !== '' ? 1 : 0);
  const m = newLast + (newParts[newLast] !== '' ? 1 : 0);

  const map = new Map();
  const a = toIds(oldParts, map);
  const b = toIds(newParts, map);

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;

  const mid = editRuns(
    a.subarray(prefix, n - suffix),
    b.subarray(prefix, m - suffix),
    map.size * 2,
  );
  const runs = [];
  const push = (kind, count) => {
    if (count === 0) return;
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === kind) last.count += count;
    else runs.push({ kind, count });
  };
  push(KEEP, prefix);
  for (const r of mid) push(r.kind, r.count);
  push(KEEP, suffix);

  // The change runs: each a stretch of deletions and insertions between two
  // kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  // A line as the patch writes it: its op, the line, a newline, and "%" on
  // a line of its own when it had none. Lines are rebuilt from the split
  // parts (index i has a newline exactly when i is not the last part).
  const writeLine = (op, parts, last, i) => {
    const line = parts[i];
    return i < last ? `${op}${line}\n` : `${op}${line}\n%\n`;
  };

  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(writeLine(KEEP, oldParts, oldLast, at));
      for (let i = 0; i < c.dels; i++) out.push(writeLine(DELETE, oldParts, oldLast, c.o + i));
      for (let i = 0; i < c.ins; i++) out.push(writeLine(INSERT, newParts, newLast, c.p + i));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(writeLine(KEEP, oldParts, oldLast, at));
  }
  return out.join('');
}
