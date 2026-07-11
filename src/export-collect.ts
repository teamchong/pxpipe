/**
 * Shared file-reading gate for `pxpipe export`. Every collection mode
 * (directory walk, explicit single-file target, and `--git` untracked files)
 * must apply the SAME three checks — include/exclude globs, a max size, and a
 * binary sniff — so the untracked path can no longer read gigabyte or filtered
 * files that directory mode would have skipped.
 *
 * Kept in its own import-safe module (no top-level side effects, unlike
 * src/node.ts which starts the server on import) so it can be unit-tested
 * directly. src/core/export.ts is deliberately fs-free, so the fs-touching gate
 * lives here rather than there.
 */

import * as fs from 'node:fs';
import { shouldIncludeFile } from './core/export.js';

/** Files larger than this are skipped by export (1 MiB). A single export bundle
 *  is meant to be paste-sized; a multi-MB file is never intentional context and
 *  reading it fully into memory is a resource-safety hazard. */
export const MAX_FILE_BYTES = 1_000_000;

/** Returns true if `buf` looks like binary (contains a null byte in the first 512 bytes). */
export function looksLikeBinary(buf: Buffer): boolean {
  const check = Math.min(buf.byteLength, 512);
  for (let i = 0; i < check; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Outcome of trying to read one file for export. `excluded` is a normal filter
 *  hit (callers stay quiet); the other non-ok kinds are worth a warning. */
export type ExportReadResult =
  | { readonly kind: 'ok'; readonly content: string }
  | { readonly kind: 'excluded' | 'oversized' | 'binary' | 'inaccessible' };

/**
 * Read a single text file for export if it passes every gate, in this order:
 *   1. include/exclude globs (relative path)
 *   2. size <= MAX_FILE_BYTES
 *   3. not binary
 * Returns the utf8 content on success, or the reason it was skipped. Pure of
 * logging so each caller can decide whether a skip is noteworthy.
 */
export function readExportTextFile(
  fullPath: string,
  relPath: string,
  include: string[],
  exclude: string[],
): ExportReadResult {
  if (!shouldIncludeFile(relPath, include, exclude)) return { kind: 'excluded' };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    return { kind: 'inaccessible' };
  }
  if (stat.size > MAX_FILE_BYTES) return { kind: 'oversized' };
  let buf: Buffer;
  try {
    buf = fs.readFileSync(fullPath);
  } catch {
    return { kind: 'inaccessible' };
  }
  if (looksLikeBinary(buf)) return { kind: 'binary' };
  return { kind: 'ok', content: buf.toString('utf8') };
}
