import {
  ByokConfigSchema,
  IsoDatetimeSchema,
  NcDocumentSchema,
  PatchPayloadSchema,
  TokenUsageSchema,
  type ByokConfig,
  type DfeRepoEntry,
  type NcDocument,
  type PatchPayload,
  type TokenUsage,
} from '../domain/types.js';
import type {
  LlmComplianceAnalysisInput,
  LlmGatewayPort,
  LlmPatchRequest,
  LlmProviderAdapter,
  SecretStorePort,
} from '../ports/interfaces.js';
import {
  assertNoDlpViolations,
  sanitizeForExternalLlm,
} from '../privacy/dlp-filter.js';
import { GeminiAdapter } from './adapters/gemini.js';
import { GithubCopilotAdapter } from './adapters/github-copilot.js';
import { OpenAiCompatibleAdapter } from './adapters/openai-compatible.js';
import {
  buildComplianceAnalysisPrompt,
  buildPatchGenerationPrompt,
  buildPatchRepairPrompt,
  estimatePromptTokens,
  extractJsonFromLlmText,
} from './prompt-builder.js';

/** Error raised when an estimated LLM prompt exceeds configured token or context-window ceilings. */
export class ByokTokenLimitError extends Error {
  readonly estimatedTokens: number;
  readonly limit: number;

  constructor(estimatedTokens: number, limit: number) {
    super(
      `Prompt estimado (${estimatedTokens} tokens) excede limite configurado (${limit} tokens)`,
    );
    this.name = 'ByokTokenLimitError';
    this.estimatedTokens = estimatedTokens;
    this.limit = limit;
  }
}

/** Error raised when a required BYOK API secret is absent in the host keychain. */
export class ByokMissingSecretError extends Error {
  constructor(secretKeyRef: string) {
    super(`Segredo BYOK não configurado para '${secretKeyRef}'`);
    this.name = 'ByokMissingSecretError';
  }
}

/** Options for instantiating `ByokLlmGateway`. */
export interface ByokLlmGatewayOptions {
  readonly secretStore: SecretStorePort;
  readonly adapters?: readonly LlmProviderAdapter[];
  readonly fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
}

function resolveEffectiveTokenCeiling(config: ByokConfig): number | undefined {
  const limits: number[] = [];
  if (config.maxTokensPerStage !== undefined) {
    limits.push(config.maxTokensPerStage);
  }
  if (config.provider === 'github-copilot' && config.contextWindowLimit !== undefined) {
    limits.push(config.contextWindowLimit);
  }
  return limits.length > 0 ? Math.min(...limits) : undefined;
}

const VALID_TARGET_PACKAGES = new Set(['mapper', 'domain', 'table', 'xml-parser', 'none']);
const VALID_DIFF_KINDS = new Set(['MISSING_TAG', 'CARDINALITY_MISMATCH', 'TYPE_MISMATCH']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTargetPackage(
  rawPackage: unknown,
  category: unknown,
  repo: DfeRepoEntry,
): unknown {
  if (rawPackage === null || rawPackage === undefined) {
    return null;
  }
  if (typeof rawPackage !== 'string') {
    return rawPackage;
  }
  const trimmed = rawPackage.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || lower === 'null' || lower === 'n/a') {
    return null;
  }
  if (VALID_TARGET_PACKAGES.has(lower)) {
    return lower;
  }
  if (lower === repo.mapperPackage.toLowerCase() || /(?:^|\.)mapper$/i.test(lower)) {
    return 'mapper';
  }
  if (lower === repo.domainPackage.toLowerCase() || /(?:^|\.)(?:domain|dto|model)$/i.test(lower)) {
    return 'domain';
  }
  if (lower === repo.tablePackage.toLowerCase() || /(?:^|\.)table$/i.test(lower)) {
    return 'table';
  }
  if (lower === repo.parserPackage.toLowerCase() || /(?:^|\.)(?:xml[-_ ]?parser|parser)$/i.test(lower)) {
    return 'xml-parser';
  }
  if (lower === 'nenhum' || lower === 'sem pacote') {
    return 'none';
  }
  if (lower.includes('mapper')) {
    return 'mapper';
  }
  if (lower.includes('table')) {
    return 'table';
  }
  if (lower.includes('parser') || lower.includes('xml')) {
    return 'xml-parser';
  }
  if (lower.includes('domain') || lower.includes('dto')) {
    return 'domain';
  }

  if (category === 'STRUCTURAL_MAPPER') return 'mapper';
  if (category === 'STRUCTURAL_DTO') return 'domain';
  if (category === 'STRUCTURAL_TABLE') return 'table';
  if (category === 'SHARED_XML_PARSER_BLOCKER') return 'xml-parser';
  if (category === 'SEMANTIC_RULE_INFO_ONLY') return 'none';
  return rawPackage;
}

function normalizeDiffKind(rawDiffKind: unknown, category: unknown): unknown {
  if (rawDiffKind === null || rawDiffKind === undefined) {
    return null;
  }
  if (typeof rawDiffKind !== 'string') {
    return rawDiffKind;
  }
  const trimmed = rawDiffKind.trim();
  if (!trimmed) {
    return null;
  }
  const upper = trimmed.toUpperCase().replace(/[\s-]+/g, '_');
  if (VALID_DIFF_KINDS.has(upper)) {
    return upper;
  }
  if (
    upper === 'NONE' ||
    upper === 'N/A' ||
    upper === 'NA' ||
    upper === 'NULL' ||
    upper === 'NO_GAP' ||
    upper === 'INFO' ||
    upper === 'INFO_ONLY' ||
    upper === 'SEMANTIC' ||
    upper === 'SEMANTIC_RULE' ||
    upper === 'VALIDATION_RULE'
  ) {
    return null;
  }
  if (
    upper === 'MISSING' ||
    upper === 'NEW_TAG' ||
    upper === 'NEW_FIELD' ||
    upper === 'ADDED' ||
    upper === 'ADD' ||
    upper === 'ADDED_TAG' ||
    upper === 'ABSENT'
  ) {
    return 'MISSING_TAG';
  }
  if (
    upper === 'CARDINALITY' ||
    upper === 'OCCURS' ||
    upper === 'MIN_OCCURS' ||
    upper === 'MAX_OCCURS' ||
    upper === 'MULTIPLICITY'
  ) {
    return 'CARDINALITY_MISMATCH';
  }
  if (
    upper === 'TYPE' ||
    upper === 'DATA_TYPE' ||
    upper === 'FORMAT_MISMATCH' ||
    upper === 'TYPE_CHANGE'
  ) {
    return 'TYPE_MISMATCH';
  }
  if (category === 'SEMANTIC_RULE_INFO_ONLY') {
    return null;
  }
  return rawDiffKind;
}

function normalizePdfCitations(rawCitations: unknown): string[] {
  if (Array.isArray(rawCitations)) {
    return rawCitations
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (typeof rawCitations === 'string') {
    const trimmed = rawCitations.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function normalizeComparableNtNumber(raw: string): string {
  return raw.trim().replace(/^nt\s*/i, '').toLowerCase();
}

function normalizeComparableNtVersion(raw: string): string {
  return raw.trim().replace(/^v+/i, '').toLowerCase();
}

function normalizeRawNcDraft(rawJson: unknown, input: LlmComplianceAnalysisInput): unknown {
  if (!isPlainRecord(rawJson)) {
    return rawJson;
  }
  const rawNtRef = isPlainRecord(rawJson.nt_ref) ? rawJson.nt_ref : undefined;
  if (rawNtRef) {
    const llmDfe = typeof rawNtRef.dfe === 'string' ? rawNtRef.dfe.trim() : '';
    const llmNum = typeof rawNtRef.nt_number === 'string' ? rawNtRef.nt_number.trim() : '';
    const llmVer = typeof rawNtRef.nt_version === 'string' ? rawNtRef.nt_version.trim() : '';
    if (
      (llmDfe && llmDfe.toLowerCase() !== input.repo.dfe.toLowerCase()) ||
      (llmNum &&
        normalizeComparableNtNumber(llmNum) !== normalizeComparableNtNumber(input.nt.ntNumber)) ||
      (llmVer &&
        normalizeComparableNtVersion(llmVer) !== normalizeComparableNtVersion(input.nt.ntVersion))
    ) {
      throw new Error(
        `NC retornada pelo LLM diverge da NT analisada (${llmDfe || '?'} ${llmNum || '?'} ${llmVer || '?'} != ${input.repo.dfe} ${input.nt.ntNumber} ${input.nt.ntVersion})`,
      );
    }
  }

  const nowIso = new Date().toISOString();
  const createdAt = IsoDatetimeSchema.safeParse(rawJson.created_at).success
    ? rawJson.created_at
    : nowIso;
  const updatedAt = IsoDatetimeSchema.safeParse(rawJson.updated_at).success
    ? rawJson.updated_at
    : nowIso;
  const ncId =
    nullableTrimmedString(rawJson.nc_id) ??
    `NC-${input.nt.ntNumber}-v${input.nt.ntVersion}-${input.baseCommitSha.slice(0, 7)}`;

  const items = Array.isArray(rawJson.items)
    ? rawJson.items.map((item, idx) => {
        if (!isPlainRecord(item)) {
          return item;
        }
        const rawDecision =
          typeof item.decision === 'string' ? item.decision.trim().toUpperCase() : undefined;
        const defaultDecision = item.category === 'SEMANTIC_RULE_INFO_ONLY' ? 'SKIP' : 'APPROVE';
        return {
          ...item,
          id: nullableTrimmedString(item.id) ?? `NC-${idx + 1}`,
          decision: rawDecision || defaultDecision,
          tagPath: nullableTrimmedString(item.tagPath),
          targetPackage: normalizeTargetPackage(item.targetPackage, item.category, input.repo),
          targetClass: nullableTrimmedString(item.targetClass),
          diffKind: normalizeDiffKind(item.diffKind, item.category),
          pdfCitations: normalizePdfCitations(item.pdfCitations),
          suggestedChange: nullableTrimmedString(item.suggestedChange),
          editedNotes: nullableTrimmedString(item.editedNotes),
          blockerReason: nullableTrimmedString(item.blockerReason),
        };
      })
    : rawJson.items;

  return {
    ...rawJson,
    nc_id: ncId,
    base_commit_sha: input.baseCommitSha,
    nt_ref: {
      dfe: input.repo.dfe,
      nt_number: input.nt.ntNumber,
      nt_version: input.nt.ntVersion,
      published_date: input.nt.publishedDate,
      pdf_sha256: input.pdf.pdfSha256,
    },
    items,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

/**
 * BYOK LLM Gateway enforcing strict DLP pre-flight validation, prompt token ceilings,
 * keychain secret retrieval, provider adapter routing, and Zod schema validation.
 */
export class ByokLlmGateway implements LlmGatewayPort {
  private readonly secretStore: SecretStorePort;
  private readonly adaptersByProvider = new Map<ByokConfig['provider'], LlmProviderAdapter>();

  constructor(options: ByokLlmGatewayOptions) {
    this.secretStore = options.secretStore;
    const configuredAdapters = options.adapters ?? [
      new GeminiAdapter({ fetchFn: options.fetchFn }),
      new OpenAiCompatibleAdapter({ fetchFn: options.fetchFn }),
      new GithubCopilotAdapter({ fetchFn: options.fetchFn }),
    ];
    for (const adapter of configuredAdapters) {
      this.adaptersByProvider.set(adapter.provider, adapter);
    }
  }

  async analyzeCompliance(
    input: LlmComplianceAnalysisInput,
  ): Promise<{ readonly nc: NcDocument; readonly usage: TokenUsage }> {
    const { systemPrompt, userPrompt } = buildComplianceAnalysisPrompt(input);
    const { rawJson, usage } = await this.invokeStage({
      config: input.config,
      javaContextFiles: input.javaContextFiles,
      systemPrompt,
      userPrompt,
      stage: 'compliance-analysis',
    });

    const nc = NcDocumentSchema.parse(normalizeRawNcDraft(rawJson, input));
    return { nc, usage };
  }

  async generatePatch(
    input: LlmPatchRequest,
  ): Promise<{ readonly payload: PatchPayload; readonly usage: TokenUsage }> {
    const { systemPrompt, userPrompt } = buildPatchGenerationPrompt(input);
    const { rawJson, usage } = await this.invokeStage({
      config: input.config,
      javaContextFiles: input.javaContextFiles,
      systemPrompt,
      userPrompt,
      stage: 'patch-generation',
    });

    return {
      payload: PatchPayloadSchema.parse(rawJson),
      usage,
    };
  }

  async repairPatch(
    input: LlmPatchRequest,
  ): Promise<{ readonly payload: PatchPayload; readonly usage: TokenUsage }> {
    const { systemPrompt, userPrompt } = buildPatchRepairPrompt(input);
    const { rawJson, usage } = await this.invokeStage({
      config: input.config,
      javaContextFiles: input.javaContextFiles,
      systemPrompt,
      userPrompt,
      stage: 'patch-repair',
    });

    return {
      payload: PatchPayloadSchema.parse(rawJson),
      usage,
    };
  }

  private async invokeStage(params: {
    readonly config: ByokConfig;
    readonly javaContextFiles: ReadonlyArray<{ readonly filePath: string; readonly content: string }>;
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly stage: string;
  }): Promise<{ readonly rawJson: unknown; readonly usage: TokenUsage }> {
    const validatedConfig = ByokConfigSchema.parse(params.config);
    assertNoDlpViolations(params.javaContextFiles);

    const sanitizedSystem = sanitizeForExternalLlm(params.systemPrompt);
    const sanitizedUser = sanitizeForExternalLlm(params.userPrompt);
    const ceiling = resolveEffectiveTokenCeiling(validatedConfig);
    const estimatedTokens = estimatePromptTokens(sanitizedSystem, sanitizedUser);
    if (ceiling !== undefined && estimatedTokens > ceiling) {
      throw new ByokTokenLimitError(estimatedTokens, ceiling);
    }

    const secret = await this.secretStore.getSecret(validatedConfig.secretKeyRef);
    if (!secret || secret.trim().length === 0) {
      throw new ByokMissingSecretError(validatedConfig.secretKeyRef);
    }

    const adapter = this.adaptersByProvider.get(validatedConfig.provider);
    if (!adapter) {
      throw new Error(`Adapter LLM não registrado para provider '${validatedConfig.provider}'`);
    }

    const response = await adapter.completeStructured(
      {
        config: validatedConfig,
        systemPrompt: sanitizedSystem,
        userPrompt: sanitizedUser,
        ...(validatedConfig.maxTokensPerStage !== undefined
          ? { maxOutputTokens: validatedConfig.maxTokensPerStage }
          : {}),
      },
      secret,
    );

    const rawJson = extractJsonFromLlmText(response.rawText);
    const stageUsage = TokenUsageSchema.parse({
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      totalTokens: response.usage.totalTokens,
      stage: params.stage,
    });

    return { rawJson, usage: stageUsage };
  }
}
