import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProviderAdapter,
} from '../../ports/interfaces.js';
import type { FetchFn } from '../http-client.js';
import {
  executeOpenAiChatCompletion,
  resolveChatCompletionsUrl,
} from './openai-compatible.js';

const GITHUB_MODELS_ENDPOINT = 'https://models.inference.ai.azure.com/chat/completions';
const COPILOT_CHAT_ENDPOINT = 'https://api.githubcopilot.com/chat/completions';

/** BYOK adapter for GitHub Models (`github-models-pat`) and GitHub Copilot (`copilot-oauth-device`). */
export class GithubCopilotAdapter implements LlmProviderAdapter {
  readonly provider = 'github-copilot' as const;
  private readonly fetchFn?: FetchFn;

  constructor(options: { readonly fetchFn?: FetchFn } = {}) {
    this.fetchFn = options.fetchFn;
  }

  async completeStructured(
    request: LlmCompletionRequest,
    apiSecret: string,
  ): Promise<LlmCompletionResponse> {
    if (request.config.provider !== 'github-copilot') {
      throw new Error(
        `GithubCopilotAdapter recebeu provider incompatível: ${request.config.provider}`,
      );
    }

    const defaultEndpoint =
      request.config.authMode === 'github-models-pat'
        ? GITHUB_MODELS_ENDPOINT
        : COPILOT_CHAT_ENDPOINT;

    const endpoint = request.config.endpointUrl
      ? resolveChatCompletionsUrl(request.config.endpointUrl)
      : defaultEndpoint;

    const extraHeaders: Record<string, string> = {};
    if (request.config.authMode === 'copilot-oauth-device') {
      extraHeaders['Editor-Version'] = 'ntconformidade/0.1.0';
      extraHeaders['Copilot-Integration-Id'] = 'ntconformidade-core';
    }
    if (request.config.enterpriseSlug) {
      extraHeaders['X-GitHub-Enterprise'] = request.config.enterpriseSlug;
    }

    return executeOpenAiChatCompletion({
      url: endpoint,
      request,
      apiSecret,
      allowLoopbackHttp: false,
      extraHeaders: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
      fetchFn: this.fetchFn,
    });
  }
}
