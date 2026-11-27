import { z } from 'zod';
import {
  ByokConfigSchema,
  ConnectionTestResultSchema,
  GITEA_PAT_SECRET_KEY,
  llmSecretKey,
  type ByokConfig,
  type ConnectionTestResult,
  type ConnectionTestStep,
  type DfeRepoEntry,
} from '../domain/types.js';
import { isSafeHttpsUrl } from '../domain/validators.js';
import { parseGiteaRepoUrl } from '../git/gitea-adapter.js';
import { WorktreeManager } from '../git/worktree-manager.js';
import { executeOpenAiChatCompletion, resolveChatCompletionsUrl } from '../llm/adapters/openai-compatible.js';
import {
  COPILOT_CHAT_HEADERS,
  exchangeCopilotSessionToken,
  requiresCopilotSessionExchange,
} from '../llm/copilot-oauth.js';
import {
  HttpStatusError,
  getJsonWithManualRedirects,
  scrubSecret,
  type FetchFn,
} from '../llm/http-client.js';
import type { ExecFileAsyncFn } from '../oracle/xsd-ast-diff.js';
import type { SecretStorePort } from '../ports/interfaces.js';

/** Options for running a live connectivity & inference check against GitHub Copilot. */
export interface TestCopilotConnectionOptions {
  readonly byokConfig: ByokConfig;
  readonly secretStore: SecretStorePort;
  readonly fetchFn?: FetchFn;
}

/** Options for running a live connectivity, permission, and Git HTTPS check against Gitea. */
export interface TestGiteaConnectionOptions {
  readonly giteaUrl: string;
  readonly baseBranch?: string;
  readonly secretStore: SecretStorePort;
  readonly fetchFn?: FetchFn;
  readonly execFileFn?: ExecFileAsyncFn;
  readonly testGitRemote?: boolean;
}

const GiteaUserSchema = z.object({
  login: z.string().optional(),
  username: z.string().optional(),
});

const GiteaRepoSchema = z.object({
  full_name: z.string().optional(),
  default_branch: z.string().optional(),
  permissions: z
    .object({
      pull: z.boolean().optional(),
      push: z.boolean().optional(),
    })
    .optional(),
});

function buildResult(params: {
  readonly ok: boolean;
  readonly target: 'github-copilot' | 'gitea';
  readonly startedAtMs: number;
  readonly summary: string;
  readonly details: string | null;
  readonly steps: readonly ConnectionTestStep[];
  readonly metadata?: Readonly<Record<string, string>>;
}): ConnectionTestResult {
  return ConnectionTestResultSchema.parse({
    ok: params.ok,
    target: params.target,
    checkedAt: new Date().toISOString(),
    latencyMs: Math.max(0, Date.now() - params.startedAtMs),
    summary: params.summary,
    details: params.details,
    steps: [...params.steps],
    ...(params.metadata ? { metadata: params.metadata } : {}),
  });
}

function tryParseGiteaRepo(rawUrl: string): {
  readonly baseUrl: string;
  readonly owner?: string;
  readonly repoName?: string;
} {
  try {
    const parsed = parseGiteaRepoUrl(rawUrl);
    return parsed;
  } catch {
    return { baseUrl: new URL(rawUrl).origin };
  }
}

function buildStubRepoForRemoteCheck(
  giteaUrl: string,
  repoSlug: string,
  baseBranch: string,
): DfeRepoEntry {
  return {
    dfe: 'NFe',
    repoSlug,
    giteaUrl,
    baseBranch,
    basePackage: 'br.gov.mg.fazenda.nfeparser',
    domainPackage: 'br.gov.mg.fazenda.nfeparser.nfe',
    mapperPackage: 'br.gov.mg.fazenda.nfeparser.mapper',
    tablePackage: 'br.gov.mg.fazenda.nfeparser.table',
    parserPackage: 'br.gov.mg.fazenda.nfeparser.parser',
    utilPackage: null,
    tagPrefix: 'NFEPROC',
    svrsRelativePath: '/Nfe/Documentos',
    baselineNt: null,
  };
}

/**
 * Verifies GitHub Copilot subscription credentials, exchanges an OAuth token for an ephemeral
 * Copilot API session when needed, and executes a lightweight ping against the selected model.
 */
export async function testCopilotConnection(
  options: TestCopilotConnectionOptions,
): Promise<ConnectionTestResult> {
  const startedAtMs = Date.now();
  const steps: ConnectionTestStep[] = [];

  const parsedConfig = ByokConfigSchema.safeParse(options.byokConfig);
  if (!parsedConfig.success || parsedConfig.data.provider !== 'github-copilot') {
    return buildResult({
      ok: false,
      target: 'github-copilot',
      startedAtMs,
      summary: 'Configuração BYOK inválida para GitHub Copilot',
      details: parsedConfig.success
        ? `Provedor '${parsedConfig.data.provider}' não suportado; utilize github-copilot.`
        : (parsedConfig.error.issues[0]?.message ?? 'Configuração inválida'),
      steps: [{ name: 'Configuração BYOK', ok: false, message: 'Provedor github-copilot obrigatório' }],
    });
  }

  const copilotConfig = parsedConfig.data;
  const rawSecret = await options.secretStore.getSecret(llmSecretKey('github-copilot'));
  const secret = rawSecret?.trim() ?? '';
  if (!secret) {
    steps.push({
      name: 'Credencial no cofre',
      ok: false,
      message: `Segredo '${llmSecretKey('github-copilot')}' não configurado. Conecte via OAuth Device.`,
    });
    return buildResult({
      ok: false,
      target: 'github-copilot',
      startedAtMs,
      summary: 'GitHub Copilot não conectado',
      details: 'Execute "Conectar com GitHub Copilot (OAuth Device)" na aba BYOK & Doctor.',
      steps,
    });
  }
  steps.push({ name: 'Credencial no cofre', ok: true, message: 'Token OAuth encontrado no cofre seguro' });

  let apiToken = secret;
  let apiOrigin = 'https://api.githubcopilot.com';
  if (requiresCopilotSessionExchange(secret)) {
    try {
      const session = await exchangeCopilotSessionToken(secret, options.fetchFn);
      apiToken = session.token;
      apiOrigin = session.apiOrigin;
      steps.push({
        name: 'Sessão assinatura Copilot',
        ok: true,
        message: `Sessão Copilot ativa obtida (${apiOrigin})`,
      });
    } catch (error) {
      let msg = scrubSecret(error instanceof Error ? error.message : String(error), secret);
      if (error instanceof HttpStatusError) {
        if (error.status === 401) {
          msg = 'Token OAuth do GitHub expirado ou revogado (HTTP 401). Reconecte via OAuth Device.';
        } else if (error.status === 403 || error.status === 404) {
          msg = `Conta GitHub sem assinatura ativa do GitHub Copilot ou acesso bloqueado (HTTP ${error.status}).`;
        }
      }
      steps.push({ name: 'Sessão assinatura Copilot', ok: false, message: msg });
      return buildResult({
        ok: false,
        target: 'github-copilot',
        startedAtMs,
        summary: 'Falha na assinatura/autenticação do GitHub Copilot',
        details: msg,
        steps,
      });
    }
  } else {
    steps.push({
      name: 'Sessão assinatura Copilot',
      ok: true,
      message: 'Token de sessão Copilot direto configurado',
    });
  }

  const extraHeaders: Record<string, string> = { ...COPILOT_CHAT_HEADERS };
  if (copilotConfig.enterpriseSlug) {
    extraHeaders['X-GitHub-Enterprise'] = copilotConfig.enterpriseSlug;
  }
  const chatUrl = copilotConfig.endpointUrl
    ? resolveChatCompletionsUrl(copilotConfig.endpointUrl)
    : resolveChatCompletionsUrl(apiOrigin);

  try {
    const completion = await executeOpenAiChatCompletion({
      url: chatUrl,
      request: {
        config: copilotConfig,
        systemPrompt: 'Responda apenas com JSON válido: {"ok":true}',
        userPrompt: 'Teste de conectividade NT Conformidade.',
        maxOutputTokens: 32,
      },
      apiSecret: apiToken,
      allowLoopbackHttp: false,
      extraHeaders,
      fetchFn: options.fetchFn,
    });
    steps.push({
      name: `Inferência no modelo ${copilotConfig.modelId}`,
      ok: true,
      message: `Modelo respondeu (${completion.usage.totalTokens} tokens)`,
    });
    return buildResult({
      ok: true,
      target: 'github-copilot',
      startedAtMs,
      summary: `GitHub Copilot operacional (${copilotConfig.modelId})`,
      details: `Endpoint: ${apiOrigin} | Tokens: ${completion.usage.totalTokens}`,
      steps,
      metadata: {
        modelId: copilotConfig.modelId,
        apiOrigin,
        totalTokens: String(completion.usage.totalTokens),
      },
    });
  } catch (error) {
    let msg = scrubSecret(
      scrubSecret(error instanceof Error ? error.message : String(error), apiToken),
      secret,
    );
    if (error instanceof HttpStatusError) {
      if (error.status === 400 || error.status === 404) {
        msg = `Modelo '${copilotConfig.modelId}' indisponível ou não habilitado na sua assinatura Copilot (HTTP ${error.status}).`;
      } else if (error.status === 401 || error.status === 403) {
        msg = `Acesso negado ao modelo '${copilotConfig.modelId}' na assinatura Copilot (HTTP ${error.status}).`;
      }
    }
    steps.push({
      name: `Inferência no modelo ${copilotConfig.modelId}`,
      ok: false,
      message: msg,
    });
    return buildResult({
      ok: false,
      target: 'github-copilot',
      startedAtMs,
      summary: `Falha ao testar modelo '${copilotConfig.modelId}' no GitHub Copilot`,
      details: msg,
      steps,
    });
  }
}

/**
 * Verifies Gitea HTTPS URL, PAT authentication (`/api/v1/user`), repository read/push permissions
 * (when a repository URL is provided), and Git CLI HTTPS connectivity (`git ls-remote`).
 */
export async function testGiteaConnection(
  options: TestGiteaConnectionOptions,
): Promise<ConnectionTestResult> {
  const startedAtMs = Date.now();
  const steps: ConnectionTestStep[] = [];
  const giteaUrl = options.giteaUrl.trim();

  if (!isSafeHttpsUrl(giteaUrl, false)) {
    return buildResult({
      ok: false,
      target: 'gitea',
      startedAtMs,
      summary: 'URL do Gitea inválida',
      details: 'URL do Gitea deve utilizar HTTPS sem credenciais embutidas.',
      steps: [{ name: 'Validação URL Gitea', ok: false, message: 'HTTPS sem credenciais obrigatório' }],
    });
  }

  const rawPat = await options.secretStore.getSecret(GITEA_PAT_SECRET_KEY);
  const pat = rawPat?.trim() ?? '';
  if (!pat) {
    steps.push({
      name: 'Token Gitea PAT',
      ok: false,
      message: `Segredo '${GITEA_PAT_SECRET_KEY}' não configurado no cofre.`,
    });
    return buildResult({
      ok: false,
      target: 'gitea',
      startedAtMs,
      summary: 'Token Gitea PAT não configurado',
      details: 'Informe e salve o Token Gitea PAT na configuração BYOK.',
      steps,
    });
  }
  steps.push({ name: 'Token Gitea PAT', ok: true, message: 'PAT presente no cofre seguro' });

  const parsedRepo = tryParseGiteaRepo(giteaUrl);
  let authenticatedUser = '';
  try {
    const rawUser = await getJsonWithManualRedirects({
      url: `${parsedRepo.baseUrl}/api/v1/user`,
      headers: { Authorization: `token ${pat}` },
      allowLoopbackHttp: false,
      allowPrivateHttps: true,
      secretToRedact: pat,
      timeoutMs: 10_000,
      fetchFn: options.fetchFn,
    });
    const parsedUser = GiteaUserSchema.safeParse(rawUser);
    authenticatedUser = parsedUser.success
      ? (parsedUser.data.login ?? parsedUser.data.username ?? '')
      : '';
    steps.push({
      name: 'Autenticação API Gitea',
      ok: true,
      message: authenticatedUser
        ? `PAT autenticado como '${authenticatedUser}'`
        : 'PAT autenticado na API REST do Gitea',
    });
  } catch (error) {
    let msg = scrubSecret(error instanceof Error ? error.message : String(error), pat);
    if (error instanceof HttpStatusError) {
      if (error.status === 401) {
        msg = 'Token Gitea PAT inválido ou expirado (HTTP 401).';
      } else if (error.status === 403) {
        msg = 'Token Gitea PAT sem permissão read:user (HTTP 403).';
      }
    }
    steps.push({ name: 'Autenticação API Gitea', ok: false, message: msg });
    return buildResult({
      ok: false,
      target: 'gitea',
      startedAtMs,
      summary: 'Falha na autenticação com o Gitea',
      details: msg,
      steps,
    });
  }

  if (!parsedRepo.owner || !parsedRepo.repoName) {
    steps.push({
      name: 'Permissões do repositório',
      ok: true,
      message: 'URL base do servidor testada (nenhum repositório específico informado)',
    });
    return buildResult({
      ok: true,
      target: 'gitea',
      startedAtMs,
      summary: authenticatedUser
        ? `Gitea autenticado (${authenticatedUser})`
        : 'Conexão com servidor Gitea validada',
      details: `Servidor: ${parsedRepo.baseUrl}`,
      steps,
      metadata: {
        baseUrl: parsedRepo.baseUrl,
        ...(authenticatedUser ? { username: authenticatedUser } : {}),
      },
    });
  }

  const repoPath = `${parsedRepo.owner}/${parsedRepo.repoName}`;
  let defaultBranch = 'main';
  try {
    const rawRepo = await getJsonWithManualRedirects({
      url: `${parsedRepo.baseUrl}/api/v1/repos/${encodeURIComponent(parsedRepo.owner)}/${encodeURIComponent(parsedRepo.repoName)}`,
      headers: { Authorization: `token ${pat}` },
      allowLoopbackHttp: false,
      allowPrivateHttps: true,
      secretToRedact: pat,
      timeoutMs: 10_000,
      fetchFn: options.fetchFn,
    });
    const repoMeta = GiteaRepoSchema.safeParse(rawRepo);
    if (repoMeta.success && repoMeta.data.default_branch) {
      defaultBranch = repoMeta.data.default_branch;
    }
    if (repoMeta.success && repoMeta.data.permissions?.push === false) {
      const msg = `PAT sem permissão de escrita (push) no repositório '${repoPath}' para abrir Pull Requests.`;
      steps.push({ name: 'Permissões do repositório', ok: false, message: msg });
      return buildResult({
        ok: false,
        target: 'gitea',
        startedAtMs,
        summary: `Sem permissão de escrita em '${repoPath}'`,
        details: msg,
        steps,
      });
    }
    steps.push({
      name: 'Permissões do repositório',
      ok: true,
      message: `Acesso ao repositório '${repoPath}' validado`,
    });
  } catch (error) {
    let msg = scrubSecret(error instanceof Error ? error.message : String(error), pat);
    if (error instanceof HttpStatusError) {
      if (error.status === 404) {
        msg = `Repositório '${repoPath}' não encontrado ou sem acesso (HTTP 404).`;
      } else if (error.status === 403) {
        msg = `Acesso negado ao repositório '${repoPath}' (HTTP 403). Verifique escopos read:repository e write:repository.`;
      }
    }
    steps.push({ name: 'Permissões do repositório', ok: false, message: msg });
    return buildResult({
      ok: false,
      target: 'gitea',
      startedAtMs,
      summary: `Falha ao validar repositório '${repoPath}'`,
      details: msg,
      steps,
    });
  }

  const targetBranch = options.baseBranch?.trim() || defaultBranch;
  if (options.testGitRemote !== false) {
    try {
      const worktrees = new WorktreeManager({
        secretStore: options.secretStore,
        execFileFn: options.execFileFn,
        timeoutMs: 15_000,
      });
      const headSha = await worktrees.getRemoteBranchHead(
        buildStubRepoForRemoteCheck(giteaUrl, parsedRepo.repoName, targetBranch),
        targetBranch,
      );
      steps.push({
        name: 'Git HTTPS (ls-remote)',
        ok: true,
        message: `Branch '${targetBranch}' acessível (${headSha.slice(0, 7)})`,
      });
    } catch (error) {
      const msg = scrubSecret(error instanceof Error ? error.message : String(error), pat);
      steps.push({ name: 'Git HTTPS (ls-remote)', ok: false, message: msg });
      return buildResult({
        ok: false,
        target: 'gitea',
        startedAtMs,
        summary: `Falha no acesso Git HTTPS a '${repoPath}'`,
        details: msg,
        steps,
      });
    }
  }

  return buildResult({
    ok: true,
    target: 'gitea',
    startedAtMs,
    summary: `Gitea operacional para '${repoPath}'`,
    details: authenticatedUser
      ? `Usuário: ${authenticatedUser} | Branch: ${targetBranch}`
      : `Servidor: ${parsedRepo.baseUrl} | Branch: ${targetBranch}`,
    steps,
    metadata: {
      baseUrl: parsedRepo.baseUrl,
      repository: repoPath,
      branch: targetBranch,
      ...(authenticatedUser ? { username: authenticatedUser } : {}),
    },
  });
}
