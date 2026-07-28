/**
 * warp's local certificate authority.
 *
 * On first use it generates a self-signed P-256 root, persists it under
 * ~/.pxpipe, and mints leaf certs per SNI host on demand so the CONNECT proxy
 * can terminate (and therefore route) the agent's TLS. Only the child process
 * trusts it: warp points the child's NODE_EXTRA_CA_CERTS at the root, so
 * nothing is installed in the system keychain and no other process on the
 * machine is affected.
 *
 * Ported from wardex ca.go. The certificate assembly is hand-rolled because
 * Node has no equivalent of Go's x509.CreateCertificate — see ./der.ts.
 */

import {
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { createSecureContext, type SecureContext } from 'node:tls';
import { isIP } from 'node:net';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  bitString,
  bool,
  contextTag,
  integer,
  octetString,
  oid,
  pem,
  seq,
  set,
  utcTime,
  utf8String,
} from './der.js';

const textEncoder = new TextEncoder();

const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_COMMON_NAME = '2.5.4.3';
const OID_ORGANIZATION = '2.5.4.10';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

const CA_COMMON_NAME = 'pxpipe warp local CA';
const CA_ORGANIZATION = 'pxpipe';

/** ecdsa-with-SHA256 takes no parameters, so the AlgorithmIdentifier is bare. */
const SIG_ALGORITHM = seq(oid(OID_ECDSA_SHA256));

function distinguishedName(commonName: string, organization?: string): Uint8Array {
  const rdns = [set(seq(oid(OID_COMMON_NAME), utf8String(commonName)))];
  if (organization) rdns.push(set(seq(oid(OID_ORGANIZATION), utf8String(organization))));
  return seq(...rdns);
}

function extension(id: string, critical: boolean, value: Uint8Array): Uint8Array {
  const parts = [oid(id)];
  if (critical) parts.push(bool(true));
  parts.push(octetString(value));
  return seq(...parts);
}

/**
 * KeyUsage is a BIT STRING indexed from the most significant bit:
 * digitalSignature(0), keyCertSign(5), cRLSign(6). The trailing count of unused
 * bits has to match the last bit we actually set or strict verifiers complain.
 */
function keyUsageExtension(bits: number[]): Uint8Array {
  const highest = Math.max(...bits);
  const byteCount = Math.floor(highest / 8) + 1;
  const bytes = new Uint8Array(byteCount);
  for (const bit of bits) bytes[Math.floor(bit / 8)]! |= 0x80 >> bit % 8;
  const unused = byteCount * 8 - (highest + 1);
  return extension(OID_KEY_USAGE, true, bitString(bytes, unused));
}

/** GeneralName: dNSName is [2] IMPLICIT IA5String, iPAddress is [7] OCTET STRING. */
function subjectAltNameExtension(host: string): Uint8Array {
  if (isIP(host)) {
    const octets =
      isIP(host) === 4
        ? Uint8Array.from(host.split('.').map((o) => Number.parseInt(o, 10)))
        : ipv6Bytes(host);
    return extension(OID_SUBJECT_ALT_NAME, false, seq(contextTag(7, octets, false)));
  }
  // [2] IMPLICIT IA5String is the IA5String content under a different tag, so
  // re-encode the content rather than slicing the header off ia5String(): that
  // header is 3 bytes, not 2, once the host reaches 128 chars, and the leftover
  // length byte lands inside the name.
  return extension(
    OID_SUBJECT_ALT_NAME,
    false,
    seq(contextTag(2, textEncoder.encode(host), false)),
  );
}

function ipv6Bytes(host: string): Uint8Array {
  const [head, tail] = host.split('::');
  const parse = (part: string) => (part ? part.split(':').filter(Boolean) : []);
  const left = parse(head ?? '');
  const right = parse(tail ?? '');
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  const out = new Uint8Array(16);
  groups.forEach((group, i) => {
    const v = Number.parseInt(group, 16);
    out[i * 2] = (v >> 8) & 0xff;
    out[i * 2 + 1] = v & 0xff;
  });
  return out;
}

interface CertificateSpec {
  subject: Uint8Array;
  issuer: Uint8Array;
  subjectPublicKey: KeyObject;
  signingKey: KeyObject;
  notBefore: Date;
  notAfter: Date;
  extensions: Uint8Array[];
}

/**
 * Assemble and self-sign a TBSCertificate. The SubjectPublicKeyInfo comes
 * straight out of node:crypto's SPKI export, so we never hand-encode a curve
 * point; everything else is RFC 5280 boilerplate.
 */
function buildCertificate(spec: CertificateSpec): Uint8Array {
  const spki = new Uint8Array(spec.subjectPublicKey.export({ type: 'spki', format: 'der' }));
  const tbs = seq(
    contextTag(0, integer(2)), // v3
    integer(new Uint8Array(randomBytes(16))),
    SIG_ALGORITHM,
    spec.issuer,
    seq(utcTime(spec.notBefore), utcTime(spec.notAfter)),
    spec.subject,
    spki,
    contextTag(3, seq(...spec.extensions)),
  );
  const signature = new Uint8Array(sign('sha256', tbs, spec.signingKey));
  return seq(tbs, SIG_ALGORITHM, bitString(signature));
}

function newKeyPair() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

function privateKeyPem(key: KeyObject): string {
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
}

export class CertificateAuthority {
  private readonly leaves = new Map<string, SecureContext>();

  private constructor(
    private readonly certPem: string,
    private readonly caKey: KeyObject,
    private readonly leafKey: KeyObject,
    private readonly leafKeyPem: string,
    readonly certPath: string,
  ) {}

  /**
   * Load the persisted CA, or create and persist one. A CA that fails to load
   * or has expired is replaced rather than reported: it is entirely derived
   * state, and the only cost of regenerating is that the child process trusts a
   * new root it is about to be handed anyway.
   */
  static loadOrCreate(dir: string): CertificateAuthority {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const certPath = join(dir, 'warp-ca.pem');
    const keyPath = join(dir, 'warp-ca-key.pem');

    try {
      const certPem = readFileSync(certPath, 'utf8');
      const keyPem = readFileSync(keyPath, 'utf8');
      const parsed = new X509Certificate(certPem);
      if (new Date(parsed.validTo).getTime() > Date.now()) {
        const caKey = createPrivateKey(keyPem);
        const leaf = newKeyPair();
        return new CertificateAuthority(
          certPem,
          caKey,
          leaf.publicKey,
          privateKeyPem(leaf.privateKey),
          certPath,
        );
      }
    } catch {
      // fall through and mint a fresh CA
    }

    const ca = newKeyPair();
    const name = distinguishedName(CA_COMMON_NAME, CA_ORGANIZATION);
    const now = Date.now();
    const der = buildCertificate({
      subject: name,
      issuer: name,
      subjectPublicKey: ca.publicKey,
      signingKey: ca.privateKey,
      notBefore: new Date(now - 60 * 60 * 1000),
      notAfter: new Date(now + 10 * 365 * 24 * 60 * 60 * 1000),
      extensions: [
        // pathLen 0: this root may sign leaves, never intermediates.
        extension(OID_BASIC_CONSTRAINTS, true, seq(bool(true), integer(0))),
        keyUsageExtension([0, 5, 6]),
      ],
    });

    const certPem = pem('CERTIFICATE', der);
    writeFileSync(certPath, certPem, { mode: 0o644 });
    writeFileSync(keyPath, privateKeyPem(ca.privateKey), { mode: 0o600 });
    chmodSync(keyPath, 0o600);

    const leaf = newKeyPair();
    return new CertificateAuthority(
      certPem,
      ca.privateKey,
      leaf.publicKey,
      privateKeyPem(leaf.privateKey),
      certPath,
    );
  }

  /**
   * Cached-or-minted TLS context for an SNI host. One leaf key is reused across
   * every host: these certs never leave the machine and are only trusted by the
   * child we spawned, so per-host keygen would buy nothing but latency on the
   * first request to each host.
   */
  secureContextFor(host: string): SecureContext {
    const name = host.replace(/\.$/, '');
    const cached = this.leaves.get(name);
    if (cached) return cached;

    const now = Date.now();
    const der = buildCertificate({
      subject: distinguishedName(name),
      issuer: distinguishedName(CA_COMMON_NAME, CA_ORGANIZATION),
      subjectPublicKey: this.leafKey,
      signingKey: this.caKey,
      notBefore: new Date(now - 60 * 60 * 1000),
      notAfter: new Date(now + 365 * 24 * 60 * 60 * 1000),
      extensions: [
        keyUsageExtension([0]),
        extension(OID_EXT_KEY_USAGE, false, seq(oid(OID_SERVER_AUTH))),
        subjectAltNameExtension(name),
      ],
    });

    const context = createSecureContext({
      key: this.leafKeyPem,
      // Ship the root alongside the leaf so the child validates the whole chain
      // from NODE_EXTRA_CA_CERTS without a separate fetch.
      cert: pem('CERTIFICATE', der) + this.certPem,
    });
    this.leaves.set(name, context);
    return context;
  }
}
