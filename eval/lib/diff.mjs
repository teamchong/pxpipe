/**
 * eval/lib/diff.mjs
 *
 * Character-level accuracy / edit-distance utilities for the L1 OCR eval.
 *
 * Uses Wagner–Fischer dynamic programming for Levenshtein distance.
 * We operate on Unicode codepoints (not UTF-16 code units) so that
 * multi-byte characters like ↵ are counted as single edits.
 */

/**
 * Convert a string to an array of Unicode codepoints.
 * @param {string} s
 * @returns {number[]}
 */
function codepoints(s) {
  return [...s].map(c => c.codePointAt(0));
}

/**
 * Levenshtein edit distance between two strings, operating at the
 * Unicode codepoint level.
 *
 * Space-optimised: O(min(|a|,|b|)) memory.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function levenshtein(a, b) {
  const sa = codepoints(a);
  const sb = codepoints(b);
  if (sa.length === 0) return sb.length;
  if (sb.length === 0) return sa.length;

  // Keep shorter string in the inner dimension for cache efficiency
  const [long, short] = sa.length >= sb.length ? [sa, sb] : [sb, sa];

  let prev = Array.from({ length: short.length + 1 }, (_, i) => i);
  for (let i = 1; i <= long.length; i++) {
    const curr = [i];
    for (let j = 1; j <= short.length; j++) {
      const cost = long[i - 1] === short[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]  + 1,        // insert
        prev[j]      + 1,        // delete
        prev[j - 1]  + cost,     // substitute
      );
    }
    prev = curr;
  }
  return prev[short.length];
}

/**
 * Character-level accuracy (0–1) where 1 = perfect transcription.
 *
 * accuracy = 1 − (editDistance / max(|ref|, |hyp|))
 *
 * Clamped to [0, 1].
 *
 * @param {string} reference   The source / ground-truth text
 * @param {string} hypothesis  The OCR / model transcription
 * @returns {number}
 */
export function charAccuracy(reference, hypothesis) {
  const refLen = codepoints(reference).length;
  const hypLen = codepoints(hypothesis).length;
  const maxLen = Math.max(refLen, hypLen, 1);
  const dist   = levenshtein(reference, hypothesis);
  return Math.max(0, 1 - dist / maxLen);
}

/**
 * Normalise text for comparison: collapse whitespace runs and trim.
 * Used before scoring so minor whitespace artefacts from OCR don't
 * unfairly penalise the reflow path.
 *
 * @param {string} text
 * @returns {string}
 */
export function normaliseForDiff(text) {
  return text
    .replace(/\r\n/g, '\n')    // CRLF → LF
    .replace(/[ \t]+/g, ' ')   // collapse horizontal whitespace
    .replace(/\n{3,}/g, '\n\n') // collapse 3+ blank lines
    .trim();
}

/**
 * Score a single block transcription.
 *
 * @param {{ reference: string, hypothesis: string }} params
 * @returns {{ editDistance: number, charAccuracy: number, refLen: number, hypLen: number }}
 */
export function scoreTranscription({ reference, hypothesis }) {
  const ref = normaliseForDiff(reference);
  const hyp = normaliseForDiff(hypothesis);
  const dist = levenshtein(ref, hyp);
  const acc  = charAccuracy(ref, hyp);
  return {
    editDistance: dist,
    charAccuracy: acc,
    refLen: codepoints(ref).length,
    hypLen: codepoints(hyp).length,
  };
}

/**
 * Aggregate an array of per-block scores into summary stats.
 *
 * @param {Array<{ editDistance: number, charAccuracy: number, refLen: number }>} scores
 * @returns {{ meanAccuracy: number, medianAccuracy: number, minAccuracy: number, totalEdits: number, totalChars: number, macroAccuracy: number }}
 */
export function aggregateScores(scores) {
  if (scores.length === 0) {
    return { meanAccuracy: 0, medianAccuracy: 0, minAccuracy: 0, totalEdits: 0, totalChars: 0, macroAccuracy: 0 };
  }

  const accs = scores.map(s => s.charAccuracy).sort((a, b) => a - b);
  const totalEdits = scores.reduce((s, r) => s + r.editDistance, 0);
  const totalChars = scores.reduce((s, r) => s + r.refLen, 0);

  return {
    meanAccuracy:   accs.reduce((s, v) => s + v, 0) / accs.length,
    medianAccuracy: accs[Math.floor(accs.length / 2)],
    minAccuracy:    accs[0],
    totalEdits,
    totalChars,
    /** Micro-averaged: treats all chars equally regardless of block size. */
    macroAccuracy:  totalChars > 0 ? Math.max(0, 1 - totalEdits / totalChars) : 0,
  };
}
