import crypto from 'node:crypto';
import type {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmProviderAdapter,
} from '../../ports/interfaces.js';
import {
  exchangeCopilotSessionToken,
  requiresCopilotSessionExchange,
  type CopilotSessionToken,
} from '../copilot-oauth.js';
import { HttpStatusError, type FetchFn } from '../http-client.js';
import {
  executeOpenAiChatCompletion,
  resolveChatCompletionsUrl,
} from './openai-compatible.js';

const GITHUB_MODELS_ENDPOINT = 'https://models.inference.ai.azure.com/chat/completions';
const COPILOT_CHAT_ENDPOINT = 'https://api.githubcopilot.com/chat/completions';
const SESSION_REFRESH_MARGIN_MS = 60_000;

/** BYOK adapter for GitHub Models (`github-models-pat`) and GitHub Copilot (`copilot-oauth-device`). */
export class GithubCopilotAdapter implements LlmProviderAdapter {
  readonly provider = 'github-copilot' as const;
  private readonly fetchFn?: FetchFn;
  private readonly sessionCache = new Map<string, CopilotSessionToken>();

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
    const copilotConfig = request.config;

    if (copilotConfig.authMode === 'github-models-pat') {
      const endpoint = copilotConfig.endpointUrl
        ? resolveChatCompletionsUrl(copilotConfig.endpointUrl)
        : GITHUB_MODELS_ENDPOINT;
      const extraHeaders = copilotConfig.enterpriseSlug
        ? { 'X-GitHub-Enterprise': copilotConfig.enterpriseSlug }
        : undefined;
      return executeOpenAiChatCompletion({
        url: endpoint,
        request,
        apiSecret,
        allowLoopbackHttp: false,
        extraHeaders,
        fetchFn: this.fetchFn,
      });
    }

    return this.executeCopilotDeviceCompletion(request, copilotConfig, apiSecret);
  }

  private async executeCopilotDeviceCompletion(
    request: LlmCompletionRequest,
    copilotConfig: Extract<LlmCompletionRequest['config'], { provider: 'github-copilot' }>,
    apiSecret: string,
  ): Promise<LlmCompletionResponse> {
    const extraHeaders: Record<string, string> = {
      'Editor-Version': 'vscode/1.95.0',
      'Editor-Plugin-Version': 'copilot-chat/0.22.0',
      'Copilot-Integration-Id': 'vscode-chat',
      'User-Agent': 'GithubCopilot/1.155.0',
      'Openai-Intent': 'conversation-panel',
    };
    if (copilotConfig.enterpriseSlug) {
      extraHeaders['X-GitHub-Enterprise'] = copilotConfig.enterpriseSlug;
    }

    const needsExchange = requiresCopilotSessionExchange(apiSecret);
    if (!needsExchange) {
      const endpoint = copilotConfig.endpointUrl
        ? resolveChatCompletionsUrl(copilotConfig.endpointUrl)
        : COPILOT_CHAT_ENDPOINT;
      return executeOpenAiChatCompletion({
        url: endpoint,
        request,
        apiSecret,
        allowLoopbackHttp: false,
        extraHeaders,
        fetchFn: this.fetchFn,
      });
    }

    const cacheKey = crypto.createHash('sha256').update(apiSecret, 'utf8').digest('hex');
    const runWithSession = async (forceRefresh: boolean): Promise<LlmCompletionResponse> => {
      const session = await this.resolveSessionToken(cacheKey, apiSecret, forceRefresh);
      const endpoint = copilotConfig.endpointUrl
        ? resolveChatCompletionsUrl(copilotConfig.endpointUrl)
        : resolveChatCompletionsUrl(session.apiOrigin);
      return executeOpenAiChatCompletion({
        url: endpoint,
        request,
        apiSecret: session.token,
        allowLoopbackHttp: false,
        extraHeaders,
        fetchFn: this.fetchFn,
      });
    };

    try {
      return await runWithSession(false);
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 401) {
        this.sessionCache.delete(cacheKey);
        return runWithSession(true);
      }
      throw error;
    }
  }

  private async resolveSessionToken(
    cacheKey: string,
    oauthToken: string,
    forceRefresh: boolean,
  ): Promise<CopilotSessionToken> {
    if (!forceRefresh) {
      const cached = this.sessionCache.get(cacheKey);
      if (cached && cached.expiresAtEpochSec * 1000 > Date.now() + SESSION_REFRESH_MARGIN_MS) {
        return cached;
      }
    }
    const fresh = await exchangeCopilotSessionToken(oauthToken, this.fetchFn);
    this.sessionCache.set(cacheKey, fresh);
    return fresh;
  }
}
