import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ByokLlmGateway,
  ComplianceOrchestrator,
  GiteaAdapter,
  GiteaForgeBridge,
  HostMavenRunner,
  IPC_CHANNELS,
  WorktreeManager,
  XsdOracleBridge,
  computeXsdAstDiff,
  extractJavaFieldTypeHints,
  openDatabase,
  type ByokConfig,
  type DfeRepoEntry,
  type ExtractedNtPdf,
  type LlmProviderAdapter,
  type NcDocument,
  type NtCatalogEntry,
  type PatchPayload,
} from '@ntc/core';
import { createDesktopIpcController, type IpcMainEventLike } from '../src/ipc-handlers.js';
import { SafeStorageSecretStore } from '../src/secret-store.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.resolve(THIS_DIR, '../../..');
const ORACLE_JAR = path.join(MONOREPO_ROOT, 'tools', 'xsd-oracle', 'target', 'xsd-oracle.jar');
const XSD_SAMPLE_DIR = path.join(MONOREPO_ROOT, 'tools', 'xsd-oracle', 'src', 'test', 'resources', 'xsd-sample');
const NFE_PARSER_READONLY_DIR = path.join(MONOREPO_ROOT, 'nfe-parser');

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
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

describe('Phase 4 E2E Integration Verification', () => {
  it('E2E-01 (Verification Plan #1): real xsd-oracle.jar + computeXsdAstDiff against read-only nfe-parser & nfe_sample.xsd', async () => {
    const oracle = new XsdOracleBridge({ jarPath: ORACLE_JAR });
    const registryEntry = {
      dfe: 'NFe' as const,
      basePackage: 'br.gov.mg.fazenda.nfeparser',
      domainPackage: 'br.gov.mg.fazenda.nfeparser.nfe',
      mapperPackage: 'br.gov.mg.fazenda.nfeparser.mapper',
      tablePackage: 'br.gov.mg.fazenda.nfeparser.table',
      parserPackage: 'br.gov.mg.fazenda.nfeparser.parser',
      utilPackage: 'br.gov.mg.fazenda.nfeparser.util',
      tagPrefix: 'NFEPROC',
    };

    const [xsd, ast, fieldTypes] = await Promise.all([
      oracle.extractXsd(XSD_SAMPLE_DIR),
      oracle.extractJavaAst(NFE_PARSER_READONLY_DIR, registryEntry),
      extractJavaFieldTypeHints(NFE_PARSER_READONLY_DIR, registryEntry.domainPackage),
    ]);

    expect(xsd.nodes.length).toBeGreaterThan(10);
    expect(ast.setterKeys.length).toBeGreaterThan(100);
    expect(fieldTypes.byClassField.size).toBeGreaterThan(50);

    const findings = computeXsdAstDiff({ xsd, ast, registryEntry, fieldTypes });
    expect(findings.some((f) => f.tagPath === 'NFEPROC.NFE.INFNFE.DET.PROD.NVE' && f.kind === 'MISSING_TAG')).toBe(false);
    expect(findings.some((f) => f.tagPath === 'NFEPROC.NFE.INFNFE.DET.IMPOSTO.PIS.PISALIQ.VPIS' && f.kind === 'MISSING_TAG')).toBe(false);
    expect(execFileSync('git', ['-C', NFE_PARSER_READONLY_DIR, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
  }, 30_000);

  it('E2E-02 (Verification Plan #2): full Desktop IPC -> NC -> bare Git worktree -> synthetic XML + mvn test -> push PR with zero test-files leak', async () => {
    const root = createTempDir('ntc-e2e-full-');
    const bareOrigin = path.join(root, 'origin.git');
    const seedDir = path.join(root, 'seed');
    const dataDir = path.join(root, 'data');

    execFileSync('git', ['init', '--bare', '--initial-branch=main', bareOrigin]);
    execFileSync('git', ['clone', bareOrigin, seedDir]);
    execFileSync('git', ['config', 'user.name', 'SEF Test'], { cwd: seedDir });
    execFileSync('git', ['config', 'user.email', 'test@fazenda.mg.gov.br'], { cwd: seedDir });

    mkdirSync(path.join(seedDir, 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe'), { recursive: true });
    mkdirSync(path.join(seedDir, 'src/main/java/br/gov/mg/fazenda/nfeparser/mapper'), { recursive: true });
    mkdirSync(path.join(seedDir, 'src/main/java/br/gov/mg/fazenda/nfeparser/table'), { recursive: true });
    mkdirSync(path.join(seedDir, 'src/main/java/br/gov/mg/fazenda/nfeparser/parser'), { recursive: true });
    mkdirSync(path.join(seedDir, 'src/test/resources/test-files'), { recursive: true });

    writeFileSync(
      path.join(seedDir, 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java'),
      'package br.gov.mg.fazenda.nfeparser.nfe;\n\npublic class Nfe {\n  private java.math.BigDecimal vProd;\n}\n',
      'utf8',
    );
    writeFileSync(
      path.join(seedDir, 'src/main/java/br/gov/mg/fazenda/nfeparser/mapper/NfeMapper.java'),
      'package br.gov.mg.fazenda.nfeparser.mapper;\nimport java.util.*;\npublic class NfeMapper { static final Map<String, String> NFE_FIELD_SETTERS = new HashMap<>(); }\n',
      'utf8',
    );
    // Real decoy taxpayer file inside test-files/** that MUST NEVER reach external LLM prompts
    writeFileSync(
      path.join(seedDir, 'src/test/resources/test-files/nota_real_44dig.xml'),
      '<nfeProc><NFe><infNFe Id="NFe31251011222333000144550010000001231000001234"><emit><CNPJ>11222333000144</CNPJ><xNome>DECOY_TAXPAYER_SECRET</xNome></emit></infNFe></NFe></nfeProc>',
      'utf8',
    );
    execFileSync('git', ['add', '.'], { cwd: seedDir });
    execFileSync('git', ['commit', '-m', 'Initial parser'], { cwd: seedDir });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: seedDir });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: seedDir, encoding: 'utf8' }).trim();

    const db = openDatabase(path.join(dataDir, 'ntc.sqlite'));
    const repo: DfeRepoEntry = {
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
    db.saveDfeRepo(repo);

    const ntEntry: NtCatalogEntry = {
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
      sourceStatus: 'MANUAL',
      fetchedAt: '2026-11-19T12:00:00.000Z',
    };
    db.upsertNtCatalogEntries([ntEntry]);

    const secretStore = new SafeStorageSecretStore({
      vaultFilePath: path.join(dataDir, 'secrets.enc.json'),
      backend: {
        isEncryptionAvailable: () => true,
        encryptString: (v) => Buffer.from(`ENC:${v}`, 'utf8'),
        decryptString: (b) => b.toString('utf8').replace(/^ENC:/, ''),
      },
    });
    await secretStore.setSecret('ntc:llm:gemini', 'AIza-mock-secret');
    await secretStore.setSecret('ntc:gitea:pat', 'pat-mock-secret');

    const capturedLlmPrompts: string[] = [];
    let llmCall = 0;
    const validXmlContent = readFileSync(path.join(XSD_SAMPLE_DIR, 'valid_nfe.xml'), 'utf8');

    const mockAdapter: LlmProviderAdapter = {
      provider: 'gemini',
      async completeStructured(request) {
        capturedLlmPrompts.push(`${request.systemPrompt}\n${request.userPrompt}`);
        llmCall += 1;
        if (llmCall === 1) {
          const nc: NcDocument = {
            nc_id: 'NC-2025.002-v1.30',
            nt_ref: {
              dfe: 'NFe',
              nt_number: '2025.002',
              nt_version: '1.30',
              published_date: '2025-10-15',
              pdf_sha256: 'a'.repeat(64),
            },
            base_commit_sha: baseSha,
            no_structural_gaps: false,
            items: [
              {
                id: 'NC-1',
                category: 'STRUCTURAL_DTO',
                decision: 'APPROVE',
                title: 'Adicionar vNF em Nfe.java',
                description: 'Campo BigDecimal vNF',
                tagPath: 'NFEPROC.NFE.INFNFE.TOTAL.ICMSTOT.VNF',
                targetPackage: 'domain',
                targetClass: 'Nfe',
                diffKind: 'MISSING_TAG',
                pdfCitations: ['p. 1'],
                suggestedChange: 'private java.math.BigDecimal vNF;',
                editedNotes: null,
                blockerReason: null,
              },
            ],
            created_at: '2026-11-19T12:00:00.000Z',
            updated_at: '2026-11-19T12:00:00.000Z',
          };
          return {
            rawText: JSON.stringify(nc),
            usage: { promptTokens: 120, completionTokens: 60, totalTokens: 180, stage: 'compliance-analysis' },
          };
        }

        const patch: PatchPayload = {
          summary: 'Adds vNF field + XSD-valid synthetic XML + JUnit test',
          edits: [
            {
              filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java',
              searchBlock: '  private java.math.BigDecimal vProd;',
              replaceBlock: '  private java.math.BigDecimal vProd;\n  private java.math.BigDecimal vNF;',
            },
          ],
          creates: [
            {
              filePath: 'src/test/resources/synthetic/nt2025_002_valid.xml',
              content: validXmlContent,
            },
            {
              filePath: 'src/test/java/br/gov/mg/fazenda/nfeparser/Nt2025002Test.java',
              content: 'package br.gov.mg.fazenda.nfeparser;\npublic class Nt2025002Test {}\n',
            },
          ],
        };
        return {
          rawText: JSON.stringify(patch),
          usage: { promptTokens: 90, completionTokens: 45, totalTokens: 135, stage: 'patch-generation' },
        };
      },
    };

    const wtMgr = new WorktreeManager({ allowLocalFileRemotes: true, secretStore });
    const maven = new HostMavenRunner({
      execFileFn: async () => ({
        stdout: '[INFO] Tests run: 1, Failures: 0\n[INFO] BUILD SUCCESS',
        stderr: '',
      }),
    });
    const gitea = new GiteaAdapter({
      secretStore,
      fetchFn: async () =>
        new Response(
          JSON.stringify({ html_url: 'https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfe-parser/pulls/101' }),
          { status: 201 },
        ),
    });

    // Point git bare clone/push operations to local bareOrigin while keeping HTTPS URL in SQLite & Gitea REST
    const realForge = new GiteaForgeBridge({ worktrees: wtMgr, maven, gitea });
    const e2eForge = {
      ensureBareMirror: (r: DfeRepoEntry, dir: string) => realForge.ensureBareMirror({ ...r, giteaUrl: `file://${bareOrigin}` }, dir),
      getRemoteBranchHead: (r: DfeRepoEntry, b: string) => realForge.getRemoteBranchHead({ ...r, giteaUrl: `file://${bareOrigin}` }, b),
      createInspectionWorktree: (b: string, s: string, w: string) => realForge.createInspectionWorktree(b, s, w),
      createWorktree: (b: string, br: string, s: string, w: string) => realForge.createWorktree(b, br, s, w),
      resetWorktreeClean: (w: string) => realForge.resetWorktreeClean(w),
      removeWorktree: (b: string, w: string) => realForge.removeWorktree(b, w),
      getWorktreeDiff: (w: string) => realForge.getWorktreeDiff(w),
      exportDiffPatch: (w: string, o: string) => realForge.exportDiffPatch(w, o),
      runMavenTest: (w: string, c: readonly string[]) => realForge.runMavenTest(w, c),
      commitPushAndOpenPr: async (inp: Parameters<GiteaForgeBridge['commitPushAndOpenPr']>[0]) => {
        await wtMgr.commitAndPushBranch({
          repo: { ...inp.repo, giteaUrl: `file://${bareOrigin}` },
          worktreeDir: inp.worktreeDir,
          branchName: inp.branchName,
          commitMessage: inp.commitMessage,
        });
        return gitea.openPullRequest({
          repo: inp.repo,
          headBranch: inp.branchName,
          title: inp.prTitle,
          body: inp.prBodyMarkdown,
        });
      },
    };

    const orchestrator = new ComplianceOrchestrator({
      db,
      oracle: new XsdOracleBridge({ jarPath: ORACLE_JAR }),
      llmGateway: new ByokLlmGateway({ secretStore, adapters: [mockAdapter] }),
      gitForge: e2eForge,
      ncWorkspaceDir: path.join(dataDir, 'ncs'),
      cacheRootDir: path.join(dataDir, 'cache', 'svrs'),
      mirrorsRootDir: path.join(dataDir, 'repos'),
      worktreesRootDir: path.join(dataDir, 'worktrees'),
      patchesDir: path.join(dataDir, 'artifacts'),
    });

    const controller = createDesktopIpcController({
      db,
      secretStore,
      dataDir,
      oracleJarPath: ORACLE_JAR,
      allowedSenderOrigins: ['file:///app/'],
      allowedXsdRoots: [XSD_SAMPLE_DIR, path.join(dataDir, 'cache', 'svrs')],
      emitProgress: () => undefined,
      orchestrator,
    });

    const trusted: IpcMainEventLike = { senderFrame: { url: 'file:///app/index.html' } };
    const byokConfig: ByokConfig = {
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      operatorName: 'Operador E2E',
      secretKeyRef: 'ntc:llm:gemini',
    };

    const pdfPath = path.join(root, 'nt.pdf');
    writeFileSync(pdfPath, '%PDF-1.4\n%%EOF', 'utf8');
    const resolvedPdf: ExtractedNtPdf = {
      pdfSha256: 'a'.repeat(64),
      totalPages: 1,
      segments: [
        {
          id: 's1',
          title: 'ICMSTot',
          xmlGroupHint: 'ICMSTot',
          pageStart: 1,
          pageEnd: 1,
          citedText: '[p. 1] Validar vNF no grupo ICMSTot.',
          estimatedTokens: 12,
        },
      ],
      warnings: [],
      cached: false,
    };

    // Orchestrator generateDraftNc followed by Desktop IPC review -> apply -> diff confirm -> open PR
    const draft = await orchestrator.generateDraftNc({
      runId: 'e2e-run-1',
      dfe: 'NFe',
      ntId: ntEntry.id,
      byokConfig,
      resolvedArtifacts: { pdf: resolvedPdf, pdfPath, xsdDir: XSD_SAMPLE_DIR },
    });
    expect(draft.run.status).toBe('DRAFT');

    const ncView = (await controller.dispatch(IPC_CHANNELS.GET_NC, trusted, {
      runId: 'e2e-run-1',
    })) as { nc: NcDocument };
    await controller.dispatch(IPC_CHANNELS.SAVE_NC, trusted, {
      runId: 'e2e-run-1',
      nc: ncView.nc,
    });

    const applyPromise = controller.dispatch(IPC_CHANNELS.APPLY_NC, trusted, {
      runId: 'e2e-run-1',
      byokConfig,
      xsdDir: XSD_SAMPLE_DIR,
    });
    let applyFailure: unknown = null;
    void applyPromise.catch((err) => {
      applyFailure = err;
    });

    await vi.waitFor(
      async () => {
        if (applyFailure) {
          throw applyFailure;
        }
        const gate = await controller.dispatch(IPC_CHANNELS.GET_PENDING_GATE, trusted, { runId: 'e2e-run-1' });
        expect((gate as { kind: string } | null)?.kind).toBe('PRE_BUILD_DIFF');
      },
      { timeout: 10_000 },
    );
    await controller.dispatch(IPC_CHANNELS.CONFIRM_PRE_BUILD_DIFF, trusted, { runId: 'e2e-run-1', approved: true });

    await vi.waitFor(
      async () => {
        if (applyFailure) {
          throw applyFailure;
        }
        const gate = await controller.dispatch(IPC_CHANNELS.GET_PENDING_GATE, trusted, { runId: 'e2e-run-1' });
        expect((gate as { kind: string } | null)?.kind).toBe('PR_CONFIRMATION');
      },
      { timeout: 10_000 },
    );
    await controller.dispatch(IPC_CHANNELS.OPEN_PR, trusted, { runId: 'e2e-run-1', approved: true });

    const outcome = (await applyPromise) as { prUrl: string; patchFilePath: string; run: { status: string } };
    expect(outcome.run.status).toBe('PR_OPENED');
    expect(outcome.prUrl).toContain('/pulls/101');
    expect(existsSync(outcome.patchFilePath)).toBe(true);

    // Critical DLP Guarantee: decoy test-files XML & taxpayer CNPJ/chave NEVER appeared in any LLM prompt
    expect(capturedLlmPrompts.length).toBeGreaterThanOrEqual(2);
    for (const prompt of capturedLlmPrompts) {
      expect(prompt).not.toContain('DECOY_TAXPAYER_SECRET');
      expect(prompt).not.toContain('31251011222333000144550010000001231000001234');
      expect(prompt).not.toContain('test-files');
    }

    // Verify pushed branch exists on bare Gitea remote, lock is released, and secret status never exposes plaintext
    const remoteBranches = execFileSync('git', ['--git-dir', bareOrigin, 'branch', '--list'], { encoding: 'utf8' });
    expect(remoteBranches).toContain('nc/nfe-nt-2025.002-v1.30');
    expect(db.getRepoLock('NFe')).toBeNull();
    const patStatus = await controller.dispatch(IPC_CHANNELS.GET_SECRET_STATUS, trusted, { key: 'ntc:gitea:pat' });
    expect(patStatus).toEqual({ configured: true });
    db.close();
  }, 45_000);
});
