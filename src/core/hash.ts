/** Dependency-free hash helper, split out of transform.ts so history.ts (which
 *  transform.ts already imports from) can use it without an import cycle. */

/** sha256[0..8] hex via Web Crypto (works in Node 18+ and Workers). 32-bit collision-safe. */
export async function sha8(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 4; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return hex;
}
