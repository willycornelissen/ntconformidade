import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ByokConfig,
  ConnectionTestResult,
  CopilotAuthStartResponse,
  CopilotModelOption,
  DfeRepoEntry,
  DoctorReport,
  NtcDesktopApi,
} from '@ntc/core';
import {
  COPILOT_BYOK_SECRET_KEYS,
  CURATED_COPILOT_MODELS,
  type CopilotByokConfig,
  extractUrlOrigin,
  isSafeEndpointInput,
  isSafeHttpsUrlInput,
  normalizeCopilotByokConfig,
  rewriteRepoOrigin,
  toErrorMessage,
} from '../api/helpers.js';

export interface SettingsByokDoctorProps {
  readonly api: NtcDesktopApi;
  readonly byokConfig: ByokConfig;
  readonly onChangeConfig: (next: ByokConfig) => void;
  readonly onGoHome?: () => void;
}

const DEFAULT_GITEA_BASE_URL = 'https://gitea.apps.ticio.fazenda.mg.gov.br';
const DEFAULT_GITEA_TEST_URL = 'https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfe-parser';

function ConnectionTestResultPanel({
  result,
  title,
}: {
  readonly result: ConnectionTestResult | null;
  readonly title: string;
}) {
  if (!result) {
    return null;
  }
  return (
    <div
      className={`alert ${result.ok ? 'alert-ok' : 'alert-danger'}`}
      role="status"
      style={{ marginTop: '0.75rem' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
        <strong>
          {title}: {result.summary}
        </strong>
        <span className={`badge ${result.ok ? 'badge-ok' : 'badge-danger'}`}>
          {result.ok ? 'PASSOU' : 'FALHOU'} ({result.latencyMs} ms)
        </span>
      </div>
      {result.details && <p style={{ margin: '0.35rem 0 0.5rem 0' }}>{result.details}</p>}
      <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
        {result.steps.map((step) => (
          <li key={step.name}>
            <strong>{step.name}:</strong> {step.ok ? 'OK' : 'FALHA'} — {step.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CopilotByokSection({
  config,
  isCopilotConnected,
  modelOptions,
  modelsSource,
  modelsWarning,
  copilotSession,
  copilotTestResult,
  busy,
  onChangeConfig,
  onSaveConfig,
  onRefreshModels,
  onStartCopilotLogin,
  onCancelCopilotLogin,
  onCopyCopilotCode,
  onTestCopilot,
}: {
  readonly config: CopilotByokConfig;
  readonly isCopilotConnected: boolean;
  readonly modelOptions: readonly CopilotModelOption[];
  readonly modelsSource: 'subscription' | 'curated';
  readonly modelsWarning: string | null;
  readonly copilotSession: CopilotAuthStartResponse | null;
  readonly copilotTestResult: ConnectionTestResult | null;
  readonly busy: boolean;
  readonly onChangeConfig: (next: CopilotByokConfig) => void;
  readonly onSaveConfig: () => void;
  readonly onRefreshModels: () => void;
  readonly onStartCopilotLogin: () => void;
  readonly onCancelCopilotLogin: () => void;
  readonly onCopyCopilotCode: (code: string) => void;
  readonly onTestCopilot: () => void;
}) {
  const effectiveModelOptions = useMemo(() => {
    if (modelOptions.some((m) => m.id === config.modelId)) {
      return modelOptions;
    }
    return [
      { id: config.modelId, name: config.modelId, source: 'curated' as const },
      ...modelOptions,
    ];
  }, [config.modelId, modelOptions]);

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div className="section-header">
        <div>
          <h3 style={{ margin: 0 }}>BYOK — Modelos da Assinatura GitHub Copilot</h3>
          <p style={{ margin: '0.25rem 0 0 0', color: 'var(--muted)', fontSize: '0.9rem' }}>
            As verificações de conformidade e correções de NT utilizam exclusivamente modelos da sua
            assinatura GitHub Copilot via OAuth Device.
          </p>
        </div>
        <span className={`badge ${isCopilotConnected ? 'badge-ok' : 'badge-warn'}`}>
          Assinatura Copilot: {isCopilotConnected ? 'Conectada' : 'Não conectada'}
        </span>
      </div>

      <div className="form-grid" style={{ marginTop: '0.75rem' }}>
        <div className="field">
          <label htmlFor="byok-provider">Provedor LLM</label>
          <input
            id="byok-provider"
            readOnly
            aria-readonly="true"
            value="GitHub Copilot (Assinatura OAuth Device)"
          />
        </div>

        <div className="field">
          <label htmlFor="byok-model">
            Modelo GitHub Copilot ({modelsSource === 'subscription' ? 'Assinatura ativa' : 'Catálogo base'})
          </label>
          <select
            id="byok-model"
            disabled={busy}
            value={config.modelId}
            onChange={(e) => onChangeConfig({ ...config, modelId: e.target.value })}
          >
            {effectiveModelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.vendor ? `${model.name} (${model.vendor}) — ${model.id}` : `${model.name} — ${model.id}`}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="byok-operator">Operador (Auditoria)</label>
          <input
            id="byok-operator"
            disabled={busy}
            value={config.operatorName}
            onChange={(e) => onChangeConfig({ ...config, operatorName: e.target.value })}
          />
        </div>

        <div className="field">
          <label htmlFor="byok-endpoint-url">Endpoint Copilot HTTPS (opcional)</label>
          <input
            id="byok-endpoint-url"
            disabled={busy}
            value={config.endpointUrl ?? ''}
            placeholder="https://api.githubcopilot.com"
            onChange={(e) => {
              const trimmed = e.target.value.trim();
              const next: CopilotByokConfig = { ...config };
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
            value={config.enterpriseSlug ?? ''}
            onChange={(e) => {
              const trimmed = e.target.value.trim();
              const next: CopilotByokConfig = { ...config };
              if (trimmed) {
                next.enterpriseSlug = trimmed;
              } else {
                delete next.enterpriseSlug;
              }
              onChangeConfig(next);
            }}
          />
        </div>
      </div>

      {modelsWarning && (
        <p className="alert alert-warn" role="status" style={{ marginTop: '0.75rem' }}>
          Não foi possível listar modelos da assinatura agora ({modelsWarning}). Exibindo catálogo base Copilot.
        </p>
      )}

      <div className="toolbar" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onSaveConfig}>
          Salvar Configuração BYOK
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onRefreshModels}>
          Atualizar Modelos Copilot
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onTestCopilot}>
          Testar LLM GitHub Copilot
        </button>
      </div>

      <div style={{ marginTop: '0.85rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
        {!copilotSession ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={onStartCopilotLogin}
          >
            {isCopilotConnected
              ? 'Reconectar GitHub Copilot (OAuth Device)'
              : 'Conectar com GitHub Copilot (OAuth Device)'}
          </button>
        ) : (
          <div className="alert alert-warn" role="status">
            <p style={{ margin: '0 0 0.4rem 0' }}>
              Abra <strong>{copilotSession.verificationUri}</strong> no navegador e informe o código:{' '}
              <code>{copilotSession.userCode}</code>
            </p>
            <div className="toolbar" style={{ marginBottom: 0 }}>
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

      <ConnectionTestResultPanel
        result={copilotTestResult}
        title="Teste de Funcionamento — GitHub Copilot"
      />
    </div>
  );
}

function GiteaAccessSection({
  giteaBaseUrl,
  giteaPatInput,
  isGiteaPatConfigured,
  syncRepoHosts,
  repos,
  selectedTestRepoDfe,
  giteaTestUrl,
  giteaTestResult,
  busy,
  onChangeGiteaBaseUrl,
  onChangeGiteaPatInput,
  onChangeSyncRepoHosts,
  onSelectTestRepo,
  onChangeGiteaTestUrl,
  onSaveGiteaAccess,
  onTestGitea,
}: {
  readonly giteaBaseUrl: string;
  readonly giteaPatInput: string;
  readonly isGiteaPatConfigured: boolean;
  readonly syncRepoHosts: boolean;
  readonly repos: readonly DfeRepoEntry[];
  readonly selectedTestRepoDfe: string;
  readonly giteaTestUrl: string;
  readonly giteaTestResult: ConnectionTestResult | null;
  readonly busy: boolean;
  readonly onChangeGiteaBaseUrl: (value: string) => void;
  readonly onChangeGiteaPatInput: (value: string) => void;
  readonly onChangeSyncRepoHosts: (checked: boolean) => void;
  readonly onSelectTestRepo: (dfe: string) => void;
  readonly onChangeGiteaTestUrl: (value: string) => void;
  readonly onSaveGiteaAccess: () => void;
  readonly onTestGitea: () => void;
}) {
  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div className="section-header">
        <div>
          <h3 style={{ margin: 0 }}>BYOK — Acesso ao Gitea</h3>
          <p style={{ margin: '0.25rem 0 0 0', color: 'var(--muted)', fontSize: '0.9rem' }}>
            Configure o servidor HTTPS e o Personal Access Token (PAT) do Gitea usados no espelhamento Git
            e abertura de Pull Requests. Escopos recomendados: <code>read:repository</code>,{' '}
            <code>write:repository</code> e <code>read:user</code>.
          </p>
        </div>
        <span className={`badge ${isGiteaPatConfigured ? 'badge-ok' : 'badge-warn'}`}>
          Gitea PAT: {isGiteaPatConfigured ? 'Configurado' : 'Não configurado'}
        </span>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSaveGiteaAccess();
        }}
        style={{ marginTop: '0.75rem' }}
      >
        <div className="form-grid">
          <div className="field">
            <label htmlFor="byok-gitea-base-url">URL do Servidor Gitea (HTTPS)</label>
            <input
              id="byok-gitea-base-url"
              disabled={busy}
              value={giteaBaseUrl}
              placeholder={DEFAULT_GITEA_BASE_URL}
              onChange={(e) => onChangeGiteaBaseUrl(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="secret-gitea-pat">
              Token Gitea PAT ({isGiteaPatConfigured ? 'Configurado' : 'Não configurado'})
            </label>
            <input
              id="secret-gitea-pat"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              disabled={busy}
              value={giteaPatInput}
              placeholder={isGiteaPatConfigured ? 'Informe novo PAT para substituir' : 'Cole o token Gitea PAT'}
              onChange={(e) => onChangeGiteaPatInput(e.target.value)}
            />
          </div>

          {repos.length > 0 && (
            <div className="field">
              <label htmlFor="gitea-test-repo">Repositório DF-e para Teste</label>
              <select
                id="gitea-test-repo"
                disabled={busy}
                value={selectedTestRepoDfe}
                onChange={(e) => onSelectTestRepo(e.target.value)}
              >
                {repos.map((repo) => (
                  <option key={repo.dfe} value={repo.dfe}>
                    {repo.dfe} — {repo.repoSlug}
                  </option>
                ))}
                <option value="__custom__">URL personalizada</option>
              </select>
            </div>
          )}

          <div className="field">
            <label htmlFor="doc-gitea-url">URL Gitea para Teste / Doctor</label>
            <input
              id="doc-gitea-url"
              disabled={busy}
              value={giteaTestUrl}
              onChange={(e) => onChangeGiteaTestUrl(e.target.value)}
            />
          </div>
        </div>

        {repos.length > 0 && (
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.45rem',
              marginTop: '0.6rem',
              fontSize: '0.9rem',
            }}
          >
            <input
              type="checkbox"
              disabled={busy}
              checked={syncRepoHosts}
              onChange={(e) => onChangeSyncRepoHosts(e.target.checked)}
            />
            Aplicar servidor Gitea a todos os repositórios DF-e cadastrados ao salvar
          </label>
        )}

        <div className="toolbar" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Salvar Acesso Gitea
          </button>
          <button type="button" className="btn" disabled={busy} onClick={onTestGitea}>
            Testar Conexão Gitea
          </button>
        </div>
      </form>

      <ConnectionTestResultPanel result={giteaTestResult} title="Teste de Funcionamento — Gitea" />
    </div>
  );
}

function DoctorDiagnosticsSection({
  sampleRepoDir,
  busy,
  doctorReport,
  onChangeSampleRepoDir,
  onRunDoctor,
}: {
  readonly sampleRepoDir: string;
  readonly busy: boolean;
  readonly doctorReport: DoctorReport | null;
  readonly onChangeSampleRepoDir: (v: string) => void;
  readonly onRunDoctor: () => void;
}) {
  return (
    <div className="card">
      <h3>Diagnóstico Completo do Ambiente (Doctor)</h3>
      <div className="form-grid" style={{ marginBottom: '0.75rem' }}>
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
  const normalizedConfig = useMemo(() => normalizeCopilotByokConfig(byokConfig), [byokConfig]);

  const [secretStatus, setSecretStatus] = useState<Record<string, boolean>>({});
  const [modelOptions, setModelOptions] = useState<readonly CopilotModelOption[]>(CURATED_COPILOT_MODELS);
  const [modelsSource, setModelsSource] = useState<'subscription' | 'curated'>('curated');
  const [modelsWarning, setModelsWarning] = useState<string | null>(null);
  const [repos, setRepos] = useState<readonly DfeRepoEntry[]>([]);
  const [giteaBaseUrl, setGiteaBaseUrl] = useState(
    normalizedConfig.giteaBaseUrl ?? DEFAULT_GITEA_BASE_URL,
  );
  const [giteaPatInput, setGiteaPatInput] = useState('');
  const [syncRepoHosts, setSyncRepoHosts] = useState(true);
  const [selectedTestRepoDfe, setSelectedTestRepoDfe] = useState('__custom__');
  const [giteaTestUrl, setGiteaTestUrl] = useState(DEFAULT_GITEA_TEST_URL);
  const [sampleRepoDir, setSampleRepoDir] = useState('');
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [copilotTestResult, setCopilotTestResult] = useState<ConnectionTestResult | null>(null);
  const [giteaTestResult, setGiteaTestResult] = useState<ConnectionTestResult | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copilotSession, setCopilotSession] = useState<CopilotAuthStartResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const isMountedRef = useRef(true);
  const statusSeqRef = useRef(0);
  const byokConfigRef = useRef(normalizedConfig);

  useEffect(() => {
    byokConfigRef.current = normalizedConfig;
  }, [normalizedConfig]);

  useEffect(() => {
    if (normalizedConfig.giteaBaseUrl) {
      setGiteaBaseUrl(normalizedConfig.giteaBaseUrl);
    }
  }, [normalizedConfig.giteaBaseUrl]);

  const refreshSecretStatuses = useCallback(async () => {
    const seq = ++statusSeqRef.current;
    const entries = await Promise.all(
      COPILOT_BYOK_SECRET_KEYS.map(
        async (key) => [key, (await api.getSecretStatus({ key })).configured] as const,
      ),
    );
    if (isMountedRef.current && seq === statusSeqRef.current) {
      setSecretStatus(Object.fromEntries(entries));
    }
  }, [api]);

  const loadCopilotModels = useCallback(
    async (cfg: CopilotByokConfig) => {
      const res = await api.listCopilotModels({
        ...(cfg.endpointUrl ? { endpointUrl: cfg.endpointUrl } : {}),
        ...(cfg.enterpriseSlug ? { enterpriseSlug: cfg.enterpriseSlug } : {}),
      });
      if (!isMountedRef.current) {
        return;
      }
      setModelOptions(res.models);
      setModelsSource(res.source);
      setModelsWarning(res.warning);
    },
    [api],
  );

  useEffect(() => {
    isMountedRef.current = true;
    let cancelled = false;
    void Promise.all([
      refreshSecretStatuses(),
      api.listRepos().catch(() => [] as readonly DfeRepoEntry[]),
      loadCopilotModels(byokConfigRef.current).catch(() => undefined),
    ])
      .then(([, loadedRepos]) => {
        if (cancelled || !isMountedRef.current || loadedRepos.length === 0) {
          return;
        }
        setRepos(loadedRepos);
        const firstRepo = loadedRepos[0];
        if (firstRepo) {
          setSelectedTestRepoDfe(firstRepo.dfe);
          setGiteaTestUrl(firstRepo.giteaUrl);
          if (!byokConfigRef.current.giteaBaseUrl) {
            const origin = extractUrlOrigin(firstRepo.giteaUrl);
            if (origin) {
              setGiteaBaseUrl(origin);
            }
          }
        }
      })
      .catch((err: unknown) => {
        if (!cancelled && isMountedRef.current) {
          setErrorMessage(toErrorMessage(err));
        }
      });
    return () => {
      cancelled = true;
      isMountedRef.current = false;
    };
  }, [api, loadCopilotModels, refreshSecretStatuses]);

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
          await loadCopilotModels(byokConfigRef.current).catch(() => undefined);
          if (!cancelled && isMountedRef.current) {
            onChangeConfig(normalizeCopilotByokConfig(saved));
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
  }, [api, copilotSession, loadCopilotModels, onChangeConfig, refreshSecretStatuses]);

  async function handleSaveByokConfig(): Promise<void> {
    setErrorMessage(null);
    setStatusMessage(null);
    if (
      normalizedConfig.endpointUrl &&
      !isSafeEndpointInput(normalizedConfig.endpointUrl, false)
    ) {
      setErrorMessage('Endpoint URL do GitHub Copilot deve utilizar HTTPS público.');
      return;
    }
    setBusy(true);
    try {
      const saved = await api.saveByokConfig(normalizedConfig);
      if (isMountedRef.current) {
        const next = normalizeCopilotByokConfig(saved);
        onChangeConfig(next);
        setStatusMessage(`Configuração BYOK (GitHub Copilot / ${next.modelId}) salva.`);
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

  async function handleRefreshModels(): Promise<void> {
    setErrorMessage(null);
    setStatusMessage(null);
    if (
      normalizedConfig.endpointUrl &&
      !isSafeEndpointInput(normalizedConfig.endpointUrl, false)
    ) {
      setErrorMessage('Endpoint URL do GitHub Copilot deve utilizar HTTPS público.');
      return;
    }
    setBusy(true);
    try {
      const res = await api.listCopilotModels({
        ...(normalizedConfig.endpointUrl ? { endpointUrl: normalizedConfig.endpointUrl } : {}),
        ...(normalizedConfig.enterpriseSlug ? { enterpriseSlug: normalizedConfig.enterpriseSlug } : {}),
      });
      if (isMountedRef.current) {
        setModelOptions(res.models);
        setModelsSource(res.source);
        setModelsWarning(res.warning);
        setStatusMessage(
          res.source === 'subscription'
            ? `${res.models.length} modelos carregados da sua assinatura GitHub Copilot.`
            : 'Catálogo base de modelos GitHub Copilot carregado.',
        );
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

  async function handleTestCopilot(): Promise<void> {
    setErrorMessage(null);
    setStatusMessage(null);
    if (
      normalizedConfig.endpointUrl &&
      !isSafeEndpointInput(normalizedConfig.endpointUrl, false)
    ) {
      setErrorMessage('Endpoint URL do GitHub Copilot deve utilizar HTTPS público.');
      return;
    }
    setBusy(true);
    try {
      const result = await api.testCopilot({ byokConfig: normalizedConfig });
      if (isMountedRef.current) {
        setCopilotTestResult(result);
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

  async function handleSaveGiteaAccess(): Promise<void> {
    setErrorMessage(null);
    setStatusMessage(null);
    const trimmedBaseUrl = giteaBaseUrl.trim();
    const trimmedPat = giteaPatInput.trim();
    if (!trimmedBaseUrl && !trimmedPat) {
      setErrorMessage('Informe a URL do servidor Gitea ou o Token Gitea PAT antes de salvar.');
      return;
    }
    if (trimmedBaseUrl && !isSafeHttpsUrlInput(trimmedBaseUrl)) {
      setErrorMessage('URL do servidor Gitea deve utilizar HTTPS sem credenciais embutidas.');
      return;
    }

    setBusy(true);
    try {
      if (trimmedPat) {
        await api.setSecret({ key: 'ntc:gitea:pat', value: trimmedPat });
        await refreshSecretStatuses();
      }

      const normalizedOrigin = trimmedBaseUrl ? extractUrlOrigin(trimmedBaseUrl) : null;
      if (normalizedOrigin) {
        const nextConfig: CopilotByokConfig = {
          ...normalizedConfig,
          giteaBaseUrl: normalizedOrigin,
        };
        const saved = await api.saveByokConfig(nextConfig);
        if (isMountedRef.current) {
          onChangeConfig(normalizeCopilotByokConfig(saved));
          setGiteaBaseUrl(normalizedOrigin);
        }

        if (syncRepoHosts && repos.length > 0) {
          const updatedRepos = await Promise.all(
            repos.map(async (repo) => {
              const repoOrigin = extractUrlOrigin(repo.giteaUrl);
              if (repoOrigin === normalizedOrigin) {
                return repo;
              }
              return api.saveRepo({
                ...repo,
                giteaUrl: rewriteRepoOrigin(repo.giteaUrl, normalizedOrigin),
              });
            }),
          );
          if (isMountedRef.current) {
            setRepos(updatedRepos);
            const activeRepo = updatedRepos.find((r) => r.dfe === selectedTestRepoDfe);
            if (activeRepo) {
              setGiteaTestUrl(activeRepo.giteaUrl);
            } else if (extractUrlOrigin(giteaTestUrl)) {
              setGiteaTestUrl(rewriteRepoOrigin(giteaTestUrl, normalizedOrigin));
            }
          }
        }
      }

      if (isMountedRef.current) {
        const parts: string[] = [];
        if (normalizedOrigin) {
          parts.push(`servidor Gitea (${normalizedOrigin})`);
        }
        if (trimmedPat) {
          parts.push('Token Gitea PAT');
        }
        setStatusMessage(`Acesso ao Gitea salvo (${parts.join(' + ')}).`);
      }
    } catch (err: unknown) {
      if (isMountedRef.current) {
        setErrorMessage(toErrorMessage(err));
      }
    } finally {
      setGiteaPatInput('');
      if (isMountedRef.current) {
        setBusy(false);
      }
    }
  }

  function handleSelectTestRepo(dfe: string): void {
    setSelectedTestRepoDfe(dfe);
    const repo = repos.find((r) => r.dfe === dfe);
    if (repo) {
      setGiteaTestUrl(repo.giteaUrl);
    }
  }

  async function handleTestGitea(): Promise<void> {
    setErrorMessage(null);
    setStatusMessage(null);
    const targetUrl = giteaTestUrl.trim() || giteaBaseUrl.trim();
    if (!targetUrl || !isSafeHttpsUrlInput(targetUrl)) {
      setErrorMessage('URL do Gitea para teste deve utilizar HTTPS sem credenciais embutidas.');
      return;
    }
    const selectedRepo = repos.find((r) => r.dfe === selectedTestRepoDfe);
    setBusy(true);
    try {
      const result = await api.testGitea({
        giteaUrl: targetUrl,
        ...(selectedRepo ? { baseBranch: selectedRepo.baseBranch } : {}),
      });
      if (isMountedRef.current) {
        setGiteaTestResult(result);
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

  async function handleRunDoctor(): Promise<void> {
    setErrorMessage(null);
    setStatusMessage(null);
    const effectiveGiteaUrl = giteaTestUrl.trim() || giteaBaseUrl.trim();
    if (effectiveGiteaUrl && !isSafeHttpsUrlInput(effectiveGiteaUrl)) {
      setErrorMessage('URL do Gitea para diagnóstico deve utilizar HTTPS sem credenciais embutidas.');
      return;
    }
    if (
      normalizedConfig.endpointUrl &&
      !isSafeEndpointInput(normalizedConfig.endpointUrl, false)
    ) {
      setErrorMessage('Endpoint URL do GitHub Copilot deve utilizar HTTPS público.');
      return;
    }
    setBusy(true);
    try {
      const report = await api.runDoctor({
        byokConfig: normalizedConfig,
        ...(effectiveGiteaUrl ? { giteaUrl: effectiveGiteaUrl } : {}),
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

      <CopilotByokSection
        config={normalizedConfig}
        isCopilotConnected={Boolean(secretStatus['ntc:llm:github-copilot'])}
        modelOptions={modelOptions}
        modelsSource={modelsSource}
        modelsWarning={modelsWarning}
        copilotSession={copilotSession}
        copilotTestResult={copilotTestResult}
        busy={busy}
        onChangeConfig={onChangeConfig}
        onSaveConfig={() => {
          void handleSaveByokConfig();
        }}
        onRefreshModels={() => {
          void handleRefreshModels();
        }}
        onStartCopilotLogin={() => {
          void handleStartCopilotLogin();
        }}
        onCancelCopilotLogin={() => {
          setCopilotSession(null);
          setStatusMessage('Login OAuth do GitHub Copilot cancelado.');
        }}
        onCopyCopilotCode={handleCopyCopilotCode}
        onTestCopilot={() => {
          void handleTestCopilot();
        }}
      />

      <GiteaAccessSection
        giteaBaseUrl={giteaBaseUrl}
        giteaPatInput={giteaPatInput}
        isGiteaPatConfigured={Boolean(secretStatus['ntc:gitea:pat'])}
        syncRepoHosts={syncRepoHosts}
        repos={repos}
        selectedTestRepoDfe={selectedTestRepoDfe}
        giteaTestUrl={giteaTestUrl}
        giteaTestResult={giteaTestResult}
        busy={busy}
        onChangeGiteaBaseUrl={setGiteaBaseUrl}
        onChangeGiteaPatInput={setGiteaPatInput}
        onChangeSyncRepoHosts={setSyncRepoHosts}
        onSelectTestRepo={handleSelectTestRepo}
        onChangeGiteaTestUrl={(value) => {
          setSelectedTestRepoDfe('__custom__');
          setGiteaTestUrl(value);
        }}
        onSaveGiteaAccess={() => {
          void handleSaveGiteaAccess();
        }}
        onTestGitea={() => {
          void handleTestGitea();
        }}
      />

      <DoctorDiagnosticsSection
        sampleRepoDir={sampleRepoDir}
        busy={busy}
        doctorReport={doctorReport}
        onChangeSampleRepoDir={setSampleRepoDir}
        onRunDoctor={() => {
          void handleRunDoctor();
        }}
      />
    </section>
  );
}
