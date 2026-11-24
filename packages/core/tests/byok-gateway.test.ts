import { describe, expect, it, vi } from 'vitest';
import type {
  ByokConfig,
  DfeRepoEntry,
  ExtractedNtPdf,
  NcDocument,
  NtCatalogEntry,
} from '../src/domain/types.js';
import type { SecretStorePort } from '../src/ports/interfaces.js';
import { ByokLlmGateway, ByokTokenLimitError } from '../src/llm/byok-gateway.js';
import { GeminiAdapter } from '../src/llm/adapters/gemini.js';
import { OpenAiCompatibleAdapter } from '../src/llm/adapters/openai-compatible.js';
import { GithubCopilotAdapter } from '../src/llm/adapters/github-copilot.js';
import {
  pollCopilotDeviceToken,
  requestCopilotDeviceCode,
} from '../src/llm/copilot-oauth.js';
import { postJsonWithManualRedirects, type FetchFn } from '../src/llm/http-client.js';
import { DlpViolationError } from '../src/privacy/dlp-filter.js';

const BASE_REPO: DfeRepoEntry = {
  dfe: 'NFe',
  repoSlug: 'nfe-parser',
  giteaUrl: 'https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfe-parser',
  baseBranch: 'main',
  basePackage: 'br.gov.mg.fazenda.nfeparser',
  domainPackage: 'br.gov.mg.fazenda.nfeparser.nfe',
  mapperPackage: 'br.gov.mg.fazenda.nfeparser.mapper',
  tablePackage: 'br.gov.mg.fazenda.nfeparser.table',
  parserPackage: 'br.gov.mg.fazenda.nfeparser.parser',
  utilPackage: 'br.gov.mg.fazenda.nfeparser.util',
  tagPrefix: 'NFEPROC',
  svrsRelativePath: '/Nfe/Documentos',
  baselineNt: null,
};

const BASE_NT: NtCatalogEntry = {
  id: 'NFe:2025.002:1.30',
  dfe: 'NFe',
  ntNumber: '2025.002',
  ntVersion: '1.30',
  publishedDate: '2025-10-15',
  homologDate: null,
  prodDate: null,
  pdfUrl: 'https://dfe-portal.svrs.rs.gov.br/Nfe/Documentos/NT2025_002.pdf',
  xsdUrl: 'https://dfe-portal.svrs.rs.gov.br/Nfe/Documentos/PL_010b.zip',
  pdfSha256: 'a'.repeat(64),
  sourceStatus: 'DOWNLOADED',
  fetchedAt: '2026-11-19T12:00:00.000Z',
};

const BASE_PDF: ExtractedNtPdf = {
  pdfSha256: 'a'.repeat(64),
  totalPages: 2,
  segments: [
    {
      id: 'seg-1',
      title: 'Grupo ICMSTot',
      xmlGroupHint: 'ICMSTot',
      pageStart: 1,
      pageEnd: 2,
      citedText: '[p. 1] Campo vIBSCBS adicionado ao grupo ICMSTot.\n[p. 2] Regra de validação W01.',
      estimatedTokens: 20,
    },
  ],
  warnings: [],
  cached: false,
};

const SAMPLE_NC: NcDocument = {
  nc_id: 'NC-2025.002-v1.30-abc1234',
  nt_ref: {
    dfe: 'NFe',
    nt_number: '2025.002',
    nt_version: '1.30',
    published_date: '2025-10-15',
    pdf_sha256: 'a'.repeat(64),
  },
  base_commit_sha: '1'.repeat(40),
  no_structural_gaps: false,
  summary: 'Inclusão da tag vIBSCBS em ICMSTot',
  semantic_notes: ['Regra W01 trata apenas validação SEFAZ'],
  items: [
    {
      id: 'NC-1',
      category: 'STRUCTURAL_DTO',
      decision: 'APPROVE',
      title: 'Adicionar vIBSCBS em Nfe.java',
      description: 'Tag vIBSCBS do tipo TDec_1302 ausente no DTO.',
      tagPath: 'NFEPROC.NFE.INFNFE.TOTAL.ICMSTOT.VIBSCBS',
      targetPackage: 'domain',
      targetClass: 'Nfe',
      diffKind: 'MISSING_TAG',
      pdfCitations: ['p. 1'],
      suggestedChange: 'private BigDecimal vIBSCBS;',
      editedNotes: null,
      blockerReason: null,
    },
  ],
  created_at: '2026-11-19T12:00:00.000Z',
  updated_at: '2026-11-19T12:00:00.000Z',
};

function makeSecretStore(secrets: Record<string, string>): SecretStorePort {
  return {
    async setSecret(key, value) {
      secrets[key] = value;
    },
    async getSecret(key) {
      return secrets[key] ?? null;
    },
    async getSecretStatus(key) {
      return { configured: Boolean(secrets[key]) };
    },
    async deleteSecret(key) {
      delete secrets[key];
    },
  };
}

describe('BYOK LLM Gateway & Provider Adapters', () => {
  it('LG-01: GeminiAdapter puts API key in x-goog-api-key header (never query string) and parses usage', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};

    const fetchFn: FetchFn = async (url, init) => {
      seenUrl = url;
      seenHeaders = { ...(init.headers as Record<string, string>) };
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(SAMPLE_NC) }] } }],
          usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 80, totalTokenCount: 200 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const adapter = new GeminiAdapter({ fetchFn });
    const config: ByokConfig = {
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      operatorName: 'Operador',
      secretKeyRef: 'ntc:llm:gemini',
      temperature: 0.1,
    };

    const res = await adapter.completeStructured(
      { config, systemPrompt: 'sys', userPrompt: 'usr', maxOutputTokens: 1024 },
      'AIza-secret-test-key',
    );

    expect(seenUrl).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
    );
    expect(seenUrl).not.toContain('key=');
    expect(seenHeaders['x-goog-api-key']).toBe('AIza-secret-test-key');
    expect(res.usage).toEqual({
      promptTokens: 120,
      completionTokens: 80,
      totalTokens: 200,
      stage: 'llm-call',
    });
    expect(JSON.parse(res.rawText).nc_id).toBe(SAMPLE_NC.nc_id);
  });

  it('LG-02: OpenAiCompatibleAdapter supports local Ollama loopback HTTP and Bearer header', async () => {
    let seenUrl = '';
    let seenAuth = '';
    let seenOrg = '';

    const fetchFn: FetchFn = async (url, init) => {
      seenUrl = url;
      const headers = init.headers as Record<string, string>;
      seenAuth = headers['Authorization'] ?? '';
      seenOrg = headers['OpenAI-Organization'] ?? '';
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '```json\n{"edits":[],"creates":[]}\n```' } }],
          usage: { prompt_tokens: 50, completion_tokens: 15, total_tokens: 65 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const adapter = new OpenAiCompatibleAdapter({ fetchFn });
    const config: ByokConfig = {
      provider: 'openai-compatible',
      modelId: 'qwen2.5-coder:32b',
      operatorName: 'Operador',
      secretKeyRef: 'ntc:llm:openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      organizationId: 'fazenda-mg',
    };

    const res = await adapter.completeStructured(
      { config, systemPrompt: 'sys', userPrompt: 'usr' },
      'local-dummy-token',
    );

    expect(seenUrl).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(seenAuth).toBe('Bearer local-dummy-token');
    expect(seenOrg).toBe('fazenda-mg');
    expect(res.usage.totalTokens).toBe(65);
  });

  it('LG-03: GithubCopilotAdapter routes github-models-pat directly and exchanges OAuth token for Copilot session with caching & 401 refresh', async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    let tokenIssueCount = 0;
    let rejectNextSession = false;

    const fetchFn: FetchFn = async (url, init) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: headers['Authorization'] ?? '' });
      if (url === 'https://api.github.com/copilot_internal/v2/token') {
        tokenIssueCount += 1;
        return new Response(
          JSON.stringify({
            token: `tid=copilot_session_${tokenIssueCount};exp=9999999999`,
            expires_at: Math.floor(Date.now() / 1000) + 1800,
            endpoints: { api: 'https://api.githubcopilot.com' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (rejectNextSession) {
        rejectNextSession = false;
        return new Response('session expired', { status: 401 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"edits":[],"creates":[]}' } }],
          usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const adapter = new GithubCopilotAdapter({ fetchFn });

    await adapter.completeStructured(
      {
        config: {
          provider: 'github-copilot',
          modelId: 'gpt-4o',
          operatorName: 'Op',
          secretKeyRef: 'ntc:llm:github-copilot',
          authMode: 'github-models-pat',
        },
        systemPrompt: 'sys',
        userPrompt: 'usr',
      },
      'ghp_pat_token',
    );

    await adapter.completeStructured(
      {
        config: {
          provider: 'github-copilot',
          modelId: 'claude-3.7-sonnet',
          operatorName: 'Op',
          secretKeyRef: 'ntc:llm:github-copilot',
          authMode: 'copilot-oauth-device',
        },
        systemPrompt: 'sys',
        userPrompt: 'usr',
      },
      'ghu_oauth_token',
    );

    // Second call reuses cached Copilot session token without re-calling /copilot_internal/v2/token
    await adapter.completeStructured(
      {
        config: {
          provider: 'github-copilot',
          modelId: 'claude-3.7-sonnet',
          operatorName: 'Op',
          secretKeyRef: 'ntc:llm:github-copilot',
          authMode: 'copilot-oauth-device',
        },
        systemPrompt: 'sys',
        userPrompt: 'usr',
      },
      'ghu_oauth_token',
    );

    // 401 from Copilot chat endpoint evicts cache and refreshes session token once
    rejectNextSession = true;
    await adapter.completeStructured(
      {
        config: {
          provider: 'github-copilot',
          modelId: 'claude-3.7-sonnet',
          operatorName: 'Op',
          secretKeyRef: 'ntc:llm:github-copilot',
          authMode: 'copilot-oauth-device',
        },
        systemPrompt: 'sys',
        userPrompt: 'usr',
      },
      'ghu_oauth_token',
    );

    expect(calls).toEqual([
      { url: 'https://models.inference.ai.azure.com/chat/completions', auth: 'Bearer ghp_pat_token' },
      { url: 'https://api.github.com/copilot_internal/v2/token', auth: 'token ghu_oauth_token' },
      { url: 'https://api.githubcopilot.com/chat/completions', auth: 'Bearer tid=copilot_session_1;exp=9999999999' },
      { url: 'https://api.githubcopilot.com/chat/completions', auth: 'Bearer tid=copilot_session_1;exp=9999999999' },
      { url: 'https://api.githubcopilot.com/chat/completions', auth: 'Bearer tid=copilot_session_1;exp=9999999999' },
      { url: 'https://api.github.com/copilot_internal/v2/token', auth: 'token ghu_oauth_token' },
      { url: 'https://api.githubcopilot.com/chat/completions', auth: 'Bearer tid=copilot_session_2;exp=9999999999' },
    ]);

    const startRes = await requestCopilotDeviceCode(async () =>
      new Response(
        JSON.stringify({
          device_code: 'dev-code-1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        }),
        { status: 200 },
      ),
    );
    expect(startRes.userCode).toBe('ABCD-1234');
    expect(startRes.verificationUri).toBe('https://github.com/login/device');

    const pendingRes = await pollCopilotDeviceToken('dev-code-1', async () =>
      new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 200 }),
    );
    expect(pendingRes).toEqual({ status: 'pending' });

    const authRes = await pollCopilotDeviceToken('dev-code-1', async () =>
      new Response(JSON.stringify({ access_token: 'ghu_real_user_token' }), { status: 200 }),
    );
    expect(authRes).toEqual({ status: 'authorized', accessToken: 'ghu_real_user_token' });
  });

  it('LG-04: http-client uses redirect:manual, blocks SSRF redirects, and scrubs secrets on errors', async () => {
    const fetchFn: FetchFn = async (_url, init) => {
      expect(init.redirect).toBe('manual');
      return new Response('', {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      });
    };

    await expect(
      postJsonWithManualRedirects({
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { Authorization: 'Bearer super-secret-xyz' },
        body: { test: true },
        allowLoopbackHttp: false,
        secretToRedact: 'super-secret-xyz',
        fetchFn,
      }),
    ).rejects.toThrow(/redirecionamento inseguro|SSRF|bloquead/i);

    const leakingFetch: FetchFn = async () =>
      new Response('Invalid key super-secret-xyz supplied', { status: 401 });

    let caughtMessage = '';
    try {
      await postJsonWithManualRedirects({
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { Authorization: 'Bearer super-secret-xyz' },
        body: { test: true },
        allowLoopbackHttp: false,
        secretToRedact: 'super-secret-xyz',
        fetchFn: leakingFetch,
      });
    } catch (error) {
      caughtMessage = error instanceof Error ? error.message : String(error);
    }

    expect(caughtMessage).toContain('401');
    expect(caughtMessage).not.toContain('super-secret-xyz');
  });

  it('LG-05: DLP pre-flight blocks test-files/** and missing secret before calling HTTP', async () => {
    const fetchSpy = vi.fn<FetchFn>();
    const gateway = new ByokLlmGateway({
      secretStore: makeSecretStore({ 'ntc:llm:gemini': 'secret-123' }),
      adapters: [new GeminiAdapter({ fetchFn: fetchSpy })],
    });

    const geminiConfig: ByokConfig = {
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      operatorName: 'Op',
      secretKeyRef: 'ntc:llm:gemini',
    };

    await expect(
      gateway.analyzeCompliance({
        config: geminiConfig,
        repo: BASE_REPO,
        nt: BASE_NT,
        baseCommitSha: '1'.repeat(40),
        pdf: BASE_PDF,
        diffFindings: [],
        javaContextFiles: [
          {
            filePath: 'test-files/secret-taxpayer-invoice.xml',
            content: '<NFe><CPF>12345678901</CPF></NFe>',
          },
        ],
      }),
    ).rejects.toThrow(DlpViolationError);
    expect(fetchSpy).not.toHaveBeenCalled();

    const emptySecretGateway = new ByokLlmGateway({
      secretStore: makeSecretStore({}),
      adapters: [new GeminiAdapter({ fetchFn: fetchSpy })],
    });

    await expect(
      emptySecretGateway.generatePatch({
        config: geminiConfig,
        nc: SAMPLE_NC,
        javaContextFiles: [{ filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java', content: 'class Nfe {}' }],
      }),
    ).rejects.toThrow(/Segredo BYOK não configurado/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('LG-06: enforces maxTokensPerStage / contextWindowLimit before sending network requests', async () => {
    const fetchSpy = vi.fn<FetchFn>();
    const gateway = new ByokLlmGateway({
      secretStore: makeSecretStore({ 'ntc:llm:github-copilot': 'ghp_abc123' }),
      adapters: [new GithubCopilotAdapter({ fetchFn: fetchSpy })],
    });

    const config: ByokConfig = {
      provider: 'github-copilot',
      modelId: 'gpt-4o',
      operatorName: 'Op',
      secretKeyRef: 'ntc:llm:github-copilot',
      authMode: 'github-models-pat',
      maxTokensPerStage: 50,
    };

    await expect(
      gateway.analyzeCompliance({
        config,
        repo: BASE_REPO,
        nt: BASE_NT,
        baseCommitSha: '1'.repeat(40),
        pdf: BASE_PDF,
        diffFindings: [],
        javaContextFiles: [
          {
            filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java',
            content: 'x'.repeat(2000),
          },
        ],
      }),
    ).rejects.toThrow(ByokTokenLimitError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('LG-07: analyzeCompliance, generatePatch, and repairPatch validate Zod schemas and attach stage usage', async () => {
    const capturedBodies: string[] = [];
    let callIndex = 0;

    const fetchFn: FetchFn = async (_url, init) => {
      capturedBodies.push(String(init.body));
      callIndex += 1;
      const responseJson =
        callIndex === 1
          ? SAMPLE_NC
          : {
              summary: callIndex === 2 ? 'Patch inicial' : 'Patch corrigido',
              edits: [
                {
                  filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java',
                  searchBlock: 'private BigDecimal vProd;',
                  replaceBlock: 'private BigDecimal vProd;\nprivate BigDecimal vIBSCBS;',
                },
              ],
              creates: [
                {
                  filePath: 'src/test/resources/synthetic/nt_2025_002_valid.xml',
                  content: '<nfeProc/>',
                },
              ],
            };

      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: `\`\`\`json\n${JSON.stringify(responseJson)}\n\`\`\`` }] } },
          ],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, totalTokenCount: 140 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const gateway = new ByokLlmGateway({
      secretStore: makeSecretStore({ 'ntc:llm:gemini': 'AIza-valid' }),
      adapters: [new GeminiAdapter({ fetchFn })],
    });

    const config: ByokConfig = {
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      operatorName: 'Op',
      secretKeyRef: 'ntc:llm:gemini',
      maxTokensPerStage: 20_000,
    };

    const ncRes = await gateway.analyzeCompliance({
      config,
      repo: BASE_REPO,
      nt: BASE_NT,
      baseCommitSha: '1'.repeat(40),
      pdf: BASE_PDF,
      diffFindings: [],
      javaContextFiles: [
        { filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java', content: 'class Nfe {}' },
      ],
    });
    expect(ncRes.nc.nc_id).toBe(SAMPLE_NC.nc_id);
    expect(ncRes.usage.stage).toBe('compliance-analysis');

    const patchRes = await gateway.generatePatch({
      config,
      nc: ncRes.nc,
      repo: BASE_REPO,
      xsdSummary: 'NFEPROC.NFE.INFNFE.TOTAL.ICMSTOT.VIBSCBS (TDec_1302)',
      javaContextFiles: [
        { filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java', content: 'private BigDecimal vProd;' },
      ],
    });
    expect(patchRes.payload.edits).toHaveLength(1);
    expect(patchRes.usage.stage).toBe('patch-generation');

    const repairRes = await gateway.repairPatch({
      config,
      nc: ncRes.nc,
      javaContextFiles: [
        { filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java', content: 'private BigDecimal vProd;' },
      ],
      repairFeedback: 'Faltou getter getVIBSCBS() em Nfe.java',
    });
    expect(repairRes.payload.summary).toBe('Patch corrigido');
    expect(repairRes.usage.stage).toBe('patch-repair');
    expect(capturedBodies[2]).toContain('Faltou getter getVIBSCBS()');
  });

  it('LG-08: blocks cross-origin credential redirects, HTTPS->HTTP downgrades, and validates malformed adapter JSON', async () => {
    await expect(
      postJsonWithManualRedirects({
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { Authorization: 'Bearer tok-secret-99' },
        body: {},
        allowLoopbackHttp: true,
        secretToRedact: 'tok-secret-99',
        maxRedirects: 2,
        fetchFn: async () =>
          new Response('', { status: 302, headers: { location: 'https://evil.example.com/steal' } }),
      }),
    ).rejects.toThrow(/cross-origin|SSRF/i);

    await expect(
      postJsonWithManualRedirects({
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {},
        body: {},
        allowLoopbackHttp: true,
        maxRedirects: 2,
        fetchFn: async () =>
          new Response('', { status: 302, headers: { location: 'http://127.0.0.1:11434/v1/chat/completions' } }),
      }),
    ).rejects.toThrow(/HTTPS -> HTTP|SSRF/i);

    const openAi = new OpenAiCompatibleAdapter({
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: [{ type: 'text', text: '{"edits":[],"creates":[]}' }] } }],
          }),
          { status: 200 },
        ),
    });
    const partRes = await openAi.completeStructured(
      {
        config: {
          provider: 'openai-compatible',
          modelId: 'gpt-4o',
          operatorName: 'Op',
          secretKeyRef: 'ntc:llm:openai-compatible',
          baseUrl: 'https://my.resource.openai.azure.com/openai/deployments/d1?api-version=2024-06-01',
        },
        systemPrompt: 'sys',
        userPrompt: 'usr',
      },
      'secret',
    );
    expect(JSON.parse(partRes.rawText)).toEqual({ edits: [], creates: [] });

    const badGemini = new GeminiAdapter({
      fetchFn: async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
    });
    await expect(
      badGemini.completeStructured(
        {
          config: { provider: 'gemini', modelId: 'models/gemini-2.5-pro', operatorName: 'Op', secretKeyRef: 'ntc:llm:gemini' },
          systemPrompt: 'sys',
          userPrompt: 'usr',
        },
        'secret',
      ),
    ).rejects.toThrow(/vazia/i);

    await expect(
      postJsonWithManualRedirects({
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {},
        body: {},
        allowLoopbackHttp: false,
        fetchFn: async () => new Response('', { status: 302 }),
      }),
    ).rejects.toThrow(/sem header Location/i);

    await expect(
      postJsonWithManualRedirects({
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {},
        body: {},
        allowLoopbackHttp: false,
        maxRedirects: 0,
        fetchFn: async () =>
          new Response('', { status: 302, headers: { location: 'https://api.openai.com/v2' } }),
      }),
    ).rejects.toThrow(/Redirecionamento bloqueado/i);

    await expect(
      postJsonWithManualRedirects({
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {},
        body: {},
        allowLoopbackHttp: false,
        secretToRedact: 'sec-transport-99',
        fetchFn: async () => {
          throw new Error('ECONNRESET sec-transport-99');
        },
      }),
    ).rejects.toThrow(/\[REDACTED\]/);

    await expect(
      postJsonWithManualRedirects({
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {},
        body: {},
        allowLoopbackHttp: false,
        fetchFn: async () => new Response('not-json', { status: 200 }),
      }),
    ).rejects.toThrow(/JSON inválida/i);

    const { extractJsonFromLlmText } = await import('../src/llm/prompt-builder.js');
    expect(extractJsonFromLlmText('Here is JSON: {"ok":true} done')).toEqual({ ok: true });
    expect(() => extractJsonFromLlmText('prose {bad json} tail')).toThrow(/não contém JSON/i);
  });

  it('LG-09: normalizes LLM NC metadata, Java package aliases, and diffKind synonyms while rejecting NT mismatch', async () => {
    let capturedPrompt = '';
    const llmDraftWithQuirks = {
      nc_id: 'NC-2025.002-v1.30',
      nt_ref: {
        dfe: 'NFe',
        nt_number: '2025.002',
        nt_version: '1.30',
        published_date: '2025-10-15',
        pdf_sha256: 'not-a-valid-sha256',
      },
      base_commit_sha: 'invalid-sha',
      no_structural_gaps: false,
      items: [
        {
          id: 'NC-1',
          category: 'STRUCTURAL_MAPPER',
          decision: 'APPROVE',
          title: 'Mapear tag',
          description: 'Adicionar mapeamento',
          tagPath: 'NFEPROC.NFE.INFNFE.TOTAL.ICMSTOT.VIBSCBS',
          targetPackage: 'br.gov.mg.fazenda.nfeparser.mapper',
          targetClass: 'TotalMapper',
          diffKind: 'NEW_TAG',
          pdfCitations: ['p. 1'],
          suggestedChange: null,
          editedNotes: null,
          blockerReason: null,
        },
        {
          id: 'NC-2',
          category: 'STRUCTURAL_DTO',
          decision: 'APPROVE',
          title: 'Adicionar campo DTO',
          description: 'Adicionar campo no DTO',
          tagPath: 'NFEPROC.NFE.INFNFE.TOTAL.ICMSTOT.VIBSCBS',
          targetPackage: 'nfe',
          targetClass: 'IcmsTot',
          diffKind: 'CARDINALITY',
          pdfCitations: ['p. 1'],
        },
        {
          id: 'NC-3',
          category: 'STRUCTURAL_TABLE',
          decision: 'APPROVE',
          title: 'Atualizar tabela',
          description: 'Atualizar tipo na tabela',
          tagPath: '',
          targetPackage: 'br.gov.mg.fazenda.nfeparser.table',
          targetClass: '',
          diffKind: 'TYPE',
          pdfCitations: ['p. 2'],
        },
        {
          id: 'NC-4',
          category: 'SHARED_XML_PARSER_BLOCKER',
          decision: 'APPROVE',
          title: 'Parser compartilhado',
          description: 'Alteração no parser',
          tagPath: null,
          targetPackage: 'br.gov.mg.fazenda.nfeparser.parser',
          targetClass: null,
          diffKind: '',
          pdfCitations: [],
          blockerReason: 'Requer ajuste em xml-parser',
        },
        {
          id: 'NC-5',
          category: 'SEMANTIC_RULE_INFO_ONLY',
          decision: 'SKIP',
          title: 'Regra de validação W01',
          description: 'Informativo semântico',
          tagPath: null,
          targetPackage: 'none',
          targetClass: null,
          diffKind: 'VALIDATION_RULE',
          pdfCitations: ['p. 2'],
        },
      ],
      created_at: '2026-11-24T10:00:00',
      updated_at: 'invalid-date',
    };

    const gateway = new ByokLlmGateway({
      secretStore: makeSecretStore({ 'ntc:llm:gemini': 'AIza-valid' }),
      adapters: [
        new GeminiAdapter({
          fetchFn: async (_url, init) => {
            capturedPrompt = String(init.body);
            return new Response(
              JSON.stringify({
                candidates: [{ content: { parts: [{ text: JSON.stringify(llmDraftWithQuirks) }] } }],
                usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 30, totalTokenCount: 80 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          },
        }),
      ],
    });

    const res = await gateway.analyzeCompliance({
      config: {
        provider: 'gemini',
        modelId: 'gemini-2.5-pro',
        operatorName: 'Op',
        secretKeyRef: 'ntc:llm:gemini',
      },
      repo: BASE_REPO,
      nt: { ...BASE_NT, ntVersion: 'v1.30' },
      baseCommitSha: '2'.repeat(40),
      pdf: BASE_PDF,
      diffFindings: [],
      javaContextFiles: [{ filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java', content: 'class Nfe {}' }],
    });

    expect(capturedPrompt).toContain(BASE_PDF.pdfSha256);
    expect(capturedPrompt).toContain('targetPackage (\\"mapper\\"|\\"domain\\"|\\"table\\"|\\"xml-parser\\"|\\"none\\"|null)');
    expect(res.nc.nt_ref.nt_version).toBe('v1.30');
    expect(res.nc.nt_ref.pdf_sha256).toBe(BASE_PDF.pdfSha256);
    expect(res.nc.base_commit_sha).toBe('2'.repeat(40));
    expect(res.nc.items.map((i) => i.targetPackage)).toEqual([
      'mapper',
      'domain',
      'table',
      'xml-parser',
      'none',
    ]);
    expect(res.nc.items.map((i) => i.diffKind)).toEqual([
      'MISSING_TAG',
      'CARDINALITY_MISMATCH',
      'TYPE_MISMATCH',
      null,
      null,
    ]);

    const mismatchedGateway = new ByokLlmGateway({
      secretStore: makeSecretStore({ 'ntc:llm:gemini': 'AIza-valid' }),
      adapters: [
        new GeminiAdapter({
          fetchFn: async () =>
            new Response(
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          text: JSON.stringify({
                            ...llmDraftWithQuirks,
                            nt_ref: { ...llmDraftWithQuirks.nt_ref, dfe: 'CTe' },
                          }),
                        },
                      ],
                    },
                  },
                ],
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
        }),
      ],
    });
    await expect(
      mismatchedGateway.analyzeCompliance({
        config: {
          provider: 'gemini',
          modelId: 'gemini-2.5-pro',
          operatorName: 'Op',
          secretKeyRef: 'ntc:llm:gemini',
        },
        repo: BASE_REPO,
        nt: BASE_NT,
        baseCommitSha: '2'.repeat(40),
        pdf: BASE_PDF,
        diffFindings: [],
        javaContextFiles: [{ filePath: 'src/main/java/br/gov/mg/fazenda/nfeparser/nfe/Nfe.java', content: 'class Nfe {}' }],
      }),
    ).rejects.toThrow(/diverge da NT analisada/i);
  });
});
