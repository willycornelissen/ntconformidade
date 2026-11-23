import { useEffect, useRef, useState } from 'react';
import type {
  ByokConfig,
  NcDocument,
  NcItem,
  NcItemDecision,
  NtcDesktopApi,
} from '@ntc/core';
import { isNcItemDecision, toErrorMessage } from '../api/helpers.js';

export interface NcReviewProps {
  readonly api: NtcDesktopApi;
  readonly runId: string | null;
  readonly xsdDir: string;
  readonly byokConfig: ByokConfig;
  readonly applyingRunId?: string | null;
  readonly onStartApply?: (request: {
    readonly runId: string;
    readonly byokConfig: ByokConfig;
    readonly xsdDir: string;
  }) => void;
  readonly onApplyStarted?: (runId: string) => void;
  readonly onGoHome?: () => void;
}

function NcItemCard({
  item,
  disabled,
  onDecisionChange,
  onNotesChange,
}: {
  readonly item: NcItem;
  readonly disabled: boolean;
  readonly onDecisionChange: (itemId: string, decision: NcItemDecision) => void;
  readonly onNotesChange: (itemId: string, notes: string) => void;
}) {
  return (
    <div className="card" style={{ marginBottom: '0.75rem' }}>
      <div className="toolbar">
        <strong>
          {item.id} — {item.title}
        </strong>
        <span className="badge badge-warn">{item.category}</span>
      </div>
      <p>{item.description}</p>
      <p>
        Tag: <code>{item.tagPath ?? 'N/A'}</code> | Citações: {item.pdfCitations.join(', ')}
      </p>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`decision-${item.id}`}>Decisão</label>
          <select
            id={`decision-${item.id}`}
            disabled={disabled}
            value={item.decision}
            onChange={(e) => {
              if (isNcItemDecision(e.target.value)) {
                onDecisionChange(item.id, e.target.value);
              }
            }}
          >
            <option value="APPROVE">APPROVE</option>
            <option value="EDIT">EDIT</option>
            <option value="SKIP">SKIP</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`notes-${item.id}`}>Notas do operador</label>
          <input
            id={`notes-${item.id}`}
            disabled={disabled}
            value={item.editedNotes ?? ''}
            onChange={(e) => onNotesChange(item.id, e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

function computeApplyHint(args: {
  readonly hasActiveBlocker: boolean;
  readonly needsNoGapConfirmation: boolean;
  readonly missingXsdDir: boolean;
  readonly isApplying: boolean;
}): string | null {
  if (args.isApplying) {
    return 'Aplicação já está em andamento para esta execução.';
  }
  if (args.hasActiveBlocker) {
    return 'Bloqueio SHARED_XML_PARSER_BLOCKER precisa estar marcado como SKIP.';
  }
  if (args.needsNoGapConfirmation) {
    return 'Confirme o checkbox de ausência de lacunas estruturais antes de prosseguir.';
  }
  if (args.missingXsdDir) {
    return 'Informe o diretório XSD para habilitar a validação e aplicação.';
  }
  return null;
}

export function NcReview({
  api,
  runId,
  xsdDir,
  byokConfig,
  applyingRunId,
  onStartApply,
  onApplyStarted,
  onGoHome,
}: NcReviewProps) {
  const [nc, setNc] = useState<NcDocument | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [manualXsdDir, setManualXsdDir] = useState(xsdDir);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    setNc(null);
    setMarkdown('');
    setStatusMessage(null);
    setErrorMessage(null);
    setManualXsdDir(xsdDir);

    if (!runId) {
      return () => {
        isMountedRef.current = false;
      };
    }

    let cancelled = false;
    void api
      .getNc({ runId })
      .then((view) => {
        if (!cancelled && isMountedRef.current) {
          setNc(view.nc);
          setMarkdown(view.markdown);
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
  }, [api, runId, xsdDir]);

  if (!runId || !nc) {
    return (
      <section className="card">
        <div className="section-header">
          <h2>Revisão de NC</h2>
          {onGoHome && (
            <button type="button" className="btn" onClick={onGoHome}>
              Voltar à Tela Inicial
            </button>
          )}
        </div>
        {errorMessage ? (
          <p className="alert alert-danger" role="alert">
            {errorMessage}
          </p>
        ) : (
          <p>Selecione ou verifique uma Nota Técnica no painel inicial para revisar a NC.</p>
        )}
      </section>
    );
  }

  const isApplying = applyingRunId === runId;
  const controlsDisabled = busy || isApplying;
  const hasActiveBlocker = nc.items.some(
    (item) => item.category === 'SHARED_XML_PARSER_BLOCKER' && item.decision !== 'SKIP',
  );
  const needsNoGapConfirmation = nc.no_structural_gaps && nc.confirmed_no_gaps !== true;
  const trimmedXsdDir = manualXsdDir.trim();
  const missingXsdDir = !nc.no_structural_gaps && trimmedXsdDir.length === 0;
  const canApply =
    !hasActiveBlocker && !needsNoGapConfirmation && !missingXsdDir && !controlsDisabled;
  const applyHint = computeApplyHint({
    hasActiveBlocker,
    needsNoGapConfirmation,
    missingXsdDir,
    isApplying,
  });

  function updateItemDecision(itemId: string, decision: NcItemDecision): void {
    setNc((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((item) => (item.id === itemId ? { ...item, decision } : item)),
          }
        : prev,
    );
  }

  function updateItemNotes(itemId: string, editedNotes: string): void {
    setNc((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((item) => (item.id === itemId ? { ...item, editedNotes } : item)),
          }
        : prev,
    );
  }

  function toggleNoGapConfirm(checked: boolean): void {
    setNc((prev) =>
      prev
        ? {
            ...prev,
            confirmed_no_gaps: checked,
            confirmed_at: checked ? new Date().toISOString() : null,
          }
        : prev,
    );
  }

  async function handleSave(): Promise<void> {
    if (!nc || !runId || controlsDisabled) {
      return;
    }
    setBusy(true);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      const saved = await api.saveNc({ runId, nc });
      if (isMountedRef.current) {
        setNc(saved.nc);
        setMarkdown(saved.markdown);
        setStatusMessage('NC salva em formato JSON e preview Markdown atualizado.');
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

  async function handleApply(): Promise<void> {
    if (!nc || !runId || !canApply) {
      return;
    }
    setBusy(true);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      await api.saveNc({ runId, nc });
      const resolvedXsd = trimmedXsdDir || 'N/A';
      if (onStartApply) {
        onStartApply({ runId, byokConfig, xsdDir: resolvedXsd });
      } else {
        onApplyStarted?.(runId);
        await api.applyNc({ runId, byokConfig, xsdDir: resolvedXsd });
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
        <h2>Revisão de NC — {nc.nc_id}</h2>
        {onGoHome && (
          <button type="button" className="btn" onClick={onGoHome}>
            Voltar à Tela Inicial
          </button>
        )}
      </div>
      <p>
        DFe: <strong>{nc.nt_ref.dfe}</strong> | NT {nc.nt_ref.nt_number} v{nc.nt_ref.nt_version} |
        Commit base: <code>{nc.base_commit_sha}</code>
      </p>

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

      {hasActiveBlocker && (
        <div className="alert alert-danger" role="alert">
          <strong>Bloqueio SHARED_XML_PARSER_BLOCKER ativo:</strong> marque os itens de biblioteca
          compartilhada como SKIP ou resolva o bloqueio antes de aplicar.
        </div>
      )}

      {nc.no_structural_gaps && (
        <div className="alert alert-warn" role="status">
          <label>
            <input
              type="checkbox"
              disabled={controlsDisabled}
              checked={nc.confirmed_no_gaps === true}
              onChange={(e) => toggleNoGapConfirm(e.target.checked)}
            />{' '}
            Confirmo que não há lacunas estruturais na NT analisada
          </label>
        </div>
      )}

      <div className="field" style={{ marginBottom: '0.75rem' }}>
        <label htmlFor="nc-xsd-dir">Diretório XSD para validação</label>
        <input
          id="nc-xsd-dir"
          disabled={controlsDisabled}
          value={manualXsdDir}
          onChange={(e) => setManualXsdDir(e.target.value)}
        />
      </div>

      {nc.items.map((item) => (
        <NcItemCard
          key={item.id}
          item={item}
          disabled={controlsDisabled}
          onDecisionChange={updateItemDecision}
          onNotesChange={updateItemNotes}
        />
      ))}

      <div className="toolbar">
        <button
          type="button"
          className="btn"
          disabled={controlsDisabled}
          onClick={() => {
            void handleSave();
          }}
        >
          Salvar Revisão
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canApply}
          aria-describedby={applyHint ? 'nc-apply-hint' : undefined}
          onClick={() => {
            void handleApply();
          }}
        >
          Aplicar NC ao parser
        </button>
      </div>
      {applyHint && (
        <p id="nc-apply-hint" style={{ marginTop: '0.5rem' }}>
          {applyHint}
        </p>
      )}

      <h3>Preview Markdown (Mão Única)</h3>
      <pre className="diff-pre">{markdown}</pre>
    </section>
  );
}
