/**
 * Minimal DER writer — just enough ASN.1 to mint an X.509 certificate.
 *
 * Node can generate keys and sign bytes, but unlike Go's crypto/x509 it has no
 * certificate *issuer*: `new X509Certificate()` only parses. Everything here
 * exists to build the handful of structures in RFC 5280 that a leaf and a root
 * need, so warp can run its own CA without pulling in a dependency.
 *
 * Only the write path is implemented. Parsing is left to node:crypto's
 * X509Certificate, which is why nothing here reads DER back.
 */

const textEncoder = new TextEncoder();

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  SEQUENCE: 0x30,
  SET: 0x31,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
} as const;

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * DER length: short form below 128, else a leading count-of-bytes marked with
 * the high bit. Indefinite length is forbidden in DER, so this is total.
 */
function encodeLength(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

/** tag + length + contents, the shape every other helper is built from. */
export function tlv(tag: number, body: Uint8Array): Uint8Array {
  return concatBytes([Uint8Array.of(tag), encodeLength(body.length), body]);
}

export function seq(...items: Uint8Array[]): Uint8Array {
  return tlv(TAG.SEQUENCE, concatBytes(items));
}

export function set(...items: Uint8Array[]): Uint8Array {
  return tlv(TAG.SET, concatBytes(items));
}

export function bool(value: boolean): Uint8Array {
  return tlv(TAG.BOOLEAN, Uint8Array.of(value ? 0xff : 0x00));
}

/**
 * INTEGER is signed two's complement: strip redundant leading zero bytes, then
 * re-add one if the top bit would otherwise read as negative. Serial numbers
 * are the reason this matters — a random 16-byte serial is negative half the
 * time, and a negative serial is a spec violation some verifiers reject.
 */
export function integer(value: number | Uint8Array): Uint8Array {
  let bytes: number[];
  if (typeof value === 'number') {
    if (value === 0) return tlv(TAG.INTEGER, Uint8Array.of(0));
    bytes = [];
    for (let v = value; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  } else {
    bytes = Array.from(value);
  }
  while (bytes.length > 1 && bytes[0] === 0x00 && (bytes[1]! & 0x80) === 0) bytes.shift();
  if ((bytes[0]! & 0x80) !== 0) bytes.unshift(0x00);
  return tlv(TAG.INTEGER, Uint8Array.from(bytes));
}

/**
 * OID: first two arcs pack into one byte (40*a + b), the rest are base-128 with
 * a continuation bit on every byte but the last.
 */
export function oid(dotted: string): Uint8Array {
  const arcs = dotted.split('.').map((a) => Number.parseInt(a, 10));
  if (arcs.length < 2 || arcs.some((a) => !Number.isFinite(a))) {
    throw new Error(`bad OID: ${dotted}`);
  }
  const out: number[] = [40 * arcs[0]! + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const septets: number[] = [];
    let v = arc;
    do {
      septets.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < septets.length - 1; i++) septets[i]! |= 0x80;
    out.push(...septets);
  }
  return tlv(TAG.OID, Uint8Array.from(out));
}

export function utf8String(value: string): Uint8Array {
  return tlv(TAG.UTF8_STRING, textEncoder.encode(value));
}

export function ia5String(value: string): Uint8Array {
  return tlv(TAG.IA5_STRING, textEncoder.encode(value));
}

export function octetString(body: Uint8Array): Uint8Array {
  return tlv(TAG.OCTET_STRING, body);
}

/** BIT STRING carries a leading count of unused bits in its final byte. */
export function bitString(body: Uint8Array, unusedBits = 0): Uint8Array {
  return tlv(TAG.BIT_STRING, concatBytes([Uint8Array.of(unusedBits), body]));
}

/** Context-specific tag, e.g. [0] EXPLICIT / [2] IMPLICIT in a SAN. */
export function contextTag(n: number, body: Uint8Array, constructed = true): Uint8Array {
  return tlv(0x80 | (constructed ? 0x20 : 0x00) | n, body);
}

/**
 * UTCTime is YYMMDDHHMMSSZ and is only unambiguous through 2049; RFC 5280
 * requires GeneralizedTime past that. Both certs we mint are short-lived
 * relative to that ceiling, but assert rather than silently emit a date that
 * verifiers will read as 19xx.
 */
export function utcTime(date: Date): Uint8Array {
  const year = date.getUTCFullYear();
  if (year >= 2050) throw new Error('utcTime: dates past 2049 need GeneralizedTime');
  const p2 = (v: number) => String(v).padStart(2, '0');
  const stamp =
    p2(year % 100) +
    p2(date.getUTCMonth() + 1) +
    p2(date.getUTCDate()) +
    p2(date.getUTCHours()) +
    p2(date.getUTCMinutes()) +
    p2(date.getUTCSeconds()) +
    'Z';
  return tlv(TAG.UTC_TIME, textEncoder.encode(stamp));
}

export function pem(label: string, der: Uint8Array): string {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
