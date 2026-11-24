import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCertificateVerifyProc,
  loadExtraTrustedCaCertificates,
  verifyCertificateChainAgainstExtraCas,
} from '../src/cert-verifier.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntc-cert-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function generateTestCaAndLeaf(dir: string, prefix: string, sanHost: string): {
  caPem: string;
  leafPem: string;
} {
  const caKey = path.join(dir, `${prefix}-ca.key`);
  const caCert = path.join(dir, `${prefix}-ca.pem`);
  const leafKey = path.join(dir, `${prefix}-leaf.key`);
  const leafCsr = path.join(dir, `${prefix}-leaf.csr`);
  const leafExt = path.join(dir, `${prefix}-leaf.ext`);
  const leafCert = path.join(dir, `${prefix}-leaf.pem`);

  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    caKey,
    '-out',
    caCert,
    '-days',
    '10',
    '-subj',
    `/CN=${prefix}-Root-CA`,
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);

  execFileSync('openssl', [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    leafKey,
    '-out',
    leafCsr,
    '-subj',
    `/CN=${sanHost}`,
  ]);

  fs.writeFileSync(
    leafExt,
    `subjectAltName=DNS:${sanHost}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n`,
    'utf8',
  );

  execFileSync('openssl', [
    'x509',
    '-req',
    '-in',
    leafCsr,
    '-CA',
    caCert,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-out',
    leafCert,
    '-days',
    '10',
    '-extfile',
    leafExt,
  ]);

  return {
    caPem: fs.readFileSync(caCert, 'utf8'),
    leafPem: fs.readFileSync(leafCert, 'utf8'),
  };
}

describe('Corporate Extra CA Certificate Verifier', () => {
  it('CV-01: loads extra CAs from NODE_EXTRA_CA_CERTS and accepts valid matching corporate proxy chain on ERR_CERT_AUTHORITY_INVALID', () => {
    const dir = makeTempDir();
    const { caPem, leafPem } = generateTestCaAndLeaf(dir, 'corp', 'api.githubcopilot.com');
    const rogue = generateTestCaAndLeaf(dir, 'rogue', 'api.githubcopilot.com');
    const bundlePath = path.join(dir, 'corp-ca.pem');
    fs.writeFileSync(bundlePath, caPem, 'utf8');

    const extraCas = loadExtraTrustedCaCertificates({ NODE_EXTRA_CA_CERTS: bundlePath }, 'win32');
    expect(extraCas).toHaveLength(1);

    // Valid Chromium verdict passes immediately
    expect(
      verifyCertificateChainAgainstExtraCas(
        {
          hostname: 'api.github.com',
          certificate: { data: rogue.leafPem },
          verificationResult: 'OK',
          errorCode: 0,
        },
        extraCas,
      ),
    ).toBe(true);

    // Valid corporate CA + matching SAN succeeds on ERR_CERT_AUTHORITY_INVALID (-202)
    expect(
      verifyCertificateChainAgainstExtraCas(
        {
          hostname: 'api.githubcopilot.com',
          certificate: { data: leafPem, issuerCert: { data: caPem } },
          verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID',
          errorCode: -202,
        },
        extraCas,
      ),
    ).toBe(true);

    // Hostname mismatch rejected even if signed by trusted corporate CA
    expect(
      verifyCertificateChainAgainstExtraCas(
        {
          hostname: 'evil.example.com',
          certificate: { data: leafPem, issuerCert: { data: caPem } },
          verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID',
          errorCode: -202,
        },
        extraCas,
      ),
    ).toBe(false);

    // Rogue untrusted CA rejected
    expect(
      verifyCertificateChainAgainstExtraCas(
        {
          hostname: 'api.githubcopilot.com',
          certificate: { data: rogue.leafPem, issuerCert: { data: rogue.caPem } },
          verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID',
          errorCode: -202,
        },
        extraCas,
      ),
    ).toBe(false);

    // Non-authority errors (e.g. expired / revoked) never overridden
    expect(
      verifyCertificateChainAgainstExtraCas(
        {
          hostname: 'api.githubcopilot.com',
          certificate: { data: leafPem, issuerCert: { data: caPem } },
          verificationResult: 'net::ERR_CERT_DATE_INVALID',
          errorCode: -201,
        },
        extraCas,
      ),
    ).toBe(false);

    // Expired timestamp rejected
    const futureMs = Date.now() + 30 * 24 * 60 * 60 * 1000;
    expect(
      verifyCertificateChainAgainstExtraCas(
        {
          hostname: 'api.githubcopilot.com',
          certificate: { data: leafPem, issuerCert: { data: caPem } },
          verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID',
          errorCode: -202,
        },
        extraCas,
        futureMs,
      ),
    ).toBe(false);

    const results: number[] = [];
    const verifyProc = createCertificateVerifyProc([new crypto.X509Certificate(caPem)]);
    verifyProc(
      {
        hostname: 'api.githubcopilot.com',
        certificate: { data: leafPem },
        verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID',
        errorCode: -202,
      },
      (code) => results.push(code),
    );
    expect(results).toEqual([0]);
  });
});
