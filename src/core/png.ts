/**
 * Minimal PNG encoder. Grayscale, 8-bit, filter = None, single IDAT.
 *
 * Cross-runtime: uses Web Streams (`CompressionStream`) which exists in:
 *   - Node 18+ (global, no import)
 *   - Cloudflare Workers (built-in)
 *   - Modern browsers
 *
 * No `Buffer`, no `node:zlib` — pure Uint8Array. That's the whole reason
 * this exists instead of `pngjs` or `node-png`.
 */

// ---- CRC32 (PNG spec table) ----------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- Helpers --------------------------------------------------------------

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

const TYPE_BYTES = (s: string): Uint8Array => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
};

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeB = TYPE_BYTES(type);
  const crcSrc = concat([typeB, data]);
  return concat([u32be(data.length), typeB, data, u32be(crc32(crcSrc))]);
}

// ---- Deflate via Web Streams ---------------------------------------------

async function deflateZlib(input: Uint8Array): Promise<Uint8Array> {
  // 'deflate' in CompressionStream is zlib-wrapped (RFC 1950), which is what
  // PNG IDAT expects. 'deflate-raw' would be RFC 1951 (no header) — wrong.
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  // Cast: TS 5.7 narrows Uint8Array<ArrayBufferLike> away from BufferSource,
  // but we never use SharedArrayBuffer here so the runtime call is safe.
  void writer.write(input as Uint8Array<ArrayBuffer>);
  void writer.close();

  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return concat(chunks);
}

// ---- Encode --------------------------------------------------------------

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encode a grayscale buffer as PNG bytes.
 *
 * @param pixels  Single-channel coverage, row-major, length = width × height.
 * @param width   Pixel width.
 * @param height  Pixel height.
 */
export async function encodeGrayPng(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  if (pixels.length !== width * height) {
    throw new Error(`encodeGrayPng: pixels.length=${pixels.length} != ${width}×${height}=${width * height}`);
  }

  // IHDR: width(4) height(4) bitDepth(1) colorType(1=gray) compress(0) filter(0) interlace(0)
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type 0 = grayscale
  // bytes 10..12 already zero

  // Add per-scanline filter byte (0 = None) and concat into raw stream
  const stride = width + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: None
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * stride + 1);
  }

  const compressed = await deflateZlib(raw);

  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/**
 * Encode an RGB buffer as PNG bytes (color type 2 = truecolor).
 *
 * @param pixels  3 bytes/pixel (R,G,B), row-major, length = width × height × 3.
 * @param width   Pixel width.
 * @param height  Pixel height.
 */
export async function encodeRgbPng(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  if (pixels.length !== width * height * 3) {
    throw new Error(`encodeRgbPng: pixels.length=${pixels.length} != ${width}×${height}×3=${width * height * 3}`);
  }

  // IHDR: width(4) height(4) bitDepth(1) colorType(1=2 truecolor) ...
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8; // bit depth per channel
  ihdr[9] = 2; // color type 2 = truecolor RGB

  // Per-scanline filter byte (0 = None); 3 bytes per pixel.
  const stride = width * 3 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: None
    raw.set(pixels.subarray(y * width * 3, (y + 1) * width * 3), y * stride + 1);
  }

  const compressed = await deflateZlib(raw);

  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/**
 * Base64-encode bytes in a way that works in both Node and Workers.
 * `btoa` is global in both, but only accepts binary strings — we hand-roll
 * to avoid the `String.fromCharCode(...big array)` blow-up.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  // Chunk to avoid maxing call stack on String.fromCharCode(...)
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
