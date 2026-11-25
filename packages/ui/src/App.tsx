import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApplyNcOutcome, ByokConfig, NtcDesktopApi, RunProgressEvent } from '@ntc/core';
import { DEFAULT_GEMINI_MODEL_ID, toErrorMessage } from './api/helpers.js';
import { resolveDesktopApi } from './api/ipc-client.js';
import { Layout, type NavTabId } from './components/Layout.js';
import { DashboardNts } from './pages/DashboardNts.js';
import { DiffAndPr } from './pages/DiffAndPr.js';
import { NcReview } from './pages/NcReview.js';
import { RepoRegistry } from './pages/RepoRegistry.js';
import { SettingsByokDoctor } from './pages/SettingsByokDoctor.js';

export const DEFAULT_BYOK_CONFIG: ByokConfig = {
  provider: 'gemini',
  modelId: DEFAULT_GEMINI_MODEL_ID,
  operatorName: 'Operador',
  secretKeyRef: 'ntc:llm:gemini',
};

export function App({ api: injectedApi }: { readonly api?: NtcDesktopApi }) {
  const api = useMemo(() => resolveDesktopApi(injectedApi), [injectedApi]);
  const [activeTab, setActiveTab] = useState<NavTabId>('dashboard');
  const [latestProgress, setLatestProgress] = useState<RunProgressEvent | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedXsdDir, setSelectedXsdDir] = useState('');
  const [byokConfig, setByokConfig] = useState<ByokConfig>(DEFAULT_BYOK_CONFIG);
  const [applyingRunId, setApplyingRunId] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyOutcome, setApplyOutcome] = useState<ApplyNcOutcome | null>(null);
  const [homeResetKey, setHomeResetKey] = useState(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    let cancelled = false;
    void api
      .getByokConfig()
      .then((savedConfig) => {
        if (!cancelled && isMountedRef.current && savedConfig) {
          setByokConfig(savedConfig);
        }
      })
      .catch(() => undefined);
    const unsubscribe = api.onRunProgress((event) => {
      if (isMountedRef.current) {
        setLatestProgress(event);
      }
    });
    return () => {
      cancelled = true;
      isMountedRef.current = false;
      unsubscribe();
    };
  }, [api]);

  function handleDraftReady(runId: string, xsdDir: string): void {
    setSelectedRunId(runId);
    setSelectedXsdDir(xsdDir);
    setApplyError(null);
    setApplyOutcome(null);
    setActiveTab('nc');
  }

  function handleOpenRunDiff(runId: string): void {
    setSelectedRunId(runId);
    setApplyError(null);
    setApplyOutcome(null);
    setActiveTab('diff');
  }

  function handleStartApply(request: {
    readonly runId: string;
    readonly byokConfig: ByokConfig;
    readonly xsdDir: string;
  }): void {
    setSelectedRunId(request.runId);
    setApplyingRunId(request.runId);
    setApplyError(null);
    setApplyOutcome(null);
    setActiveTab('diff');

    void api
      .applyNc(request)
      .then((outcome) => {
        if (isMountedRef.current) {
          setApplyOutcome(outcome);
        }
      })
      .catch((err: unknown) => {
        if (isMountedRef.current) {
          setApplyError(toErrorMessage(err));
        }
      })
      .finally(() => {
        if (isMountedRef.current) {
          setApplyingRunId((prev) => (prev === request.runId ? null : prev));
        }
      });
  }

  function handleGoHome(): void {
    setActiveTab('dashboard');
    setHomeResetKey((prev) => prev + 1);
  }

  return (
    <Layout
      activeTab={activeTab}
      onSelectTab={setActiveTab}
      onGoHome={handleGoHome}
      latestProgress={latestProgress}
    >
      {activeTab === 'dashboard' && (
        <DashboardNts
          api={api}
          byokConfig={byokConfig}
          homeResetKey={homeResetKey}
          onDraftReady={handleDraftReady}
          onOpenRunDiff={handleOpenRunDiff}
        />
      )}
      {activeTab === 'repos' && <RepoRegistry api={api} onGoHome={handleGoHome} />}
      {activeTab === 'nc' && (
        <NcReview
          key={selectedRunId ?? 'none'}
          api={api}
          runId={selectedRunId}
          xsdDir={selectedXsdDir}
          byokConfig={byokConfig}
          applyingRunId={applyingRunId}
          onStartApply={handleStartApply}
          onGoHome={handleGoHome}
        />
      )}
      {activeTab === 'diff' && (
        <DiffAndPr
          api={api}
          runId={selectedRunId}
          latestProgress={latestProgress}
          applyingRunId={applyingRunId}
          applyError={applyError}
          applyOutcome={applyOutcome}
          onGoHome={handleGoHome}
        />
      )}
      {activeTab === 'settings' && (
        <SettingsByokDoctor
          api={api}
          byokConfig={byokConfig}
          onChangeConfig={setByokConfig}
          onGoHome={handleGoHome}
        />
      )}
    </Layout>
  );
}
