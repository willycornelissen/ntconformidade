import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ByokConfig } from '@ntc/core';
import { SettingsByokDoctor } from '../src/pages/SettingsByokDoctor.js';
import { makeMockApi } from './mock-api.js';

describe('SettingsByokDoctor', () => {
  it('UI-SD-01: saves BYOK secrets without ever rendering plaintext secrets and renders doctor checks', async () => {
    const user = userEvent.setup();
    const configuredKeys = new Set<string>();
    const setSecret = vi.fn(async ({ key }: { key: string }) => {
      configuredKeys.add(key);
      return { configured: true };
    });
    const runDoctor = vi.fn(async () => ({
      ok: true,
      checkedAt: '2026-11-19T12:00:00.000Z',
      checks: [
        { id: 'JAVA_JDK' as const, status: 'OK' as const, summary: 'JDK 21 detectado', details: 'needsRelease8Flag=true', needsRelease8Flag: true },
        { id: 'MAVEN' as const, status: 'OK' as const, summary: 'Apache Maven 3.8.7', details: null },
      ],
    }));
    const onChangeConfig = vi.fn();

    const api = makeMockApi({
      getSecretStatus: vi.fn(async ({ key }) => ({ configured: configuredKeys.has(key) })),
      setSecret,
      runDoctor,
    });

    const initialConfig: ByokConfig = {
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      operatorName: 'Willy',
      secretKeyRef: 'ntc:llm:gemini',
    };

    const { container } = render(
      <SettingsByokDoctor
        api={api}
        byokConfig={initialConfig}
        onChangeConfig={onChangeConfig}
      />,
    );

    const giteaInput = await screen.findByLabelText(/Token Gitea PAT/i);
    await user.type(giteaInput, 'pat-secret-never-render');
    await user.click(screen.getByRole('button', { name: /Salvar Gitea PAT/i }));

    expect(setSecret).toHaveBeenCalledWith({
      key: 'ntc:gitea:pat',
      value: 'pat-secret-never-render',
    });
    expect(giteaInput).toHaveValue('');
    expect(container.textContent).not.toContain('pat-secret-never-render');

    await user.click(screen.getByRole('button', { name: /Executar Diagnóstico \(Doctor\)/i }));
    expect(await screen.findByText(/JDK 21 detectado/i)).toBeInTheDocument();
  });

  it('UI-SD-02: renders provider-specific BYOK fields and clears stale key input when switching providers', async () => {
    const user = userEvent.setup();
    const onChangeConfig = vi.fn();
    const api = makeMockApi();

    const { rerender } = render(
      <SettingsByokDoctor
        api={api}
        byokConfig={{
          provider: 'gemini',
          modelId: 'gemini-2.5-pro',
          operatorName: 'Op',
          secretKeyRef: 'ntc:llm:gemini',
        }}
        onChangeConfig={onChangeConfig}
      />,
    );

    const llmInput = await screen.findByLabelText(/Chave\/Token gemini/i);
    await user.type(llmInput, 'temp-secret');
    await user.selectOptions(screen.getByLabelText(/Provedor LLM/i), 'openai-compatible');

    expect(onChangeConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai-compatible',
        secretKeyRef: 'ntc:llm:openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
      }),
    );
    expect(llmInput).toHaveValue('');

    rerender(
      <SettingsByokDoctor
        api={api}
        byokConfig={{
          provider: 'github-copilot',
          modelId: 'gpt-4o',
          operatorName: 'Op',
          secretKeyRef: 'ntc:llm:github-copilot',
          authMode: 'github-models-pat',
        }}
        onChangeConfig={onChangeConfig}
      />,
    );
    expect(await screen.findByLabelText(/Modo Autenticação Copilot/i)).toBeInTheDocument();
  });
});
