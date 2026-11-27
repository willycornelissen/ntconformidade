import { z } from 'zod';
import {
  HttpsUrlSchema,
  llmSecretKey,
  type CopilotModelOption,
  type ListCopilotModelsResult,
} from '../domain/types.js';
import { isAllowedByokUrl } from '../domain/validators.js';
import type { SecretStorePort } from '../ports/interfaces.js';
import {
  getJsonWithManualRedirects,
  postJsonWithManualRedirects,
  scrubSecret,
  type FetchFn,
} from './http-client.js';

/** Official public OAuth Client ID for GitHub Copilot IDE integrations (non-secret). */
export const COPILOT_OAUTH_CLIENT_ID = 'Iv1.b507a08c87ecfe98';

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_INTERNAL_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const DEFAULT_COPILOT_API_ORIGIN = 'https://api.githubcopilot.com';

export const COPILOT_CLIENT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Editor-Version': 'vscode/1.95.0',
  'Editor-Plugin-Version': 'copilot-chat/0.22.0',
  'User-Agent': 'GithubCopilot/1.155.0',
});

export const COPILOT_CHAT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  ...COPILOT_CLIENT_HEADERS,
  'Copilot-Integration-Id': 'vscode-chat',
  'Openai-Intent': 'conversation-panel',
});

/** Curated GitHub Copilot subscription models shown as baseline/offline fallback. */
export const CURATED_COPILOT_MODELS: readonly CopilotModelOption[] = Object.freeze([
  { id: 'gpt-4.1', name: 'GPT-4.1 (Copilot Base)', vendor: 'OpenAI', source: 'curated' },
  { id: 'gpt-4o', name: 'GPT-4o', vendor: 'OpenAI', source: 'curated' },
  { id: 'gpt-5', name: 'GPT-5', vendor: 'OpenAI', source: 'curated' },
  { id: 'gpt-5-mini', name: 'GPT-5 mini', vendor: 'OpenAI', source: 'curated' },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', vendor: 'Anthropic', source: 'curated' },
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', vendor: 'Anthropic', source: 'curated' },
  { id: 'claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', vendor: 'Anthropic', source: 'curated' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro (Copilot)', vendor: 'Google', source: 'curated' },
  { id: 'o4-mini', name: 'o4-mini', vendor: 'OpenAI', source: 'curated' },
]);

const DeviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: HttpsUrlSchema,
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().default(5),
});

const OAuthPollResponseSchema = z.object({
  access_token: z.string().min(1).optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
  interval: z.number().int().positive().optional(),
});

const CopilotSessionTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.number().int().positive(),
  endpoints: z
    .object({
      api: HttpsUrlSchema.optional(),
    })
    .optional(),
});

/** Public parameters returned to initiate GitHub OAuth Device authorization in a browser. */
export interface CopilotDeviceCodeStart {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresIn: number;
  readonly interval: number;
}

/** Single-step poll status for GitHub OAuth Device authorization. */
export interface CopilotDeviceTokenPollOutcome {
  readonly status: 'pending' | 'slow_down' | 'authorized' | 'expired' | 'denied' | 'error';
  readonly accessToken?: string;
  readonly interval?: number;
  readonly error?: string;
}

/** Short-lived GitHub Copilot API session token and resolved API base origin. */
export interface CopilotSessionToken {
  readonly token: string;
  readonly expiresAtEpochSec: number;
  readonly apiOrigin: string;
}

/** Returns true when a stored secret is a GitHub OAuth/PAT credential requiring `/copilot_internal/v2/token` exchange. */
export function requiresCopilotSessionExchange(secret: string): boolean {
  const trimmed = secret.trim();
  return /^(?:ghu|gho|ghp)_|^github_pat_/i.test(trimmed);
}

/** Starts a GitHub OAuth Device flow for Copilot and returns the verification URI and user code. */
export async function requestCopilotDeviceCode(fetchFn?: FetchFn): Promise<CopilotDeviceCodeStart> {
  const raw = await postJsonWithManualRedirects({
    url: GITHUB_DEVICE_CODE_URL,
    headers: { 'User-Agent': 'ntconformidade/0.1.0' },
    body: {
      client_id: COPILOT_OAUTH_CLIENT_ID,
      scope: 'read:user',
    },
    allowLoopbackHttp: false,
    fetchFn,
  });
  const parsed = DeviceCodeResponseSchema.parse(raw);
  return {
    deviceCode: parsed.device_code,
    userCode: parsed.user_code,
    verificationUri: parsed.verification_uri,
    expiresIn: parsed.expires_in,
    interval: parsed.interval,
  };
}

/** Polls GitHub OAuth once for completion of an in-flight Device Flow session. */
export async function pollCopilotDeviceToken(
  deviceCode: string,
  fetchFn?: FetchFn,
): Promise<CopilotDeviceTokenPollOutcome> {
  const trimmedCode = deviceCode.trim();
  if (!trimmedCode) {
    throw new Error('deviceCode obrigatório para verificação OAuth do Copilot');
  }
  const raw = await postJsonWithManualRedirects({
    url: GITHUB_OAUTH_TOKEN_URL,
    headers: { 'User-Agent': 'ntconformidade/0.1.0' },
    body: {
      client_id: COPILOT_OAUTH_CLIENT_ID,
      device_code: trimmedCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    },
    allowLoopbackHttp: false,
    secretToRedact: trimmedCode,
    fetchFn,
  });

  const parsed = OAuthPollResponseSchema.parse(raw);
  if (parsed.access_token) {
    return { status: 'authorized', accessToken: parsed.access_token };
  }
  switch (parsed.error) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down':
      return {
        status: 'slow_down',
        ...(parsed.interval !== undefined ? { interval: parsed.interval } : {}),
      };
    case 'expired_token':
      return {
        status: 'expired',
        error: parsed.error_description ?? 'Código OAuth do GitHub expirado. Gere um novo código.',
      };
    case 'access_denied':
      return {
        status: 'denied',
        error: parsed.error_description ?? 'Autorização negada pelo usuário no GitHub.',
      };
    default:
      return {
        status: 'error',
        error:
          parsed.error_description ??
          parsed.error ??
          'Resposta inesperada durante autenticação OAuth do GitHub Copilot.',
      };
  }
}

/** Exchanges a GitHub OAuth user token (`ghu_`/`gho_`) for an ephemeral Copilot API session token. */
export async function exchangeCopilotSessionToken(
  oauthToken: string,
  fetchFn?: FetchFn,
): Promise<CopilotSessionToken> {
  const raw = await getJsonWithManualRedirects({
    url: COPILOT_INTERNAL_TOKEN_URL,
    headers: {
      Authorization: `token ${oauthToken}`,
      ...COPILOT_CLIENT_HEADERS,
    },
    allowLoopbackHttp: false,
    secretToRedact: oauthToken,
    fetchFn,
  });

  const parsed = CopilotSessionTokenSchema.parse(raw);
  return {
    token: parsed.token,
    expiresAtEpochSec: parsed.expires_at,
    apiOrigin: (parsed.endpoints?.api ?? DEFAULT_COPILOT_API_ORIGIN).replace(/\/+$/, ''),
  };
}

const CopilotModelsPayloadSchema = z.union([
  z.object({
    data: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string().optional(),
        vendor: z.string().optional(),
        model_picker_enabled: z.boolean().optional(),
        capabilities: z
          .object({
            type: z.string().optional(),
          })
          .optional(),
      }),
    ),
  }),
  z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      vendor: z.string().optional(),
      model_picker_enabled: z.boolean().optional(),
      capabilities: z
        .object({
          type: z.string().optional(),
        })
        .optional(),
    }),
  ),
]);

/** Resolves the `/models` endpoint URL from an optional Copilot base URL or session origin. */
export function resolveCopilotModelsUrl(endpointUrl?: string, sessionApiOrigin?: string): string {
  const rawBase = (endpointUrl ?? sessionApiOrigin ?? DEFAULT_COPILOT_API_ORIGIN).trim();
  if (!isAllowedByokUrl(rawBase, false)) {
    throw new Error(`Endpoint URL do GitHub Copilot bloqueado por política SSRF: '${rawBase}'`);
  }
  const parsed = new URL(rawBase);
  const trimmedPath = parsed.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  parsed.pathname = trimmedPath.endsWith('/models') ? trimmedPath : `${trimmedPath}/models`;
  return parsed.toString();
}

/** Fetches models enabled on the authenticated user's GitHub Copilot subscription. */
export async function fetchCopilotSubscriptionModels(options: {
  readonly secret: string;
  readonly endpointUrl?: string;
  readonly enterpriseSlug?: string;
  readonly fetchFn?: FetchFn;
}): Promise<{ readonly models: readonly CopilotModelOption[]; readonly apiOrigin: string }> {
  const trimmedSecret = options.secret.trim();
  if (!trimmedSecret) {
    throw new Error('Segredo do GitHub Copilot vazio');
  }

  let bearerToken = trimmedSecret;
  let apiOrigin = DEFAULT_COPILOT_API_ORIGIN;
  if (requiresCopilotSessionExchange(trimmedSecret)) {
    const session = await exchangeCopilotSessionToken(trimmedSecret, options.fetchFn);
    bearerToken = session.token;
    apiOrigin = session.apiOrigin;
  }

  const modelsUrl = resolveCopilotModelsUrl(options.endpointUrl, apiOrigin);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearerToken}`,
    Accept: 'application/json',
    ...COPILOT_CHAT_HEADERS,
  };
  if (options.enterpriseSlug) {
    headers['X-GitHub-Enterprise'] = options.enterpriseSlug;
  }

  const raw = await getJsonWithManualRedirects({
    url: modelsUrl,
    headers,
    allowLoopbackHttp: false,
    secretToRedact: bearerToken,
    fetchFn: options.fetchFn,
  });

  const parsed = CopilotModelsPayloadSchema.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : parsed.data;
  const seenIds = new Set<string>();
  const models: CopilotModelOption[] = [];
  for (const item of entries) {
    const capType = item.capabilities?.type?.toLowerCase();
    if (capType && capType !== 'chat') {
      continue;
    }
    if (item.model_picker_enabled === false) {
      continue;
    }
    if (seenIds.has(item.id)) {
      continue;
    }
    seenIds.add(item.id);
    models.push({
      id: item.id,
      name: item.name?.trim() ? item.name.trim() : item.id,
      ...(item.vendor?.trim() ? { vendor: item.vendor.trim() } : {}),
      source: 'subscription',
    });
  }

  if (models.length === 0) {
    throw new Error('A API do GitHub Copilot não retornou modelos de chat habilitados para a assinatura');
  }
  return { models, apiOrigin };
}

/**
 * Lists GitHub Copilot subscription models when authenticated, falling back cleanly
 * to the curated Copilot model catalog when unauthenticated or offline.
 */
export async function listAvailableCopilotModels(options: {
  readonly secretStore: SecretStorePort;
  readonly endpointUrl?: string;
  readonly enterpriseSlug?: string;
  readonly fetchFn?: FetchFn;
}): Promise<ListCopilotModelsResult> {
  const secret = await options.secretStore.getSecret(llmSecretKey('github-copilot'));
  if (!secret || !secret.trim()) {
    return {
      models: [...CURATED_COPILOT_MODELS],
      source: 'curated',
      warning: null,
    };
  }
  try {
    const res = await fetchCopilotSubscriptionModels({
      secret,
      endpointUrl: options.endpointUrl,
      enterpriseSlug: options.enterpriseSlug,
      fetchFn: options.fetchFn,
    });
    return {
      models: [...res.models],
      source: 'subscription',
      warning: null,
    };
  } catch (error) {
    const msg = scrubSecret(error instanceof Error ? error.message : String(error), secret.trim());
    return {
      models: [...CURATED_COPILOT_MODELS],
      source: 'curated',
      warning: msg,
    };
  }
}
