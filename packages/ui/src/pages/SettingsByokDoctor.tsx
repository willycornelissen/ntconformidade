import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ByokConfig,
  CopilotAuthStartResponse,
  DoctorReport,
  NtcDesktopApi,
  SecretKeyTarget,
} from '@ntc/core';
import {
  ALL_SECRET_KEYS,
  isByokProvider,
  isCopilotAuthMode,
  isSafeEndpointInput,
  isSafeHttpsUrlInput,
  toErrorMessage,
} from '../api/helpers.js';

export interface SettingsByokDoctorProps {
  readonly api: NtcDesktopApi;
  readonly byokConfig: ByokConfig;
  readonly onChangeConfig: (next: ByokConfig) => void;
  readonly onGoHome?: () => void;
}

function buildSwitchedConfig(
  prev: ByokConfig,
  provider: ByokConfig['provider'],
): ByokConfig {
  const common = {
    modelId: provider === 'gemini' ? 'gemini-2.5-pro' : 'gpt-4o',
    operatorName: prev.operatorName,
    ...(prev.maxTokensPerStage !== undefined ? { maxTokensPerStage: prev.maxTokensPerStage } : {}),
    ...(prev.temperature !== undefined ? { temperature: prev.temperature } : {}),
  };
  if (provider === 'gemini') {
    return { provider: 'gemini', secretKeyRef: 'ntc:llm:gemini', ...common };
  }
  if (provider === 'openai-compatible') {
    return {
      provider: 'openai-compatible',
      secretKeyRef: 'ntc:llm:openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      ...common,
    };
  }
  return {
    provider: 'github-copilot',
    secretKeyRef: 'ntc:llm:github-copilot',
    authMode: 'github-models-pat',
    ...common,
  };
}

function ByokConfigSection({
  byokConfig,
  busy,
  onProviderChange,
  onChangeConfig,
  onSaveConfig,
}: {
  readonly byokConfig: ByokConfig;
  readonly busy: boolean;
  readonly onProviderChange: (provider: ByokConfig['provider']) => void;
  readonly onChangeConfig: (next: ByokConfig) => void;
  readonly onSaveConfig: () => void;
}) {
  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <h3>Configuração BYOK</h3>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="byok-provider">Provedor LLM</label>
          <select
            id="byok-provider"
            disabled={busy}
            value={byokConfig.provider}
            onChange={(e) => {
              if (isByokProvider(e.target.value)) {
                onProviderChange(e.target.value);
              }
            }}
          >
            <option value="gemini">Google Gemini</option>
            <option value="openai-compatible">OpenAI / Ollama Local</option>
            <option value="github-copilot">GitHub Copilot / Models</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="byok-model">Modelo</label>
          <input
            id="byok-model"
            disabled={busy}
            value={byokConfig.modelId}
            onChange={(e) => onChangeConfig({ ...byokConfig, modelId: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="byok-operator">Operador (Auditoria)</label>
          <input
            id="byok-operator"
            disabled={busy}
            value={byokConfig.operatorName}
            onChange={(e) => onChangeConfig({ ...byokConfig, operatorName: e.target.value })}
          />
        </div>

        {byokConfig.provider === 'openai-compatible' && (
          <>
            <div className="field">
              <label htmlFor="byok-base-url">Endpoint Base URL (OpenAI / Ollama)</label>
              <input
                id="byok-base-url"
                disabled={busy}
                value={byokConfig.baseUrl}
                onChange={(e) => onChangeConfig({ ...byokConfig, baseUrl: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="byok-org-id">Organization ID (opcional)</label>
              <input
                id="byok-org-id"
                disabled={busy}
                value={byokConfig.organizationId ?? ''}
                onChange={(e) => {
                  const trimmed = e.target.value.trim();
                  const next = { ...byokConfig };
                  if (trimmed) {
                    next.organizationId = trimmed;
                  } else {
                    delete next.organizationId;
                  }
                  onChangeConfig(next);
                }}
              />
            </div>
          </>
        )}

        {byokConfig.provider === 'github-copilot' && (
          <>
            <div className="field">
              <label htmlFor="byok-auth-mode">Modo Autenticação Copilot</label>
              <select
                id="byok-auth-mode"
                disabled={busy}
                value={byokConfig.authMode}
                onChange={(e) => {
                  if (isCopilotAuthMode(e.target.value)) {
                    onChangeConfig({ ...byokConfig, authMode: e.target.value });
                  }
                }}
              >
                <option value="github-models-pat">GitHub Models PAT</option>
                <option value="copilot-oauth-device">Copilot OAuth Device</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="byok-endpoint-url">Endpoint URL HTTPS (opcional)</label>
              <input
                id="byok-endpoint-url"
                disabled={busy}
                value={byokConfig.endpointUrl ?? ''}
                onChange={(e) => {
                  const trimmed = e.target.value.trim();
                  const next = { ...byokConfig };
                  if (trimmed) {
                    next.endpointUrl = trimmed;
                  } else {
                    delete next.endpointUrl;
                  }
                  onChangeConfig(next);
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="byok-enterprise-slug">Enterprise Slug (opcional)</label>
              <input
                id="byok-enterprise-slug"
                disabled={busy}
                value={byokConfig.enterpriseSlug ?? ''}
                onChange={(e) => {
                  const trimmed = e.target.value.trim();
                  const next = { ...byokConfig };
                  if (trimmed) {
                    next.enterpriseSlug = trimmed;
                  } else {
                    delete next.enterpriseSlug;
                  }
                  onChangeConfig(next);
                }}
              />
            </div>
          </>
        )}
      </div>
      <div className="toolbar" style={{ marginTop: '0.75rem' }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onSaveConfig}>
          Salvar Configuração BYOK
        </button>
      </div>
    </div>
  );
}

function SecretVaultSection({
  provider,
  isCopilotOAuthMode,
  secretStatus,
  currentLlmSecretKey,
  giteaPatInput,
  llmKeyInput,
  copilotSession,
  busy,
  onChangeGiteaPat,
  onChangeLlmKey,
  onSaveSecret,
  onStartCopilotLogin,
  onCancelCopilotLogin,
  onCopyCopilotCode,
}: {
  readonly provider: ByokConfig['provider'];
  readonly isCopilotOAuthMode: boolean;
  readonly secretStatus: Record<string, boolean>;
  readonly currentLlmSecretKey: SecretKeyTarget;
  readonly giteaPatInput: string;
  readonly llmKeyInput: string;
  readonly copilotSession: CopilotAuthStartResponse | null;
  readonly busy: boolean;
  readonly onChangeGiteaPat: (v: string) => void;
  readonly onChangeLlmKey: (v: string) => void;
  readonly onSaveSecret: (key: SecretKeyTarget, value: string, clearFn: () => void) => void;
  readonly onStartCopilotLogin: () => void;
  readonly onCancelCopilotLogin: () => void;
  readonly onCopyCopilotCode: (code: string) => void;
}) {
  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <h3>Cofre de Segredos (Electron safeStorage)</h3>
      <div className="form-grid">
        <form
          className="field"
          onSubmit={(e) => {
            e.preventDefault();
            onSaveSecret('ntc:gitea:pat', giteaPatInput, () => onChangeGiteaPat(''));
          }}
        >
          <label htmlFor="secret-gitea-pat">
            Token Gitea PAT ({secretStatus['ntc:gitea:pat'] ? 'Configurado' : 'Não configurado'})
          </label>
          <input
            id="secret-gitea-pat"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            disabled={busy}
            value={giteaPatInput}
            onChange={(e) => onChangeGiteaPat(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Salvar Gitea PAT
          </button>
        </form>

        <form
          className="field"
          onSubmit={(e) => {
            e.preventDefault();
            onSaveSecret(currentLlmSecretKey, llmKeyInput, () => onChangeLlmKey(''));
          }}
        >
          <label htmlFor="secret-llm-key">
            Chave/Token {provider} (
            {secretStatus[currentLlmSecretKey] ? 'Configurado' : 'Não configurado'})
          </label>
          <input
            id="secret-llm-key"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            disabled={busy}
            value={llmKeyInput}
            onChange={(e) => onChangeLlmKey(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Salvar Chave BYOK
          </button>
        </form>
      </div>

      {isCopilotOAuthMode && (
        <div style={{ marginTop: '0.85rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
          {!copilotSession ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={onStartCopilotLogin}
            >
              Conectar com GitHub Copilot (OAuth Device)
            </button>
          ) : (
            <div className="alert alert-warn" role="status">
              <p style={{ margin: '0 0 0.4rem 0' }}>
                Abra <strong>{copilotSession.verificationUri}</strong> no navegador e informe o código:{' '}
                <code>{copilotSession.userCode}</code>
              </p>
              <div className="toolbar">
                <button
                  type="button"
                  className="btn"
                  onClick={() => onCopyCopilotCode(copilotSession.userCode)}
                >
                  Copiar Código
                </button>
                <button type="button" className="btn" onClick={onCancelCopilotLogin}>
                  Cancelar Login
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DoctorDiagnosticsSection({
  giteaUrl,
  sampleRepoDir,
  busy,
  doctorReport,
  onChangeGiteaUrl,
  onChangeSampleRepoDir,
  onRunDoctor,
}: {
  readonly giteaUrl: string;
  readonly sampleRepoDir: string;
  readonly busy: boolean;
  readonly doctorReport: DoctorReport | null;
  readonly onChangeGiteaUrl: (v: string) => void;
  readonly onChangeSampleRepoDir: (v: string) => void;
  readonly onRunDoctor: () => void;
}) {
  return (
    <div className="card">
      <h3>Diagnóstico de Ambiente (Doctor)</h3>
      <div className="form-grid" style={{ marginBottom: '0.75rem' }}>
        <div className="field">
          <label htmlFor="doc-gitea-url">URL Gitea para checagem</label>
          <input
            id="doc-gitea-url"
            disabled={busy}
            value={giteaUrl}
            onChange={(e) => onChangeGiteaUrl(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="doc-repo-dir">Diretório parser local (.m2 offline)</label>
          <input
            id="doc-repo-dir"
            disabled={busy}
            value={sampleRepoDir}
            onChange={(e) => onChangeSampleRepoDir(e.target.value)}
            placeholder="Opcional"
          />
        </div>
      </div>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={onRunDoctor}>
        Executar Diagnóstico (Doctor)
      </button>

      {doctorReport && (
        <table className="data-table" style={{ marginTop: '0.75rem' }}>
          <caption className="sr-only">Resultados do diagnóstico Doctor</caption>
          <thead>
            <tr>
              <th scope="col">Check</th>
              <th scope="col">Status</th>
              <th scope="col">Resumo</th>
              <th scope="col">Detalhes</th>
            </tr>
          </thead>
          <tbody>
            {doctorReport.checks.map((check) => (
              <tr key={check.id}>
                <td>{check.id}</td>
                <td>
                  <span
                    className={`badge ${
                      check.status === 'OK'
                        ? 'badge-ok'
                        : check.status === 'WARN'
                          ? 'badge-warn'
                          : 'badge-danger'
                    }`}
                  >
                    {check.status}
                  </span>
                </td>
                <td>{check.summary}</td>
                <td>{check.details ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function SettingsByokDoctor({
  api,
  byokConfig,
  onChangeConfig,
  onGoHome,
}: SettingsByokDoctorProps) {
  const [secretStatus, setSecretStatus] = useState<Record<string, boolean>>({});
  const [giteaPatInput, setGiteaPatInput] = useState('');
  const [llmKeyInput, setLlmKeyInput] = useState('');
  const [giteaUrl, setGiteaUrl] = useState('https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfe-parser');
  const [sampleRepoDir, setSampleRepoDir] = useState('');
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copilotSession, setCopilotSession] = useState<CopilotAuthStartResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const isMountedRef = useRef(true);
  const statusSeqRef = useRef(0);
  const byokConfigRef = useRef(byokConfig);

  useEffect(() => {
    byokConfigRef.current = byokConfig;
  }, [byokConfig]);

  const refreshSecretStatuses = useCallback(async () => {
    const seq = ++statusSeqRef.current;
    const entries = await Promise.all(
      ALL_SECRET_KEYS.map(async (key) => [key, (await api.getSecretStatus({ key })).configured] as const),
    );
    if (isMountedRef.current && seq === statusSeqRef.current) {
      setSecretStatus(Object.fromEntries(entries));
    }
  }, [api]);

  useEffect(() => {
    isMountedRef.current = true;
    let cancelled = false;
    void refreshSecretStatuses().catch((err: unknown) => {
      if (!cancelled && isMountedRef.current) {
        setErrorMessage(toErrorMessage(err));
      }
    });
    return () => {
      cancelled = true;
      isMountedRef.current = false;
    };
  }, [refreshSecretStatuses]);

  useEffect(() => {
    if (!copilotSession) {
      return;
    }
    let cancelled = false;
    let timerId: number | undefined;
    let intervalMs = Math.max(1000, copilotSession.interval * 1000);
    const expiresAtMs = Date.now() + copilotSession.expiresIn * 1000;

    const scheduleNext = (): void => {
      if (cancelled) {
        return;
      }
      timerId = window.setTimeout(() => {
        void pollOnce();
      }, intervalMs);
    };

    const pollOnce = async (): Promise<void> => {
      if (cancelled) {
        return;
      }
      if (Date.now() >= expiresAtMs) {
        if (!cancelled && isMountedRef.current) {
          setCopilotSession(null);
          setErrorMessage('Código OAuth do GitHub Copilot expirado. Tente conectar novamente.');
        }
        return;
      }
      try {
        const res = await api.pollCopilotAuth({ deviceCode: copilotSession.deviceCode });
        if (cancelled || !isMountedRef.current) {
          return;
        }
        if (res.status === 'authorized') {
          await refreshSecretStatuses();
          const saved = await api.saveByokConfig(byokConfigRef.current);
          if (!cancelled && isMountedRef.current) {
            onChangeConfig(saved);
            setCopilotSession(null);
            setStatusMessage('GitHub Copilot autorizado e configuração BYOK salva.');
          }
          return;
        }
        if (res.status === 'pending') {
          scheduleNext();
          return;
        }
        if (res.status === 'slow_down') {
          intervalMs = res.interval ? res.interval * 1000 : intervalMs + 5000;
          scheduleNext();
          return;
        }
        setCopilotSession(null);
        setErrorMessage(res.error ?? 'Falha na autorização do GitHub Copilot.');
      } catch (err: unknown) {
        if (!cancelled && isMountedRef.current) {
          setCopilotSession(null);
          setErrorMessage(toErrorMessage(err));
        }
      }
    };

    scheduleNext();
    return () => {
      cancelled = true;
      if (timerId !== undefined) {
        window.clearTimeout(timerId);
      }
    };
  }, [api, copilotSession, onChangeConfig, refreshSecretStatuses]);

  function handleProviderChange(provider: ByokConfig['provider']): void {
    setLlmKeyInput('');
    setCopilotSession(null);
    setDoctorReport(null);
    setStatusMessage(null);
    setErrorMessage(null);
    onChangeConfig(buildSwitchedConfig(byokConfig, provider));
  }

  async function handleSaveByokConfig(): Promise<void> {
    setErrorMessage(null);
    setStatusMessage(null);
    setBusy(true);
    try {
      const saved = await api.saveByokConfig(byokConfig);
      if (isMountedRef.current) {
        onChangeConfig(saved);
        setStatusMessage(`Configuração BYOK (${saved.provider} / ${saved.modelId}) salva.`);
      }
    } catch (err: unknown) {
      if (isMountedRef.current) {
        setErrorMessage(toErrorMessage(err));
      }
    } finally {
      if (isMountedRef.current) {
        setBusy(false);
      }
    }
  }

  async function handleStartCopilotLogin(): Promise<void> {
    setErrorMessage(null);
    setStatusMessage(null);
    setBusy(true);
    try {
      const session = await api.startCopilotAuth();
      if (isMountedRef.current) {
        setCopilotSession(session);
        setStatusMessage(`Aguardando autorização no GitHub para o código ${session.userCode}.`);
      }
    } catch (err: unknown) {
      if (isMountedRef.current) {
        setErrorMessage(toErrorMessage(err));
      }
    } finally {
      if (isMountedRef.current) {
        setBusy(false);
      }
    }
  }

  function handleCopyCopilotCode(code: string): void {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(code).catch(() => undefined);
      setStatusMessage(`Código ${code} copiado para a área de transferência.`);
    }
  }

  async function saveSecretInput(
    key: SecretKeyTarget,
    value: string,
    clearFn: () => void,
  ): Promise<void> {
    setErrorMessage(null);
    setStatusMessage(null);
    if (!value.trim()) {
      setErrorMessage('Informe o token antes de salvar.');
      return;
    }
    setBusy(true);
    try {
      await api.setSecret({ key, value });
      await refreshSecretStatuses();
      if (isMountedRef.current) {
        setStatusMessage(`Segredo '${key}' salvo no cofre do sistema operacional.`);
      }
    } catch (err: unknown) {
      if (isMountedRef.current) {
        setErrorMessage(toErrorMessage(err));
      }
    } finally {
      clearFn();
      if (isMountedRef.current) {
        setBusy(false);
      }
    }
  }

  async function handleRunDoctor(): Promise<void> {
    setErrorMessage(null);
    setStatusMessage(null);
    if (giteaUrl.trim() && !isSafeHttpsUrlInput(giteaUrl)) {
      setErrorMessage('URL do Gitea para diagnóstico deve utilizar HTTPS sem credenciais embutidas.');
      return;
    }
    if (
      byokConfig.provider === 'openai-compatible' &&
      !isSafeEndpointInput(byokConfig.baseUrl, true)
    ) {
      setErrorMessage('Base URL OpenAI-compatible deve ser HTTPS ou http://localhost/127.0.0.1.');
      return;
    }
    if (
      byokConfig.provider === 'github-copilot' &&
      byokConfig.endpointUrl &&
      !isSafeEndpointInput(byokConfig.endpointUrl, false)
    ) {
      setErrorMessage('Endpoint URL do GitHub Copilot deve utilizar HTTPS público.');
      return;
    }
    setBusy(true);
    try {
      const report = await api.runDoctor({
        byokConfig,
        ...(giteaUrl.trim() ? { giteaUrl: giteaUrl.trim() } : {}),
        ...(sampleRepoDir.trim() ? { sampleRepoDir: sampleRepoDir.trim() } : {}),
      });
      if (isMountedRef.current) {
        setDoctorReport(report);
      }
    } catch (err: unknown) {
      if (isMountedRef.current) {
        setErrorMessage(toErrorMessage(err));
      }
    } finally {
      if (isMountedRef.current) {
        setBusy(false);
      }
    }
  }

  const currentLlmSecretKey: SecretKeyTarget = `ntc:llm:${byokConfig.provider}`;

  return (
    <section className="card">
      <div className="section-header">
        <h2>BYOK, Segredos e Doctor</h2>
        {onGoHome && (
          <button type="button" className="btn" onClick={onGoHome}>
            Voltar à Tela Inicial
          </button>
        )}
      </div>
      {statusMessage && (
        <p className="alert alert-ok" role="status">
          {statusMessage}
        </p>
      )}
      {errorMessage && (
        <p className="alert alert-danger" role="alert">
          {errorMessage}
        </p>
      )}

      <ByokConfigSection
        byokConfig={byokConfig}
        busy={busy}
        onProviderChange={handleProviderChange}
        onChangeConfig={onChangeConfig}
        onSaveConfig={() => {
          void handleSaveByokConfig();
        }}
      />

      <SecretVaultSection
        provider={byokConfig.provider}
        isCopilotOAuthMode={
          byokConfig.provider === 'github-copilot' && byokConfig.authMode === 'copilot-oauth-device'
        }
        secretStatus={secretStatus}
        currentLlmSecretKey={currentLlmSecretKey}
        giteaPatInput={giteaPatInput}
        llmKeyInput={llmKeyInput}
        copilotSession={copilotSession}
        busy={busy}
        onChangeGiteaPat={setGiteaPatInput}
        onChangeLlmKey={setLlmKeyInput}
        onSaveSecret={(k, v, clearFn) => {
          void saveSecretInput(k, v, clearFn);
        }}
        onStartCopilotLogin={() => {
          void handleStartCopilotLogin();
        }}
        onCancelCopilotLogin={() => {
          setCopilotSession(null);
          setStatusMessage('Login OAuth do GitHub Copilot cancelado.');
        }}
        onCopyCopilotCode={handleCopyCopilotCode}
      />

      <DoctorDiagnosticsSection
        giteaUrl={giteaUrl}
        sampleRepoDir={sampleRepoDir}
        busy={busy}
        doctorReport={doctorReport}
        onChangeGiteaUrl={setGiteaUrl}
        onChangeSampleRepoDir={setSampleRepoDir}
        onRunDoctor={() => {
          void handleRunDoctor();
        }}
      />
    </section>
  );
}
