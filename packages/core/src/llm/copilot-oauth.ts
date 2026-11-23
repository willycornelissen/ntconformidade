import { z } from 'zod';
import { HttpsUrlSchema } from '../domain/types.js';
import {
  getJsonWithManualRedirects,
  postJsonWithManualRedirects,
  type FetchFn,
} from './http-client.js';

/** Official public OAuth Client ID for GitHub Copilot IDE integrations (non-secret). */
export const COPILOT_OAUTH_CLIENT_ID = 'Iv1.b507a08c87ecfe98';

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const COPILOT_INTERNAL_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';
const DEFAULT_COPILOT_API_ORIGIN = 'https://api.githubcopilot.com';

const COPILOT_CLIENT_HEADERS: Readonly<Record<string, string>> = {
  'Editor-Version': 'vscode/1.95.0',
  'Editor-Plugin-Version': 'copilot-chat/0.22.0',
  'User-Agent': 'GithubCopilot/1.155.0',
};

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
