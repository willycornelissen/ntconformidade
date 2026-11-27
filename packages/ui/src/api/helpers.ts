import type {
  ByokConfig,
  CopilotModelOption,
  DfeCode,
  NcItemDecision,
  SecretKeyTarget,
} from '@ntc/core';

export const DEFAULT_COPILOT_MODEL_ID = 'gpt-4.1';

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

export const COPILOT_BYOK_SECRET_KEYS: readonly SecretKeyTarget[] = [
  'ntc:gitea:pat',
  'ntc:llm:github-copilot',
];

export type CopilotByokConfig = Extract<ByokConfig, { provider: 'github-copilot' }>;

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

const NC_DECISIONS: readonly NcItemDecision[] = ['APPROVE', 'EDIT', 'SKIP'];

export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isDfeCode(value: string): value is DfeCode {
  return (ALL_DFES as readonly string[]).includes(value);
}

export function isNcItemDecision(value: string): value is NcItemDecision {
  return (NC_DECISIONS as readonly string[]).includes(value);
}

/** Coerces any persisted or default BYOK config into a GitHub Copilot OAuth subscription config. */
export function normalizeCopilotByokConfig(config?: ByokConfig | null): CopilotByokConfig {
  const isCopilot = config?.provider === 'github-copilot';
  const modelId =
    isCopilot && config.modelId.trim() ? config.modelId.trim() : DEFAULT_COPILOT_MODEL_ID;
  return {
    provider: 'github-copilot',
    modelId,
    operatorName: config?.operatorName?.trim() || 'Operador',
    secretKeyRef: 'ntc:llm:github-copilot',
    authMode: 'copilot-oauth-device',
    ...(isCopilot && config.endpointUrl ? { endpointUrl: config.endpointUrl } : {}),
    ...(isCopilot && config.enterpriseSlug ? { enterpriseSlug: config.enterpriseSlug } : {}),
    ...(isCopilot && config.contextWindowLimit !== undefined
      ? { contextWindowLimit: config.contextWindowLimit }
      : {}),
    ...(config?.maxTokensPerStage !== undefined
      ? { maxTokensPerStage: config.maxTokensPerStage }
      : {}),
    ...(config?.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config?.giteaBaseUrl ? { giteaBaseUrl: config.giteaBaseUrl } : {}),
  };
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

export function extractUrlOrigin(rawUrl: string): string | null {
  try {
    return new URL(rawUrl.trim()).origin;
  } catch {
    return null;
  }
}

export function rewriteRepoOrigin(repoUrl: string, targetBaseUrl: string): string {
  const repoParsed = new URL(repoUrl.trim());
  const baseParsed = new URL(targetBaseUrl.trim());
  return `${baseParsed.origin}${repoParsed.pathname}`;
}
