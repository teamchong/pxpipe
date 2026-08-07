/**
 * Minimal PNG encoder (grayscale + RGB, 8-bit, filter=Average, single IDAT).
 * Pure Uint8Array — uses CompressionStream (Node 18+, Workers, browsers); no Buffer/node:zlib.
 */

// ---- CRC32 ---------------------------------------------------------------

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

// ---- Helpers -------------------------------------------------------------

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
  // 'deflate' = RFC 1950 zlib-wrapped — what PNG IDAT needs. 'deflate-raw' (RFC 1951) would be wrong.
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  // TS 5.7 narrows Uint8Array<ArrayBufferLike> away from BufferSource; safe since we never use SharedArrayBuffer.
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
 * Prepend scanline filter bytes using PNG's Average filter (type 3):
 *   Filt(x) = Orig(x) − floor((Recon(a) + Recon(b)) / 2)
 * where `a` is the same channel of the pixel to the left (x − bpp) and `b` the byte directly
 * above. Encoding may read the ORIGINAL bytes for a/b because the decoder reconstructs those
 * positions exactly before it needs them — the transform is bit-exact reversible, so decoded
 * pixels are byte-identical to `pixels`. Nothing about the image the model sees changes.
 *
 * Chosen over filter=None (the previous behavior): residuals of 5×8 bitmap glyphs on a flat
 * background collapse to mostly zeros, which deflate encodes in both less space and less time —
 * ~34% smaller IDAT at roughly half the compression cost on a representative dense page. That
 * matters because every image is re-uploaded on every turn, so IDAT size is a per-request
 * bandwidth cost. Filtering is pure JS ahead of the compressor, so it stays portable to
 * Workers unlike a deflate-level change (see the CompressionStream note above).
 */
function filterAverage(pixels: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const rowBytes = width * bpp;
  const stride = rowBytes + 1;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const src = y * rowBytes;
    const dst = y * stride;
    out[dst] = 3; // filter: Average
    for (let x = 0; x < rowBytes; x++) {
      // Off-image neighbors are defined as zero by the spec, not clamped/wrapped.
      const a = x >= bpp ? pixels[src + x - bpp]! : 0;
      const b = y > 0 ? pixels[src - rowBytes + x]! : 0;
      // a + b ≤ 510 so the shift is exact; only the result wraps to a byte.
      out[dst + 1 + x] = (pixels[src + x]! - ((a + b) >> 1)) & 0xff;
    }
  }
  return out;
}

/** Encode a single-channel (grayscale) buffer as PNG bytes. pixels is row-major, length = width × height. */
export async function encodeGrayPng(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  if (pixels.length !== width * height) {
    throw new Error(`encodeGrayPng: pixels.length=${pixels.length} != ${width}×${height}=${width * height}`);
  }

  // IHDR: width(4) height(4) bitDepth=8 colorType=0(gray) compress=0 filter=0 interlace=0
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8;
  ihdr[9] = 0; // colorType 0 = grayscale; bytes 10-12 already zero

  const compressed = await deflateZlib(filterAverage(pixels, width, height, 1));

  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Encode an RGB (3 bytes/pixel, R,G,B) buffer as PNG bytes (colorType 2 = truecolor). length = width × height × 3. */
export async function encodeRgbPng(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  if (pixels.length !== width * height * 3) {
    throw new Error(`encodeRgbPng: pixels.length=${pixels.length} != ${width}×${height}×3=${width * height * 3}`);
  }

  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8; // bit depth per channel
  ihdr[9] = 2; // colorType 2 = truecolor RGB; bytes 10-12 already zero

  const compressed = await deflateZlib(filterAverage(pixels, width, height, 3));

  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/** Base64-encode bytes. Chunks to avoid call-stack blow-up from String.fromCharCode(...bigArray). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
