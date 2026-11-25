import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ByokConfig,
  ComplianceRun,
  DfeCode,
  NtCatalogEntry,
  NtcDesktopApi,
  SvrsDfeSyncResult,
} from '@ntc/core';
import { ALL_DFES, isDfeCode, toErrorMessage } from '../api/helpers.js';
import homeLogo from '../assets/home-logo.png';

export interface DashboardNtsProps {
  readonly api: NtcDesktopApi;
  readonly byokConfig: ByokConfig;
  readonly homeResetKey?: number;
  readonly onDraftReady: (runId: string, xsdDir: string) => void;
}

interface DfeGroupSummary {
  readonly dfe: DfeCode;
  readonly entries: readonly NtCatalogEntry[];
  readonly latestEntry: NtCatalogEntry | null;
  readonly syncError: string | null;
}

function sourceStatusBadgeClass(status: NtCatalogEntry['sourceStatus']): string {
  if (status === 'PARSE_ERROR') {
    return 'badge badge-danger';
  }
  if (status === 'UNAVAILABLE') {
    return 'badge badge-warn';
  }
  return 'badge badge-ok';
}

function formatSourceStatusLabel(status: NtCatalogEntry['sourceStatus']): string {
  return status === 'DISCOVERED' ? 'Publicada' : status;
}

function findLatestNcRunByNt(runs: readonly ComplianceRun[]): ReadonlyMap<string, ComplianceRun> {
  const byNt = new Map<string, ComplianceRun>();
  for (const run of runs) {
    if (!run.ncJsonPath) {
      continue;
    }
    const existing = byNt.get(run.ntId);
    const isNewer =
      !existing ||
      run.createdAt.localeCompare(existing.createdAt) > 0 ||
      (run.createdAt === existing.createdAt && run.updatedAt.localeCompare(existing.updatedAt) > 0);
    if (isNewer) {
      byNt.set(run.ntId, run);
    }
  }
  return byNt;
}

function formatBrDate(rawDate: string): string {
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(rawDate.trim());
  if (isoMatch?.[1] && isoMatch[2] && isoMatch[3]) {
    return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;
  }
  return rawDate;
}

function compareEntriesDesc(a: NtCatalogEntry, b: NtCatalogEntry): number {
  const byDate = b.publishedDate.localeCompare(a.publishedDate);
  if (byDate !== 0) {
    return byDate;
  }
  const byNum = b.ntNumber.localeCompare(a.ntNumber, undefined, { numeric: true });
  if (byNum !== 0) {
    return byNum;
  }
  return b.ntVersion.localeCompare(a.ntVersion, undefined, { numeric: true });
}

function groupEntriesByDfe(
  entries: readonly NtCatalogEntry[],
  syncResults: readonly SvrsDfeSyncResult[],
): readonly DfeGroupSummary[] {
  const errorByDfe = new Map<DfeCode, string | null>();
  for (const res of syncResults) {
    errorByDfe.set(res.dfe, res.error);
  }
  return ALL_DFES.map((dfe) => {
    const dfeEntries = entries.filter((entry) => entry.dfe === dfe).sort(compareEntriesDesc);
    return {
      dfe,
      entries: dfeEntries,
      latestEntry: dfeEntries[0] ?? null,
      syncError: errorByDfe.get(dfe) ?? null,
    };
  });
}

function ManualNtImportForm(props: {
  readonly busy: boolean;
  readonly dfe: DfeCode;
  readonly ntNumber: string;
  readonly ntVersion: string;
  readonly publishedDate: string;
  readonly pdfPath: string;
  readonly xsdPath: string;
  readonly onChangeDfe: (dfe: DfeCode) => void;
  readonly onChangeNtNumber: (v: string) => void;
  readonly onChangeNtVersion: (v: string) => void;
  readonly onChangeDate: (v: string) => void;
  readonly onChangePdfPath: (v: string) => void;
  readonly onChangeXsdPath: (v: string) => void;
  readonly onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <form className="card" onSubmit={props.onSubmit}>
      <h3>Importação Manual Offline (PDF + XSD)</h3>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="manual-dfe">DFe</label>
          <select
            id="manual-dfe"
            value={props.dfe}
            disabled={props.busy}
            onChange={(e) => {
              if (isDfeCode(e.target.value)) {
                props.onChangeDfe(e.target.value);
              }
            }}
          >
            {ALL_DFES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="manual-nt-number">Número NT</label>
          <input
            id="manual-nt-number"
            required
            disabled={props.busy}
            value={props.ntNumber}
            onChange={(e) => props.onChangeNtNumber(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="manual-nt-version">Versão NT</label>
          <input
            id="manual-nt-version"
            required
            disabled={props.busy}
            value={props.ntVersion}
            onChange={(e) => props.onChangeNtVersion(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="manual-pub-date">Data Publicação</label>
          <input
            id="manual-pub-date"
            required
            disabled={props.busy}
            value={props.publishedDate}
            onChange={(e) => props.onChangeDate(e.target.value)}
            placeholder="dd/MM/yyyy"
          />
        </div>
        <div className="field">
          <label htmlFor="manual-pdf-path">Caminho PDF</label>
          <input
            id="manual-pdf-path"
            required
            disabled={props.busy}
            value={props.pdfPath}
            onChange={(e) => props.onChangePdfPath(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="manual-xsd-path">Caminho XSD</label>
          <input
            id="manual-xsd-path"
            required
            disabled={props.busy}
            value={props.xsdPath}
            onChange={(e) => props.onChangeXsdPath(e.target.value)}
          />
        </div>
      </div>
      <div className="toolbar" style={{ marginTop: '0.75rem' }}>
        <button type="submit" className="btn btn-primary" disabled={props.busy}>
          Confirmar Importação
        </button>
      </div>
    </form>
  );
}

function DfeDocumentCardsGrid({
  groups,
  ncRunByNtId,
  busy,
  onSelectDfe,
}: {
  readonly groups: readonly DfeGroupSummary[];
  readonly ncRunByNtId: ReadonlyMap<string, ComplianceRun>;
  readonly busy: boolean;
  readonly onSelectDfe: (dfe: DfeCode) => void;
}) {
  return (
    <div className="dfe-grid">
      {groups.map((group) => {
        const verifiedCount = group.entries.filter((entry) => ncRunByNtId.has(entry.id)).length;
        return (
          <button
            key={group.dfe}
            type="button"
            className="dfe-card"
            disabled={busy}
            onClick={() => onSelectDfe(group.dfe)}
          >
            <div className="dfe-card-header">
              <span className="dfe-card-title">{group.dfe}</span>
              <span className="dfe-card-badges">
                <span className={group.entries.length > 0 ? 'badge badge-ok' : 'badge badge-warn'}>
                  {group.entries.length} {group.entries.length === 1 ? 'NT' : 'NTs'}
                </span>
                {verifiedCount > 0 && (
                  <span className="badge badge-ok">
                    {verifiedCount} {verifiedCount === 1 ? 'verificada' : 'verificadas'}
                  </span>
                )}
              </span>
            </div>
            {group.latestEntry ? (
              <span className="dfe-card-meta">
                Última: NT {group.latestEntry.ntNumber} ({group.latestEntry.ntVersion}) —{' '}
                {formatBrDate(group.latestEntry.publishedDate)}
              </span>
            ) : (
              <span className="dfe-card-meta">Nenhuma NT em cache.</span>
            )}
            {group.syncError && (
              <span className="badge badge-danger">Erro coleta: {group.syncError}</span>
            )}
            <span className="dfe-card-footer" aria-hidden="true">
              Abrir catálogo →
            </span>
          </button>
        );
      })}
    </div>
  );
}

function NtCatalogTable({
  dfe,
  entries,
  ncRunByNtId,
  busy,
  onCheckCompliance,
  onReviewNc,
}: {
  readonly dfe: DfeCode;
  readonly entries: readonly NtCatalogEntry[];
  readonly ncRunByNtId: ReadonlyMap<string, ComplianceRun>;
  readonly busy: boolean;
  readonly onCheckCompliance: (entry: NtCatalogEntry) => void;
  readonly onReviewNc: (entry: NtCatalogEntry, run: ComplianceRun) => void;
}) {
  return (
    <table className="data-table">
      <caption className="sr-only">Notas Técnicas de {dfe}</caption>
      <thead>
        <tr>
          <th scope="col">NT</th>
          <th scope="col">Versão</th>
          <th scope="col">Publicação</th>
          <th scope="col">Status</th>
          <th scope="col">Ações</th>
        </tr>
      </thead>
      <tbody>
        {entries.length === 0 ? (
          <tr>
            <td colSpan={5}>Nenhuma Nota Técnica encontrada para {dfe}.</td>
          </tr>
        ) : (
          entries.map((entry) => {
            const ncRun = ncRunByNtId.get(entry.id);
            return (
              <tr key={entry.id}>
                <td>{entry.ntNumber}</td>
                <td>{entry.ntVersion}</td>
                <td>{formatBrDate(entry.publishedDate)}</td>
                <td>
                  {ncRun ? (
                    <span className="badge badge-ok">Verificada</span>
                  ) : (
                    <span className={sourceStatusBadgeClass(entry.sourceStatus)}>
                      {formatSourceStatusLabel(entry.sourceStatus)}
                    </span>
                  )}
                </td>
                <td>
                  {ncRun ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => onReviewNc(entry, ncRun)}
                    >
                      Revisar NC
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => onCheckCompliance(entry)}
                    >
                      Verificar conformidade
                    </button>
                  )}
                </td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}

export function DashboardNts({
  api,
  byokConfig,
  homeResetKey,
  onDraftReady,
}: DashboardNtsProps) {
  const [entries, setEntries] = useState<readonly NtCatalogEntry[]>([]);
  const [runs, setRuns] = useState<readonly ComplianceRun[]>([]);
  const [syncResults, setSyncResults] = useState<readonly SvrsDfeSyncResult[]>([]);
  const [manualXsdMap, setManualXsdMap] = useState<Readonly<Record<string, string>>>({});
  const [selectedDfe, setSelectedDfe] = useState<DfeCode | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [showManualForm, setShowManualForm] = useState(false);
  const [manualDfe, setManualDfe] = useState<DfeCode>('NFe');
  const [manualNtNumber, setManualNtNumber] = useState('');
  const [manualNtVersion, setManualNtVersion] = useState('');
  const [manualDate, setManualDate] = useState('');
  const [manualPdfPath, setManualPdfPath] = useState('');
  const [manualXsdPath, setManualXsdPath] = useState('');

  const isMountedRef = useRef(true);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    if (homeResetKey !== undefined && homeResetKey > 0) {
      setSelectedDfe(null);
      setSearchQuery('');
      setShowManualForm(false);
    }
  }, [homeResetKey]);

  const refreshCached = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    const [cachedNts, cachedRuns] = await Promise.all([api.listNts(), api.listRuns()]);
    if (!isMountedRef.current || seq !== requestSeqRef.current) {
      return;
    }
    setEntries(cachedNts);
    setRuns(cachedRuns);
  }, [api]);

  useEffect(() => {
    isMountedRef.current = true;
    let cancelled = false;
    void refreshCached().catch((err: unknown) => {
      if (!cancelled && isMountedRef.current) {
        setErrorMessage(toErrorMessage(err));
      }
    });
    return () => {
      cancelled = true;
      isMountedRef.current = false;
    };
  }, [refreshCached]);

  const groupedDfes = useMemo(
    () => groupEntriesByDfe(entries, syncResults),
    [entries, syncResults],
  );

  const ncRunByNtId = useMemo(() => findLatestNcRunByNt(runs), [runs]);

  const visibleGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return groupedDfes;
    }
    return groupedDfes.filter(
      (g) =>
        g.dfe.toLowerCase().includes(q) ||
        g.entries.some(
          (e) => e.ntNumber.toLowerCase().includes(q) || e.ntVersion.toLowerCase().includes(q),
        ),
    );
  }, [groupedDfes, searchQuery]);

  const selectedDfeEntries = useMemo(() => {
    if (!selectedDfe) {
      return [];
    }
    const group = groupedDfes.find((g) => g.dfe === selectedDfe);
    const list = group?.entries ?? [];
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return list;
    }
    return list.filter(
      (entry) =>
        entry.ntNumber.toLowerCase().includes(q) || entry.ntVersion.toLowerCase().includes(q),
    );
  }, [groupedDfes, selectedDfe, searchQuery]);

  async function handleSyncSvrs(): Promise<void> {
    setBusy(true);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      const results = await api.syncSvrs();
      if (!isMountedRef.current) {
        return;
      }
      setSyncResults(results);
      await refreshCached();
      if (isMountedRef.current) {
        setStatusMessage('Sincronização SVRS concluída.');
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

  async function handleManualImport(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      const imported = await api.importManualNt({
        dfe: manualDfe,
        ntNumber: manualNtNumber,
        ntVersion: manualNtVersion,
        publishedDate: manualDate,
        pdfSourcePath: manualPdfPath,
        xsdSourcePath: manualXsdPath,
      });
      if (!isMountedRef.current) {
        return;
      }
      setManualXsdMap((prev) => ({ ...prev, [imported.entry.id]: imported.xsdDir }));
      await refreshCached();
      if (isMountedRef.current) {
        const importedLabel = `NT ${manualNtNumber} v${manualNtVersion} importada manualmente.`;
        setShowManualForm(false);
        setSelectedDfe(imported.entry.dfe);
        setManualNtNumber('');
        setManualNtVersion('');
        setManualDate('');
        setManualPdfPath('');
        setManualXsdPath('');
        setStatusMessage(importedLabel);
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

  async function handleCheckCompliance(entry: NtCatalogEntry): Promise<void> {
    setBusy(true);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      const draft = await api.checkCompliance({
        dfe: entry.dfe,
        ntId: entry.id,
        byokConfig,
      });
      if (isMountedRef.current) {
        onDraftReady(draft.run.runId, draft.xsdDir || manualXsdMap[entry.id] || '');
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

  const syncErrors = syncResults.filter((r) => r.error !== null);
  const verifiedNtCount = entries.filter((entry) => ncRunByNtId.has(entry.id)).length;

  const toolbarBlock = (
    <div className="home-toolbar">
      <div className="field home-search-field">
        <label htmlFor="nt-search">{selectedDfe ? 'Buscar NT' : 'Filtrar DFe ou NT'}</label>
        <input
          id="nt-search"
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={selectedDfe ? 'Ex.: 2025.002' : 'Ex.: NFe ou 2025.002'}
        />
      </div>

      <div className="home-toolbar-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => {
            void handleSyncSvrs();
          }}
        >
          Sincronizar SVRS
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          aria-expanded={showManualForm}
          onClick={() => setShowManualForm((prev) => !prev)}
        >
          Importar NT Manual
        </button>
      </div>
    </div>
  );

  const feedbackBlock = (
    <>
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
      {syncErrors.length > 0 && (
        <div className="alert alert-warn" role="status">
          {syncErrors.map((errItem) => (
            <div key={errItem.dfe}>
              {errItem.dfe}: {errItem.error}
            </div>
          ))}
        </div>
      )}
      {showManualForm && (
        <ManualNtImportForm
          busy={busy}
          dfe={manualDfe}
          ntNumber={manualNtNumber}
          ntVersion={manualNtVersion}
          publishedDate={manualDate}
          pdfPath={manualPdfPath}
          xsdPath={manualXsdPath}
          onChangeDfe={setManualDfe}
          onChangeNtNumber={setManualNtNumber}
          onChangeNtVersion={setManualNtVersion}
          onChangeDate={setManualDate}
          onChangePdfPath={setManualPdfPath}
          onChangeXsdPath={setManualXsdPath}
          onSubmit={(e) => {
            void handleManualImport(e);
          }}
        />
      )}
    </>
  );

  if (selectedDfe) {
    return (
      <section className="card">
        <div className="section-header">
          <h2>Notas Técnicas — {selectedDfe}</h2>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              setSelectedDfe(null);
              setSearchQuery('');
            }}
          >
            Voltar à Tela Inicial
          </button>
        </div>

        {toolbarBlock}
        {feedbackBlock}

        <NtCatalogTable
          dfe={selectedDfe}
          entries={selectedDfeEntries}
          ncRunByNtId={ncRunByNtId}
          busy={busy}
          onCheckCompliance={(entry) => {
            void handleCheckCompliance(entry);
          }}
          onReviewNc={(entry, run) => {
            onDraftReady(run.runId, manualXsdMap[entry.id] || '');
          }}
        />
      </section>
    );
  }

  return (
    <div className="home-dashboard">
      <section className="card home-hero">
        <div className="home-hero-brand">
          <img
            src={homeLogo}
            alt="DFe — Documento Fiscal Eletrônico"
            className="home-hero-logo"
          />
        </div>
        <div className="home-hero-content">
          <h2>Notas Técnicas por Documento Fiscal</h2>
          <p className="home-hero-subtitle">
            Selecione um documento fiscal para consultar Notas Técnicas, verificar conformidade com os
            parsers e revisar Notas de Conformidade.
          </p>
          <div className="home-stats">
            <div className="home-stat">
              <span className="home-stat-value">{ALL_DFES.length}</span>
              <span className="home-stat-label">Documentos DF-e</span>
            </div>
            <div className="home-stat">
              <span className="home-stat-value">{entries.length}</span>
              <span className="home-stat-label">NTs em cache</span>
            </div>
            <div className="home-stat">
              <span className="home-stat-value">{verifiedNtCount}</span>
              <span className="home-stat-label">NTs verificadas</span>
            </div>
          </div>
        </div>
      </section>

      <section className="card">
        {toolbarBlock}
        {feedbackBlock}
        <DfeDocumentCardsGrid
          groups={visibleGroups}
          ncRunByNtId={ncRunByNtId}
          busy={busy}
          onSelectDfe={(dfe) => {
            setSelectedDfe(dfe);
            setSearchQuery('');
          }}
        />
      </section>
    </div>
  );
}
