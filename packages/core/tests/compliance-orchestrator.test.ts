import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ByokConfig,
  DfeRepoEntry,
  ExtractedNtPdf,
  NcDocument,
  NtCatalogEntry,
  PatchPayload,
  RunProgressEvent,
} from '../src/domain/types.js';
import type {
  GitMavenForgePort,
  LlmGatewayPort,
  MavenTestRunResult,
  OracleAnalyzerPort,
} from '../src/ports/interfaces.js';
import { openDatabase, type NtcDatabase } from '../src/storage/sqlite.js';
import { WorktreeManager } from '../src/git/worktree-manager.js';
import { analyzeDeclarativeDiff, ComplianceOrchestrator } from '../src/orchestrator/compliance-orchestrator.js';

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

const BYOK_CONFIG: ByokConfig = {
  provider: 'gemini',
  modelId: 'gemini-2.5-pro',
  operatorName: 'Willy',
  secretKeyRef: 'ntc:llm:gemini',
};

const NT_ENTRY: NtCatalogEntry = {
  id: 'NFe:2025.002:1.30',
  dfe: 'NFe',
  ntNumber: '2025.002',
  ntVersion: '1.30',
  publishedDate: '2025-10-15',
  homologDate: null,
  prodDate: null,
  pdfUrl: 'https://dfe-portal.svrs.rs.gov.br/Nfe/Documentos/NT2025.pdf',
  xsdUrl: 'https://dfe-portal.svrs.rs.gov.br/Nfe/Documentos/PL_010b.zip',
  pdfSha256: 'a'.repeat(64),
  sourceStatus: 'DOWNLOADED',
  fetchedAt: '2026-11-19T12:00:00.000Z',
};

const EXTRACTED_PDF: ExtractedNtPdf = {
  pdfSha256: 'a'.repeat(64),
  totalPages: 1,
  segments: [
    {
      id: 'seg-1',
      title: 'ICMSTot',
      xmlGroupHint: 'ICMSTot',
      pageStart: 1,
      pageEnd: 1,
      citedText: '[p. 1] Incluir tag vIBSCBS em ICMSTot.',
      estimatedTokens: 15,
    },
  ],
  warnings: [],
  cached: false,
};

function setupRealBareRepoAndDb(): {
  db: NtcDatabase;
  repo: DfeRepoEntry;
  localRemoteRepo: DfeRepoEntry;
  commitSha: string;
  root: string;
  xsdDir: string;
  pdfPath: string;
} {
  const root = createTempDir('ntc-orch-');
  const bareDir = path.join(root, 'origin.git');
  const seedDir = path.join(root, 'seed');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bareDir]);
  execFileSync('git', ['clone', bareDir, seedDir]);
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seedDir });
  execFileSync('git', ['config', 'user.email', 'test@fazenda.mg.gov.br'], { cwd: seedDir });

  const nfeJavaDir = path.join(seedDir, 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe');
  mkdirSync(nfeJavaDir, { recursive: true });
  writeFileSync(
    path.join(nfeJavaDir, 'Nfe.java'),
    'package br.gov.mg.fazenda.nfeparser.nfe;\n\npublic class Nfe {\n  private java.math.BigDecimal vProd;\n}\n',
    'utf8',
  );
  execFileSync('git', ['add', '.'], { cwd: seedDir });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: seedDir });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: seedDir });
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: seedDir, encoding: 'utf8' }).trim();

  const xsdDir = path.join(root, 'xsds');
  mkdirSync(xsdDir, { recursive: true });
  writeFileSync(path.join(xsdDir, 'nfe.xsd'), '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"/>', 'utf8');
  const pdfPath = path.join(root, 'nt.pdf');
  writeFileSync(pdfPath, '%PDF-1.4\n%%EOF', 'utf8');

  const db = openDatabase(path.join(root, 'ntc.db'));
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
  db.upsertNtCatalogEntries([NT_ENTRY]);

  return {
    db,
    repo,
    localRemoteRepo: { ...repo, giteaUrl: `file://${bareDir}` },
    commitSha,
    root,
    xsdDir,
    pdfPath,
  };
}

function makeOracleMock(): OracleAnalyzerPort {
  return {
    async extractXsd() {
      return {
        rootElements: ['NFEPROC'],
        nodes: [
          {
            tagPath: 'NFEPROC.NFE.INFNFE.TOTAL.ICMSTOT.VIBSCBS',
            xsdType: 'TDec_1302',
            minOccurs: 0,
            maxOccurs: 1,
            isAttribute: false,
          },
        ],
      };
    },
    async extractJavaAst() {
      return { setterKeys: [], jsonProperties: [], tableFields: [] };
    },
    async validateXml() {
      return { valid: true, errors: [] };
    },
  };
}

function makeForge(
  wtMgr: WorktreeManager,
  root: string,
  mavenImpl: (wt: string, classes: readonly string[]) => Promise<MavenTestRunResult>,
  prSpy = vi.fn(async () => ({ prUrl: 'https://gitea.example.org/Integracao/nfe-parser/pulls/7' })),
): GitMavenForgePort {
  const localRemote = (repo: DfeRepoEntry): DfeRepoEntry => ({
    ...repo,
    giteaUrl: `file://${path.join(root, 'origin.git')}`,
  });
  return {
    ensureBareMirror: (repo, mirrorsDir) => wtMgr.ensureBareMirror(localRemote(repo), mirrorsDir),
    getRemoteBranchHead: (repo, branch) => wtMgr.getRemoteBranchHead(localRemote(repo), branch),
    createInspectionWorktree: (bare, sha, wt) => wtMgr.createInspectionWorktree(bare, sha, wt),
    createWorktree: (bare, branch, sha, wt) => wtMgr.createWorktree(bare, branch, sha, wt),
    resetWorktreeClean: (wt) => wtMgr.resetWorktreeClean(wt),
    removeWorktree: (bare, wt) => wtMgr.removeWorktree(bare, wt),
    getWorktreeDiff: (wt) => wtMgr.getWorktreeDiff(wt),
    exportDiffPatch: (wt, out) => wtMgr.exportDiffPatch(wt, out),
    runMavenTest: mavenImpl,
    commitPushAndOpenPr: prSpy,
  };
}

describe('ComplianceOrchestrator (CUJ 2–4)', () => {
  it('OR-01: full happy path DRAFT -> APPROVED -> TESTED -> PR_OPENED with pre-build + PR gates and lock/worktree cleanup', async () => {
    const { db, repo, commitSha, root, xsdDir, pdfPath } = setupRealBareRepoAndDb();
    const events: RunProgressEvent[] = [];
    const wtMgr = new WorktreeManager({ allowLocalFileRemotes: true });
    const prSpy = vi.fn(async () => ({
      prUrl: 'https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfe-parser/pulls/99',
    }));

    const llm: LlmGatewayPort = {
      async analyzeCompliance(input) {
        const nc: NcDocument = {
          nc_id: 'NC-2025.002-v1.30',
          nt_ref: {
            dfe: 'NFe',
            nt_number: '2025.002',
            nt_version: '1.30',
            published_date: '2025-10-15',
            pdf_sha256: input.pdf.pdfSha256,
          },
          base_commit_sha: input.baseCommitSha,
          no_structural_gaps: false,
          items: [
            {
              id: 'NC-1',
              category: 'STRUCTURAL_DTO',
              decision: 'APPROVE',
              title: 'Adicionar vIBSCBS',
              description: 'Campo BigDecimal em Nfe.java',
              tagPath: 'NFEPROC.NFE.INFNFE.TOTAL.ICMSTOT.VIBSCBS',
              targetPackage: 'domain',
              targetClass: 'Nfe',
              diffKind: 'MISSING_TAG',
              pdfCitations: ['p. 1'],
              suggestedChange: 'private java.math.BigDecimal vIBSCBS;',
              editedNotes: null,
              blockerReason: null,
            },
          ],
          created_at: '2026-11-19T12:00:00.000Z',
          updated_at: '2026-11-19T12:00:00.000Z',
        };
        return { nc, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, stage: 'compliance-analysis' } };
      },
      async generatePatch() {
        const payload: PatchPayload = {
          edits: [
            {
              filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java',
              searchBlock: '  private java.math.BigDecimal vProd;',
              replaceBlock: '  private java.math.BigDecimal vProd;\n  private java.math.BigDecimal vIBSCBS;',
            },
          ],
          creates: [
            {
              filePath: 'src/test/resources/synthetic/nt_2025_002.xml',
              content: '<nfeProc><vIBSCBS>1.00</vIBSCBS></nfeProc>',
            },
          ],
        };
        return { payload, usage: { promptTokens: 80, completionTokens: 40, totalTokens: 120, stage: 'patch-generation' } };
      },
      async repairPatch() {
        throw new Error('should not be called');
      },
    };

    const orchestrator = new ComplianceOrchestrator({
      db,
      oracle: makeOracleMock(),
      llmGateway: llm,
      gitForge: makeForge(
        wtMgr,
        root,
        async () => ({
          passed: true,
          classification: 'PASSED',
          summary: 'PASSED',
          failedTestClasses: [],
          sanitizedLog: '[INFO] BUILD SUCCESS',
        }),
        prSpy,
      ),
      ncWorkspaceDir: path.join(root, 'ncs'),
      cacheRootDir: path.join(root, 'cache'),
      mirrorsRootDir: path.join(root, 'mirrors'),
      worktreesRootDir: path.join(root, 'worktrees'),
      patchesDir: path.join(root, 'patches'),
      onProgress: (ev) => events.push(ev),
    });

    const draft = await orchestrator.generateDraftNc({
      runId: 'run-or-1',
      dfe: repo.dfe,
      ntId: NT_ENTRY.id,
      byokConfig: BYOK_CONFIG,
      resolvedArtifacts: { pdf: EXTRACTED_PDF, pdfPath, xsdDir },
    });
    expect(draft.run.status).toBe('DRAFT');
    expect(draft.run.baseCommitSha).toBe(commitSha);
    expect(existsSync(draft.savedNc.jsonPath)).toBe(true);

    let seenPreviewDiff = '';
    const applyResult = await orchestrator.approveAndRunCompliance({
      runId: 'run-or-1',
      byokConfig: BYOK_CONFIG,
      xsdDir,
      requestPreBuildApproval: async (preview) => {
        seenPreviewDiff = preview.unifiedDiff;
        return { approved: true };
      },
      requestPrApproval: async () => ({ approved: true }),
    });

    expect(seenPreviewDiff).toContain('vIBSCBS');
    expect(applyResult.run.status).toBe('PR_OPENED');
    expect(applyResult.prUrl).toContain('/pulls/99');
    expect(applyResult.run.tokenUsage?.totalTokens).toBe(270);
    expect(prSpy).toHaveBeenCalledTimes(1);
    expect(db.getRepoLock('NFe')).toBeNull();
    expect(events.some((e) => e.step === 'PRE_BUILD_DIFF_REVIEW')).toBe(true);
    db.close();
  }, 20_000);

  it('OR-02: bounded PATCH_REPAIR loop retries compile failure once, repairs, and passes', async () => {
    const { db, repo, root, xsdDir, pdfPath } = setupRealBareRepoAndDb();
    const wtMgr = new WorktreeManager({ allowLocalFileRemotes: true });
    let mvnCalls = 0;

    const llm: LlmGatewayPort = {
      async analyzeCompliance(input) {
        return {
          nc: {
            nc_id: 'NC-2025.002-v1.30',
            nt_ref: { dfe: 'NFe', nt_number: '2025.002', nt_version: '1.30', published_date: '2025-10-15', pdf_sha256: input.pdf.pdfSha256 },
            base_commit_sha: input.baseCommitSha,
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
          },
          usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70, stage: 'compliance-analysis' },
        };
      },
      async generatePatch() {
        return {
          payload: {
            edits: [
              {
                filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java',
                searchBlock: '  private java.math.BigDecimal vProd;',
                replaceBlock: '  private java.math.BigDecimal vProd;\n  private UndefinedType brokenField;',
              },
            ],
            creates: [],
          },
          usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60, stage: 'patch-generation' },
        };
      },
      async repairPatch() {
        return {
          payload: {
            edits: [
              {
                filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java',
                searchBlock: '  private java.math.BigDecimal vProd;',
                replaceBlock: '  private java.math.BigDecimal vProd;\n  private java.math.BigDecimal fixedField;',
              },
            ],
            creates: [],
          },
          usage: { promptTokens: 45, completionTokens: 25, totalTokens: 70, stage: 'patch-repair' },
        };
      },
    };

    const orchestrator = new ComplianceOrchestrator({
      db,
      oracle: makeOracleMock(),
      llmGateway: llm,
      gitForge: makeForge(wtMgr, root, async () => {
        mvnCalls += 1;
        if (mvnCalls === 1) {
          return {
            passed: false,
            classification: 'SYNTHETIC_OR_COMPILE_ERROR',
            summary: 'compile error',
            failedTestClasses: [],
            sanitizedLog: 'cannot find symbol UndefinedType',
          };
        }
        return {
          passed: true,
          classification: 'PASSED',
          summary: 'ok',
          failedTestClasses: [],
          sanitizedLog: 'BUILD SUCCESS',
        };
      }),
      ncWorkspaceDir: path.join(root, 'ncs'),
      cacheRootDir: path.join(root, 'cache'),
      mirrorsRootDir: path.join(root, 'mirrors'),
      worktreesRootDir: path.join(root, 'worktrees'),
      patchesDir: path.join(root, 'patches'),
    });

    await orchestrator.generateDraftNc({
      runId: 'run-or-2',
      dfe: repo.dfe,
      ntId: NT_ENTRY.id,
      byokConfig: BYOK_CONFIG,
      resolvedArtifacts: { pdf: EXTRACTED_PDF, pdfPath, xsdDir },
    });

    const result = await orchestrator.approveAndRunCompliance({
      runId: 'run-or-2',
      byokConfig: BYOK_CONFIG,
      xsdDir,
      requestPreBuildApproval: async () => ({ approved: true }),
      requestPrApproval: async () => ({ approved: false }),
    });

    expect(mvnCalls).toBe(2);
    expect(result.run.status).toBe('TESTED');
    expect(existsSync(result.patchFilePath!)).toBe(true);
    expect(readFileSync(result.patchFilePath!, 'utf8')).toContain('fixedField');
    expect(result.run.tokenUsage?.totalTokens).toBe(200);
    db.close();
  }, 20_000);

  it('OR-03: aborts immediately on INFRA_ERROR without wasting repair attempts and releases lock', async () => {
    const { db, repo, root, xsdDir, pdfPath } = setupRealBareRepoAndDb();
    const wtMgr = new WorktreeManager({ allowLocalFileRemotes: true });
    const repairSpy = vi.fn();

    const orchestrator = new ComplianceOrchestrator({
      db,
      oracle: makeOracleMock(),
      llmGateway: {
        async analyzeCompliance(input) {
          return {
            nc: {
              nc_id: 'NC-2025.002-v1.30',
              nt_ref: { dfe: 'NFe', nt_number: '2025.002', nt_version: '1.30', published_date: '2025-10-15', pdf_sha256: input.pdf.pdfSha256 },
              base_commit_sha: input.baseCommitSha,
              no_structural_gaps: false,
              items: [
                {
                  id: 'NC-1',
                  category: 'STRUCTURAL_DTO',
                  decision: 'APPROVE',
                  title: 'x',
                  description: 'y',
                  tagPath: 'NFEPROC.X',
                  targetPackage: 'domain',
                  targetClass: 'Nfe',
                  diffKind: 'MISSING_TAG',
                  pdfCitations: ['p. 1'],
                  suggestedChange: null,
                  editedNotes: null,
                  blockerReason: null,
                },
              ],
              created_at: '2026-11-19T12:00:00.000Z',
              updated_at: '2026-11-19T12:00:00.000Z',
            },
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, stage: 'compliance-analysis' },
          };
        },
        async generatePatch() {
          return {
            payload: {
              edits: [
                {
                  filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java',
                  searchBlock: '  private java.math.BigDecimal vProd;',
                  replaceBlock: '  private java.math.BigDecimal vProd;\n  private int ok;',
                },
              ],
              creates: [],
            },
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, stage: 'patch-generation' },
          };
        },
        repairPatch: repairSpy,
      },
      gitForge: makeForge(wtMgr, root, async () => ({
        passed: false,
        classification: 'INFRA_ERROR',
        summary: 'offline .m2 missing',
        failedTestClasses: [],
        sanitizedLog: 'Could not transfer artifact',
      })),
      ncWorkspaceDir: path.join(root, 'ncs'),
      cacheRootDir: path.join(root, 'cache'),
      mirrorsRootDir: path.join(root, 'mirrors'),
      worktreesRootDir: path.join(root, 'worktrees'),
      patchesDir: path.join(root, 'patches'),
    });

    await orchestrator.generateDraftNc({
      runId: 'run-or-3',
      dfe: repo.dfe,
      ntId: NT_ENTRY.id,
      byokConfig: BYOK_CONFIG,
      resolvedArtifacts: { pdf: EXTRACTED_PDF, pdfPath, xsdDir },
    });

    await expect(
      orchestrator.approveAndRunCompliance({
        runId: 'run-or-3',
        byokConfig: BYOK_CONFIG,
        xsdDir,
        requestPreBuildApproval: async () => ({ approved: true }),
        requestPrApproval: async () => ({ approved: true }),
      }),
    ).rejects.toThrow(/infraestrutura|INFRA_ERROR|offline/i);

    expect(repairSpy).not.toHaveBeenCalled();
    expect(db.getComplianceRun('run-or-3')?.status).toBe('FAILED');
    expect(db.getComplianceRun('run-or-3')?.failedStep).toBe('MAVEN_TEST');
    expect(db.getRepoLock('NFe')).toBeNull();
    db.close();
  }, 20_000);

  it('OR-04: rejects concurrent execution via repo_locks and rejects active SHARED_XML_PARSER_BLOCKER', async () => {
    const { db, repo, root, xsdDir, pdfPath } = setupRealBareRepoAndDb();
    const wtMgr = new WorktreeManager({ allowLocalFileRemotes: true });

    const orchestrator = new ComplianceOrchestrator({
      db,
      oracle: makeOracleMock(),
      llmGateway: {
        async analyzeCompliance(input) {
          return {
            nc: {
              nc_id: 'NC-BLOCK',
              nt_ref: { dfe: 'NFe', nt_number: '2025.002', nt_version: '1.30', published_date: '2025-10-15', pdf_sha256: input.pdf.pdfSha256 },
              base_commit_sha: input.baseCommitSha,
              no_structural_gaps: false,
              items: [
                {
                  id: 'NC-1',
                  category: 'SHARED_XML_PARSER_BLOCKER',
                  decision: 'APPROVE',
                  title: 'Parser lib blocker',
                  description: 'Blocked',
                  tagPath: 'NFEPROC.ROOT',
                  targetPackage: 'xml-parser',
                  targetClass: null,
                  diffKind: 'MISSING_TAG',
                  pdfCitations: ['p. 1'],
                  suggestedChange: null,
                  editedNotes: null,
                  blockerReason: 'Shared XML parser lacks support',
                },
              ],
              created_at: '2026-11-19T12:00:00.000Z',
              updated_at: '2026-11-19T12:00:00.000Z',
            },
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, stage: 'compliance-analysis' },
          };
        },
        async generatePatch() {
          throw new Error('blocked');
        },
        async repairPatch() {
          throw new Error('blocked');
        },
      },
      gitForge: makeForge(wtMgr, root, async () => ({
        passed: true,
        classification: 'PASSED',
        summary: 'ok',
        failedTestClasses: [],
        sanitizedLog: '',
      })),
      ncWorkspaceDir: path.join(root, 'ncs'),
      cacheRootDir: path.join(root, 'cache'),
      mirrorsRootDir: path.join(root, 'mirrors'),
      worktreesRootDir: path.join(root, 'worktrees'),
      patchesDir: path.join(root, 'patches'),
    });

    await orchestrator.generateDraftNc({
      runId: 'run-or-4',
      dfe: repo.dfe,
      ntId: NT_ENTRY.id,
      byokConfig: BYOK_CONFIG,
      resolvedArtifacts: { pdf: EXTRACTED_PDF, pdfPath, xsdDir },
    });

    await expect(
      orchestrator.approveAndRunCompliance({
        runId: 'run-or-4',
        byokConfig: BYOK_CONFIG,
        xsdDir,
        requestPreBuildApproval: async () => ({ approved: true }),
        requestPrApproval: async () => ({ approved: true }),
      }),
    ).rejects.toThrow(/SHARED_XML_PARSER_BLOCKER/);

    expect(db.getComplianceRun('run-or-4')?.failedStep).toBe('NC_APPROVAL');
    db.close();
  }, 20_000);

  it('OR-05: enforces repo_locks contention and short-circuits confirmed no_structural_gaps runs cleanly', async () => {
    const { db, repo, commitSha, root, xsdDir, pdfPath } = setupRealBareRepoAndDb();
    const wtMgr = new WorktreeManager({ allowLocalFileRemotes: true });

    const orchestrator = new ComplianceOrchestrator({
      db,
      oracle: makeOracleMock(),
      llmGateway: {
        async analyzeCompliance(input) {
          return {
            nc: {
              nc_id: 'NC-CLEAN',
              nt_ref: { dfe: 'NFe', nt_number: '2025.002', nt_version: '1.30', published_date: '2025-10-15', pdf_sha256: input.pdf.pdfSha256 },
              base_commit_sha: commitSha,
              no_structural_gaps: true,
              confirmed_no_gaps: true,
              confirmed_at: '2026-11-19T12:05:00.000Z',
              items: [],
              created_at: '2026-11-19T12:00:00.000Z',
              updated_at: '2026-11-19T12:05:00.000Z',
            },
            usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30, stage: 'compliance-analysis' },
          };
        },
        async generatePatch() {
          throw new Error('should not run');
        },
        async repairPatch() {
          throw new Error('should not run');
        },
      },
      gitForge: makeForge(wtMgr, root, async () => ({
        passed: true,
        classification: 'PASSED',
        summary: 'ok',
        failedTestClasses: [],
        sanitizedLog: '',
      })),
      ncWorkspaceDir: path.join(root, 'ncs'),
      cacheRootDir: path.join(root, 'cache'),
      mirrorsRootDir: path.join(root, 'mirrors'),
      worktreesRootDir: path.join(root, 'worktrees'),
      patchesDir: path.join(root, 'patches'),
    });

    await orchestrator.generateDraftNc({
      runId: 'run-or-clean',
      dfe: repo.dfe,
      ntId: NT_ENTRY.id,
      byokConfig: BYOK_CONFIG,
      resolvedArtifacts: { pdf: EXTRACTED_PDF, pdfPath, xsdDir },
    });

    const cleanRes = await orchestrator.approveAndRunCompliance({
      runId: 'run-or-clean',
      byokConfig: BYOK_CONFIG,
      xsdDir,
      requestPreBuildApproval: async () => ({ approved: true }),
      requestPrApproval: async () => ({ approved: true }),
    });
    expect(cleanRes.run.status).toBe('TESTED');
    expect(cleanRes.prUrl).toBeNull();

    // Contention check: pre-existing lock blocks another run for the same DFE
    db.createComplianceRun({
      runId: 'run-holder',
      dfe: 'NFe',
      ntId: NT_ENTRY.id,
      operatorName: 'Op',
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
    });
    db.acquireRepoLock('NFe', 'run-holder');

    const { saveNcDocument } = await import('../src/nc/nc-service.js');
    const saved = await saveNcDocument(path.join(root, 'ncs'), {
      nc_id: 'NC-LOCKED',
      nt_ref: { dfe: 'NFe', nt_number: '2025.002', nt_version: '1.30', published_date: '2025-10-15', pdf_sha256: 'a'.repeat(64) },
      base_commit_sha: commitSha,
      no_structural_gaps: false,
      items: [
        {
          id: 'NC-1',
          category: 'STRUCTURAL_DTO',
          decision: 'APPROVE',
          title: 'x',
          description: 'y',
          tagPath: 'NFEPROC.X',
          targetPackage: 'domain',
          targetClass: 'Nfe',
          diffKind: 'MISSING_TAG',
          pdfCitations: ['p. 1'],
          suggestedChange: null,
          editedNotes: null,
          blockerReason: null,
        },
      ],
      created_at: '2026-11-19T12:00:00.000Z',
      updated_at: '2026-11-19T12:00:00.000Z',
    });
    db.createComplianceRun({
      runId: 'run-contender',
      dfe: 'NFe',
      ntId: NT_ENTRY.id,
      operatorName: 'Op',
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      baseCommitSha: commitSha,
      ncJsonPath: path.basename(saved.jsonPath),
    });

    await expect(
      orchestrator.approveAndRunCompliance({
        runId: 'run-contender',
        byokConfig: BYOK_CONFIG,
        xsdDir,
        requestPreBuildApproval: async () => ({ approved: true }),
        requestPrApproval: async () => ({ approved: true }),
      }),
    ).rejects.toThrow(/travado|lock|uso/i);

    expect(db.getRepoLock('NFe')?.runId).toBe('run-holder');
    db.close();
  }, 20_000);

  it('OR-06: analyzeDeclarativeDiff flags imperative control flow while allowing declarative DTO/test changes', () => {
    const declarative = analyzeDeclarativeDiff(
      [
        '+++ b/src/main/java/Nfe.java',
        '+  private BigDecimal vIBSCBS;',
        '+++ b/src/test/java/NtTest.java',
        '+  if (x > 0) { assertTrue(true); }',
      ].join('\n'),
    );
    expect(declarative.isStrictlyDeclarative).toBe(true);

    const imperative = analyzeDeclarativeDiff(
      ['+++ b/src/main/java/Nfe.java', '+  if (vProd != null) { return; }'].join('\n'),
    );
    expect(imperative.isStrictlyDeclarative).toBe(false);
    expect(imperative.nonDeclarativeReasons[0]).toContain('Nfe.java');
  });

  it('OR-07: rejects empty xsdDir and records USER_ABORT on pre-build rejection cleanly', async () => {
    const { db, repo, commitSha, root, xsdDir, pdfPath } = setupRealBareRepoAndDb();
    const wtMgr = new WorktreeManager({ allowLocalFileRemotes: true });

    const orchestrator = new ComplianceOrchestrator({
      db,
      oracle: makeOracleMock(),
      llmGateway: {
        async analyzeCompliance(input) {
          return {
            nc: {
              nc_id: 'NC-ABORT',
              nt_ref: { dfe: 'NFe', nt_number: '2025.002', nt_version: '1.30', published_date: '2025-10-15', pdf_sha256: input.pdf.pdfSha256 },
              base_commit_sha: commitSha,
              no_structural_gaps: false,
              items: [
                {
                  id: 'NC-1',
                  category: 'STRUCTURAL_DTO',
                  decision: 'APPROVE',
                  title: 'x',
                  description: 'y',
                  tagPath: 'NFEPROC.X',
                  targetPackage: 'domain',
                  targetClass: 'Nfe',
                  diffKind: 'MISSING_TAG',
                  pdfCitations: ['p. 1'],
                  suggestedChange: null,
                  editedNotes: null,
                  blockerReason: null,
                },
              ],
              created_at: '2026-11-19T12:00:00.000Z',
              updated_at: '2026-11-19T12:00:00.000Z',
            },
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, stage: 'compliance-analysis' },
          };
        },
        async generatePatch() {
          return {
            payload: {
              edits: [
                {
                  filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java',
                  searchBlock: '  private java.math.BigDecimal vProd;',
                  replaceBlock: '  private java.math.BigDecimal vProd;\n  private int ok;',
                },
              ],
              creates: [],
            },
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20, stage: 'patch-generation' },
          };
        },
        async repairPatch() {
          throw new Error('unused');
        },
      },
      gitForge: makeForge(wtMgr, root, async () => ({
        passed: true,
        classification: 'PASSED',
        summary: 'ok',
        failedTestClasses: [],
        sanitizedLog: '',
      })),
      ncWorkspaceDir: path.join(root, 'ncs'),
      cacheRootDir: path.join(root, 'cache'),
      mirrorsRootDir: path.join(root, 'mirrors'),
      worktreesRootDir: path.join(root, 'worktrees'),
      patchesDir: path.join(root, 'patches'),
    });

    await orchestrator.generateDraftNc({
      runId: 'run-empty-xsd',
      dfe: repo.dfe,
      ntId: NT_ENTRY.id,
      byokConfig: BYOK_CONFIG,
      resolvedArtifacts: { pdf: EXTRACTED_PDF, pdfPath, xsdDir },
    });
    await expect(
      orchestrator.approveAndRunCompliance({
        runId: 'run-empty-xsd',
        byokConfig: BYOK_CONFIG,
        xsdDir: '   ',
        requestPreBuildApproval: async () => ({ approved: true }),
        requestPrApproval: async () => ({ approved: true }),
      }),
    ).rejects.toThrow(/XSD/i);
    expect(db.getComplianceRun('run-empty-xsd')?.failedStep).toBe('PATCH_GUARDRAILS');

    await orchestrator.generateDraftNc({
      runId: 'run-user-abort',
      dfe: repo.dfe,
      ntId: NT_ENTRY.id,
      byokConfig: BYOK_CONFIG,
      resolvedArtifacts: { pdf: EXTRACTED_PDF, pdfPath, xsdDir },
    });
    await expect(
      orchestrator.approveAndRunCompliance({
        runId: 'run-user-abort',
        byokConfig: BYOK_CONFIG,
        xsdDir,
        requestPreBuildApproval: async () => ({ approved: false, reason: 'Operador recusou' }),
        requestPrApproval: async () => ({ approved: true }),
      }),
    ).rejects.toThrow(/Operador recusou/);
    expect(db.getComplianceRun('run-user-abort')?.failedStep).toBe('USER_ABORT');
    db.close();
  }, 20_000);
});
