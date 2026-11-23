import { useEffect, useRef, useState } from 'react';
import type { DfeCode, DfeRepoEntry, NtcDesktopApi } from '@ntc/core';
import { isSafeHttpsUrlInput, toErrorMessage } from '../api/helpers.js';

type EditableRepoField =
  | 'giteaUrl'
  | 'baseBranch'
  | 'domainPackage'
  | 'mapperPackage'
  | 'tablePackage'
  | 'parserPackage'
  | 'utilPackage'
  | 'baselineNt';

function RepoCard({
  repo,
  saving,
  onChangeField,
  onSave,
}: {
  readonly repo: DfeRepoEntry;
  readonly saving: boolean;
  readonly onChangeField: (dfe: DfeCode, field: EditableRepoField, value: string) => void;
  readonly onSave: (repo: DfeRepoEntry) => void;
}) {
  return (
    <form
      className="card"
      style={{ marginBottom: '0.75rem' }}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(repo);
      }}
    >
      <h3>
        {repo.dfe} — <strong>{repo.repoSlug}</strong> ({repo.tagPrefix})
      </h3>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`url-${repo.dfe}`}>URL Gitea HTTPS</label>
          <input
            id={`url-${repo.dfe}`}
            disabled={saving}
            value={repo.giteaUrl}
            onChange={(e) => onChangeField(repo.dfe, 'giteaUrl', e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`branch-${repo.dfe}`}>Branch base</label>
          <input
            id={`branch-${repo.dfe}`}
            disabled={saving}
            value={repo.baseBranch}
            onChange={(e) => onChangeField(repo.dfe, 'baseBranch', e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`domain-${repo.dfe}`}>Pacote Domain</label>
          <input
            id={`domain-${repo.dfe}`}
            disabled={saving}
            value={repo.domainPackage}
            onChange={(e) => onChangeField(repo.dfe, 'domainPackage', e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`mapper-${repo.dfe}`}>Pacote Mapper</label>
          <input
            id={`mapper-${repo.dfe}`}
            disabled={saving}
            value={repo.mapperPackage}
            onChange={(e) => onChangeField(repo.dfe, 'mapperPackage', e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`table-${repo.dfe}`}>Pacote Table</label>
          <input
            id={`table-${repo.dfe}`}
            disabled={saving}
            value={repo.tablePackage}
            onChange={(e) => onChangeField(repo.dfe, 'tablePackage', e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`parser-${repo.dfe}`}>Pacote Parser</label>
          <input
            id={`parser-${repo.dfe}`}
            disabled={saving}
            value={repo.parserPackage}
            onChange={(e) => onChangeField(repo.dfe, 'parserPackage', e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`util-${repo.dfe}`}>Pacote Util (opcional)</label>
          <input
            id={`util-${repo.dfe}`}
            disabled={saving}
            value={repo.utilPackage ?? ''}
            onChange={(e) => onChangeField(repo.dfe, 'utilPackage', e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`baseline-${repo.dfe}`}>NT Baseline (opcional)</label>
          <input
            id={`baseline-${repo.dfe}`}
            disabled={saving}
            value={repo.baselineNt ?? ''}
            onChange={(e) => onChangeField(repo.dfe, 'baselineNt', e.target.value)}
          />
        </div>
      </div>
      <div className="toolbar" style={{ marginTop: '0.75rem' }}>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          Salvar Repositório
        </button>
      </div>
    </form>
  );
}

export function RepoRegistry({ api }: { readonly api: NtcDesktopApi }) {
  const [repos, setRepos] = useState<DfeRepoEntry[]>([]);
  const [savingDfe, setSavingDfe] = useState<DfeCode | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    let cancelled = false;
    void api
      .listRepos()
      .then((loaded) => {
        if (!cancelled && isMountedRef.current) {
          setRepos([...loaded]);
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
  }, [api]);

  function updateField(dfe: DfeCode, field: EditableRepoField, value: string): void {
    setRepos((prev) =>
      prev.map((repo) => {
        if (repo.dfe !== dfe) {
          return repo;
        }
        if (field === 'utilPackage' || field === 'baselineNt') {
          return { ...repo, [field]: value.trim() === '' ? null : value };
        }
        return { ...repo, [field]: value };
      }),
    );
  }

  async function handleSave(repo: DfeRepoEntry): Promise<void> {
    setErrorMessage(null);
    setStatusMessage(null);
    if (!isSafeHttpsUrlInput(repo.giteaUrl)) {
      setErrorMessage(`URL do Gitea para ${repo.dfe} deve usar HTTPS válido sem credenciais embutidas.`);
      return;
    }
    setSavingDfe(repo.dfe);
    try {
      await api.saveRepo(repo);
      if (isMountedRef.current) {
        setStatusMessage(`Repositório ${repo.repoSlug} (${repo.dfe}) salvo.`);
      }
    } catch (err: unknown) {
      if (isMountedRef.current) {
        setErrorMessage(toErrorMessage(err));
      }
    } finally {
      if (isMountedRef.current) {
        setSavingDfe(null);
      }
    }
  }

  return (
    <section className="card">
      <h2>Registro de Repositórios DFe</h2>
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

      {repos.map((repo) => (
        <RepoCard
          key={repo.dfe}
          repo={repo}
          saving={savingDfe === repo.dfe}
          onChangeField={updateField}
          onSave={(r) => {
            void handleSave(r);
          }}
        />
      ))}
    </section>
  );
}
