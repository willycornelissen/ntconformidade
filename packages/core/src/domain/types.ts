import { z } from 'zod';
import {
  isAllowedByokUrl,
  isSafeHttpsUrl,
  isSafeRelativeRepoPath,
  isValidCalendarIsoDate,
} from './validators.js';

export const CORE_VERSION = '0.1.0';
export {
  hasPdfMagicHeader,
  isAllowedByokUrl,
  isAllowedHttpUrl,
  isLoopbackHostname,
  isPrivateOrReservedHost,
  isSafeHttpsUrl,
  isSafeRelativeRepoPath,
  isValidCalendarIsoDate,
  normalizeRepoRelativePath,
} from './validators.js';

export const DFE_CODES = ['NFe', 'BPe', 'MDFe', 'CTe', 'NF3e', 'NFCom', 'GTVe', 'NFCe'] as const;
export const DfeCodeSchema = z.enum(DFE_CODES);
export type DfeCode = z.infer<typeof DfeCodeSchema>;

export const RUN_STATUSES = ['DRAFT', 'APPROVED', 'TESTED', 'PR_OPENED', 'FAILED'] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const FAILED_STEPS = [
  'SVRS_SYNC',
  'PDF_EXTRACT',
  'ORACLE_DIFF',
  'LLM_CHECK',
  'NC_APPROVAL',
  'STALENESS_CHECK',
  'WORKTREE_PREP',
  'PATCH_APPLY',
  'PATCH_GUARDRAILS',
  'SYNTHETIC_XSD_VALIDATE',
  'MAVEN_TEST',
  'PATCH_REPAIR',
  'GIT_PUSH_PR',
  'USER_ABORT',
] as const;
export const FailedStepSchema = z.enum(FAILED_STEPS);
export type FailedStep = z.infer<typeof FailedStepSchema>;

export const ALLOWED_RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = Object.freeze({
  DRAFT: Object.freeze(['APPROVED', 'FAILED'] as const),
  APPROVED: Object.freeze(['TESTED', 'FAILED'] as const),
  TESTED: Object.freeze(['PR_OPENED', 'FAILED'] as const),
  PR_OPENED: Object.freeze([] as const),
  FAILED: Object.freeze([] as const),
});

export function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  return ALLOWED_RUN_TRANSITIONS[from].includes(to);
}

export function assertValidRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRunStatus(from, to)) {
    throw new Error(`Transição de estado inválida: ${from} -> ${to}`);
  }
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;
const COMMIT_SHA_RE = /^[a-f0-9]{40}$/i;
const GIT_BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

export const HttpsUrlSchema = z
  .url()
  .refine((u) => isSafeHttpsUrl(u, false), 'URL deve utilizar HTTPS sem credenciais embutidas');

export const IsoDateSchema = z
  .string()
  .refine(isValidCalendarIsoDate, 'Data deve estar no formato válido YYYY-MM-DD');

export const IsoDatetimeSchema = z.iso.datetime({ offset: true });
export const Sha256HexSchema = z.string().regex(SHA256_HEX_RE, 'SHA-256 inválido');

export const SafeRelativeRepoPathSchema = z
  .string()
  .min(1)
  .refine(isSafeRelativeRepoPath, 'Caminho relativo inválido ou proibido');

export const JavaPackageNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/, 'Nome de pacote Java inválido');

export const DfeRepoEntrySchema = z.object({
  dfe: DfeCodeSchema,
  repoSlug: z.string().min(1),
  giteaUrl: HttpsUrlSchema,
  baseBranch: z.string().min(1),
  basePackage: JavaPackageNameSchema,
  domainPackage: JavaPackageNameSchema,
  mapperPackage: JavaPackageNameSchema,
  tablePackage: JavaPackageNameSchema,
  parserPackage: JavaPackageNameSchema,
  utilPackage: JavaPackageNameSchema.nullable(),
  tagPrefix: z.string().regex(/^[A-Z0-9_]+$/, 'tagPrefix deve estar em caixa alta'),
  svrsRelativePath: z.string().startsWith('/'),
  baselineNt: z.string().min(1).nullable(),
});
export type DfeRepoEntry = z.infer<typeof DfeRepoEntrySchema>;

export const DfeRegistrySchema = z.array(DfeRepoEntrySchema).min(1);
export type DfeRegistry = z.infer<typeof DfeRegistrySchema>;

export const TokenUsageStageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  stage: z.string().min(1),
});

export const TokenUsageSchema = TokenUsageStageSchema.extend({
  stages: z.array(TokenUsageStageSchema).optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export function aggregateTokenUsage(stages: readonly TokenUsage[]): TokenUsage {
  const flat = stages.flatMap((u) => (u.stages && u.stages.length > 0 ? u.stages : [u]));
  const promptTokens = flat.reduce((acc, s) => acc + s.promptTokens, 0);
  const completionTokens = flat.reduce((acc, s) => acc + s.completionTokens, 0);
  const totalTokens = flat.reduce((acc, s) => acc + s.totalTokens, 0);
  const lastStage = flat[flat.length - 1]?.stage ?? 'aggregate';
  return TokenUsageSchema.parse({
    promptTokens,
    completionTokens,
    totalTokens,
    stage: lastStage,
    stages: flat.map((s) => ({
      promptTokens: s.promptTokens,
      completionTokens: s.completionTokens,
      totalTokens: s.totalTokens,
      stage: s.stage,
    })),
  });
}

export const ComplianceRunSchema = z
  .object({
    runId: z.string().min(1),
    dfe: DfeCodeSchema,
    ntId: z.string().min(1),
    status: RunStatusSchema,
    failedStep: FailedStepSchema.nullable(),
    errorMessage: z.string().nullable(),
    operatorName: z.string().trim().min(1),
    provider: z.enum(['gemini', 'openai-compatible', 'github-copilot']),
    modelId: z.string().trim().min(1),
    baseCommitSha: z.string().regex(COMMIT_SHA_RE).nullable(),
    branchName: z.string().regex(GIT_BRANCH_RE, 'Nome de branch inválido').nullable(),
    ncJsonPath: SafeRelativeRepoPathSchema.nullable(),
    prUrl: HttpsUrlSchema.nullable(),
    tokenUsage: TokenUsageSchema.nullable(),
    createdAt: IsoDatetimeSchema,
    updatedAt: IsoDatetimeSchema,
  })
  .superRefine((run, ctx) => {
    if (run.status === 'FAILED') {
      if (!run.failedStep) {
        ctx.addIssue({ code: 'custom', path: ['failedStep'], message: 'failedStep obrigatório em FAILED' });
      }
      if (!run.errorMessage || run.errorMessage.trim().length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['errorMessage'],
          message: 'errorMessage obrigatório em FAILED',
        });
      }
    }
  });
export type ComplianceRun = z.infer<typeof ComplianceRunSchema>;

export const NtSourceStatusSchema = z.enum([
  'DISCOVERED',
  'DOWNLOADED',
  'MANUAL',
  'PARSE_ERROR',
  'UNAVAILABLE',
]);
export type NtSourceStatus = z.infer<typeof NtSourceStatusSchema>;

export const NtCatalogEntrySchema = z.object({
  id: z.string().min(1),
  dfe: DfeCodeSchema,
  ntNumber: z.string().min(1),
  ntVersion: z.string().min(1),
  publishedDate: IsoDateSchema,
  homologDate: IsoDateSchema.nullable(),
  prodDate: IsoDateSchema.nullable(),
  pdfUrl: HttpsUrlSchema.nullable(),
  xsdUrl: HttpsUrlSchema.nullable(),
  pdfSha256: Sha256HexSchema.nullable(),
  sourceStatus: NtSourceStatusSchema,
  fetchedAt: IsoDatetimeSchema,
});
export type NtCatalogEntry = z.infer<typeof NtCatalogEntrySchema>;

export const ManualNtImportRequestSchema = z.object({
  dfe: DfeCodeSchema,
  ntNumber: z.string().trim().min(1),
  ntVersion: z.string().trim().min(1),
  publishedDate: z.string().trim().min(1),
  pdfSourcePath: z.string().trim().min(1),
  xsdSourcePath: z.string().trim().min(1),
  homologDate: z.string().trim().min(1).nullable().optional(),
  prodDate: z.string().trim().min(1).nullable().optional(),
});

export const NtPublicationGroupSchema = z.object({
  dfe: DfeCodeSchema,
  ntNumber: z.string().min(1),
  latestVersion: z.string().min(1),
  latestPublishedDate: IsoDateSchema,
  entries: z.array(NtCatalogEntrySchema).min(1),
});
export type NtPublicationGroup = z.infer<typeof NtPublicationGroupSchema>;

export const SvrsDfeSyncResultSchema = z.object({
  dfe: DfeCodeSchema,
  entries: z.array(NtCatalogEntrySchema),
  groups: z.array(NtPublicationGroupSchema),
  error: z.string().nullable(),
});
export type SvrsDfeSyncResult = z.infer<typeof SvrsDfeSyncResultSchema>;

export const XsdNodeSchema = z.object({
  tagPath: z.string().min(1),
  xsdType: z.string().min(1),
  minOccurs: z.number().int().nonnegative(),
  maxOccurs: z.union([z.number().int().nonnegative(), z.literal('unbounded')]),
  isAttribute: z.boolean(),
});
export type XsdNode = z.infer<typeof XsdNodeSchema>;

export const ExtractXsdResultSchema = z.object({
  rootElements: z.array(z.string().min(1)),
  nodes: z.array(XsdNodeSchema),
});
export type ExtractXsdResult = z.infer<typeof ExtractXsdResultSchema>;

export const ValidationErrorSchema = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  message: z.string().min(1),
});
export type ValidationError = z.infer<typeof ValidationErrorSchema>;

export const ValidateXmlResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(ValidationErrorSchema),
});
export type ValidateXmlResult = z.infer<typeof ValidateXmlResultSchema>;

export const OracleRegistryEntrySchema = z.object({
  dfe: DfeCodeSchema,
  basePackage: JavaPackageNameSchema,
  domainPackage: JavaPackageNameSchema,
  mapperPackage: JavaPackageNameSchema,
  tablePackage: JavaPackageNameSchema,
  parserPackage: JavaPackageNameSchema,
  utilPackage: JavaPackageNameSchema.nullable(),
  tagPrefix: z.string().regex(/^[A-Z0-9_]+$/),
});
export type OracleRegistryEntry = z.infer<typeof OracleRegistryEntrySchema>;

export const SetterKeyEntrySchema = z.object({
  fullTagPath: z.string().min(1),
  leafTag: z.string().min(1),
  mapperClass: z.string().min(1),
  targetDtoField: z.string().min(1),
});
export type SetterKeyEntry = z.infer<typeof SetterKeyEntrySchema>;

export const JsonPropertyEntrySchema = z.object({
  className: z.string().min(1),
  fieldName: z.string().min(1),
  jsonName: z.string().min(1),
});
export type JsonPropertyEntry = z.infer<typeof JsonPropertyEntrySchema>;

export const TableFieldEntrySchema = z.object({
  tableClass: z.string().min(1),
  fieldName: z.string().min(1),
});
export type TableFieldEntry = z.infer<typeof TableFieldEntrySchema>;

export const ExtractJavaAstResultSchema = z.object({
  setterKeys: z.array(SetterKeyEntrySchema),
  jsonProperties: z.array(JsonPropertyEntrySchema),
  tableFields: z.array(TableFieldEntrySchema),
});
export type ExtractJavaAstResult = z.infer<typeof ExtractJavaAstResultSchema>;

export const StructuralDiffKindSchema = z.enum(['MISSING_TAG', 'CARDINALITY_MISMATCH', 'TYPE_MISMATCH']);
export type StructuralDiffKind = z.infer<typeof StructuralDiffKindSchema>;

export const StructuralDiffFindingSchema = z.object({
  kind: StructuralDiffKindSchema,
  tagPath: z.string().min(1),
  expectedXsdType: z.string().min(1).nullable(),
  actualJavaDetail: z.string().nullable(),
  message: z.string().min(1),
});
export type StructuralDiffFinding = z.infer<typeof StructuralDiffFindingSchema>;

export const PdfComplexityWarningCodeSchema = z.enum([
  'SCANNED_OR_IMAGE_PDF',
  'BLANK_PAGE_DETECTED',
  'LARGE_PDF_PAGE_COUNT',
  'HIGH_TOKEN_ESTIMATE',
  'COMPLEX_TABLE_OR_REVISION_RISK',
  'MISSING_EOF_MARKER',
]);
export type PdfComplexityWarningCode = z.infer<typeof PdfComplexityWarningCodeSchema>;

export const PdfComplexityWarningSchema = z.object({
  code: PdfComplexityWarningCodeSchema,
  message: z.string().min(1),
  page: z.number().int().positive().optional(),
});
export type PdfComplexityWarning = z.infer<typeof PdfComplexityWarningSchema>;

export const PdfGroupSegmentSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    xmlGroupHint: z.string().nullable(),
    pageStart: z.number().int().positive(),
    pageEnd: z.number().int().positive(),
    citedText: z.string().min(1),
    estimatedTokens: z.number().int().nonnegative(),
  })
  .refine((s) => s.pageEnd >= s.pageStart, 'pageEnd deve ser >= pageStart');
export type PdfGroupSegment = z.infer<typeof PdfGroupSegmentSchema>;

export const ExtractedNtPdfSchema = z.object({
  pdfSha256: Sha256HexSchema,
  totalPages: z.number().int().positive(),
  segments: z.array(PdfGroupSegmentSchema).min(1),
  warnings: z.array(PdfComplexityWarningSchema),
  cached: z.boolean(),
});
export type ExtractedNtPdf = z.infer<typeof ExtractedNtPdfSchema>;

export const NcItemCategorySchema = z.enum([
  'STRUCTURAL_MAPPER',
  'STRUCTURAL_DTO',
  'STRUCTURAL_TABLE',
  'SHARED_XML_PARSER_BLOCKER',
  'SEMANTIC_RULE_INFO_ONLY',
]);
export type NcItemCategory = z.infer<typeof NcItemCategorySchema>;

export const NcItemDecisionSchema = z.enum(['APPROVE', 'SKIP', 'EDIT']);
export type NcItemDecision = z.infer<typeof NcItemDecisionSchema>;

export const NcItemSchema = z.object({
  id: z.string().min(1),
  category: NcItemCategorySchema,
  decision: NcItemDecisionSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  tagPath: z.string().min(1).nullable(),
  targetPackage: z.enum(['mapper', 'domain', 'table', 'xml-parser', 'none']).nullable(),
  targetClass: z.string().min(1).nullable(),
  diffKind: StructuralDiffKindSchema.nullable(),
  pdfCitations: z.array(z.string().min(1)),
  suggestedChange: z.string().nullable(),
  editedNotes: z.string().nullable(),
  blockerReason: z.string().nullable(),
});
export type NcItem = z.infer<typeof NcItemSchema>;

export const NcDocumentSchema = z.object({
  nc_id: z.string().min(1),
  nt_ref: z.object({
    dfe: DfeCodeSchema,
    nt_number: z.string().min(1),
    nt_version: z.string().min(1),
    published_date: IsoDateSchema,
    pdf_sha256: Sha256HexSchema,
  }),
  base_commit_sha: z.string().regex(COMMIT_SHA_RE),
  no_structural_gaps: z.boolean(),
  summary: z.string().optional(),
  semantic_notes: z.array(z.string()).optional(),
  confirmed_no_gaps: z.boolean().optional(),
  confirmed_at: IsoDatetimeSchema.nullable().optional(),
  items: z.array(NcItemSchema),
  created_at: IsoDatetimeSchema,
  updated_at: IsoDatetimeSchema,
});
export type NcDocument = z.infer<typeof NcDocumentSchema>;

export function hasActiveSharedParserBlocker(nc: NcDocument): boolean {
  return nc.items.some((item) => item.category === 'SHARED_XML_PARSER_BLOCKER' && item.decision !== 'SKIP');
}

export function canApplyNc(nc: NcDocument): boolean {
  return !hasActiveSharedParserBlocker(nc);
}

const CREATE_TARGET_RE = /^(src\/test\/java\/.+Test\.java|src\/test\/resources\/synthetic\/.+\.xml)$/;

export const PatchEditSchema = z.object({
  filePath: SafeRelativeRepoPathSchema,
  searchBlock: z.string().min(1, 'searchBlock não pode ser vazio'),
  replaceBlock: z.string(),
});
export type PatchEdit = z.infer<typeof PatchEditSchema>;

export const PatchCreateSchema = z.object({
  filePath: SafeRelativeRepoPathSchema.refine(
    (p) => CREATE_TARGET_RE.test(p),
    'Novos arquivos permitidos apenas em src/test/java/*Test.java ou src/test/resources/synthetic/*.xml',
  ),
  content: z.string().min(1),
});
export type PatchCreate = z.infer<typeof PatchCreateSchema>;

export const PatchPayloadSchema = z.object({
  summary: z.string().optional(),
  edits: z.array(PatchEditSchema),
  creates: z.array(PatchCreateSchema),
});
export type PatchPayload = z.infer<typeof PatchPayloadSchema>;

const BYOK_COMMON_FIELDS = {
  modelId: z.string().trim().min(1),
  operatorName: z.string().trim().min(1),
  secretKeyRef: z.string().trim().min(1),
  maxTokensPerStage: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
};

const RemoteVendorUrlSchema = z
  .url()
  .refine((u) => isAllowedByokUrl(u, false), 'URL HTTPS pública sem credenciais/IPs obrigatória');

const OpenAiEndpointUrlSchema = z
  .url()
  .refine((u) => isAllowedByokUrl(u, true), 'URL de endpoint LLM insegura');

export const ByokConfigSchema = z.discriminatedUnion('provider', [
  z
    .object({
      provider: z.literal('gemini'),
      ...BYOK_COMMON_FIELDS,
      baseUrl: RemoteVendorUrlSchema.optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal('openai-compatible'),
      ...BYOK_COMMON_FIELDS,
      baseUrl: OpenAiEndpointUrlSchema,
      organizationId: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal('github-copilot'),
      ...BYOK_COMMON_FIELDS,
      authMode: z.enum(['github-models-pat', 'copilot-oauth-device']),
      endpointUrl: RemoteVendorUrlSchema.optional(),
      enterpriseSlug: z.string().min(1).optional(),
      contextWindowLimit: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type ByokConfig = z.infer<typeof ByokConfigSchema>;

export const GITEA_PAT_SECRET_KEY = 'ntc:gitea:pat';

export function llmSecretKey<T extends ByokConfig['provider']>(provider: T): `ntc:llm:${T}` {
  return `ntc:llm:${provider}`;
}

export function toOracleRegistryEntry(repo: DfeRepoEntry): OracleRegistryEntry {
  return OracleRegistryEntrySchema.parse({
    dfe: repo.dfe,
    basePackage: repo.basePackage,
    domainPackage: repo.domainPackage,
    mapperPackage: repo.mapperPackage,
    tablePackage: repo.tablePackage,
    parserPackage: repo.parserPackage,
    utilPackage: repo.utilPackage,
    tagPrefix: repo.tagPrefix,
  });
}

export const DoctorStatusSchema = z.enum(['OK', 'WARN', 'ERROR']);
export type DoctorStatus = z.infer<typeof DoctorStatusSchema>;

export const DoctorCheckIdSchema = z.enum([
  'JAVA_JDK',
  'MAVEN',
  'GIT_CONFIG',
  'MAVEN_DEPS',
  'XSD_ORACLE',
  'GITEA_API',
  'LLM_ENDPOINT',
]);
export type DoctorCheckId = z.infer<typeof DoctorCheckIdSchema>;

export const DoctorCheckResultSchema = z.object({
  id: DoctorCheckIdSchema,
  status: DoctorStatusSchema,
  summary: z.string().min(1),
  details: z.string().nullable(),
  needsRelease8Flag: z.boolean().optional(),
});
export type DoctorCheckResult = z.infer<typeof DoctorCheckResultSchema>;

export const DoctorReportSchema = z.object({
  ok: z.boolean(),
  checkedAt: IsoDatetimeSchema,
  checks: z.array(DoctorCheckResultSchema).min(1),
});
export type DoctorReport = z.infer<typeof DoctorReportSchema>;

export const SurefireSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failedClasses: z.array(z.string().min(1)),
});
export type SurefireSummary = z.infer<typeof SurefireSummarySchema>;

export const MavenTestClassificationSchema = z.enum([
  'PASSED',
  'INFRA_ERROR',
  'LEGACY_TEST_FAILURE',
  'SYNTHETIC_OR_COMPILE_ERROR',
]);

export const MavenTestRunResultIpcSchema = z.object({
  passed: z.boolean(),
  classification: MavenTestClassificationSchema,
  summary: z.string(),
  failedTestClasses: z.array(z.string()),
  sanitizedLog: z.string(),
  surefireSummary: SurefireSummarySchema.optional(),
});

export const PreBuildDiffPreviewSchema = z.object({
  runId: z.string().min(1),
  branchName: z.string().min(1),
  unifiedDiff: z.string(),
  isStrictlyDeclarative: z.boolean(),
  nonDeclarativeReasons: z.array(z.string()),
  editedFiles: z.array(SafeRelativeRepoPathSchema),
  createdFiles: z.array(SafeRelativeRepoPathSchema),
});
export type PreBuildDiffPreview = z.infer<typeof PreBuildDiffPreviewSchema>;

export const RunProgressStepSchema = z.enum([
  'SVRS_SYNC',
  'PDF_EXTRACT',
  'MIRROR_SYNC',
  'ORACLE_DIFF',
  'LLM_CHECK',
  'NC_SAVED',
  'STALENESS_CHECK',
  'WORKTREE_PREP',
  'PATCH_APPLY',
  'PATCH_GUARDRAILS',
  'SYNTHETIC_XSD_VALIDATE',
  'PRE_BUILD_DIFF_REVIEW',
  'MAVEN_TEST',
  'PATCH_REPAIR',
  'PR_REVIEW',
  'GIT_PUSH_PR',
  'COMPLETED',
  'FAILED',
]);
export type RunProgressStep = z.infer<typeof RunProgressStepSchema>;

export const RunProgressEventSchema = z.object({
  runId: z.string().min(1),
  dfe: DfeCodeSchema,
  ntId: z.string().min(1),
  step: RunProgressStepSchema,
  status: RunStatusSchema,
  message: z.string().min(1),
  attempt: z.number().int().positive().optional(),
  maxAttempts: z.number().int().positive().optional(),
  timestamp: IsoDatetimeSchema,
});
export type RunProgressEvent = z.infer<typeof RunProgressEventSchema>;
