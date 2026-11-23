import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  openDatabase,
  loadDefaultRegistryEntries,
  type NtcDatabase,
  type NtCatalogEntry,
} from '../src/index.js';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..', '..');
const REGISTRY_PATH = path.join(ROOT_DIR, 'config', 'dfe-registry.default.json');

const tempDirs: string[] = [];
const openHandles: NtcDatabase[] = [];

async function createTempDb(): Promise<{ dir: string; dbPath: string; ntcDb: NtcDatabase }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ntc-sqlite-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'nested', 'ntc.sqlite');
  const ntcDb = openDatabase(dbPath);
  openHandles.push(ntcDb);
  return { dir, dbPath, ntcDb };
}

function makeNtEntry(overrides: Partial<NtCatalogEntry> = {}): NtCatalogEntry {
  return {
    id: 'NFe:2026.005:v1.00',
    dfe: 'NFe',
    ntNumber: '2026.005',
    ntVersion: 'v1.00',
    publishedDate: '2026-10-26',
    homologDate: '2026-11-10',
    prodDate: '2026-12-01',
    pdfUrl: 'https://dfe-portal.svrs.rs.gov.br/Nfe/Download/nt2026_005.pdf',
    xsdUrl: 'https://dfe-portal.svrs.rs.gov.br/Nfe/Download/PL_009.zip',
    pdfSha256: 'a'.repeat(64),
    sourceStatus: 'DISCOVERED',
    fetchedAt: '2026-11-19T12:00:00.000Z',
    ...overrides,
  };
}

afterEach(async () => {
  while (openHandles.length > 0) {
    openHandles.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe('Ciclo 2 — Armazenamento SQLite WAL e Migrações', () => {
  it('SQ-01 e SQ-02 ativam WAL/foreign_keys e executam migrações 001/002 de forma idempotente', async () => {
    const { dbPath, ntcDb } = await createTempDb();

    const journalRow = ntcDb.rawDb.pragma('journal_mode', { simple: true }) as string;
    const fkRow = ntcDb.rawDb.pragma('foreign_keys', { simple: true }) as number;
    expect(journalRow.toLowerCase()).toBe('wal');
    expect(fkRow).toBe(1);

    const migrations = ntcDb.rawDb
      .prepare('SELECT version, checksum_sha256 FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: string; checksum_sha256: string }>;
    expect(migrations.map((m) => m.version)).toEqual([
      '001_initial.sql',
      '002_repo_metadata_and_locks.sql',
    ]);

    ntcDb.close();
    const reopened = openDatabase(dbPath);
    openHandles.push(reopened);

    const migrationsAfter = reopened.rawDb
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: string }>;
    expect(migrationsAfter).toHaveLength(2);
  });

  it('SQ-03 e SQ-04 semeiam os 8 DFes preservando edições existentes e NFCe isolado', async () => {
    const { ntcDb } = await createTempDb();
    const defaults = await loadDefaultRegistryEntries(REGISTRY_PATH);
    expect(defaults).toHaveLength(8);

    ntcDb.seedDefaultRepos(defaults);
    const repos = ntcDb.listDfeRepos();
    expect(repos).toHaveLength(8);
    expect(repos.find((r) => r.dfe === 'NFCe')?.repoSlug).toBe('nfce-parser');
    expect(repos.find((r) => r.dfe === 'NFe')?.repoSlug).toBe('nfe-parser');

    const nfeCustom = repos.find((r) => r.dfe === 'NFe');
    if (!nfeCustom) {
      throw new Error('NFe ausente');
    }
    ntcDb.saveDfeRepo({ ...nfeCustom, baseBranch: 'release/2.x', baselineNt: '2026.001@v1.00' });

    ntcDb.seedDefaultRepos(defaults);
    const reloadedNfe = ntcDb.listDfeRepos().find((r) => r.dfe === 'NFe');
    expect(reloadedNfe?.baseBranch).toBe('release/2.x');
    expect(reloadedNfe?.baselineNt).toBe('2026.001@v1.00');

    // Simula banco preexistente com rota legada quebrada '/Gtve/Documentos' e valida reparo automático
    const gtveEntry = repos.find((r) => r.dfe === 'GTVe');
    if (!gtveEntry) {
      throw new Error('GTVe ausente');
    }
    ntcDb.saveDfeRepo({ ...gtveEntry, svrsRelativePath: '/Gtve/Documentos' });
    ntcDb.seedDefaultRepos(defaults);
    expect(ntcDb.getDfeRepo('GTVe')?.svrsRelativePath).toBe('/Cte/Documentos');
  });

  it('SQ-05 e SQ-06 aplicam integridade FK e restrição CHECK de status no SQLite', async () => {
    const { ntcDb } = await createTempDb();

    expect(() =>
      ntcDb.rawDb
        .prepare(
          `INSERT INTO compliance_runs (
            run_id, dfe, nt_id, status, operator_name, provider, model_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('r1', 'NFe', 'nt-inexistente', 'DRAFT', 'willy', 'gemini', 'gemini-2.5-pro', '2026-11-19T12:00:00.000Z', '2026-11-19T12:00:00.000Z'),
    ).toThrow(/FOREIGN KEY/i);

    ntcDb.upsertNtCatalogEntries([makeNtEntry()]);

    expect(() =>
      ntcDb.rawDb
        .prepare(
          `INSERT INTO compliance_runs (
            run_id, dfe, nt_id, status, operator_name, provider, model_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('r2', 'NFe', 'NFe:2026.005:v1.00', 'BROKEN_STATE', 'willy', 'gemini', 'gemini-2.5-pro', '2026-11-19T12:00:00.000Z', '2026-11-19T12:00:00.000Z'),
    ).toThrow(/CHECK/i);
  });

  it('SQ-07 e SQ-08 fazem upsert preservando id/FKs e mantendo múltiplas versões', async () => {
    const { ntcDb } = await createTempDb();
    ntcDb.upsertNtCatalogEntries([makeNtEntry()]);

    const run = ntcDb.createComplianceRun({
      runId: 'run-fk',
      dfe: 'NFe',
      ntId: 'NFe:2026.005:v1.00',
      operatorName: 'willy',
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
    });
    expect(run.status).toBe('DRAFT');

    // Novo upsert na mesma chave lógica com outro id proposto deve manter o id original (FK intacta)
    ntcDb.upsertNtCatalogEntries([
      makeNtEntry({
        id: 'NFe:outro-id',
        homologDate: '2026-11-20',
        sourceStatus: 'DOWNLOADED',
      }),
      makeNtEntry({
        id: 'NFe:2026.005:v1.10',
        ntVersion: 'v1.10',
        publishedDate: '2026-11-05',
      }),
    ]);

    const nts = ntcDb.listNtCatalogByDfe('NFe');
    expect(nts).toHaveLength(2);
    expect(nts.find((n) => n.ntVersion === 'v1.00')?.id).toBe('NFe:2026.005:v1.00');
    expect(nts.find((n) => n.ntVersion === 'v1.00')?.sourceStatus).toBe('DOWNLOADED');

    const latest = ntcDb.getLatestNtsPerDfe();
    expect(latest.find((n) => n.dfe === 'NFe')?.ntVersion).toBe('v1.10');
  });

  it('SQ-09 a SQ-11 validam transições de compliance_runs, falha uniforme e rollback em erro', async () => {
    const { ntcDb } = await createTempDb();
    ntcDb.upsertNtCatalogEntries([makeNtEntry()]);

    ntcDb.createComplianceRun({
      runId: 'run-happy',
      dfe: 'NFe',
      ntId: 'NFe:2026.005:v1.00',
      operatorName: 'willy',
      provider: 'github-copilot',
      modelId: 'gpt-4.1',
    });

    // Transição inválida não altera DB
    expect(() =>
      ntcDb.transitionComplianceRunStatus({ runId: 'run-happy', nextStatus: 'PR_OPENED' }),
    ).toThrow(/Transição/i);
    expect(ntcDb.getComplianceRun('run-happy')?.status).toBe('DRAFT');

    const approved = ntcDb.transitionComplianceRunStatus({
      runId: 'run-happy',
      nextStatus: 'APPROVED',
      baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
      ncJsonPath: 'ncs/NC-2026.005.json',
    });
    expect(approved.status).toBe('APPROVED');

    const tested = ntcDb.transitionComplianceRunStatus({
      runId: 'run-happy',
      nextStatus: 'TESTED',
      branchName: 'nc/nfe-2026-005-v1-00',
    });
    expect(tested.status).toBe('TESTED');

    const opened = ntcDb.transitionComplianceRunStatus({
      runId: 'run-happy',
      nextStatus: 'PR_OPENED',
      prUrl: 'https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfe-parser/pulls/42',
    });
    expect(opened.status).toBe('PR_OPENED');

    ntcDb.createComplianceRun({
      runId: 'run-fail',
      dfe: 'NFe',
      ntId: 'NFe:2026.005:v1.00',
      operatorName: 'willy',
      provider: 'openai-compatible',
      modelId: 'gpt-4o',
    });

    expect(() =>
      ntcDb.transitionComplianceRunStatus({
        runId: 'run-fail',
        nextStatus: 'FAILED',
        errorMessage: 'falha sem step',
      }),
    ).toThrow(/failedStep/i);
    expect(ntcDb.getComplianceRun('run-fail')?.status).toBe('DRAFT');

    const failed = ntcDb.transitionComplianceRunStatus({
      runId: 'run-fail',
      nextStatus: 'FAILED',
      failedStep: 'ORACLE_DIFF',
      errorMessage: 'Falha determinística controlada',
    });
    expect(failed.status).toBe('FAILED');
    expect(failed.failedStep).toBe('ORACLE_DIFF');
    expect(failed.errorMessage).toBe('Falha determinística controlada');
  });

  it('SQ-12 e SQ-13 garantem lock exclusivo por repositório, resiliência a SQL injection e detecção de adulteração', async () => {
    const { dir, ntcDb } = await createTempDb();
    const defaults = await loadDefaultRegistryEntries(REGISTRY_PATH);
    ntcDb.seedDefaultRepos(defaults);

    ntcDb.acquireRepoLock('NFe', 'run-lock-1');
    expect(() => ntcDb.acquireRepoLock('NFe', 'run-lock-2')).toThrow(/travado|bloqueado/i);
    ntcDb.releaseRepoLock('NFe', 'run-lock-1');
    expect(() => ntcDb.acquireRepoLock('NFe', 'run-lock-2')).not.toThrow();

    // SQL Injection payload tratado como dado literal parametrizado
    const sqliNt = makeNtEntry({
      id: "NFe:'; DROP TABLE compliance_runs; --:v1",
      ntNumber: "'; DROP TABLE compliance_runs; --",
    });
    ntcDb.upsertNtCatalogEntries([sqliNt]);
    expect(ntcDb.listNtCatalogByDfe('NFe')).toHaveLength(1);
    expect(ntcDb.rawDb.prepare("SELECT name FROM sqlite_master WHERE name='compliance_runs'").get()).toBeTruthy();

    // Migração ausente e adulteração de checksum detectadas ao reabrir
    const customMigDir = path.join(dir, 'custom-migs');
    await fs.mkdir(customMigDir, { recursive: true });
    await fs.writeFile(path.join(customMigDir, '001_initial.sql'), '-- adulterado\nSELECT 1;', 'utf8');
    expect(() => openDatabase(path.join(dir, 'nested', 'ntc.sqlite'), { migrationsDir: customMigDir })).toThrow(
      /adulteração|ausente/i,
    );
    await fs.writeFile(path.join(customMigDir, '002_repo_metadata_and_locks.sql'), '-- dummy', 'utf8');
    expect(() => openDatabase(path.join(dir, 'nested', 'ntc.sqlite'), { migrationsDir: customMigDir })).toThrow(
      /integridade|checksum/i,
    );
  });

  it('SQ-14 expõe lookups getDfeRepo, getNtCatalogEntry, listComplianceRuns, getRepoLock e updateComplianceRunProgress', async () => {
    const { ntcDb } = await createTempDb();
    const defaults = await loadDefaultRegistryEntries(REGISTRY_PATH);
    ntcDb.seedDefaultRepos(defaults);

    expect(ntcDb.getDfeRepo('NFCe')?.repoSlug).toBe('nfce-parser');
    ntcDb.upsertNtCatalogEntries([makeNtEntry()]);
    expect(ntcDb.getNtCatalogEntry('NFe:2026.005:v1.00')?.ntNumber).toBe('2026.005');
    expect(ntcDb.getNtCatalogEntry('nao-existe')).toBeNull();

    ntcDb.createComplianceRun({
      runId: 'run-prog',
      dfe: 'NFe',
      ntId: 'NFe:2026.005:v1.00',
      operatorName: 'willy',
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
    });

    const updatedDraft = ntcDb.updateComplianceRunProgress({
      runId: 'run-prog',
      baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
      ncJsonPath: 'ncs/NC-NFe-2026.005-v1.00.json',
      tokenUsage: { promptTokens: 50, completionTokens: 20, totalTokens: 70, stage: 'analyze' },
    });
    expect(updatedDraft.status).toBe('DRAFT');
    expect(updatedDraft.ncJsonPath).toBe('ncs/NC-NFe-2026.005-v1.00.json');

    expect(ntcDb.listComplianceRuns({ dfe: 'NFe', status: 'DRAFT' })).toHaveLength(1);
    ntcDb.acquireRepoLock('NFe', 'run-prog');
    expect(ntcDb.getRepoLock('NFe')?.runId).toBe('run-prog');
    expect(ntcDb.releaseRepoLock('NFe', 'run-prog')).toBe(true);
    expect(ntcDb.getRepoLock('NFe')).toBeNull();

    ntcDb.transitionComplianceRunStatus({
      runId: 'run-prog',
      nextStatus: 'FAILED',
      failedStep: 'LLM_CHECK',
      errorMessage: 'falha',
    });
    expect(() =>
      ntcDb.updateComplianceRunProgress({
        runId: 'run-prog',
        ncJsonPath: 'ncs/other.json',
      }),
    ).toThrow(/terminal|FAILED/i);
  });
});
