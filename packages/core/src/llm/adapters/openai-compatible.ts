import { z } from 'zod';
import { TokenUsageSchema } from '../../domain/types.js';
import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProviderAdapter,
} from '../../ports/interfaces.js';
import { postJsonWithManualRedirects, type FetchFn } from '../http-client.js';

const OpenAiContentPartSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
});

const OpenAiChatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.union([z.string(), z.array(OpenAiContentPartSchema), z.null()]).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

/** Normalizes an OpenAI-compatible base URL to `/chat/completions` preserving any query string. */
export function resolveChatCompletionsUrl(rawBaseUrl: string): string {
  const parsed = new URL(rawBaseUrl);
  const trimmedPath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = trimmedPath.endsWith('/chat/completions')
    ? trimmedPath
    : `${trimmedPath}/chat/completions`;
  return parsed.toString();
}

function extractChoiceText(rawContent: string | ReadonlyArray<{ readonly text?: string }> | null | undefined): string {
  if (typeof rawContent === 'string') {
    return rawContent.trim();
  }
  if (Array.isArray(rawContent)) {
    return rawContent.map((part) => part.text ?? '').join('').trim();
  }
  return '';
}

/** Shared executor for OpenAI-compatible `/chat/completions` endpoints (used by OpenAI & Copilot adapters). */
export async function executeOpenAiChatCompletion(options: {
  readonly url: string;
  readonly request: LlmCompletionRequest;
  readonly apiSecret: string;
  readonly allowLoopbackHttp: boolean;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly fetchFn?: FetchFn;
}): Promise<LlmCompletionResponse> {
  const { request, apiSecret } = options;
  const rawJson = await postJsonWithManualRedirects({
    url: options.url,
    headers: { Authorization: `Bearer ${apiSecret}`, ...options.extraHeaders },
    body: {
      model: request.config.modelId,
      temperature: request.config.temperature ?? 0.1,
      ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
      messages: [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.userPrompt },
      ],
    },
    allowLoopbackHttp: options.allowLoopbackHttp,
    secretToRedact: apiSecret,
    fetchFn: options.fetchFn,
  });

  const parsed = OpenAiChatResponseSchema.parse(rawJson);
  const rawText = extractChoiceText(parsed.choices?.[0]?.message?.content);
  if (!rawText) {
    throw new Error('Provedor OpenAI-compatível retornou choices[0].message.content vazio');
  }

  const promptTokens = parsed.usage?.prompt_tokens ?? 0;
  const completionTokens = parsed.usage?.completion_tokens ?? 0;
  const totalTokens = parsed.usage?.total_tokens ?? promptTokens + completionTokens;

  return {
    rawText,
    usage: TokenUsageSchema.parse({ promptTokens, completionTokens, totalTokens, stage: 'llm-call' }),
  };
}

/** BYOK adapter for OpenAI-compatible APIs (OpenAI, Ollama loopback, vLLM, Groq, OpenRouter). */
export class OpenAiCompatibleAdapter implements LlmProviderAdapter {
  readonly provider = 'openai-compatible' as const;
  private readonly fetchFn?: FetchFn;

  constructor(options: { readonly fetchFn?: FetchFn } = {}) {
    this.fetchFn = options.fetchFn;
  }

  async completeStructured(
    request: LlmCompletionRequest,
    apiSecret: string,
  ): Promise<LlmCompletionResponse> {
    if (request.config.provider !== 'openai-compatible') {
      throw new Error(
        `OpenAiCompatibleAdapter recebeu provider incompatível: ${request.config.provider}`,
      );
    }

    const extraHeaders = request.config.organizationId
      ? { 'OpenAI-Organization': request.config.organizationId }
      : undefined;

    return executeOpenAiChatCompletion({
      url: resolveChatCompletionsUrl(request.config.baseUrl),
      request,
      apiSecret,
      allowLoopbackHttp: true,
      extraHeaders,
      fetchFn: this.fetchFn,
    });
  }
}
