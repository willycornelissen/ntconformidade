import {
  ByokConfigSchema,
  NcDocumentSchema,
  PatchPayloadSchema,
  TokenUsageSchema,
  type ByokConfig,
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

function bindVerifiedNcMetadata(
  nc: NcDocument,
  input: LlmComplianceAnalysisInput,
): NcDocument {
  if (
    nc.nt_ref.dfe !== input.repo.dfe ||
    nc.nt_ref.nt_number !== input.nt.ntNumber ||
    nc.nt_ref.nt_version !== input.nt.ntVersion
  ) {
    throw new Error(
      `NC retornada pelo LLM diverge da NT analisada (${nc.nt_ref.dfe} ${nc.nt_ref.nt_number} v${nc.nt_ref.nt_version} != ${input.repo.dfe} ${input.nt.ntNumber} v${input.nt.ntVersion})`,
    );
  }
  return NcDocumentSchema.parse({
    ...nc,
    base_commit_sha: input.baseCommitSha,
    nt_ref: {
      ...nc.nt_ref,
      published_date: input.nt.publishedDate,
      pdf_sha256: input.pdf.pdfSha256,
    },
  });
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
      new GeminiAdapter(),
      new OpenAiCompatibleAdapter(),
      new GithubCopilotAdapter(),
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

    const parsedNc = NcDocumentSchema.parse(rawJson);
    return {
      nc: bindVerifiedNcMetadata(parsedNc, input),
      usage,
    };
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
