import { z } from 'zod';
import {
  HttpsUrlSchema,
  llmSecretKey,
  type CopilotModelLimits,
  type CopilotModelOption,
  type CopilotQuotaInfo,
  type CopilotQuotaSnapshot,
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
const COPILOT_INTERNAL_USER_URL = 'https://api.github.com/copilot_internal/user';
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
  {
    id: 'gpt-4.1',
    name: 'GPT-4.1 (Copilot Base)',
    vendor: 'OpenAI',
    source: 'curated',
    limits: { maxContextWindowTokens: 128000, maxPromptTokens: 111616, maxOutputTokens: 16384 },
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    vendor: 'OpenAI',
    source: 'curated',
    limits: { maxContextWindowTokens: 128000, maxPromptTokens: 111616, maxOutputTokens: 16384 },
  },
  {
    id: 'gpt-5',
    name: 'GPT-5',
    vendor: 'OpenAI',
    source: 'curated',
    limits: { maxContextWindowTokens: 200000, maxPromptTokens: 128000, maxOutputTokens: 16384 },
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 mini',
    vendor: 'OpenAI',
    source: 'curated',
    limits: { maxContextWindowTokens: 200000, maxPromptTokens: 128000, maxOutputTokens: 16384 },
  },
  {
    id: 'claude-sonnet-4',
    name: 'Claude Sonnet 4',
    vendor: 'Anthropic',
    source: 'curated',
    limits: { maxContextWindowTokens: 200000, maxPromptTokens: 128000, maxOutputTokens: 16384 },
  },
  {
    id: 'claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    vendor: 'Anthropic',
    source: 'curated',
    limits: { maxContextWindowTokens: 200000, maxPromptTokens: 128000, maxOutputTokens: 16384 },
  },
  {
    id: 'claude-3.7-sonnet',
    name: 'Claude 3.7 Sonnet',
    vendor: 'Anthropic',
    source: 'curated',
    limits: { maxContextWindowTokens: 200000, maxPromptTokens: 128000, maxOutputTokens: 16384 },
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro (Copilot)',
    vendor: 'Google',
    source: 'curated',
    limits: { maxContextWindowTokens: 1000000, maxPromptTokens: 128000, maxOutputTokens: 16384 },
  },
  {
    id: 'o4-mini',
    name: 'o4-mini',
    vendor: 'OpenAI',
    source: 'curated',
    limits: { maxContextWindowTokens: 200000, maxPromptTokens: 128000, maxOutputTokens: 16384 },
  },
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

const CopilotModelEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  vendor: z.string().optional(),
  model_picker_enabled: z.boolean().optional(),
  capabilities: z
    .object({
      type: z.string().optional(),
      limits: z
        .object({
          max_context_window_tokens: z.number().int().positive().optional(),
          max_prompt_tokens: z.number().int().positive().optional(),
          max_output_tokens: z.number().int().positive().optional(),
        })
        .optional(),
    })
    .optional(),
});

const CopilotModelsPayloadSchema = z.union([
  z.object({ data: z.array(CopilotModelEntrySchema) }),
  z.array(CopilotModelEntrySchema),
]);

const RawCopilotQuotaSnapshotSchema = z.object({
  entitlement: z.number().nonnegative().nullish(),
  remaining: z.number().nonnegative().nullish(),
  percent_remaining: z.number().nullish(),
  unlimited: z.boolean().nullish(),
});

const CopilotUserQuotaPayloadSchema = z.object({
  copilot_plan: z.string().nullish(),
  quota_reset_date: z.string().nullish(),
  quota_reset_date_utc: z.string().nullish(),
  quota_snapshots: z
    .object({
      chat: RawCopilotQuotaSnapshotSchema.nullish(),
      premium_interactions: RawCopilotQuotaSnapshotSchema.nullish(),
      completions: RawCopilotQuotaSnapshotSchema.nullish(),
    })
    .nullish(),
});

function extractModelLimits(
  rawLimits?: z.infer<typeof CopilotModelEntrySchema>['capabilities'],
): CopilotModelLimits | undefined {
  const limits = rawLimits?.limits;
  if (!limits) {
    return undefined;
  }
  const out: {
    maxContextWindowTokens?: number;
    maxPromptTokens?: number;
    maxOutputTokens?: number;
  } = {};
  if (limits.max_context_window_tokens !== undefined) {
    out.maxContextWindowTokens = limits.max_context_window_tokens;
  }
  if (limits.max_prompt_tokens !== undefined) {
    out.maxPromptTokens = limits.max_prompt_tokens;
  }
  if (limits.max_output_tokens !== undefined) {
    out.maxOutputTokens = limits.max_output_tokens;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeQuotaSnapshot(
  raw?: z.infer<typeof RawCopilotQuotaSnapshotSchema> | null,
): CopilotQuotaSnapshot | undefined {
  if (!raw) {
    return undefined;
  }
  const snapshot: {
    entitlement?: number;
    remaining?: number;
    percentRemaining?: number;
    unlimited?: boolean;
  } = {};
  if (raw.entitlement !== undefined && raw.entitlement !== null) {
    snapshot.entitlement = raw.entitlement;
  }
  if (raw.remaining !== undefined && raw.remaining !== null) {
    snapshot.remaining = raw.remaining;
  }
  if (raw.percent_remaining !== undefined && raw.percent_remaining !== null) {
    snapshot.percentRemaining = Math.max(0, Math.min(100, raw.percent_remaining));
  }
  if (raw.unlimited !== undefined && raw.unlimited !== null) {
    snapshot.unlimited = raw.unlimited;
  }
  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

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

/** Fetches GitHub Copilot account quota snapshots from `/copilot_internal/user` when available. */
export async function fetchCopilotUserQuota(options: {
  readonly oauthToken: string;
  readonly fetchFn?: FetchFn;
}): Promise<CopilotQuotaInfo | null> {
  const trimmed = options.oauthToken.trim();
  if (!trimmed || !requiresCopilotSessionExchange(trimmed)) {
    return null;
  }
  try {
    const raw = await getJsonWithManualRedirects({
      url: COPILOT_INTERNAL_USER_URL,
      headers: {
        Authorization: `token ${trimmed}`,
        Accept: 'application/json',
        ...COPILOT_CLIENT_HEADERS,
      },
      allowLoopbackHttp: false,
      secretToRedact: trimmed,
      fetchFn: options.fetchFn,
    });
    const parsed = CopilotUserQuotaPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      return null;
    }
    const data = parsed.data;
    const chat = normalizeQuotaSnapshot(data.quota_snapshots?.chat);
    const premiumInteractions = normalizeQuotaSnapshot(data.quota_snapshots?.premium_interactions);
    const completions = normalizeQuotaSnapshot(data.quota_snapshots?.completions);
    const quotaResetDate = data.quota_reset_date_utc?.trim() || data.quota_reset_date?.trim() || undefined;
    const plan = data.copilot_plan?.trim() || undefined;

    if (!plan && !quotaResetDate && !chat && !premiumInteractions && !completions) {
      return null;
    }
    return {
      ...(plan ? { plan } : {}),
      ...(quotaResetDate ? { quotaResetDate } : {}),
      ...(chat ? { chat } : {}),
      ...(premiumInteractions ? { premiumInteractions } : {}),
      ...(completions ? { completions } : {}),
    };
  } catch {
    return null;
  }
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
    const limits = extractModelLimits(item.capabilities);
    models.push({
      id: item.id,
      name: item.name?.trim() ? item.name.trim() : item.id,
      ...(item.vendor?.trim() ? { vendor: item.vendor.trim() } : {}),
      source: 'subscription',
      ...(limits ? { limits } : {}),
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
  readonly includeQuota?: boolean;
  readonly fetchFn?: FetchFn;
}): Promise<ListCopilotModelsResult> {
  const secret = await options.secretStore.getSecret(llmSecretKey('github-copilot'));
  if (!secret || !secret.trim()) {
    return {
      models: [...CURATED_COPILOT_MODELS],
      source: 'curated',
      warning: null,
      ...(options.includeQuota ? { quota: null } : {}),
    };
  }
  const quotaPromise = options.includeQuota
    ? fetchCopilotUserQuota({ oauthToken: secret, fetchFn: options.fetchFn })
    : Promise.resolve(undefined);

  try {
    const [res, quota] = await Promise.all([
      fetchCopilotSubscriptionModels({
        secret,
        endpointUrl: options.endpointUrl,
        enterpriseSlug: options.enterpriseSlug,
        fetchFn: options.fetchFn,
      }),
      quotaPromise,
    ]);
    return {
      models: [...res.models],
      source: 'subscription',
      warning: null,
      ...(quota !== undefined ? { quota } : {}),
    };
  } catch (error) {
    const msg = scrubSecret(error instanceof Error ? error.message : String(error), secret.trim());
    const quota = await quotaPromise;
    return {
      models: [...CURATED_COPILOT_MODELS],
      source: 'curated',
      warning: msg,
      ...(quota !== undefined ? { quota } : {}),
    };
  }
}
