import type {
  ByokConfig,
  DfeCode,
  DfeRepoEntry,
  ExtractJavaAstResult,
  ExtractXsdResult,
  ExtractedNtPdf,
  NcDocument,
  NtCatalogEntry,
  OracleRegistryEntry,
  PatchPayload,
  StructuralDiffFinding,
  SurefireSummary,
  SvrsDfeSyncResult,
  TokenUsage,
  ValidateXmlResult,
} from '../domain/types.js';

export interface ManualNtImportRequest {
  readonly dfe: DfeCode;
  readonly ntNumber: string;
  readonly ntVersion: string;
  readonly publishedDate: string;
  readonly pdfSourcePath: string;
  readonly xsdSourcePath: string;
  readonly homologDate?: string | null;
  readonly prodDate?: string | null;
}

export interface DownloadedNtArtifacts {
  readonly pdfPath: string | null;
  readonly pdfSha256: string | null;
  readonly xsdDir: string | null;
}

export interface NtSourcePort {
  syncAll(repos: readonly DfeRepoEntry[]): Promise<readonly SvrsDfeSyncResult[]>;
  syncDfe(repo: DfeRepoEntry): Promise<SvrsDfeSyncResult>;
  downloadNtArtifacts(entry: NtCatalogEntry, cacheRootDir: string): Promise<DownloadedNtArtifacts>;
  importManualNt(request: ManualNtImportRequest, cacheRootDir: string): Promise<{ entry: NtCatalogEntry; xsdDir: string }>;
}

export interface OracleAnalyzerPort {
  extractXsd(xsdDir: string): Promise<ExtractXsdResult>;
  extractJavaAst(repoDir: string, registryEntry: OracleRegistryEntry): Promise<ExtractJavaAstResult>;
  validateXml(xsdDir: string, xmlFilePath: string): Promise<ValidateXmlResult>;
}

export interface LlmCompletionRequest {
  readonly config: ByokConfig;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxOutputTokens?: number;
}

export interface LlmCompletionResponse {
  readonly rawText: string;
  readonly usage: TokenUsage;
}

export interface LlmProviderAdapter {
  readonly provider: ByokConfig['provider'];
  completeStructured(request: LlmCompletionRequest, apiSecret: string): Promise<LlmCompletionResponse>;
}

export interface LlmComplianceAnalysisInput {
  readonly config: ByokConfig;
  readonly repo: DfeRepoEntry;
  readonly nt: NtCatalogEntry;
  readonly baseCommitSha: string;
  readonly pdf: ExtractedNtPdf;
  readonly diffFindings: readonly StructuralDiffFinding[];
  readonly javaContextFiles: ReadonlyArray<{ readonly filePath: string; readonly content: string }>;
}

export interface LlmPatchRequest {
  readonly config: ByokConfig;
  readonly nc: NcDocument;
  readonly javaContextFiles: ReadonlyArray<{ readonly filePath: string; readonly content: string }>;
  readonly repairFeedback?: string;
  readonly repo?: DfeRepoEntry;
  readonly xsdSummary?: string;
}

export interface LlmGatewayPort {
  analyzeCompliance(input: LlmComplianceAnalysisInput): Promise<{ readonly nc: NcDocument; readonly usage: TokenUsage }>;
  generatePatch(input: LlmPatchRequest): Promise<{ readonly payload: PatchPayload; readonly usage: TokenUsage }>;
  repairPatch(input: LlmPatchRequest): Promise<{ readonly payload: PatchPayload; readonly usage: TokenUsage }>;
}

export interface MavenTestRunResult {
  readonly passed: boolean;
  readonly classification: 'PASSED' | 'INFRA_ERROR' | 'LEGACY_TEST_FAILURE' | 'SYNTHETIC_OR_COMPILE_ERROR';
  readonly summary: string;
  readonly failedTestClasses: readonly string[];
  readonly sanitizedLog: string;
  readonly surefireSummary?: SurefireSummary;
}

export interface GitMavenForgePort {
  ensureBareMirror(repo: DfeRepoEntry, mirrorsRootDir: string): Promise<string>;
  getRemoteBranchHead(repo: DfeRepoEntry, branch: string): Promise<string>;
  createInspectionWorktree?(bareRepoDir: string, commitSha: string, worktreeDir: string): Promise<void>;
  createWorktree(bareRepoDir: string, branchName: string, baseCommitSha: string, worktreeDir: string): Promise<void>;
  resetWorktreeClean?(worktreeDir: string): Promise<void>;
  removeWorktree(bareRepoDir: string, worktreeDir: string): Promise<void>;
  getWorktreeDiff?(worktreeDir: string): Promise<string>;
  exportDiffPatch(worktreeDir: string, outputPatchPath: string): Promise<string>;
  runMavenTest(worktreeDir: string, createdTestClasses: readonly string[]): Promise<MavenTestRunResult>;
  commitPushAndOpenPr(input: {
    readonly repo: DfeRepoEntry;
    readonly worktreeDir: string;
    readonly branchName: string;
    readonly commitMessage: string;
    readonly prTitle: string;
    readonly prBodyMarkdown: string;
  }): Promise<{ readonly prUrl: string }>;
}

export interface SecretStorePort {
  setSecret(key: string, plaintextValue: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  getSecretStatus(key: string): Promise<{ configured: boolean }>;
  deleteSecret(key: string): Promise<void>;
}
