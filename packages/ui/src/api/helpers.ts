import type {
  ByokConfig,
  CopilotModelOption,
  CopilotQuotaInfo,
  CopilotQuotaSnapshot,
  DfeCode,
  ListCopilotModelsResult,
  NcItemDecision,
  SecretKeyTarget,
} from '@ntc/core';

export const DEFAULT_COPILOT_MODEL_ID = 'gpt-4.1';

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

export interface ByokTokenAvailability {
  readonly modelId: string;
  readonly modelName: string;
  readonly isConnected: boolean;
  readonly source: 'subscription' | 'curated';
  readonly maxPromptTokens: number | null;
  readonly maxContextWindowTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly configuredStageLimit: number | null;
  readonly effectiveAvailableTokens: number | null;
  readonly quota: CopilotQuotaInfo | null;
  readonly quotaSummaryText: string | null;
  readonly buttonBadgeText: string;
  readonly buttonTooltip: string;
}

export function formatTokenCountShort(tokens: number): string {
  if (tokens >= 1_000_000) {
    const val = tokens / 1_000_000;
    const text = Number.isInteger(val) ? String(val) : val.toFixed(1).replace('.', ',');
    return `${text}M`;
  }
  if (tokens >= 1_000) {
    const val = tokens / 1_000;
    const text = Number.isInteger(val) ? String(val) : val.toFixed(1).replace('.', ',');
    return `${text}k`;
  }
  return String(tokens);
}

export function formatTokenCountExact(tokens: number): string {
  return tokens.toLocaleString('pt-BR');
}

function pickPrimaryQuotaSnapshot(
  quota: CopilotQuotaInfo | null | undefined,
): { readonly label: string; readonly snapshot: CopilotQuotaSnapshot } | null {
  if (!quota) {
    return null;
  }
  if (quota.premiumInteractions) {
    return { label: 'Premium', snapshot: quota.premiumInteractions };
  }
  if (quota.chat) {
    return { label: 'Chat', snapshot: quota.chat };
  }
  if (quota.completions) {
    return { label: 'Completions', snapshot: quota.completions };
  }
  return null;
}

function formatQuotaLabel(quota: CopilotQuotaInfo | null | undefined): {
  readonly compact: string | null;
  readonly detailed: string | null;
} {
  const picked = pickPrimaryQuotaSnapshot(quota);
  if (!picked) {
    if (quota?.plan) {
      return { compact: null, detailed: `Plano ${quota.plan}` };
    }
    return { compact: null, detailed: null };
  }
  const { label, snapshot } = picked;
  const planPrefix = quota?.plan ? `Plano ${quota.plan} · ` : '';
  if (snapshot.unlimited) {
    return {
      compact: 'Ilimitado',
      detailed: `${planPrefix}${label}: ilimitado`,
    };
  }
  if (snapshot.remaining !== undefined && snapshot.entitlement !== undefined) {
    const rem = Math.round(snapshot.remaining);
    const ent = Math.round(snapshot.entitlement);
    const pct =
      snapshot.percentRemaining !== undefined
        ? ` (${Math.round(snapshot.percentRemaining)}%)`
        : '';
    return {
      compact: `${rem}/${ent}`,
      detailed: `${planPrefix}${label}: ${rem}/${ent} restantes${pct}`,
    };
  }
  if (snapshot.percentRemaining !== undefined) {
    const pct = `${Math.round(snapshot.percentRemaining)}%`;
    return {
      compact: `${pct} cota`,
      detailed: `${planPrefix}${label}: ${pct} restante`,
    };
  }
  return {
    compact: null,
    detailed: quota?.plan ? `Plano ${quota.plan}` : null,
  };
}

export function buildByokTokenAvailability(
  byokConfig: ByokConfig | null | undefined,
  modelsResult: ListCopilotModelsResult | null | undefined,
  isConnected: boolean,
): ByokTokenAvailability {
  const normalized = normalizeCopilotByokConfig(byokConfig);
  const models = modelsResult?.models ?? CURATED_COPILOT_MODELS;
  const matchedModel = models.find((m) => m.id === normalized.modelId);
  const fallbackModel = CURATED_COPILOT_MODELS.find((m) => m.id === normalized.modelId);
  const limits = matchedModel?.limits ?? fallbackModel?.limits;

  const maxPromptTokens = limits?.maxPromptTokens ?? null;
  const maxContextWindowTokens = limits?.maxContextWindowTokens ?? null;
  const maxOutputTokens = limits?.maxOutputTokens ?? null;

  const configuredLimits: number[] = [];
  if (normalized.maxTokensPerStage !== undefined) {
    configuredLimits.push(normalized.maxTokensPerStage);
  }
  if (normalized.contextWindowLimit !== undefined) {
    configuredLimits.push(normalized.contextWindowLimit);
  }
  const configuredStageLimit = configuredLimits.length > 0 ? Math.min(...configuredLimits) : null;

  const modelInputLimit = maxPromptTokens ?? maxContextWindowTokens;
  let effectiveAvailableTokens: number | null = null;
  if (configuredStageLimit !== null && modelInputLimit !== null) {
    effectiveAvailableTokens = Math.min(configuredStageLimit, modelInputLimit);
  } else {
    effectiveAvailableTokens = configuredStageLimit ?? modelInputLimit;
  }

  const quota = modelsResult?.quota ?? null;
  const quotaText = formatQuotaLabel(quota);
  const tokPart =
    effectiveAvailableTokens !== null ? `${formatTokenCountShort(effectiveAvailableTokens)} tok` : null;
  const statusPart = isConnected ? quotaText.compact : 'Desconectado';
  const badgeParts = [tokPart, statusPart].filter((p): p is string => Boolean(p));
  const buttonBadgeText =
    badgeParts.length > 0 ? badgeParts.join(' · ') : isConnected ? 'Conectado' : 'Desconectado';

  const tooltipParts = [
    `Modelo LLM: ${normalized.modelId}`,
    effectiveAvailableTokens !== null
      ? `Tokens disponíveis p/ operação (prompt): ${formatTokenCountExact(effectiveAvailableTokens)}`
      : 'Tokens disponíveis p/ operação: não informado pelo modelo',
    maxContextWindowTokens !== null
      ? `Janela de contexto: ${formatTokenCountExact(maxContextWindowTokens)} tokens`
      : null,
    maxOutputTokens !== null ? `Saída máx.: ${formatTokenCountExact(maxOutputTokens)} tokens` : null,
    `Assinatura Copilot: ${isConnected ? 'Conectada' : 'Não conectada'}`,
    quotaText.detailed ? `Cota: ${quotaText.detailed}` : null,
  ].filter((p): p is string => Boolean(p));

  return {
    modelId: normalized.modelId,
    modelName: matchedModel?.name ?? fallbackModel?.name ?? normalized.modelId,
    isConnected,
    source: modelsResult?.source ?? 'curated',
    maxPromptTokens,
    maxContextWindowTokens,
    maxOutputTokens,
    configuredStageLimit,
    effectiveAvailableTokens,
    quota,
    quotaSummaryText: quotaText.detailed,
    buttonBadgeText,
    buttonTooltip: tooltipParts.join(' | '),
  };
}

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
