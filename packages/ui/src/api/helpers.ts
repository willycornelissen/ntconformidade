import type { ByokConfig, DfeCode, NcItemDecision, SecretKeyTarget } from '@ntc/core';

export const DEFAULT_GEMINI_MODEL_ID = 'gemini-3.1-pro-preview';

export const ALL_DFES: readonly DfeCode[] = [
  'NFe',
  'BPe',
  'MDFe',
  'CTe',
  'NF3e',
  'NFCom',
  'GTVe',
  'NFCe',
];

export const ALL_SECRET_KEYS: readonly SecretKeyTarget[] = [
  'ntc:gitea:pat',
  'ntc:llm:gemini',
  'ntc:llm:openai-compatible',
  'ntc:llm:github-copilot',
];

const NC_DECISIONS: readonly NcItemDecision[] = ['APPROVE', 'EDIT', 'SKIP'];
const BYOK_PROVIDERS: readonly ByokConfig['provider'][] = [
  'gemini',
  'openai-compatible',
  'github-copilot',
];
const COPILOT_AUTH_MODES: readonly ('github-models-pat' | 'copilot-oauth-device')[] = [
  'github-models-pat',
  'copilot-oauth-device',
];

export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isDfeCode(value: string): value is DfeCode {
  return (ALL_DFES as readonly string[]).includes(value);
}

export function isNcItemDecision(value: string): value is NcItemDecision {
  return (NC_DECISIONS as readonly string[]).includes(value);
}

export function isByokProvider(value: string): value is ByokConfig['provider'] {
  return (BYOK_PROVIDERS as readonly string[]).includes(value);
}

export function isCopilotAuthMode(
  value: string,
): value is 'github-models-pat' | 'copilot-oauth-device' {
  return (COPILOT_AUTH_MODES as readonly string[]).includes(value);
}

/** Validates renderer HTTPS URL inputs strictly, blocking HTTP and embedded userinfo credentials. */
export function isSafeHttpsUrlInput(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function isSafeEndpointInput(rawUrl: string, allowLoopbackHttp: boolean): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.username || parsed.password || parsed.hash) {
      return false;
    }
    if (parsed.protocol === 'https:') {
      return true;
    }
    if (allowLoopbackHttp && parsed.protocol === 'http:') {
      const host = parsed.hostname.toLowerCase();
      return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    }
    return false;
  } catch {
    return false;
  }
}
