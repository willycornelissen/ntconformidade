import { z } from 'zod';
import { TokenUsageSchema } from '../../domain/types.js';
import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProviderAdapter,
} from '../../ports/interfaces.js';
import { postJsonWithManualRedirects, type FetchFn } from '../http-client.js';

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const GeminiApiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z.array(z.object({ text: z.string().optional() })).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().int().nonnegative().optional(),
      candidatesTokenCount: z.number().int().nonnegative().optional(),
      totalTokenCount: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

function buildGeminiEndpointUrl(baseUrl: string | undefined, modelId: string): string {
  const base = (baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
  const normalizedModel = encodeURIComponent(modelId.replace(/^models\//, ''));
  return `${base}/models/${normalizedModel}:generateContent`;
}

function buildGeminiRequestBody(request: LlmCompletionRequest): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: request.systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: request.userPrompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: request.config.temperature ?? 0.1,
      ...(request.maxOutputTokens !== undefined
        ? { maxOutputTokens: request.maxOutputTokens }
        : {}),
    },
  };
}

/** BYOK adapter for Google Gemini `generateContent` using `x-goog-api-key` header auth. */
export class GeminiAdapter implements LlmProviderAdapter {
  readonly provider = 'gemini' as const;
  private readonly fetchFn?: FetchFn;

  constructor(options: { readonly fetchFn?: FetchFn } = {}) {
    this.fetchFn = options.fetchFn;
  }

  async completeStructured(
    request: LlmCompletionRequest,
    apiSecret: string,
  ): Promise<LlmCompletionResponse> {
    if (request.config.provider !== 'gemini') {
      throw new Error(`GeminiAdapter recebeu provider incompatível: ${request.config.provider}`);
    }

    const rawJson = await postJsonWithManualRedirects({
      url: buildGeminiEndpointUrl(request.config.baseUrl, request.config.modelId),
      headers: { 'x-goog-api-key': apiSecret },
      body: buildGeminiRequestBody(request),
      allowLoopbackHttp: false,
      secretToRedact: apiSecret,
      fetchFn: this.fetchFn,
    });

    const parsed = GeminiApiResponseSchema.parse(rawJson);
    const rawText = parsed.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('')
      .trim();

    if (!rawText) {
      throw new Error('Gemini retornou resposta vazia sem texto em candidates[0]');
    }

    const promptTokens = parsed.usageMetadata?.promptTokenCount ?? 0;
    const completionTokens = parsed.usageMetadata?.candidatesTokenCount ?? 0;
    const totalTokens = parsed.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens;

    return {
      rawText,
      usage: TokenUsageSchema.parse({
        promptTokens,
        completionTokens,
        totalTokens,
        stage: 'llm-call',
      }),
    };
  }
}
