import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ApplyNcOutcome,
  NtcDesktopApi,
  PendingApprovalGate,
  PreBuildDiffPreview,
  RunProgressEvent,
} from '@ntc/core';
import { toErrorMessage } from '../api/helpers.js';

export interface DiffAndPrProps {
  readonly api: NtcDesktopApi;
  readonly runId: string | null;
  readonly latestProgress: RunProgressEvent | null;
  readonly applyingRunId?: string | null;
  readonly applyError?: string | null;
  readonly applyOutcome?: ApplyNcOutcome | null;
}

function PreBuildDiffCard({
  preview,
  busy,
  onApprove,
  onReject,
}: {
  readonly preview: PreBuildDiffPreview;
  readonly busy: boolean;
  readonly onApprove: () => void;
  readonly onReject: () => void;
}) {
  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <h3>Conferência Pré-Build — Branch {preview.branchName}</h3>
      {!preview.isStrictlyDeclarative && (
        <div className="alert alert-warn" role="status">
          <strong>Alteração não estritamente declarativa:</strong>
          <ul>
            {preview.nonDeclarativeReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
      <p>
        Editados: {preview.editedFiles.join(', ') || 'nenhum'} | Criados:{' '}
        {preview.createdFiles.join(', ') || 'nenhum'}
      </p>
      <pre className="diff-pre">{preview.unifiedDiff}</pre>
      <div className="toolbar" style={{ marginTop: '0.75rem' }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onApprove}>
          Aprovar Diff Pré-Build
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={onReject}>
          Rejeitar Diff
        </button>
      </div>
    </div>
  );
}

function MavenPrSummaryCard({ gate }: { readonly gate: PendingApprovalGate }) {
  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <h3>Resultado Maven &amp; Surefire — Branch {gate.branchName}</h3>
      <p>{gate.mavenResult?.summary}</p>
      {gate.mavenResult?.surefireSummary && (
        <p>
          Total: {gate.mavenResult.surefireSummary.total} | Erros:{' '}
          {gate.mavenResult.surefireSummary.errors} | Falhas:{' '}
          {gate.mavenResult.surefireSummary.failures}
        </p>
      )}
      <p>
        Artefato local <code>.patch</code>: <code>{gate.patchFilePath}</code>
      </p>
    </div>
  );
}

export function DiffAndPr({
  api,
  runId,
  latestProgress,
  applyingRunId,
  applyError,
  applyOutcome,
}: DiffAndPrProps) {
  const [gate, setGate] = useState<PendingApprovalGate | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isMountedRef = useRef(true);
  const requestSeqRef = useRef(0);
  const matchingProgress =
    latestProgress && runId && latestProgress.runId === runId ? latestProgress : null;

  const refreshGate = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    if (!runId) {
      if (isMountedRef.current) {
        setGate(null);
      }
      return;
    }
    const nextGate = await api.getPendingGate({ runId });
    if (!isMountedRef.current || seq !== requestSeqRef.current) {
      return;
    }
    setGate(nextGate);
  }, [api, runId]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    requestSeqRef.current += 1;
    setGate(null);
    setStatusMessage(null);
    setErrorMessage(null);
  }, [runId]);

  useEffect(() => {
    if (!runId) {
      return;
    }
    if (latestProgress && latestProgress.runId !== runId) {
      return;
    }
    let cancelled = false;
    void refreshGate().catch((err: unknown) => {
      if (!cancelled && isMountedRef.current) {
        setErrorMessage(toErrorMessage(err));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [runId, latestProgress, refreshGate]);

  useEffect(() => {
    if (!runId || applyingRunId !== runId || gate !== null) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshGate().catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [runId, applyingRunId, gate, refreshGate]);

  async function handlePreBuildDecision(approved: boolean): Promise<void> {
    if (!runId || busy) {
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    try {
      const res = await api.confirmPreBuildDiff({
        runId,
        approved,
        ...(approved ? {} : { reason: 'Rejeitado pelo operador na conferência pré-build' }),
        ...(gate?.gateToken ? { gateToken: gate.gateToken } : {}),
      });
      if (!isMountedRef.current) {
        return;
      }
      if (!res.acknowledged) {
        setErrorMessage('Conferência pré-build expirou ou já foi respondida.');
        await refreshGate();
        return;
      }
      await refreshGate();
      if (isMountedRef.current) {
        setStatusMessage(
          approved ? 'Diff pré-build aprovado; executando Maven...' : 'Execução abortada pelo operador.',
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

  async function handlePrDecision(approved: boolean): Promise<void> {
    if (!runId || busy) {
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    try {
      const res = await api.openPr({
        runId,
        approved,
        ...(gate?.gateToken ? { gateToken: gate.gateToken } : {}),
      });
      if (!isMountedRef.current) {
        return;
      }
      if (!res.acknowledged) {
        setErrorMessage('Confirmação de PR expirou ou já foi respondida.');
        await refreshGate();
        return;
      }
      await refreshGate();
      if (isMountedRef.current) {
        setStatusMessage(
          approved
            ? 'Push e abertura de Pull Request solicitados no Gitea.'
            : 'Push ignorado; apenas o arquivo .patch local foi preservado.',
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

  const prReady = gate?.kind === 'PR_CONFIRMATION' && gate.mavenResult?.passed === true;
  const activeError = applyError ?? errorMessage;

  return (
    <section className="card">
      <h2>Conferência de Diff e PR</h2>
      {!runId && <p>Nenhuma execução selecionada.</p>}
      {runId && applyingRunId === runId && !gate && !activeError && (
        <p className="alert alert-warn" role="status">
          Aplicação da NC em andamento ({matchingProgress?.step ?? 'preparando worktree e patch'})...
        </p>
      )}
      {statusMessage && (
        <p className="alert alert-ok" role="status">
          {statusMessage}
        </p>
      )}
      {activeError && (
        <p className="alert alert-danger" role="alert">
          {activeError}
        </p>
      )}

      {applyOutcome && applyOutcome.run.runId === runId && (
        <div className="alert alert-ok" role="status">
          <strong>Execução finalizada ({applyOutcome.run.status}):</strong>{' '}
          {applyOutcome.prUrl ? (
            <span>PR criado em {applyOutcome.prUrl}</span>
          ) : (
            <span>Patch local: {applyOutcome.patchFilePath ?? 'nenhum'}</span>
          )}
        </div>
      )}

      {gate?.kind === 'PRE_BUILD_DIFF' && gate.preview && (
        <PreBuildDiffCard
          preview={gate.preview}
          busy={busy}
          onApprove={() => {
            void handlePreBuildDecision(true);
          }}
          onReject={() => {
            void handlePreBuildDecision(false);
          }}
        />
      )}

      {gate?.kind === 'PR_CONFIRMATION' && <MavenPrSummaryCard gate={gate} />}

      <div className="toolbar">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!prReady || busy}
          aria-describedby={!prReady ? 'pr-gate-hint' : undefined}
          onClick={() => {
            void handlePrDecision(true);
          }}
        >
          Abrir PR no Gitea
        </button>
        {prReady && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              void handlePrDecision(false);
            }}
          >
            Manter apenas .patch local
          </button>
        )}
        {runId && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              void refreshGate().catch((err: unknown) => {
                if (isMountedRef.current) {
                  setErrorMessage(toErrorMessage(err));
                }
              });
            }}
          >
            Atualizar status
          </button>
        )}
      </div>
      {!prReady && (
        <p id="pr-gate-hint" style={{ marginTop: '0.5rem' }}>
          Abertura de PR liberada somente após aprovação pré-build e sucesso dos testes Maven.
        </p>
      )}
    </section>
  );
}
