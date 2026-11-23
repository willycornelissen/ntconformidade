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

export interface DashboardNtsProps {
  readonly api: NtcDesktopApi;
  readonly byokConfig: ByokConfig;
  readonly onDraftReady: (runId: string, xsdDir: string) => void;
  readonly onOpenRunDiff?: (runId: string) => void;
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

function NtCatalogTable({
  entries,
  busy,
  onCheckCompliance,
}: {
  readonly entries: readonly NtCatalogEntry[];
  readonly busy: boolean;
  readonly onCheckCompliance: (entry: NtCatalogEntry) => void;
}) {
  return (
    <table className="data-table">
      <caption className="sr-only">Notas Técnicas cacheadas</caption>
      <thead>
        <tr>
          <th scope="col">DFe</th>
          <th scope="col">NT</th>
          <th scope="col">Versão</th>
          <th scope="col">Publicação</th>
          <th scope="col">Status Fonte</th>
          <th scope="col">Ações</th>
        </tr>
      </thead>
      <tbody>
        {entries.length === 0 ? (
          <tr>
            <td colSpan={6}>Nenhuma Nota Técnica encontrada no cache.</td>
          </tr>
        ) : (
          entries.map((entry) => (
            <tr key={entry.id}>
              <td>{entry.dfe}</td>
              <td>{entry.ntNumber}</td>
              <td>{entry.ntVersion}</td>
              <td>{entry.publishedDate}</td>
              <td>
                <span className={sourceStatusBadgeClass(entry.sourceStatus)}>
                  {entry.sourceStatus}
                </span>
              </td>
              <td>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => onCheckCompliance(entry)}
                >
                  Verificar conformidade
                </button>
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function RecentRunsTable({
  runs,
  busy,
  onDraftReady,
  onOpenRunDiff,
}: {
  readonly runs: readonly ComplianceRun[];
  readonly busy: boolean;
  readonly onDraftReady: (runId: string, xsdDir: string) => void;
  readonly onOpenRunDiff?: (runId: string) => void;
}) {
  return (
    <div style={{ marginTop: '1rem' }}>
      <h3>Execuções Recentes</h3>
      <table className="data-table">
        <caption className="sr-only">Execuções de conformidade recentes</caption>
        <thead>
          <tr>
            <th scope="col">Run ID</th>
            <th scope="col">DFe</th>
            <th scope="col">NT</th>
            <th scope="col">Status</th>
            <th scope="col">Ação</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.runId}>
              <td>{run.runId}</td>
              <td>{run.dfe}</td>
              <td>{run.ntId}</td>
              <td>{run.status}</td>
              <td>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    run.status === 'DRAFT'
                      ? onDraftReady(run.runId, '')
                      : onOpenRunDiff?.(run.runId)
                  }
                >
                  Abrir
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DashboardNts({ api, byokConfig, onDraftReady, onOpenRunDiff }: DashboardNtsProps) {
  const [entries, setEntries] = useState<readonly NtCatalogEntry[]>([]);
  const [runs, setRuns] = useState<readonly ComplianceRun[]>([]);
  const [syncResults, setSyncResults] = useState<readonly SvrsDfeSyncResult[]>([]);
  const [manualXsdMap, setManualXsdMap] = useState<Readonly<Record<string, string>>>({});
  const [dfeFilter, setDfeFilter] = useState<'ALL' | DfeCode>('ALL');
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

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return entries.filter((entry) => {
      if (dfeFilter !== 'ALL' && entry.dfe !== dfeFilter) {
        return false;
      }
      if (!q) {
        return true;
      }
      return (
        entry.ntNumber.toLowerCase().includes(q) ||
        entry.ntVersion.toLowerCase().includes(q) ||
        entry.dfe.toLowerCase().includes(q)
      );
    });
  }, [entries, dfeFilter, searchQuery]);

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

  return (
    <section className="card">
      <h2>Notas Técnicas SVRS</h2>
      <div className="toolbar">
        <div className="field">
          <label htmlFor="dfe-filter">Filtrar por DFe</label>
          <select
            id="dfe-filter"
            value={dfeFilter}
            onChange={(e) => {
              if (e.target.value === 'ALL' || isDfeCode(e.target.value)) {
                setDfeFilter(e.target.value);
              }
            }}
          >
            <option value="ALL">Todos</option>
            {ALL_DFES.map((dfe) => (
              <option key={dfe} value={dfe}>
                {dfe}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="nt-search">Buscar NT</label>
          <input
            id="nt-search"
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Ex.: 2025.002"
          />
        </div>

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

      <NtCatalogTable
        entries={filteredEntries}
        busy={busy}
        onCheckCompliance={(entry) => {
          void handleCheckCompliance(entry);
        }}
      />

      {runs.length > 0 && (
        <RecentRunsTable
          runs={runs}
          busy={busy}
          onDraftReady={onDraftReady}
          onOpenRunDiff={onOpenRunDiff}
        />
      )}
    </section>
  );
}
