import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_CA_BUNDLE_BYTES = 10 * 1024 * 1024;
const MAX_CHAIN_DEPTH = 10;
const CHROMIUM_ERR_CERT_AUTHORITY_INVALID = -202;
const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/** Minimal Electron `Certificate` tree shape passed to `setCertificateVerifyProc`. */
export interface PeerCertificateNode {
  readonly data: string;
  readonly issuerCert?: PeerCertificateNode;
}

/** Minimal Electron `setCertificateVerifyProc` request subset for deterministic verification. */
export interface CertificateVerifyRequestLike {
  readonly hostname: string;
  readonly certificate: PeerCertificateNode;
  readonly verificationResult: string;
  readonly errorCode: number;
}

function isCertValidAt(cert: crypto.X509Certificate, nowMs: number): boolean {
  const notBefore = Date.parse(cert.validFrom);
  const notAfter = Date.parse(cert.validTo);
  return Number.isFinite(notBefore) && Number.isFinite(notAfter) && notBefore <= nowMs && nowMs <= notAfter;
}

function parsePemBundle(pemText: string): crypto.X509Certificate[] {
  const certs: crypto.X509Certificate[] = [];
  for (const match of pemText.matchAll(PEM_CERT_RE)) {
    try {
      certs.push(new crypto.X509Certificate(match[0]));
    } catch {
      // Ignore malformed certificate blocks inside external PEM bundles
    }
  }
  return certs;
}

/**
 * Loads additional trusted CA certificates from `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
 * and (on Linux) `/etc/ssl/certs/ca-certificates.crt` so corporate proxy CAs work inside Electron `net.fetch`.
 */
export function loadExtraTrustedCaCertificates(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): readonly crypto.X509Certificate[] {
  const candidatePaths = new Set<string>();
  for (const envKey of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'] as const) {
    const raw = env[envKey]?.trim();
    if (raw) {
      candidatePaths.add(path.resolve(raw));
    }
  }
  if (platform === 'linux') {
    candidatePaths.add('/etc/ssl/certs/ca-certificates.crt');
  }

  const seenFingerprints = new Set<string>();
  const cas: crypto.X509Certificate[] = [];

  for (const caPath of candidatePaths) {
    try {
      const stat = fs.statSync(caPath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CA_BUNDLE_BYTES) {
        continue;
      }
      const rawPem = fs.readFileSync(caPath, 'utf8');
      for (const cert of parsePemBundle(rawPem)) {
        if (!seenFingerprints.has(cert.fingerprint256)) {
          seenFingerprints.add(cert.fingerprint256);
          cas.push(cert);
        }
      }
    } catch {
      // Unreadable optional CA file paths are ignored safely
    }
  }

  return cas;
}

function collectPresentedChain(leafNode: PeerCertificateNode): crypto.X509Certificate[] {
  const chain: crypto.X509Certificate[] = [];
  const seen = new Set<string>();
  let cursor: PeerCertificateNode | undefined = leafNode;

  while (cursor && chain.length < MAX_CHAIN_DEPTH) {
    const parsed = new crypto.X509Certificate(cursor.data);
    if (seen.has(parsed.fingerprint256)) {
      break;
    }
    seen.add(parsed.fingerprint256);
    chain.push(parsed);
    cursor = cursor.issuerCert;
  }
  return chain;
}

function safeVerifySignature(child: crypto.X509Certificate, issuer: crypto.X509Certificate): boolean {
  try {
    return child.issuer === issuer.subject && child.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

/**
 * Cryptographically verifies a Chromium `ERR_CERT_AUTHORITY_INVALID` certificate chain against
 * explicitly configured extra CAs (checks expiry, RFC 6125 hostname, intermediate CA flags, and signature chain).
 */
export function verifyCertificateChainAgainstExtraCas(
  request: CertificateVerifyRequestLike,
  extraCas: readonly crypto.X509Certificate[],
  nowMs: number = Date.now(),
): boolean {
  if (request.errorCode === 0 || request.verificationResult === 'OK') {
    return true;
  }
  const isAuthorityError =
    request.errorCode === CHROMIUM_ERR_CERT_AUTHORITY_INVALID ||
    /CERT_AUTHORITY_INVALID/i.test(request.verificationResult);
  if (!isAuthorityError || extraCas.length === 0) {
    return false;
  }

  try {
    const chain = collectPresentedChain(request.certificate);
    const leaf = chain[0];
    if (!leaf) {
      return false;
    }
    if (!leaf.checkHost(request.hostname)) {
      return false;
    }
    if (!chain.every((cert) => isCertValidAt(cert, nowMs))) {
      return false;
    }
    for (let i = 0; i < chain.length - 1; i += 1) {
      const child = chain[i]!;
      const parent = chain[i + 1]!;
      if (!parent.ca || !safeVerifySignature(child, parent)) {
        return false;
      }
    }

    const trustedByFingerprint = new Set(
      extraCas.filter((ca) => isCertValidAt(ca, nowMs)).map((ca) => ca.fingerprint256),
    );
    const validExtraCas = extraCas.filter((ca) => ca.ca && isCertValidAt(ca, nowMs));

    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const cert = chain[i]!;
      if (trustedByFingerprint.has(cert.fingerprint256)) {
        return true;
      }
      if (validExtraCas.some((ca) => safeVerifySignature(cert, ca))) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Creates an Electron `session.setCertificateVerifyProc` callback backed by `extraCas`. */
export function createCertificateVerifyProc(
  extraCas: readonly crypto.X509Certificate[] = loadExtraTrustedCaCertificates(),
): (request: CertificateVerifyRequestLike, callback: (verificationResult: number) => void) => void {
  return (request, callback) => {
    callback(verifyCertificateChainAgainstExtraCas(request, extraCas) ? 0 : -2);
  };
}
