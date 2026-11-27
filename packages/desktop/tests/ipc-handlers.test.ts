import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GITEA_PAT_SECRET_KEY,
  IPC_CHANNELS,
  openDatabase,
  type ByokConfig,
  type DfeRepoEntry,
  type NcDocument,
  type NtCatalogEntry,
} from '@ntc/core';
import {
  createDesktopIpcController,
  isAllowedSenderFrame,
  type IpcMainEventLike,
  type IpcMainLike,
} from '../src/ipc-handlers.js';
import { SafeStorageSecretStore } from '../src/secret-store.js';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ntc-ipc-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

const SAMPLE_REPO: DfeRepoEntry = {
  dfe: 'NFe',
  repoSlug: 'nfe-parser',
  giteaUrl: 'https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfe-parser',
  baseBranch: 'main',
  basePackage: 'br.gov.mg.fazenda.nfeparser',
  domainPackage: 'br.gov.mg.fazenda.nfeparser.nfe',
  mapperPackage: 'br.gov.mg.fazenda.nfeparser.mapper',
  tablePackage: 'br.gov.mg.fazenda.nfeparser.table',
  parserPackage: 'br.gov.mg.fazenda.nfeparser.parser',
  utilPackage: 'br.gov.mg.fazenda.nfeparser.util',
  tagPrefix: 'NFEPROC',
  svrsRelativePath: '/Nfe/Documentos',
  baselineNt: null,
};

const SAMPLE_NT: NtCatalogEntry = {
  id: 'NFe:2025.002:1.30',
  dfe: 'NFe',
  ntNumber: '2025.002',
  ntVersion: '1.30',
  publishedDate: '2025-10-15',
  homologDate: null,
  prodDate: null,
  pdfUrl: 'https://dfe-portal.svrs.rs.gov.br/Nfe/Documentos/NT.pdf',
  xsdUrl: 'https://dfe-portal.svrs.rs.gov.br/Nfe/Documentos/XSD.zip',
  pdfSha256: 'a'.repeat(64),
  sourceStatus: 'DOWNLOADED',
  fetchedAt: '2026-11-19T12:00:00.000Z',
};

const SAMPLE_NC: NcDocument = {
  nc_id: 'NC-2025.002-v1.30',
  nt_ref: {
    dfe: 'NFe',
    nt_number: '2025.002',
    nt_version: '1.30',
    published_date: '2025-10-15',
    pdf_sha256: 'a'.repeat(64),
  },
  base_commit_sha: '1'.repeat(40),
  no_structural_gaps: false,
  items: [
    {
      id: 'NC-1',
      category: 'STRUCTURAL_DTO',
      decision: 'APPROVE',
      title: 'vIBSCBS',
      description: 'Add field',
      tagPath: 'NFEPROC.NFE.INFNFE.TOTAL.ICMSTOT.VIBSCBS',
      targetPackage: 'domain',
      targetClass: 'Nfe',
      diffKind: 'MISSING_TAG',
      pdfCitations: ['p. 1'],
      suggestedChange: 'private BigDecimal vIBSCBS;',
      editedNotes: null,
      blockerReason: null,
    },
  ],
  created_at: '2026-11-19T12:00:00.000Z',
  updated_at: '2026-11-19T12:00:00.000Z',
};

const BYOK_CONFIG: ByokConfig = {
  provider: 'gemini',
  modelId: 'gemini-2.5-pro',
  operatorName: 'Operador',
  secretKeyRef: 'ntc:llm:gemini',
};

describe('Desktop IPC Controller & Sender Security', () => {
  it('IPC-01: validates allowed renderer frame origins and rejects prefix collisions & external origins', () => {
    expect(isAllowedSenderFrame('file:///opt/app/ui/index.html', ['file:///opt/app/ui/'])).toBe(true);
    expect(isAllowedSenderFrame('file:///opt/app/ui/index.html', ['file:///opt/app/ui/index.html'])).toBe(true);
    expect(isAllowedSenderFrame('file:///opt/app/ui-evil/index.html', ['file:///opt/app/ui/'])).toBe(false);
    expect(isAllowedSenderFrame('file:///opt/app/ui/../etc/passwd', ['file:///opt/app/ui/'])).toBe(false);
    expect(isAllowedSenderFrame('http://127.0.0.1:5173/', ['http://127.0.0.1:5173'])).toBe(true);
    expect(isAllowedSenderFrame('http://127.0.0.1:51730/', ['http://127.0.0.1:5173'])).toBe(false);
    expect(isAllowedSenderFrame('http://127.0.0.1:5173.evil.com/', ['http://127.0.0.1:5173'])).toBe(false);
    expect(isAllowedSenderFrame('https://evil.example.com/index.html', ['file:///opt/app/ui/'])).toBe(false);
    expect(isAllowedSenderFrame(undefined, ['file:///opt/app/ui/'])).toBe(false);
  });

  it('IPC-02: stores secrets without ever returning plaintext via ntc:get-secret-status', async () => {
    const dir = createTempDir();
    const db = openDatabase(path.join(dir, 'ntc.db'));
    db.seedDefaultRepos([SAMPLE_REPO]);
    const secretStore = new SafeStorageSecretStore({
      vaultFilePath: path.join(dir, 'secrets.enc.json'),
      backend: {
        isEncryptionAvailable: () => true,
        encryptString: (v) => Buffer.from(v, 'utf8'),
        decryptString: (b) => b.toString('utf8'),
      },
    });

    const handlers = new Map<string, (event: IpcMainEventLike, payload: unknown) => Promise<unknown>>();
    const mockIpcMain: IpcMainLike = {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
    };

    const controller = createDesktopIpcController({
      db,
      secretStore,
      dataDir: dir,
      oracleJarPath: '/opt/xsd-oracle.jar',
      allowedSenderOrigins: ['http://127.0.0.1:5173'],
      emitProgress: () => undefined,
    });
    controller.register(mockIpcMain);

    const trustedEvent: IpcMainEventLike = { senderFrame: { url: 'http://127.0.0.1:5173/index.html' } };
    const untrustedEvent: IpcMainEventLike = { senderFrame: { url: 'https://evil.attacker.org/' } };

    const setRes = await handlers.get(IPC_CHANNELS.SET_SECRET)!(trustedEvent, {
      key: GITEA_PAT_SECRET_KEY,
      value: 'pat-secret-xyz-1234',
    });
    expect(setRes).toEqual({ configured: true });

    const statusRes = await handlers.get(IPC_CHANNELS.GET_SECRET_STATUS)!(trustedEvent, {
      key: GITEA_PAT_SECRET_KEY,
    });
    expect(statusRes).toEqual({ configured: true });
    expect(JSON.stringify(statusRes)).not.toContain('pat-secret-xyz-1234');

    await expect(
      handlers.get(IPC_CHANNELS.LIST_REPOS)!(untrustedEvent, undefined),
    ).rejects.toThrow(/origem|frame|bloquead/i);
    db.close();
  });

  it('IPC-03: coordinates repository CRUD, NT catalog listing, and Zod validation errors cleanly', async () => {
    const dir = createTempDir();
    const db = openDatabase(path.join(dir, 'ntc.db'));
    db.seedDefaultRepos([SAMPLE_REPO]);
    db.upsertNtCatalogEntries([SAMPLE_NT]);

    const secretStore = new SafeStorageSecretStore({
      vaultFilePath: path.join(dir, 'secrets.enc.json'),
      backend: {
        isEncryptionAvailable: () => true,
        encryptString: (v) => Buffer.from(v, 'utf8'),
        decryptString: (b) => b.toString('utf8'),
      },
    });

    const controller = createDesktopIpcController({
      db,
      secretStore,
      dataDir: dir,
      oracleJarPath: '/opt/xsd-oracle.jar',
      allowedSenderOrigins: ['file:///app/'],
      emitProgress: () => undefined,
    });

    const trusted: IpcMainEventLike = { senderFrame: { url: 'file:///app/index.html' } };
    const repos = await controller.dispatch(IPC_CHANNELS.LIST_REPOS, trusted, undefined);
    expect(repos).toHaveLength(1);

    const nts = await controller.dispatch(IPC_CHANNELS.LIST_NTS, trusted, { dfe: 'NFe' });
    expect(nts).toHaveLength(1);

    await expect(
      controller.dispatch(IPC_CHANNELS.SAVE_REPO, trusted, { ...SAMPLE_REPO, giteaUrl: 'http://insecure/repo' }),
    ).rejects.toThrow();
    db.close();
  });

  it('IPC-04: handles checkCompliance, getNc, saveNc, and async pre-build + PR confirmation handshake', async () => {
    const dir = createTempDir();
    const db = openDatabase(path.join(dir, 'ntc.db'));
    db.seedDefaultRepos([SAMPLE_REPO]);
    db.upsertNtCatalogEntries([SAMPLE_NT]);

    const progressEvents: unknown[] = [];
    const secretStore = new SafeStorageSecretStore({
      vaultFilePath: path.join(dir, 'secrets.enc.json'),
      backend: {
        isEncryptionAvailable: () => true,
        encryptString: (v) => Buffer.from(v, 'utf8'),
        decryptString: (b) => b.toString('utf8'),
      },
    });

    const mockOrchestrator = {
      generateDraftNc: vi.fn(async (input: { runId: string }) => {
        const { saveNcDocument } = await import('@ntc/core');
        db.createComplianceRun({
          runId: input.runId,
          dfe: 'NFe',
          ntId: SAMPLE_NT.id,
          operatorName: 'Op',
          provider: 'gemini',
          modelId: 'gemini-2.5-pro',
          baseCommitSha: '1'.repeat(40),
          ncJsonPath: 'NFe/NC-2025.002-v1.30.json',
        });
        const saved = await saveNcDocument(path.join(dir, 'ncs', 'NFe'), SAMPLE_NC);
        const run = db.getComplianceRun(input.runId)!;
        return { run, savedNc: saved, xsdDir: '/tmp/xsds' };
      }),
      approveAndRunCompliance: vi.fn(
        async (input: {
          runId: string;
          requestPreBuildApproval: (p: unknown) => Promise<{ approved: boolean }>;
          requestPrApproval: (i: unknown) => Promise<{ approved: boolean }>;
        }) => {
          const pre = await input.requestPreBuildApproval({
            runId: input.runId,
            branchName: 'nc/nfe-nt-2025.002-v1.30',
            unifiedDiff: '+ private BigDecimal vIBSCBS;',
            isStrictlyDeclarative: true,
            nonDeclarativeReasons: [],
            editedFiles: ['src/main/java/Nfe.java'],
            createdFiles: [],
          });
          if (!pre.approved) {
            throw new Error('rejected');
          }
          const pr = await input.requestPrApproval({
            runId: input.runId,
            branchName: 'nc/nfe-nt-2025.002-v1.30',
            patchFilePath: '/tmp/a.patch',
            mavenResult: { passed: true, classification: 'PASSED', summary: 'ok', failedTestClasses: [], sanitizedLog: 'ok' },
          });
          db.transitionComplianceRunStatus({ runId: input.runId, nextStatus: 'APPROVED' });
          db.transitionComplianceRunStatus({ runId: input.runId, nextStatus: 'TESTED' });
          const finalRun = pr.approved
            ? db.transitionComplianceRunStatus({
                runId: input.runId,
                nextStatus: 'PR_OPENED',
                prUrl: 'https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfe-parser/pulls/10',
              })
            : db.getComplianceRun(input.runId)!;
          return {
            run: finalRun,
            patchFilePath: '/tmp/a.patch',
            prUrl: finalRun.prUrl,
            mavenResult: { passed: true, classification: 'PASSED', summary: 'ok', failedTestClasses: [], sanitizedLog: 'ok' },
          };
        },
      ),
    };

    const controller = createDesktopIpcController({
      db,
      secretStore,
      dataDir: dir,
      oracleJarPath: '/opt/xsd-oracle.jar',
      allowedSenderOrigins: ['file:///app/'],
      allowedXsdRoots: ['/tmp/xsds', path.join(dir, 'cache', 'svrs')],
      emitProgress: (ev) => progressEvents.push(ev),
      orchestrator: mockOrchestrator as unknown as Parameters<typeof createDesktopIpcController>[0]['orchestrator'],
    });
    const trusted: IpcMainEventLike = { senderFrame: { url: 'file:///app/index.html' } };

    const checkRes = (await controller.dispatch(IPC_CHANNELS.CHECK_COMPLIANCE, trusted, {
      runId: 'run-ipc-1',
      dfe: 'NFe',
      ntId: SAMPLE_NT.id,
      byokConfig: BYOK_CONFIG,
    })) as { run: { runId: string } };
    expect(checkRes.run.runId).toBe('run-ipc-1');

    const loadedNc = (await controller.dispatch(IPC_CHANNELS.GET_NC, trusted, {
      runId: 'run-ipc-1',
    })) as { nc: NcDocument; markdown: string };
    expect(loadedNc.nc.nc_id).toBe('NC-2025.002-v1.30');
    expect(loadedNc.markdown).toContain('# NC-2025.002-v1.30');

    const applyPromise = controller.dispatch(IPC_CHANNELS.APPLY_NC, trusted, {
      runId: 'run-ipc-1',
      byokConfig: BYOK_CONFIG,
      xsdDir: '/tmp/xsds',
    });

    await vi.waitFor(async () => {
      const gate = await controller.dispatch(IPC_CHANNELS.GET_PENDING_GATE, trusted, { runId: 'run-ipc-1' });
      expect((gate as { kind: string } | null)?.kind).toBe('PRE_BUILD_DIFF');
    });
    await controller.dispatch(IPC_CHANNELS.CONFIRM_PRE_BUILD_DIFF, trusted, { runId: 'run-ipc-1', approved: true });

    await vi.waitFor(async () => {
      const gate = await controller.dispatch(IPC_CHANNELS.GET_PENDING_GATE, trusted, { runId: 'run-ipc-1' });
      expect((gate as { kind: string } | null)?.kind).toBe('PR_CONFIRMATION');
    });
    await controller.dispatch(IPC_CHANNELS.OPEN_PR, trusted, { runId: 'run-ipc-1', approved: true });

    const applyOutcome = (await applyPromise) as { prUrl: string; run: { status: string } };
    expect(applyOutcome.run.status).toBe('PR_OPENED');
    expect(applyOutcome.prUrl).toContain('/pulls/10');
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    db.close();
  });

  it('IPC-05: blocks cross-provider secretKeyRef, out-of-bounds paths, concurrent applyNc, and wrong-kind gate confirmations', async () => {
    const dir = createTempDir();
    const db = openDatabase(path.join(dir, 'ntc.db'));
    db.seedDefaultRepos([SAMPLE_REPO]);
    db.upsertNtCatalogEntries([SAMPLE_NT]);

    const secretStore = new SafeStorageSecretStore({
      vaultFilePath: path.join(dir, 'secrets.enc.json'),
      backend: {
        isEncryptionAvailable: () => true,
        encryptString: (v) => Buffer.from(v, 'utf8'),
        decryptString: (b) => b.toString('utf8'),
      },
    });

    const controller = createDesktopIpcController({
      db,
      secretStore,
      dataDir: dir,
      oracleJarPath: '/opt/xsd-oracle.jar',
      allowedSenderOrigins: ['file:///app/'],
      emitProgress: () => undefined,
      orchestrator: {
        generateDraftNc: async () => {
          throw new Error('should not be reached');
        },
        approveAndRunCompliance: async (input) => {
          await input.requestPreBuildApproval({
            runId: input.runId,
            branchName: 'nc/test',
            unifiedDiff: '',
            isStrictlyDeclarative: true,
            nonDeclarativeReasons: [],
            editedFiles: [],
            createdFiles: [],
          });
          throw new Error('aborted');
        },
      },
    });
    const trusted: IpcMainEventLike = { senderFrame: { url: 'file:///app/index.html' } };

    // Cross-provider secretKeyRef binding rejected
    await expect(
      controller.dispatch(IPC_CHANNELS.CHECK_COMPLIANCE, trusted, {
        dfe: 'NFe',
        ntId: SAMPLE_NT.id,
        byokConfig: { ...BYOK_CONFIG, secretKeyRef: GITEA_PAT_SECRET_KEY },
      }),
    ).rejects.toThrow(/secretKeyRef/i);

    // Out-of-bounds XSD dir / UNC path rejected
    await expect(
      controller.dispatch(IPC_CHANNELS.APPLY_NC, trusted, {
        runId: 'run-locked',
        byokConfig: BYOK_CONFIG,
        xsdDir: '/etc',
      }),
    ).rejects.toThrow(/permitidos/i);

    await expect(
      controller.dispatch(IPC_CHANNELS.IMPORT_MANUAL_NT, trusted, {
        dfe: 'NFe',
        ntNumber: '2025.002',
        ntVersion: '1.30',
        publishedDate: '2025-10-15',
        pdfSourcePath: '\\\\evil-server\\share\\nt.pdf',
        xsdSourcePath: '/tmp/xsd',
      }),
    ).rejects.toThrow(/UNC/i);

    // Prepare a real allowed xsd dir and test concurrent APPLY_NC + wrong gate confirmation + dispose
    const allowedXsd = path.join(dir, 'cache', 'svrs', 'NFe', 'manual', 'xsd');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(allowedXsd, { recursive: true });

    const firstApply = controller.dispatch(IPC_CHANNELS.APPLY_NC, trusted, {
      runId: 'run-concurrent',
      byokConfig: BYOK_CONFIG,
      xsdDir: allowedXsd,
    });

    await vi.waitFor(async () => {
      const gate = await controller.dispatch(IPC_CHANNELS.GET_PENDING_GATE, trusted, { runId: 'run-concurrent' });
      expect((gate as { kind: string; gateToken?: string } | null)?.kind).toBe('PRE_BUILD_DIFF');
    });

    // Wrong gate kind & mismatched gateToken must return acknowledged: false
    expect(
      await controller.dispatch(IPC_CHANNELS.OPEN_PR, trusted, { runId: 'run-concurrent', approved: true }),
    ).toEqual({ acknowledged: false });
    expect(
      await controller.dispatch(IPC_CHANNELS.CONFIRM_PRE_BUILD_DIFF, trusted, {
        runId: 'run-concurrent',
        approved: true,
        gateToken: 'wrong-token',
      }),
    ).toEqual({ acknowledged: false });

    // Second overlapping APPLY_NC on same runId fails
    await expect(
      controller.dispatch(IPC_CHANNELS.APPLY_NC, trusted, {
        runId: 'run-concurrent',
        byokConfig: BYOK_CONFIG,
        xsdDir: allowedXsd,
      }),
    ).rejects.toThrow(/em andamento/i);

    controller.dispose();
    await expect(firstApply).rejects.toThrow(/encerrada/i);
    db.close();
  });

function buildMinimalValidPdf(text: string): Buffer {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (str: string): void => {
    const b = Buffer.from(str, 'latin1');
    chunks.push(b);
    pos += b.length;
  };
  const addObj = (id: number, body: string): void => {
    offsets[id] = pos;
    push(`${id} 0 obj\n${body}\nendobj\n`);
  };
  push('%PDF-1.4\n');
  addObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  addObj(2, '<< /Type /Pages /Kids [4 0 R] /Count 1 >>');
  addObj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const stream = `BT /F1 11 Tf 40 760 Td (${text}) Tj ET`;
  addObj(4, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>');
  addObj(5, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  const xrefPos = pos;
  push('xref\n0 6\n0000000000 65535 f \n');
  for (let id = 1; id < 6; id += 1) {
    push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

  it('IPC-06: offline IMPORT_MANUAL_NT + CHECK_COMPLIANCE resolves cached manual artifacts automatically', async () => {
    const dir = createTempDir();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const db = openDatabase(path.join(dir, 'ntc.db'));
    db.seedDefaultRepos([SAMPLE_REPO]);

    const pdfSrc = path.join(dir, 'source.pdf');
    const xsdSrcDir = path.join(dir, 'source-xsd');
    mkdirSync(xsdSrcDir, { recursive: true });
    writeFileSync(pdfSrc, buildMinimalValidPdf('NT 2025.002 ICMSTot vNF'));
    writeFileSync(path.join(xsdSrcDir, 'nfe.xsd'), '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"/>', 'utf8');

    const secretStore = new SafeStorageSecretStore({
      vaultFilePath: path.join(dir, 'secrets.enc.json'),
      backend: {
        isEncryptionAvailable: () => true,
        encryptString: (v) => Buffer.from(v, 'utf8'),
        decryptString: (b) => b.toString('utf8'),
      },
    });

    const generateSpy = vi.fn(async (input: { runId: string; resolvedArtifacts?: { xsdDir: string; pdfPath: string } }) => {
      db.createComplianceRun({
        runId: input.runId,
        dfe: 'NFe',
        ntId: SAMPLE_NT.id,
        operatorName: 'Op',
        provider: 'gemini',
        modelId: 'gemini-2.5-pro',
        baseCommitSha: '1'.repeat(40),
        ncJsonPath: 'NFe/NC-2025.002-v1.30.json',
      });
      return {
        run: db.getComplianceRun(input.runId)!,
        savedNc: { nc: SAMPLE_NC },
        xsdDir: input.resolvedArtifacts?.xsdDir ?? '',
      };
    });

    const controller = createDesktopIpcController({
      db,
      secretStore,
      dataDir: dir,
      oracleJarPath: '/opt/xsd-oracle.jar',
      allowedSenderOrigins: ['file:///app/'],
      emitProgress: () => undefined,
      orchestrator: {
        generateDraftNc: generateSpy as unknown as Parameters<typeof createDesktopIpcController>[0]['orchestrator'] extends infer O
          ? O extends { generateDraftNc: infer G }
            ? G
            : never
          : never,
        approveAndRunCompliance: async () => {
          throw new Error('unused');
        },
      },
    });
    const trusted: IpcMainEventLike = { senderFrame: { url: 'file:///app/index.html' } };

    const imported = (await controller.dispatch(IPC_CHANNELS.IMPORT_MANUAL_NT, trusted, {
      dfe: 'NFe',
      ntNumber: '2025.002',
      ntVersion: '1.30',
      publishedDate: '2025-10-15',
      pdfSourcePath: pdfSrc,
      xsdSourcePath: xsdSrcDir,
    })) as { entry: NtCatalogEntry; xsdDir: string };

    // Stored cleanly under <dataDir>/cache/svrs/<dfe>/manual (no svrs/svrs duplication)
    expect(imported.xsdDir).toContain(path.join(dir, 'cache', 'svrs', 'NFe', 'manual', '2025.002_1.30', 'xsd'));
    expect(imported.xsdDir).not.toContain(path.join('svrs', 'svrs'));

    // CHECK_COMPLIANCE without explicit pdfPath/xsdDir resolves manual offline artifacts automatically
    await controller.dispatch(IPC_CHANNELS.CHECK_COMPLIANCE, trusted, {
      runId: 'run-manual-auto',
      dfe: 'NFe',
      ntId: imported.entry.id,
      byokConfig: BYOK_CONFIG,
    });
    expect(generateSpy).toHaveBeenCalledTimes(1);
    const callArg = generateSpy.mock.calls[0]?.[0];
    expect(callArg?.resolvedArtifacts?.xsdDir).toBe(imported.xsdDir);
    db.close();
  });

  it('IPC-07: persists BYOK config and completes Copilot OAuth device flow storing secret without leaking token over IPC', async () => {
    const dir = createTempDir();
    const db = openDatabase(path.join(dir, 'ntc.sqlite'));
    const secretStore = new SafeStorageSecretStore({
      vaultFilePath: path.join(dir, 'secrets.enc.json'),
      backend: {
        isEncryptionAvailable: () => true,
        encryptString: (v) => Buffer.from(v, 'utf8'),
        decryptString: (b) => b.toString('utf8'),
      },
    });

    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/login/device/code')) {
        return new Response(
          JSON.stringify({
            device_code: 'dev-secret-999',
            user_code: 'WXYZ-5678',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ access_token: 'ghu_never_return_over_ipc' }), { status: 200 });
    });

    const controller = createDesktopIpcController({
      db,
      secretStore,
      dataDir: dir,
      oracleJarPath: '/opt/xsd-oracle.jar',
      allowedSenderOrigins: ['file:///app/'],
      fetchFn,
      emitProgress: () => undefined,
      orchestrator: {
        generateDraftNc: async () => {
          throw new Error('unused');
        },
        approveAndRunCompliance: async () => {
          throw new Error('unused');
        },
      },
    });
    const trusted: IpcMainEventLike = { senderFrame: { url: 'file:///app/index.html' } };

    expect(await controller.dispatch(IPC_CHANNELS.GET_BYOK_CONFIG, trusted, undefined)).toBeNull();
    const saved = await controller.dispatch(IPC_CHANNELS.SAVE_BYOK_CONFIG, trusted, {
      provider: 'github-copilot',
      modelId: 'gpt-4o',
      operatorName: 'Willy',
      secretKeyRef: 'ntc:llm:github-copilot',
      authMode: 'copilot-oauth-device',
    });
    expect(saved).toMatchObject({ provider: 'github-copilot', authMode: 'copilot-oauth-device' });
    expect(await controller.dispatch(IPC_CHANNELS.GET_BYOK_CONFIG, trusted, undefined)).toEqual(saved);

    const start = (await controller.dispatch(IPC_CHANNELS.START_COPILOT_AUTH, trusted, undefined)) as {
      deviceCode: string;
      userCode: string;
      verificationUri: string;
    };
    expect(start.userCode).toBe('WXYZ-5678');

    const poll = (await controller.dispatch(IPC_CHANNELS.POLL_COPILOT_AUTH, trusted, {
      deviceCode: start.deviceCode,
    })) as Record<string, unknown>;
    expect(poll).toEqual({ status: 'authorized' });
    expect(JSON.stringify(poll)).not.toContain('ghu_never_return_over_ipc');
    expect(await secretStore.getSecret('ntc:llm:github-copilot')).toBe('ghu_never_return_over_ipc');

    db.close();
  });

  it('IPC-08: allows empty xsdDir from CHECK_COMPLIANCE and N/A xsdDir in APPLY_NC only when NC has no_structural_gaps', async () => {
    const dir = createTempDir();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const db = openDatabase(path.join(dir, 'ntc.sqlite'));
    db.seedDefaultRepos([SAMPLE_REPO]);
    db.upsertNtCatalogEntries([SAMPLE_NT]);

    const secretStore = new SafeStorageSecretStore({
      vaultFilePath: path.join(dir, 'secrets.enc.json'),
      backend: {
        isEncryptionAvailable: () => true,
        encryptString: (v) => Buffer.from(v, 'utf8'),
        decryptString: (b) => b.toString('utf8'),
      },
    });

    const nfeNcDir = path.join(dir, 'ncs', 'NFe');
    mkdirSync(nfeNcDir, { recursive: true });
    writeFileSync(
      path.join(nfeNcDir, 'NC-no-gaps.json'),
      JSON.stringify({ ...SAMPLE_NC, no_structural_gaps: true, confirmed_no_gaps: true, items: [] }),
      'utf8',
    );
    writeFileSync(
      path.join(nfeNcDir, 'NC-has-gaps.json'),
      JSON.stringify({ ...SAMPLE_NC, no_structural_gaps: false }),
      'utf8',
    );

    const controller = createDesktopIpcController({
      db,
      secretStore,
      dataDir: dir,
      oracleJarPath: '/opt/xsd-oracle.jar',
      allowedSenderOrigins: ['file:///app/'],
      emitProgress: () => undefined,
      orchestrator: {
        generateDraftNc: async ({ runId }) => {
          const run = db.createComplianceRun({
            runId,
            dfe: 'NFe',
            ntId: SAMPLE_NT.id,
            operatorName: 'Op',
            provider: 'gemini',
            modelId: 'gemini-3.1-pro-preview',
            baseCommitSha: '1'.repeat(40),
            ncJsonPath: 'NFe/NC-no-gaps.json',
          });
          return {
            run,
            savedNc: { nc: { ...SAMPLE_NC, no_structural_gaps: true, confirmed_no_gaps: true, items: [] } },
            xsdDir: '',
          };
        },
        approveAndRunCompliance: async ({ runId }) => ({
          run: db.getComplianceRun(runId)!,
          patchFilePath: null,
          prUrl: null,
          mavenResult: null,
        }),
      },
    });
    const trusted: IpcMainEventLike = { senderFrame: { url: 'file:///app/index.html' } };

    const checkRes = (await controller.dispatch(IPC_CHANNELS.CHECK_COMPLIANCE, trusted, {
      runId: 'run-no-xsd-ipc',
      dfe: 'NFe',
      ntId: SAMPLE_NT.id,
      byokConfig: BYOK_CONFIG,
    })) as { xsdDir: string };
    expect(checkRes.xsdDir).toBe('');

    const applyOk = await controller.dispatch(IPC_CHANNELS.APPLY_NC, trusted, {
      runId: 'run-no-xsd-ipc',
      byokConfig: BYOK_CONFIG,
      xsdDir: 'N/A',
    });
    expect(applyOk).toMatchObject({ patchFilePath: null, prUrl: null });

    db.createComplianceRun({
      runId: 'run-gaps-na',
      dfe: 'NFe',
      ntId: SAMPLE_NT.id,
      operatorName: 'Op',
      provider: 'gemini',
      modelId: 'gemini-3.1-pro-preview',
      baseCommitSha: '1'.repeat(40),
      ncJsonPath: 'NFe/NC-has-gaps.json',
    });
    await expect(
      controller.dispatch(IPC_CHANNELS.APPLY_NC, trusted, {
        runId: 'run-gaps-na',
        byokConfig: BYOK_CONFIG,
        xsdDir: 'N/A',
      }),
    ).rejects.toThrow(/permitidos/i);

    db.close();
  });

  it('IPC-09: lists Copilot subscription models and runs live Copilot & Gitea connection tests securely', async () => {
    const dir = createTempDir();
    const db = openDatabase(path.join(dir, 'ntc.sqlite'));
    db.seedDefaultRepos([SAMPLE_REPO]);

    const secretStore = new SafeStorageSecretStore({
      vaultFilePath: path.join(dir, 'secrets.enc.json'),
      backend: {
        isEncryptionAvailable: () => true,
        encryptString: (v) => Buffer.from(v, 'utf8'),
        decryptString: (b) => b.toString('utf8'),
      },
    });
    await secretStore.setSecret('ntc:llm:github-copilot', 'ghu_ipc_copilot_secret');
    await secretStore.setSecret('ntc:gitea:pat', 'gitea_ipc_pat_secret');

    const controller = createDesktopIpcController({
      db,
      secretStore,
      dataDir: dir,
      oracleJarPath: '/opt/xsd-oracle.jar',
      allowedSenderOrigins: ['file:///app/'],
      emitProgress: () => undefined,
      fetchFn: async (url) => {
        const target = String(url);
        if (target === 'https://api.github.com/copilot_internal/v2/token') {
          return new Response(
            JSON.stringify({
              token: 'tid=ipc_session_token',
              expires_at: Math.floor(Date.now() / 1000) + 1800,
              endpoints: { api: 'https://api.githubcopilot.com' },
            }),
            { status: 200 },
          );
        }
        if (target === 'https://api.githubcopilot.com/models') {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'gpt-4.1', name: 'GPT-4.1', vendor: 'OpenAI', capabilities: { type: 'chat' } },
                { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', vendor: 'Anthropic', capabilities: { type: 'chat' } },
              ],
            }),
            { status: 200 },
          );
        }
        if (target === 'https://api.githubcopilot.com/chat/completions') {
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"ok":true}' } }],
              usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
            }),
            { status: 200 },
          );
        }
        if (target.endsWith('/api/v1/user')) {
          return new Response(JSON.stringify({ login: 'operador.sef' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ permissions: { pull: true, push: true } }),
          { status: 200 },
        );
      },
    });

    const trusted: IpcMainEventLike = { senderFrame: { url: 'file:///app/index.html' } };
    const untrusted: IpcMainEventLike = { senderFrame: { url: 'https://evil.example/app' } };

    await expect(
      controller.dispatch(IPC_CHANNELS.LIST_COPILOT_MODELS, untrusted, undefined),
    ).rejects.toThrow(/não autorizada|bloqueada/i);

    const modelsRes = (await controller.dispatch(
      IPC_CHANNELS.LIST_COPILOT_MODELS,
      trusted,
      undefined,
    )) as { source: string; models: Array<{ id: string }> };
    expect(modelsRes.source).toBe('subscription');
    expect(modelsRes.models.map((m) => m.id)).toEqual(['gpt-4.1', 'claude-sonnet-4']);

    const copilotTest = (await controller.dispatch(IPC_CHANNELS.TEST_COPILOT, trusted, {
      byokConfig: {
        provider: 'github-copilot',
        modelId: 'claude-sonnet-4',
        operatorName: 'Willy',
        secretKeyRef: 'ntc:llm:github-copilot',
        authMode: 'copilot-oauth-device',
      },
    })) as { ok: boolean; target: string; summary: string };
    expect(copilotTest.ok).toBe(true);
    expect(copilotTest.target).toBe('github-copilot');
    expect(JSON.stringify(copilotTest)).not.toContain('ghu_ipc_copilot_secret');

    const giteaTest = (await controller.dispatch(IPC_CHANNELS.TEST_GITEA, trusted, {
      giteaUrl: 'https://gitea.apps.ticio.fazenda.mg.gov.br',
      testGitRemote: false,
    })) as { ok: boolean; target: string; summary: string };
    expect(giteaTest.ok).toBe(true);
    expect(giteaTest.target).toBe('gitea');
    expect(JSON.stringify(giteaTest)).not.toContain('gitea_ipc_pat_secret');

    await expect(
      controller.dispatch(IPC_CHANNELS.TEST_GITEA, trusted, {
        giteaUrl: 'http://insecure.local/repo',
      }),
    ).rejects.toThrow();

    db.close();
  });
});
