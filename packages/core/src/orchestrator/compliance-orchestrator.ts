import path from 'node:path';
import {
  PreBuildDiffPreviewSchema,
  RunProgressEventSchema,
  aggregateTokenUsage,
  toOracleRegistryEntry,
  type ByokConfig,
  type ComplianceRun,
  type DfeCode,
  type DfeRepoEntry,
  type ExtractJavaAstResult,
  type ExtractedNtPdf,
  type FailedStep,
  type NcDocument,
  type NtCatalogEntry,
  type PatchPayload,
  type PreBuildDiffPreview,
  type RunProgressEvent,
  type RunProgressStep,
  type RunStatus,
  type StructuralDiffFinding,
  type TokenUsage,
} from '../domain/types.js';
import {
  checkNcReadiness,
  loadNcDocument,
  renderNcMarkdown,
  saveNcDocument,
  type SavedNcResult,
} from '../nc/nc-service.js';
import {
  computeXsdAstDiff,
  extractJavaFieldTypeHints,
} from '../oracle/xsd-ast-diff.js';
import {
  applyPatchToWorktree,
  extractAllowedJavaContextForNc,
} from '../patch/patch-engine.js';
import { extractNtPdf } from '../pdf/nt-pdf-extractor.js';
import type {
  GitMavenForgePort,
  LlmGatewayPort,
  MavenTestRunResult,
  OracleAnalyzerPort,
} from '../ports/interfaces.js';
import { sanitizeLogMessage } from '../privacy/dlp-filter.js';
import type { NtcDatabase } from '../storage/sqlite.js';
import { downloadNtArtifacts } from '../svrs/svrs-scraper.js';
import {
  defaultExecFileAsync,
  pathExistsAsync,
  resolveContainedNoSymlinkPath,
} from '../toolchain/exec-utils.js';
import { buildSanitizedToolchainEnv } from '../toolchain/host-maven-runner.js';

const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;

/** Error carrying the exact failed pipeline step for durable SQLite tracking. */
export class OrchestratorStepError extends Error {
  readonly failedStep: FailedStep;

  constructor(failedStep: FailedStep, message: string) {
    super(sanitizeLogMessage(message));
    this.name = 'OrchestratorStepError';
    this.failedStep = failedStep;
  }
}

/** Configuration dependencies for `ComplianceOrchestrator`. */
export interface ComplianceOrchestratorOptions {
  readonly db: NtcDatabase;
  readonly oracle: OracleAnalyzerPort;
  readonly llmGateway: LlmGatewayPort;
  readonly gitForge: GitMavenForgePort;
  readonly ncWorkspaceDir: string;
  readonly cacheRootDir: string;
  readonly mirrorsRootDir: string;
  readonly worktreesRootDir: string;
  readonly patchesDir: string;
  readonly maxRepairAttempts?: number;
  readonly fetchFn?: typeof fetch;
  readonly onProgress?: (event: RunProgressEvent) => void;
}

/** Input parameters for Phase A (`DRAFT` NC generation, CUJ 2). */
export interface GenerateDraftNcInput {
  readonly runId: string;
  readonly dfe: DfeCode;
  readonly ntId: string;
  readonly byokConfig: ByokConfig;
  readonly resolvedArtifacts?: {
    readonly pdf: ExtractedNtPdf;
    readonly pdfPath: string;
    readonly xsdDir: string;
  };
}

/** Input parameters for Phase B (`APPROVED -> TESTED -> PR_OPENED`, CUJ 3–4). */
export interface ApproveAndRunInput {
  readonly runId: string;
  readonly byokConfig: ByokConfig;
  readonly xsdDir: string;
  readonly currentPdfSha256?: string;
  readonly requestPreBuildApproval: (
    preview: PreBuildDiffPreview,
  ) => Promise<{ readonly approved: boolean; readonly reason?: string }>;
  readonly requestPrApproval: (input: {
    readonly runId: string;
    readonly branchName: string;
    readonly patchFilePath: string;
    readonly mavenResult: MavenTestRunResult;
  }) => Promise<{ readonly approved: boolean }>;
}

/** Result of `approveAndRunCompliance`. */
export interface ApproveAndRunResult {
  readonly run: ComplianceRun;
  readonly patchFilePath: string | null;
  readonly prUrl: string | null;
  readonly mavenResult: MavenTestRunResult | null;
}

function sanitizeSegment(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/\.{2,}/g, '_').replace(/^\.+|\.+$/g, '') || 'item';
}

function buildBranchName(dfe: DfeCode, nt: NtCatalogEntry): string {
  const num = sanitizeSegment(nt.ntNumber);
  const ver = sanitizeSegment(nt.ntVersion);
  return `nc/${dfe.toLowerCase()}-nt-${num}-v${ver}`;
}

function deriveAffectedClassHints(
  diffFindings: readonly StructuralDiffFinding[],
  ast: ExtractJavaAstResult,
): string[] {
  const names = new Set<string>();
  const findingPaths = new Set(diffFindings.map((f) => f.tagPath.toUpperCase()));
  for (const setter of ast.setterKeys) {
    const leaf = setter.leafTag.toUpperCase();
    const matchesDiff =
      findingPaths.has(setter.fullTagPath.toUpperCase()) ||
      [...findingPaths].some((fp) => fp.endsWith(`.${leaf}`));
    if (matchesDiff) {
      names.add(setter.mapperClass);
      names.add(setter.mapperClass.replace(/Mapper$/, ''));
    }
  }
  return [...names];
}

function buildXsdSummaryText(nc: NcDocument): string {
  const lines = nc.items
    .filter((item) => item.decision !== 'SKIP' && item.tagPath)
    .map((item) => `- ${item.tagPath} (${item.diffKind ?? 'STRUCTURAL'} -> ${item.targetClass ?? 'DTO'})`);
  return lines.join('\n');
}

const NON_DECLARATIVE_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly reason: string }> = [
  { pattern: /\b(?:if|for|while|switch|try|catch)\b/, reason: 'controle de fluxo imperativo detectado no diff Java' },
  { pattern: /\bRuntime\b|\bProcessBuilder\b|\bSocket\b/, reason: 'API de sistema/rede proibida no diff' },
  { pattern: /\bpublic\s+(?:static\s+)?[A-Za-z0-9_<>[\]]+\s+[a-z_][A-Za-z0-9_]*\s*\([^)]*\)\s*\{/, reason: 'declaração de novo método em código Java' },
];

/** Evaluates added unified-diff lines to flag non-declarative imperative changes for human review. */
export function analyzeDeclarativeDiff(unifiedDiff: string): {
  readonly isStrictlyDeclarative: boolean;
  readonly nonDeclarativeReasons: readonly string[];
} {
  const reasons = new Set<string>();
  let currentFile = '';
  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6).trim();
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) {
      continue;
    }
    if (currentFile.startsWith('src/test/')) {
      continue;
    }
    const added = line.slice(1);
    for (const rule of NON_DECLARATIVE_PATTERNS) {
      if (rule.pattern.test(added)) {
        reasons.add(`${currentFile || 'src'}: ${rule.reason}`);
      }
    }
  }
  const list = [...reasons];
  return { isStrictlyDeclarative: list.length === 0, nonDeclarativeReasons: list };
}

function sanitizeThrownError(error: unknown): Error {
  if (error instanceof OrchestratorStepError) {
    return error;
  }
  const cleanMsg = sanitizeLogMessage(error instanceof Error ? error.message : String(error));
  const wrapped = new Error(cleanMsg);
  if (error instanceof Error) {
    wrapped.name = error.name;
  }
  return wrapped;
}

/**
 * Coordinates the end-to-end compliance lifecycle (CUJ 2–4):
 * artifact fetch, deterministic XSD × AST diff, BYOK NC drafting, guarded patch generation,
 * pre-build diff review, Maven execution with bounded 3-attempt repair, `.patch` export, and Gitea PR.
 */
export class ComplianceOrchestrator {
  private readonly opts: ComplianceOrchestratorOptions;
  private readonly maxAttempts: number;

  constructor(options: ComplianceOrchestratorOptions) {
    this.opts = options;
    this.maxAttempts = options.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
  }

  async generateDraftNc(input: GenerateDraftNcInput): Promise<{
    readonly run: ComplianceRun;
    readonly savedNc: SavedNcResult;
    readonly xsdDir: string;
  }> {
    const repo = this.requireRepo(input.dfe);
    const nt = this.requireNt(input.ntId);
    let run = this.opts.db.createComplianceRun({
      runId: input.runId,
      dfe: repo.dfe,
      ntId: nt.id,
      operatorName: input.byokConfig.operatorName,
      provider: input.byokConfig.provider,
      modelId: input.byokConfig.modelId,
    });

    let activeStep: FailedStep = 'SVRS_SYNC';
    try {
      const { pdf, xsdDir } = await this.resolveDraftArtifacts(run, nt, input.resolvedArtifacts);
      activeStep = 'ORACLE_DIFF';
      this.emitProgress(run, 'MIRROR_SYNC', `Sincronizando espelho bare para ${repo.repoSlug}`);

      const bareMirror = await this.opts.gitForge.ensureBareMirror(repo, this.opts.mirrorsRootDir);
      const baseCommitSha = await this.opts.gitForge.getRemoteBranchHead(repo, repo.baseBranch);
      run = this.opts.db.updateComplianceRunProgress({ runId: run.runId, baseCommitSha });

      const draftResult = await this.analyzeDraftInInspectionWorktree({
        run,
        repo,
        nt,
        pdf,
        xsdDir,
        bareMirror,
        baseCommitSha,
        byokConfig: input.byokConfig,
        setActiveStep: (step) => {
          activeStep = step;
        },
      });
      return { run: draftResult.run, savedNc: draftResult.savedNc, xsdDir };
    } catch (error) {
      this.failRunSafely(run, activeStep, error);
      throw sanitizeThrownError(error);
    }
  }

  async approveAndRunCompliance(input: ApproveAndRunInput): Promise<ApproveAndRunResult> {
    let run = this.requireRun(input.runId);
    const repo = this.requireRepo(run.dfe);
    const nt = this.requireNt(run.ntId);
    let activeStep: FailedStep = 'NC_APPROVAL';
    let lockHeld = false;

    try {
      if (!input.xsdDir.trim()) {
        throw new OrchestratorStepError('PATCH_GUARDRAILS', 'Diretório XSD obrigatório não informado');
      }
      const nc = await this.loadValidatedNcForRun(run);
      activeStep = 'STALENESS_CHECK';
      await this.verifyReadinessBeforeLock(run, repo, nc, input.currentPdfSha256);

      if (nc.no_structural_gaps && nc.confirmed_no_gaps === true) {
        run = this.opts.db.transitionComplianceRunStatus({ runId: run.runId, nextStatus: 'APPROVED' });
        run = this.opts.db.transitionComplianceRunStatus({ runId: run.runId, nextStatus: 'TESTED' });
        return { run, patchFilePath: null, prUrl: null, mavenResult: null };
      }

      activeStep = 'WORKTREE_PREP';
      this.opts.db.acquireRepoLock(repo.dfe, run.runId);
      lockHeld = true;
      run = this.opts.db.transitionComplianceRunStatus({ runId: run.runId, nextStatus: 'APPROVED' });
      return await this.executeLockedPatchFlow(run, repo, nt, nc, input, (step) => {
        activeStep = step;
      });
    } catch (error) {
      if (activeStep !== 'WORKTREE_PREP' || lockHeld || error instanceof OrchestratorStepError) {
        this.failRunSafely(run, activeStep, error);
      }
      throw sanitizeThrownError(error);
    } finally {
      if (lockHeld) {
        this.opts.db.releaseRepoLock(repo.dfe, run.runId);
      }
    }
  }

  private async loadValidatedNcForRun(run: ComplianceRun): Promise<NcDocument> {
    if (!run.ncJsonPath || path.isAbsolute(run.ncJsonPath)) {
      throw new OrchestratorStepError('NC_APPROVAL', `Caminho ncJsonPath ausente ou inválido em '${run.runId}'`);
    }
    const resolved = await resolveContainedNoSymlinkPath(this.opts.ncWorkspaceDir, run.ncJsonPath);
    return loadNcDocument(resolved);
  }

  private async resolveDraftArtifacts(
    run: ComplianceRun,
    nt: NtCatalogEntry,
    override?: GenerateDraftNcInput['resolvedArtifacts'],
  ): Promise<{ readonly pdf: ExtractedNtPdf; readonly xsdDir: string }> {
    if (override) {
      this.emitProgress(run, 'PDF_EXTRACT', `Usando artefatos resolvidos para ${nt.ntNumber}`);
      return { pdf: override.pdf, xsdDir: override.xsdDir };
    }
    this.emitProgress(run, 'SVRS_SYNC', `Baixando artefatos SVRS de ${nt.ntNumber}`);
    const downloaded = await downloadNtArtifacts(nt, this.opts.cacheRootDir, {
      fetchFn: this.opts.fetchFn,
    });
    if (!downloaded.pdfPath || !downloaded.xsdDir) {
      throw new OrchestratorStepError(
        'SVRS_SYNC',
        `Artefatos PDF/XSD ausentes para '${nt.id}'. Utilize importação manual offline.`,
      );
    }
    this.emitProgress(run, 'PDF_EXTRACT', `Extraindo PDF ${nt.ntNumber}`);
    const pdf = await extractNtPdf(downloaded.pdfPath);
    return { pdf, xsdDir: downloaded.xsdDir };
  }

  private async prepareInspectionWorktree(bareMirror: string, sha: string, dir: string, runId: string): Promise<void> {
    if (this.opts.gitForge.createInspectionWorktree) {
      await this.opts.gitForge.createInspectionWorktree(bareMirror, sha, dir);
      return;
    }
    await this.opts.gitForge.createWorktree(bareMirror, `nc/inspect-${sanitizeSegment(runId)}`, sha, dir);
  }

  private async analyzeDraftInInspectionWorktree(params: {
    readonly run: ComplianceRun;
    readonly repo: DfeRepoEntry;
    readonly nt: NtCatalogEntry;
    readonly pdf: ExtractedNtPdf;
    readonly xsdDir: string;
    readonly bareMirror: string;
    readonly baseCommitSha: string;
    readonly byokConfig: ByokConfig;
    readonly setActiveStep: (step: FailedStep) => void;
  }): Promise<{ readonly run: ComplianceRun; readonly savedNc: SavedNcResult }> {
    const inspectDir = path.join(this.opts.worktreesRootDir, `inspect-${sanitizeSegment(params.run.runId)}`);
    await this.prepareInspectionWorktree(params.bareMirror, params.baseCommitSha, inspectDir, params.run.runId);

    try {
      this.emitProgress(params.run, 'ORACLE_DIFF', 'Executando oracle determinístico XSD × AST');
      const regEntry = toOracleRegistryEntry(params.repo);
      const [xsd, ast, fieldTypes] = await Promise.all([
        this.opts.oracle.extractXsd(params.xsdDir),
        this.opts.oracle.extractJavaAst(inspectDir, regEntry),
        extractJavaFieldTypeHints(inspectDir, params.repo.domainPackage),
      ]);

      const diffFindings = computeXsdAstDiff({ xsd, ast, registryEntry: regEntry, fieldTypes });
      const classHints = deriveAffectedClassHints(diffFindings, ast);
      const javaContextFiles = await extractAllowedJavaContextForNc(inspectDir, params.repo, undefined, 25, classHints);

      params.setActiveStep('LLM_CHECK');
      this.emitProgress(params.run, 'LLM_CHECK', 'Gerando NC estruturada via provedor BYOK');
      const llmRes = await this.opts.llmGateway.analyzeCompliance({
        config: params.byokConfig,
        repo: params.repo,
        nt: params.nt,
        baseCommitSha: params.baseCommitSha,
        pdf: params.pdf,
        diffFindings,
        javaContextFiles,
      });

      const dfeNcDir = path.join(this.opts.ncWorkspaceDir, params.repo.dfe);
      const savedNc = await saveNcDocument(dfeNcDir, llmRes.nc);
      const relNcPath = path.relative(this.opts.ncWorkspaceDir, savedNc.jsonPath).replace(/\\/g, '/');
      const updatedRun = this.opts.db.updateComplianceRunProgress({
        runId: params.run.runId,
        ncJsonPath: relNcPath,
        tokenUsage: aggregateTokenUsage([llmRes.usage]),
      });
      this.emitProgress(updatedRun, 'NC_SAVED', `NC salva em ${savedNc.jsonPath}`);
      return { run: updatedRun, savedNc };
    } finally {
      // Remove temporary inspection worktree after Phase A regardless of success/error
      await this.opts.gitForge.removeWorktree(params.bareMirror, inspectDir).catch(() => undefined);
    }
  }

  private async verifyReadinessBeforeLock(
    run: ComplianceRun,
    repo: DfeRepoEntry,
    nc: NcDocument,
    currentPdfSha256?: string,
  ): Promise<void> {
    this.emitProgress(run, 'STALENESS_CHECK', 'Validando staleness e bloqueios da NC');
    const remoteHeadSha = await this.opts.gitForge.getRemoteBranchHead(repo, repo.baseBranch);
    const readiness = checkNcReadiness(nc, remoteHeadSha, currentPdfSha256 ?? nc.nt_ref.pdf_sha256);
    if (!readiness.ready) {
      const step: FailedStep =
        readiness.hasBlocker || readiness.needsNoGapConfirmation ? 'NC_APPROVAL' : 'STALENESS_CHECK';
      throw new OrchestratorStepError(step, readiness.reasons.join(' '));
    }
  }

  private async executeLockedPatchFlow(
    initialRun: ComplianceRun,
    repo: DfeRepoEntry,
    nt: NtCatalogEntry,
    nc: NcDocument,
    input: ApproveAndRunInput,
    setStep: (step: FailedStep) => void,
  ): Promise<ApproveAndRunResult> {
    let run = initialRun;
    const branchName = buildBranchName(repo.dfe, nt);
    const worktreeDir = path.join(this.opts.worktreesRootDir, `run-${sanitizeSegment(run.runId)}`);
    const patchOutPath = path.join(this.opts.patchesDir, `${sanitizeSegment(run.runId)}.patch`);
    const usages: TokenUsage[] = run.tokenUsage ? [run.tokenUsage] : [];
    let bareMirror = '';

    try {
      this.emitProgress(run, 'WORKTREE_PREP', `Preparando worktree isolado ${branchName}`);
      bareMirror = await this.opts.gitForge.ensureBareMirror(repo, this.opts.mirrorsRootDir);
      await this.opts.gitForge.createWorktree(bareMirror, branchName, nc.base_commit_sha, worktreeDir);
      run = this.opts.db.updateComplianceRunProgress({ runId: run.runId, branchName });

      const javaContextFiles = await extractAllowedJavaContextForNc(worktreeDir, repo, nc);
      setStep('PATCH_APPLY');
      this.emitProgress(run, 'PATCH_APPLY', 'Gerando patch Java e testes sintéticos');
      const initialGen = await this.opts.llmGateway.generatePatch({
        config: input.byokConfig,
        nc,
        repo,
        xsdSummary: buildXsdSummaryText(nc),
        javaContextFiles,
      });
      usages.push(initialGen.usage);

      const { mavenResult } = await this.runRepairLoop({
        run,
        repo,
        nc,
        branchName,
        worktreeDir,
        initialPayload: initialGen.payload,
        javaContextFiles,
        usages,
        input,
        setStep,
      });

      const exportedPatchPath = await this.opts.gitForge.exportDiffPatch(worktreeDir, patchOutPath);
      run = this.opts.db.transitionComplianceRunStatus({
        runId: run.runId,
        nextStatus: 'TESTED',
        tokenUsage: aggregateTokenUsage(usages),
      });

      return await this.finalizePrOrPatch({
        run,
        repo,
        nt,
        nc,
        branchName,
        worktreeDir,
        exportedPatchPath,
        mavenResult,
        usages,
        input,
        setStep,
      });
    } catch (error) {
      if (await pathExistsAsync(worktreeDir)) {
        // Persist best-effort .patch artifact for forensic diagnosis before worktree removal
        await this.opts.gitForge.exportDiffPatch(worktreeDir, patchOutPath).catch(() => undefined);
      }
      throw error;
    } finally {
      if (bareMirror) {
        // Always reclaim worktree after run completion or failure
        await this.opts.gitForge.removeWorktree(bareMirror, worktreeDir).catch(() => undefined);
      }
    }
  }

  private async finalizePrOrPatch(params: {
    readonly run: ComplianceRun;
    readonly repo: DfeRepoEntry;
    readonly nt: NtCatalogEntry;
    readonly nc: NcDocument;
    readonly branchName: string;
    readonly worktreeDir: string;
    readonly exportedPatchPath: string;
    readonly mavenResult: MavenTestRunResult;
    readonly usages: readonly TokenUsage[];
    readonly input: ApproveAndRunInput;
    readonly setStep: (step: FailedStep) => void;
  }): Promise<ApproveAndRunResult> {
    this.emitProgress(params.run, 'PR_REVIEW', 'Aguardando confirmação do operador para push/PR no Gitea');
    const prDecision = await params.input.requestPrApproval({
      runId: params.run.runId,
      branchName: params.branchName,
      patchFilePath: params.exportedPatchPath,
      mavenResult: params.mavenResult,
    });
    if (!prDecision.approved) {
      return {
        run: params.run,
        patchFilePath: params.exportedPatchPath,
        prUrl: null,
        mavenResult: params.mavenResult,
      };
    }

    params.setStep('GIT_PUSH_PR');
    this.emitProgress(params.run, 'GIT_PUSH_PR', `Enviando branch ${params.branchName} e abrindo PR`);
    const { prUrl } = await this.opts.gitForge.commitPushAndOpenPr({
      repo: params.repo,
      worktreeDir: params.worktreeDir,
      branchName: params.branchName,
      commitMessage: `feat(${params.repo.dfe.toLowerCase()}): adequação NT ${params.nt.ntNumber} v${params.nt.ntVersion}`,
      prTitle: `[NT ${params.nt.ntNumber} v${params.nt.ntVersion}] Adequação ${params.repo.dfe}`,
      prBodyMarkdown: renderNcMarkdown(params.nc),
    });

    const updated = this.opts.db.transitionComplianceRunStatus({
      runId: params.run.runId,
      nextStatus: 'PR_OPENED',
      prUrl,
      tokenUsage: aggregateTokenUsage(params.usages),
    });
    this.emitProgress(updated, 'COMPLETED', `Pull Request aberto: ${prUrl}`);
    return {
      run: updated,
      patchFilePath: params.exportedPatchPath,
      prUrl,
      mavenResult: params.mavenResult,
    };
  }

  private async runRepairLoop(params: {
    readonly run: ComplianceRun;
    readonly repo: DfeRepoEntry;
    readonly nc: NcDocument;
    readonly branchName: string;
    readonly worktreeDir: string;
    readonly initialPayload: PatchPayload;
    readonly javaContextFiles: ReadonlyArray<{ readonly filePath: string; readonly content: string }>;
    readonly usages: TokenUsage[];
    readonly input: ApproveAndRunInput;
    readonly setStep: (step: FailedStep) => void;
  }): Promise<{ readonly mavenResult: MavenTestRunResult }> {
    let currentPayload = params.initialPayload;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (attempt > 1) {
        await this.resetWorktree(params.worktreeDir);
      }

      const applied = await this.applyGuardedOrRepair(params, currentPayload, attempt);
      if (applied.nextPayload) {
        currentPayload = applied.nextPayload;
        continue;
      }

      const preview = await this.buildPreBuildPreview(
        params.run.runId,
        params.branchName,
        params.worktreeDir,
        applied.modifiedFiles,
        applied.createdFiles,
      );
      this.emitProgress(params.run, 'PRE_BUILD_DIFF_REVIEW', 'Aguardando aprovação pré-build do diff', attempt);
      const approval = await params.input.requestPreBuildApproval(preview);
      if (!approval.approved) {
        throw new OrchestratorStepError('USER_ABORT', approval.reason ?? 'Diff pré-build rejeitado pelo operador.');
      }

      params.setStep('MAVEN_TEST');
      this.emitProgress(params.run, 'MAVEN_TEST', `Executando mvn test no host (tentativa ${attempt}/${this.maxAttempts})`, attempt);
      const createdJavaTests = applied.createdFiles.filter((file) => file.endsWith('.java'));
      const mavenResult = await this.opts.gitForge.runMavenTest(params.worktreeDir, createdJavaTests);

      if (mavenResult.passed) {
        return { mavenResult };
      }
      if (mavenResult.classification === 'INFRA_ERROR' || mavenResult.classification === 'LEGACY_TEST_FAILURE') {
        throw new OrchestratorStepError('MAVEN_TEST', `${mavenResult.classification}: ${mavenResult.summary}`);
      }
      if (attempt === this.maxAttempts) {
        throw new OrchestratorStepError('PATCH_REPAIR', `Falha após ${this.maxAttempts} tentativas: ${mavenResult.summary}`);
      }

      params.setStep('PATCH_REPAIR');
      currentPayload = await this.repairAttempt(params, attempt, mavenResult.sanitizedLog);
    }

    throw new OrchestratorStepError('PATCH_REPAIR', 'Loop de reparo encerrado sem sucesso');
  }

  private async applyGuardedOrRepair(
    params: {
      readonly run: ComplianceRun;
      readonly repo: DfeRepoEntry;
      readonly nc: NcDocument;
      readonly worktreeDir: string;
      readonly javaContextFiles: ReadonlyArray<{ readonly filePath: string; readonly content: string }>;
      readonly usages: TokenUsage[];
      readonly input: ApproveAndRunInput;
      readonly setStep: (step: FailedStep) => void;
    },
    currentPayload: PatchPayload,
    attempt: number,
  ): Promise<{
    readonly modifiedFiles: readonly string[];
    readonly createdFiles: readonly string[];
    readonly nextPayload?: PatchPayload;
  }> {
    try {
      params.setStep('PATCH_GUARDRAILS');
      this.emitProgress(params.run, 'PATCH_GUARDRAILS', `Validando guardrails e XSD (tentativa ${attempt}/${this.maxAttempts})`, attempt);
      const applied = await applyPatchToWorktree(params.worktreeDir, params.repo, currentPayload, {
        xsdDir: params.input.xsdDir,
        oracle: this.opts.oracle,
      });
      return { modifiedFiles: applied.modifiedFiles, createdFiles: applied.createdFiles };
    } catch (guardrailError) {
      const message = sanitizeLogMessage(guardrailError instanceof Error ? guardrailError.message : String(guardrailError));
      if (attempt === this.maxAttempts) {
        throw new OrchestratorStepError('PATCH_GUARDRAILS', message);
      }
      params.setStep('PATCH_REPAIR');
      return { modifiedFiles: [], createdFiles: [], nextPayload: await this.repairAttempt(params, attempt, message) };
    }
  }

  private async repairAttempt(
    params: {
      readonly run: ComplianceRun;
      readonly repo: DfeRepoEntry;
      readonly nc: NcDocument;
      readonly javaContextFiles: ReadonlyArray<{ readonly filePath: string; readonly content: string }>;
      readonly usages: TokenUsage[];
      readonly input: ApproveAndRunInput;
    },
    attempt: number,
    feedback: string,
  ): Promise<PatchPayload> {
    this.emitProgress(params.run, 'PATCH_REPAIR', `Solicitando reparo BYOK após falha na tentativa ${attempt}`, attempt);
    const repaired = await this.opts.llmGateway.repairPatch({
      config: params.input.byokConfig,
      nc: params.nc,
      repo: params.repo,
      xsdSummary: buildXsdSummaryText(params.nc),
      javaContextFiles: params.javaContextFiles,
      repairFeedback: feedback,
    });
    params.usages.push(repaired.usage);
    return repaired.payload;
  }

  private async buildPreBuildPreview(
    runId: string,
    branchName: string,
    worktreeDir: string,
    editedFiles: readonly string[],
    createdFiles: readonly string[],
  ): Promise<PreBuildDiffPreview> {
    const unifiedDiff = this.opts.gitForge.getWorktreeDiff
      ? await this.opts.gitForge.getWorktreeDiff(worktreeDir)
      : '';
    const declarativeCheck = analyzeDeclarativeDiff(unifiedDiff);
    return PreBuildDiffPreviewSchema.parse({
      runId,
      branchName,
      unifiedDiff,
      isStrictlyDeclarative: declarativeCheck.isStrictlyDeclarative,
      nonDeclarativeReasons: [...declarativeCheck.nonDeclarativeReasons],
      editedFiles: [...editedFiles],
      createdFiles: [...createdFiles],
    });
  }

  private async resetWorktree(worktreeDir: string): Promise<void> {
    if (this.opts.gitForge.resetWorktreeClean) {
      await this.opts.gitForge.resetWorktreeClean(worktreeDir);
      return;
    }
    const env = buildSanitizedToolchainEnv();
    await defaultExecFileAsync('git', ['-C', worktreeDir, 'checkout', '--', '.'], {
      shell: false,
      timeout: 30_000,
      env,
    });
    await defaultExecFileAsync('git', ['-C', worktreeDir, 'clean', '-fdx'], {
      shell: false,
      timeout: 30_000,
      env,
    });
  }

  private requireRepo(dfe: DfeCode): DfeRepoEntry {
    const repo = this.opts.db.getDfeRepo(dfe);
    if (!repo) {
      throw new Error(`Repositório DFE '${dfe}' não encontrado no catálogo`);
    }
    return repo;
  }

  private requireNt(ntId: string): NtCatalogEntry {
    const nt = this.opts.db.getNtCatalogEntry(ntId);
    if (!nt) {
      throw new Error(`Nota Técnica '${ntId}' não encontrada no catálogo`);
    }
    return nt;
  }

  private requireRun(runId: string): ComplianceRun {
    const run = this.opts.db.getComplianceRun(runId);
    if (!run) {
      throw new Error(`Execução '${runId}' não encontrada`);
    }
    return run;
  }

  private failRunSafely(run: ComplianceRun, fallbackStep: FailedStep, error: unknown): void {
    const latest = this.opts.db.getComplianceRun(run.runId);
    if (!latest || latest.status === 'FAILED' || latest.status === 'PR_OPENED') {
      return;
    }
    const step = error instanceof OrchestratorStepError ? error.failedStep : fallbackStep;
    const msg = sanitizeLogMessage(error instanceof Error ? error.message : String(error));
    this.opts.db.transitionComplianceRunStatus({
      runId: run.runId,
      nextStatus: 'FAILED',
      failedStep: step,
      errorMessage: msg,
    });
    try {
      this.emitProgress(latest, 'FAILED', msg, undefined, 'FAILED');
    } catch {
      // Never mask original failure if operator progress sink throws
    }
  }

  private emitProgress(
    run: ComplianceRun,
    step: RunProgressStep,
    message: string,
    attempt?: number,
    statusOverride?: RunStatus,
  ): void {
    if (!this.opts.onProgress) {
      return;
    }
    const event = RunProgressEventSchema.parse({
      runId: run.runId,
      dfe: run.dfe,
      ntId: run.ntId,
      step,
      status: statusOverride ?? run.status,
      message: sanitizeLogMessage(message),
      ...(attempt !== undefined ? { attempt, maxAttempts: this.maxAttempts } : {}),
      timestamp: new Date().toISOString(),
    });
    this.opts.onProgress(event);
  }
}
