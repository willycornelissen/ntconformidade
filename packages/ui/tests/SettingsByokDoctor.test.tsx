import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ByokConfig, DfeRepoEntry } from '@ntc/core';
import { SettingsByokDoctor } from '../src/pages/SettingsByokDoctor.js';
import { makeMockApi } from './mock-api.js';

const SAMPLE_REPO: DfeRepoEntry = {
  dfe: 'NFe',
  repoSlug: 'nfe-parser',
  giteaUrl: 'https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfe-parser',
  baseBranch: 'main',
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

describe('SettingsByokDoctor', () => {
  it('UI-SD-01: saves Gitea server URL and PAT in BYOK without rendering plaintext secrets and runs Doctor', async () => {
    const user = userEvent.setup();
    const configuredKeys = new Set<string>();
    const setSecret = vi.fn(async ({ key }: { key: string }) => {
      configuredKeys.add(key);
      return { configured: true };
    });
    const saveByokConfig = vi.fn(async (cfg: ByokConfig) => cfg);
    const saveRepo = vi.fn(async (repo: DfeRepoEntry) => repo);
    const runDoctor = vi.fn(async () => ({
      ok: true,
      checkedAt: '2026-11-19T12:00:00.000Z',
      checks: [
        {
          id: 'JAVA_JDK' as const,
          status: 'OK' as const,
          summary: 'JDK 21 detectado',
          details: 'needsRelease8Flag=true',
          needsRelease8Flag: true,
        },
        { id: 'MAVEN' as const, status: 'OK' as const, summary: 'Apache Maven 3.8.7', details: null },
      ],
    }));
    const onChangeConfig = vi.fn();

    const api = makeMockApi({
      listRepos: vi.fn(async () => [SAMPLE_REPO]),
      saveRepo,
      saveByokConfig,
      getSecretStatus: vi.fn(async ({ key }) => ({ configured: configuredKeys.has(key) })),
      setSecret,
      runDoctor,
    });

    const initialConfig: ByokConfig = {
      provider: 'github-copilot',
      modelId: 'gpt-4.1',
      operatorName: 'Willy',
      secretKeyRef: 'ntc:llm:github-copilot',
      authMode: 'copilot-oauth-device',
    };

    const { container } = render(
      <SettingsByokDoctor
        api={api}
        byokConfig={initialConfig}
        onChangeConfig={onChangeConfig}
      />,
    );

    const serverInput = await screen.findByLabelText(/URL do Servidor Gitea/i);
    await user.clear(serverInput);
    await user.type(serverInput, 'https://git.fazenda.mg.gov.br');

    const giteaInput = screen.getByLabelText(/Token Gitea PAT/i);
    await user.type(giteaInput, 'pat-secret-never-render');
    await user.click(screen.getByRole('button', { name: /Salvar Acesso Gitea/i }));

    expect(setSecret).toHaveBeenCalledWith({
      key: 'ntc:gitea:pat',
      value: 'pat-secret-never-render',
    });
    expect(saveByokConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github-copilot',
        authMode: 'copilot-oauth-device',
        giteaBaseUrl: 'https://git.fazenda.mg.gov.br',
      }),
    );
    expect(saveRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        dfe: 'NFe',
        giteaUrl: 'https://git.fazenda.mg.gov.br/Integracao/nfe-parser',
      }),
    );
    expect(giteaInput).toHaveValue('');
    expect(container.textContent).not.toContain('pat-secret-never-render');

    await user.click(screen.getByRole('button', { name: /Executar Diagnóstico \(Doctor\)/i }));
    expect(await screen.findByText(/JDK 21 detectado/i)).toBeInTheDocument();
  });

  it('UI-SD-02: enforces GitHub Copilot subscription models only and updates model selection from subscription list', async () => {
    const user = userEvent.setup();
    const onChangeConfig = vi.fn();
    const listCopilotModels = vi.fn(async () => ({
      models: [
        { id: 'gpt-4.1', name: 'GPT-4.1', vendor: 'OpenAI', source: 'subscription' as const },
        { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', vendor: 'Anthropic', source: 'subscription' as const },
      ],
      source: 'subscription' as const,
      warning: null,
    }));

    const api = makeMockApi({
      listCopilotModels,
    });

    // Even if a legacy non-Copilot config is passed, UI normalizes strictly to GitHub Copilot OAuth
    render(
      <SettingsByokDoctor
        api={api}
        byokConfig={{
          provider: 'gemini',
          modelId: 'gemini-3.1-pro-preview',
          operatorName: 'Willy',
          secretKeyRef: 'ntc:llm:gemini',
        }}
        onChangeConfig={onChangeConfig}
      />,
    );

    const providerField = await screen.findByLabelText(/Provedor LLM/i);
    expect(providerField).toHaveValue('GitHub Copilot (Assinatura OAuth Device)');
    expect(screen.queryByRole('option', { name: /Google Gemini/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Ollama/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Modo Autenticação Copilot/i)).not.toBeInTheDocument();

    const modelSelect = await screen.findByLabelText(/Modelo GitHub Copilot/i);
    await user.selectOptions(modelSelect, 'claude-sonnet-4');

    expect(onChangeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'github-copilot',
        authMode: 'copilot-oauth-device',
        secretKeyRef: 'ntc:llm:github-copilot',
        modelId: 'claude-sonnet-4',
        operatorName: 'Willy',
      }),
    );
    expect(screen.getByLabelText(/Capacidade de tokens disponíveis/i)).toBeInTheDocument();
  });

  it('UI-SD-03: completes Copilot OAuth Device login, refreshes subscription models, and runs Copilot & Gitea connection tests', async () => {
    const user = userEvent.setup();
    let copilotConfigured = false;
    let pollCalls = 0;

    const saveByokConfig = vi.fn(async (cfg: ByokConfig) => cfg);
    const startCopilotAuth = vi.fn(async () => ({
      deviceCode: 'dev-ui-1',
      userCode: 'COPILOT-99',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 1,
    }));
    const pollCopilotAuth = vi.fn(async () => {
      pollCalls += 1;
      if (pollCalls === 1) {
        return { status: 'pending' as const };
      }
      copilotConfigured = true;
      return { status: 'authorized' as const };
    });
    const listCopilotModels = vi.fn(async () => ({
      models: [
        { id: 'gpt-4o', name: 'GPT-4o', vendor: 'OpenAI', source: 'subscription' as const },
        { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', vendor: 'Anthropic', source: 'subscription' as const },
      ],
      source: copilotConfigured ? ('subscription' as const) : ('curated' as const),
      warning: null,
    }));
    const testCopilot = vi.fn(async () => ({
      ok: true,
      target: 'github-copilot' as const,
      checkedAt: '2026-11-27T12:00:00.000Z',
      latencyMs: 120,
      summary: 'GitHub Copilot operacional (gpt-4o)',
      details: 'Endpoint: https://api.githubcopilot.com | Tokens: 18',
      steps: [
        { name: 'Credencial no cofre', ok: true, message: 'OK' },
        { name: 'Sessão assinatura Copilot', ok: true, message: 'Sessão Copilot ativa' },
        { name: 'Inferência no modelo gpt-4o', ok: true, message: 'Modelo respondeu (18 tokens)' },
      ],
    }));
    const testGitea = vi.fn(async () => ({
      ok: false,
      target: 'gitea' as const,
      checkedAt: '2026-11-27T12:00:00.000Z',
      latencyMs: 55,
      summary: 'Token Gitea PAT inválido ou expirado (HTTP 401)',
      details: 'Gere um novo PAT no Gitea.',
      steps: [{ name: 'Autenticação API Gitea', ok: false, message: 'HTTP 401' }],
    }));

    const api = makeMockApi({
      listRepos: vi.fn(async () => [SAMPLE_REPO]),
      getSecretStatus: vi.fn(async ({ key }) => ({
        configured: key === 'ntc:llm:github-copilot' ? copilotConfigured : false,
      })),
      saveByokConfig,
      startCopilotAuth,
      pollCopilotAuth,
      listCopilotModels,
      testCopilot,
      testGitea,
    });

    const copilotConfig: ByokConfig = {
      provider: 'github-copilot',
      modelId: 'gpt-4o',
      operatorName: 'Willy',
      secretKeyRef: 'ntc:llm:github-copilot',
      authMode: 'copilot-oauth-device',
    };

    render(
      <SettingsByokDoctor
        api={api}
        byokConfig={copilotConfig}
        onChangeConfig={() => undefined}
      />,
    );

    await user.click(await screen.findByRole('button', { name: /Salvar Configuração BYOK/i }));
    expect(saveByokConfig).toHaveBeenCalledWith(copilotConfig);
    expect(
      await screen.findByText(/Configuração BYOK \(GitHub Copilot \/ gpt-4o\) salva/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Conectar com GitHub Copilot \(OAuth Device\)/i }));
    expect(startCopilotAuth).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('COPILOT-99')).toBeInTheDocument();

    expect(
      await screen.findByText(/GitHub Copilot autorizado e configuração BYOK salva/i, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(pollCalls).toBe(2);
    expect(await screen.findByText(/Assinatura Copilot: Conectada/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Testar LLM GitHub Copilot/i }));
    expect(testCopilot).toHaveBeenCalledWith({ byokConfig: copilotConfig });
    expect(await screen.findByText(/GitHub Copilot operacional \(gpt-4o\)/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Testar Conexão Gitea/i }));
    expect(testGitea).toHaveBeenCalledWith({
      giteaUrl: SAMPLE_REPO.giteaUrl,
      baseBranch: SAMPLE_REPO.baseBranch,
    });
    expect(await screen.findByText(/Token Gitea PAT inválido ou expirado \(HTTP 401\)/i)).toBeInTheDocument();
  });
});
