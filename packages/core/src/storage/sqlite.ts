import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import {
  assertValidRunTransition,
  ComplianceRunSchema,
  DfeRegistrySchema,
  DfeRepoEntrySchema,
  NtCatalogEntrySchema,
  TokenUsageSchema,
  type ComplianceRun,
  type DfeCode,
  type DfeRepoEntry,
  type FailedStep,
  type NtCatalogEntry,
  type RunStatus,
  type TokenUsage,
} from '../domain/types.js';

export interface OpenDatabaseOptions {
  readonly migrationsDir?: string;
}

export interface CreateRunInput {
  readonly runId: string;
  readonly dfe: DfeCode;
  readonly ntId: string;
  readonly operatorName: string;
  readonly provider: ComplianceRun['provider'];
  readonly modelId: string;
  readonly baseCommitSha?: string | null;
  readonly branchName?: string | null;
  readonly ncJsonPath?: string | null;
}

export interface TransitionRunInput {
  readonly runId: string;
  readonly nextStatus: RunStatus;
  readonly failedStep?: FailedStep | null;
  readonly errorMessage?: string | null;
  readonly baseCommitSha?: string | null;
  readonly branchName?: string | null;
  readonly ncJsonPath?: string | null;
  readonly prUrl?: string | null;
  readonly tokenUsage?: TokenUsage | null;
}

export interface UpdateRunProgressInput {
  readonly runId: string;
  readonly baseCommitSha?: string | null;
  readonly branchName?: string | null;
  readonly ncJsonPath?: string | null;
  readonly prUrl?: string | null;
  readonly tokenUsage?: TokenUsage | null;
}

export interface ListRunsFilter {
  readonly dfe?: DfeCode;
  readonly status?: RunStatus;
  readonly ntId?: string;
}

export interface NtcDatabase {
  readonly rawDb: Database.Database;
  close(): void;
  [Symbol.dispose](): void;
  seedDefaultRepos(entries: readonly DfeRepoEntry[]): void;
  listDfeRepos(): DfeRepoEntry[];
  getDfeRepo(dfe: DfeCode): DfeRepoEntry | null;
  saveDfeRepo(entry: DfeRepoEntry): void;
  upsertNtCatalogEntries(entries: readonly NtCatalogEntry[]): void;
  listNtCatalogByDfe(dfe?: DfeCode): NtCatalogEntry[];
  getNtCatalogEntry(ntId: string): NtCatalogEntry | null;
  getLatestNtsPerDfe(): NtCatalogEntry[];
  createComplianceRun(input: CreateRunInput): ComplianceRun;
  getComplianceRun(runId: string): ComplianceRun | null;
  listComplianceRuns(filter?: ListRunsFilter): ComplianceRun[];
  updateComplianceRunProgress(input: UpdateRunProgressInput): ComplianceRun;
  transitionComplianceRunStatus(input: TransitionRunInput): ComplianceRun;
  acquireRepoLock(dfe: DfeCode, runId: string): void;
  getRepoLock(dfe: DfeCode): { runId: string; lockedAt: string } | null;
  releaseRepoLock(dfe: DfeCode, runId: string): boolean;
}

const MigrationRowSchema = z.object({ version: z.string(), checksum_sha256: z.string() });
const LockRowSchema = z.object({ run_id: z.string(), locked_at: z.string() });

interface NtCatalogRow {
  id: string;
  dfe: string;
  nt_number: string;
  nt_version: string;
  published_date: string;
  homolog_date: string | null;
  prod_date: string | null;
  pdf_url: string | null;
  xsd_url: string | null;
  pdf_sha256: string | null;
  source_status: string;
  fetched_at: string;
}

interface DfeRepoRow {
  dfe: string;
  repo_slug: string;
  gitea_url: string;
  base_branch: string;
  base_package: string;
  domain_package: string;
  mapper_package: string;
  table_package: string;
  parser_package: string;
  util_package: string | null;
  tag_prefix: string;
  svrs_relative_path: string;
  baseline_nt: string | null;
}

interface ComplianceRunRow {
  run_id: string;
  dfe: string;
  nt_id: string;
  status: string;
  failed_step: string | null;
  error_message: string | null;
  operator_name: string;
  provider: string;
  model_id: string;
  base_commit_sha: string | null;
  branch_name: string | null;
  nc_json_path: string | null;
  pr_url: string | null;
  token_usage_json: string | null;
  created_at: string;
  updated_at: string;
}

const DEFAULT_MIGRATIONS_DIR = path.resolve(import.meta.dirname, 'migrations');

const UPSERT_REPO_BASE_SQL = `
  INSERT INTO dfe_repos (
    dfe, repo_slug, gitea_url, base_branch, base_package, domain_package,
    mapper_package, table_package, parser_package, util_package, tag_prefix,
    svrs_relative_path, baseline_nt
  ) VALUES (
    @dfe, @repoSlug, @giteaUrl, @baseBranch, @basePackage, @domainPackage,
    @mapperPackage, @tablePackage, @parserPackage, @utilPackage, @tagPrefix,
    @svrsRelativePath, @baselineNt
  )
`;

export async function loadDefaultRegistryEntries(registryFilePath: string): Promise<DfeRepoEntry[]> {
  const raw = await fsp.readFile(registryFilePath, 'utf8');
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `JSON inválido no arquivo de registro (${registryFilePath}): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return DfeRegistrySchema.parse(parsedJson);
}

export function openDatabase(dbPath: string, options?: OpenDatabaseOptions): NtcDatabase {
  if (!dbPath || dbPath.includes('\0')) {
    throw new Error('Caminho do banco SQLite inválido');
  }
  if (dbPath !== ':memory:') {
    const resolved = path.resolve(dbPath);
    if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
      throw new Error(`Symlink não permitido para banco SQLite: ${dbPath}`);
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  }

  const rawDb = new Database(dbPath);
  try {
    rawDb.pragma('journal_mode = WAL');
    rawDb.pragma('busy_timeout = 5000');
    rawDb.pragma('foreign_keys = ON');
    rawDb.pragma('trusted_schema = OFF');
    rawDb.pragma('synchronous = NORMAL');
    applyMigrations(rawDb, options?.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
    return createDatabaseApi(rawDb);
  } catch (err) {
    rawDb.close();
    throw err;
  }
}

function applyMigrations(db: Database.Database, migrationsDir: string): void {
  if (!fs.existsSync(migrationsDir) || fs.lstatSync(migrationsDir).isSymbolicLink()) {
    throw new Error(`Diretório de migrações inválido ou ausente: ${migrationsDir}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum_sha256 TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const appliedRows = db
    .prepare('SELECT version, checksum_sha256 FROM schema_migrations ORDER BY version')
    .all()
    .map((r) => MigrationRowSchema.parse(r));
  const diskSet = new Set(files);
  for (const row of appliedRows) {
    if (!diskSet.has(row.version)) {
      throw new Error(`Migração aplicada ausente no disco (adulteração): ${row.version}`);
    }
  }

  const appliedMap = new Map(appliedRows.map((r) => [r.version, r.checksum_sha256]));
  const recordStmt = db.prepare(
    'INSERT INTO schema_migrations (version, checksum_sha256, applied_at) VALUES (?, ?, ?)',
  );

  for (const file of files) {
    const absFile = path.join(migrationsDir, file);
    if (fs.lstatSync(absFile).isSymbolicLink()) {
      throw new Error(`Symlink bloqueado em migração SQL: ${file}`);
    }
    const sql = fs.readFileSync(absFile, 'utf8');
    const checksum = crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
    const existing = appliedMap.get(file);
    if (existing !== undefined) {
      if (existing !== checksum) {
        throw new Error(`Falha de integridade/checksum na migração já aplicada: ${file}`);
      }
      continue;
    }
    db.transaction(() => {
      db.exec(sql);
      recordStmt.run(file, checksum, new Date().toISOString());
    }).immediate();
  }
}

function createDatabaseApi(rawDb: Database.Database): NtcDatabase {
  const seedStmt = rawDb.prepare(`${UPSERT_REPO_BASE_SQL} ON CONFLICT(dfe) DO NOTHING`);
  const saveStmt = rawDb.prepare(`
    ${UPSERT_REPO_BASE_SQL}
    ON CONFLICT(dfe) DO UPDATE SET
      repo_slug = excluded.repo_slug, gitea_url = excluded.gitea_url,
      base_branch = excluded.base_branch, base_package = excluded.base_package,
      domain_package = excluded.domain_package, mapper_package = excluded.mapper_package,
      table_package = excluded.table_package, parser_package = excluded.parser_package,
      util_package = excluded.util_package, tag_prefix = excluded.tag_prefix,
      svrs_relative_path = excluded.svrs_relative_path, baseline_nt = excluded.baseline_nt
  `);

  const repairGtvePathStmt = rawDb.prepare(
    "UPDATE dfe_repos SET svrs_relative_path = ? WHERE dfe = 'GTVe' AND svrs_relative_path = '/Gtve/Documentos'",
  );
  const repairNfeEventSchemaStmt = rawDb.prepare(
    `UPDATE nt_catalog
     SET xsd_url = 'https://dfe-portal.svrs.rs.gov.br/NFE/DownloadArquivoEstatico/?sistema=NFE&tipoArquivo=2&nomeArquivo=PL_010b_NT2025_002_v1.30.zip'
     WHERE dfe = 'NFe' AND nt_number = '2025.002' AND xsd_url LIKE '%Schema_Evento_211110_NT2025.002%'`,
  );

  return {
    rawDb,
    close: () => rawDb.close(),
    [Symbol.dispose]: () => rawDb.close(),
    seedDefaultRepos: (entries) => {
      runRepoBatch(rawDb, seedStmt, entries);
      const gtveDefault = entries.find((e) => e.dfe === 'GTVe');
      if (gtveDefault && gtveDefault.svrsRelativePath !== '/Gtve/Documentos') {
        repairGtvePathStmt.run(gtveDefault.svrsRelativePath);
      }
      repairNfeEventSchemaStmt.run();
    },
    saveDfeRepo: (entry) => {
      saveStmt.run(DfeRepoEntrySchema.parse(entry));
    },
    listDfeRepos: () =>
      (rawDb.prepare('SELECT * FROM dfe_repos ORDER BY dfe ASC').all() as DfeRepoRow[]).map(mapRepoRow),
    getDfeRepo: (dfe) => {
      const row = rawDb.prepare('SELECT * FROM dfe_repos WHERE dfe = ?').get(dfe) as DfeRepoRow | undefined;
      return row ? mapRepoRow(row) : null;
    },
    upsertNtCatalogEntries: (entries) => runNtUpserts(rawDb, entries),
    listNtCatalogByDfe: (dfe) => queryNts(rawDb, dfe),
    getNtCatalogEntry: (ntId) => {
      const row = rawDb.prepare('SELECT * FROM nt_catalog WHERE id = ?').get(ntId) as NtCatalogRow | undefined;
      return row ? mapNtRow(row) : null;
    },
    getLatestNtsPerDfe: () => queryLatestNtsPerDfe(rawDb),
    createComplianceRun: (input) => insertComplianceRun(rawDb, input),
    getComplianceRun: (runId) => fetchComplianceRun(rawDb, runId),
    listComplianceRuns: (filter) => queryComplianceRuns(rawDb, filter),
    updateComplianceRunProgress: (input) => updateRunProgress(rawDb, input),
    transitionComplianceRunStatus: (input) => updateComplianceRunStatus(rawDb, input),
    acquireRepoLock: (dfe, runId) => lockRepo(rawDb, dfe, runId),
    getRepoLock: (dfe) => fetchRepoLock(rawDb, dfe),
    releaseRepoLock: (dfe, runId) => unlockRepo(rawDb, dfe, runId),
  };
}

function runRepoBatch(
  db: Database.Database,
  stmt: Database.Statement,
  entries: readonly DfeRepoEntry[],
): void {
  const validated = entries.map((e) => DfeRepoEntrySchema.parse(e));
  db.transaction(() => {
    for (const entry of validated) {
      stmt.run(entry);
    }
  }).immediate();
}

function runNtUpserts(db: Database.Database, entries: readonly NtCatalogEntry[]): void {
  const stmt = db.prepare(`
    INSERT INTO nt_catalog (
      id, dfe, nt_number, nt_version, published_date, homolog_date, prod_date,
      pdf_url, xsd_url, pdf_sha256, source_status, fetched_at
    ) VALUES (
      @id, @dfe, @ntNumber, @ntVersion, @publishedDate, @homologDate, @prodDate,
      @pdfUrl, @xsdUrl, @pdfSha256, @sourceStatus, @fetchedAt
    ) ON CONFLICT(dfe, nt_number, nt_version) DO UPDATE SET
      published_date = excluded.published_date,
      homolog_date = COALESCE(excluded.homolog_date, nt_catalog.homolog_date),
      prod_date = COALESCE(excluded.prod_date, nt_catalog.prod_date),
      pdf_url = COALESCE(excluded.pdf_url, nt_catalog.pdf_url),
      xsd_url = COALESCE(excluded.xsd_url, nt_catalog.xsd_url),
      pdf_sha256 = COALESCE(excluded.pdf_sha256, nt_catalog.pdf_sha256),
      source_status = excluded.source_status,
      fetched_at = excluded.fetched_at
  `);
  const validated = entries.map((e) => NtCatalogEntrySchema.parse(e));
  db.transaction(() => {
    for (const entry of validated) {
      stmt.run(entry);
    }
  }).immediate();
}

function queryNts(db: Database.Database, dfe?: DfeCode): NtCatalogEntry[] {
  const rows = dfe
    ? (db
        .prepare('SELECT * FROM nt_catalog WHERE dfe = ? ORDER BY published_date DESC, nt_number DESC')
        .all(dfe) as NtCatalogRow[])
    : (db
        .prepare('SELECT * FROM nt_catalog ORDER BY dfe ASC, published_date DESC, nt_number DESC')
        .all() as NtCatalogRow[]);
  return rows.map(mapNtRow).sort((a, b) => compareNtEntryOrder(a, b, dfe === undefined));
}

function compareNtEntryOrder(a: NtCatalogEntry, b: NtCatalogEntry, byDfeFirst: boolean): number {
  if (byDfeFirst) {
    const dfeCmp = a.dfe.localeCompare(b.dfe);
    if (dfeCmp !== 0) {
      return dfeCmp;
    }
  }
  const dateCmp = b.publishedDate.localeCompare(a.publishedDate);
  if (dateCmp !== 0) {
    return dateCmp;
  }
  const numCmp = b.ntNumber.localeCompare(a.ntNumber, undefined, { numeric: true });
  return numCmp !== 0 ? numCmp : b.ntVersion.localeCompare(a.ntVersion, undefined, { numeric: true });
}

function queryLatestNtsPerDfe(db: Database.Database): NtCatalogEntry[] {
  const all = queryNts(db);
  const latestByDfe = new Map<DfeCode, NtCatalogEntry>();
  for (const item of all) {
    if (!latestByDfe.has(item.dfe)) {
      latestByDfe.set(item.dfe, item);
    }
  }
  return [...latestByDfe.values()];
}

function insertComplianceRun(db: Database.Database, input: CreateRunInput): ComplianceRun {
  const now = new Date().toISOString();
  const run = ComplianceRunSchema.parse({
    runId: input.runId,
    dfe: input.dfe,
    ntId: input.ntId,
    status: 'DRAFT',
    failedStep: null,
    errorMessage: null,
    operatorName: input.operatorName,
    provider: input.provider,
    modelId: input.modelId,
    baseCommitSha: input.baseCommitSha ?? null,
    branchName: input.branchName ?? null,
    ncJsonPath: input.ncJsonPath ?? null,
    prUrl: null,
    tokenUsage: null,
    createdAt: now,
    updatedAt: now,
  });

  db.prepare(`
    INSERT INTO compliance_runs (
      run_id, dfe, nt_id, status, failed_step, error_message, operator_name,
      provider, model_id, base_commit_sha, branch_name, nc_json_path, pr_url,
      token_usage_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.runId,
    run.dfe,
    run.ntId,
    run.status,
    run.failedStep,
    run.errorMessage,
    run.operatorName,
    run.provider,
    run.modelId,
    run.baseCommitSha,
    run.branchName,
    run.ncJsonPath,
    run.prUrl,
    null,
    run.createdAt,
    run.updatedAt,
  );
  return run;
}

function fetchComplianceRun(db: Database.Database, runId: string): ComplianceRun | null {
  const row = db.prepare('SELECT * FROM compliance_runs WHERE run_id = ?').get(runId) as
    | ComplianceRunRow
    | undefined;
  return row ? mapRunRow(row) : null;
}

function queryComplianceRuns(db: Database.Database, filter?: ListRunsFilter): ComplianceRun[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter?.dfe) {
    clauses.push('dfe = ?');
    params.push(filter.dfe);
  }
  if (filter?.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter?.ntId) {
    clauses.push('nt_id = ?');
    params.push(filter.ntId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM compliance_runs ${where} ORDER BY created_at DESC, run_id DESC`)
    .all(...params) as ComplianceRunRow[];
  return rows.map(mapRunRow);
}

function persistRunUpdate(
  db: Database.Database,
  expectedCurrentStatus: RunStatus,
  updated: ComplianceRun,
): ComplianceRun {
  const tokenJson = updated.tokenUsage ? JSON.stringify(updated.tokenUsage) : null;
  const res = db
    .prepare(`
      UPDATE compliance_runs SET
        status = ?, failed_step = ?, error_message = ?, base_commit_sha = ?,
        branch_name = ?, nc_json_path = ?, pr_url = ?, token_usage_json = ?, updated_at = ?
      WHERE run_id = ? AND status = ?
    `)
    .run(
      updated.status,
      updated.failedStep,
      updated.errorMessage,
      updated.baseCommitSha,
      updated.branchName,
      updated.ncJsonPath,
      updated.prUrl,
      tokenJson,
      updated.updatedAt,
      updated.runId,
      expectedCurrentStatus,
    );
  if (res.changes !== 1) {
    throw new Error(`Conflito de estado concorrente para execução ${updated.runId}`);
  }
  return updated;
}

function updateRunProgress(db: Database.Database, input: UpdateRunProgressInput): ComplianceRun {
  const tx = db.transaction(() => {
    const current = fetchComplianceRun(db, input.runId);
    if (!current) {
      throw new Error(`Execução não encontrada: ${input.runId}`);
    }
    if (current.status === 'FAILED' || current.status === 'PR_OPENED') {
      throw new Error(`Não é permitido atualizar progresso de execução terminal (${current.status}): ${input.runId}`);
    }
    const updated = ComplianceRunSchema.parse({
      ...current,
      baseCommitSha: input.baseCommitSha !== undefined ? input.baseCommitSha : current.baseCommitSha,
      branchName: input.branchName !== undefined ? input.branchName : current.branchName,
      ncJsonPath: input.ncJsonPath !== undefined ? input.ncJsonPath : current.ncJsonPath,
      prUrl: input.prUrl !== undefined ? input.prUrl : current.prUrl,
      tokenUsage: input.tokenUsage !== undefined ? input.tokenUsage : current.tokenUsage,
      updatedAt: new Date().toISOString(),
    });
    return persistRunUpdate(db, current.status, updated);
  });
  return tx.immediate();
}

function updateComplianceRunStatus(db: Database.Database, input: TransitionRunInput): ComplianceRun {
  const tx = db.transaction(() => {
    const current = fetchComplianceRun(db, input.runId);
    if (!current) {
      throw new Error(`Execução não encontrada: ${input.runId}`);
    }
    assertValidRunTransition(current.status, input.nextStatus);
    const updated = ComplianceRunSchema.parse({
      ...current,
      status: input.nextStatus,
      failedStep: input.nextStatus === 'FAILED' ? (input.failedStep ?? null) : current.failedStep,
      errorMessage: input.nextStatus === 'FAILED' ? (input.errorMessage ?? null) : current.errorMessage,
      baseCommitSha: input.baseCommitSha !== undefined ? input.baseCommitSha : current.baseCommitSha,
      branchName: input.branchName !== undefined ? input.branchName : current.branchName,
      ncJsonPath: input.ncJsonPath !== undefined ? input.ncJsonPath : current.ncJsonPath,
      prUrl: input.prUrl !== undefined ? input.prUrl : current.prUrl,
      tokenUsage: input.tokenUsage !== undefined ? input.tokenUsage : current.tokenUsage,
      updatedAt: new Date().toISOString(),
    });
    return persistRunUpdate(db, current.status, updated);
  });
  return tx.immediate();
}

function lockRepo(db: Database.Database, dfe: DfeCode, runId: string): void {
  if (!runId || !runId.trim()) {
    throw new Error('runId obrigatório para adquirir lock do repositório');
  }
  db.transaction(() => {
    const res = db
      .prepare('INSERT INTO repo_locks (dfe, run_id, locked_at) VALUES (?, ?, ?) ON CONFLICT(dfe) DO NOTHING')
      .run(dfe, runId, new Date().toISOString());
    if (res.changes !== 1) {
      const ownerRow = db.prepare('SELECT run_id, locked_at FROM repo_locks WHERE dfe = ?').get(dfe);
      const owner = ownerRow ? LockRowSchema.parse(ownerRow).run_id : 'desconhecida';
      throw new Error(`Repositório ${dfe} está travado pela execução ${owner}`);
    }
  }).immediate();
}

function fetchRepoLock(db: Database.Database, dfe: DfeCode): { runId: string; lockedAt: string } | null {
  const row = db.prepare('SELECT run_id, locked_at FROM repo_locks WHERE dfe = ?').get(dfe);
  if (!row) {
    return null;
  }
  const parsed = LockRowSchema.parse(row);
  return { runId: parsed.run_id, lockedAt: parsed.locked_at };
}

function unlockRepo(db: Database.Database, dfe: DfeCode, runId: string): boolean {
  const res = db.prepare('DELETE FROM repo_locks WHERE dfe = ? AND run_id = ?').run(dfe, runId);
  return res.changes === 1;
}

function mapRepoRow(row: DfeRepoRow): DfeRepoEntry {
  return DfeRepoEntrySchema.parse({
    dfe: row.dfe,
    repoSlug: row.repo_slug,
    giteaUrl: row.gitea_url,
    baseBranch: row.base_branch,
    basePackage: row.base_package,
    domainPackage: row.domain_package,
    mapperPackage: row.mapper_package,
    tablePackage: row.table_package,
    parserPackage: row.parser_package,
    utilPackage: row.util_package,
    tagPrefix: row.tag_prefix,
    svrsRelativePath: row.svrs_relative_path,
    baselineNt: row.baseline_nt,
  });
}

function mapNtRow(row: NtCatalogRow): NtCatalogEntry {
  return NtCatalogEntrySchema.parse({
    id: row.id,
    dfe: row.dfe,
    ntNumber: row.nt_number,
    ntVersion: row.nt_version,
    publishedDate: row.published_date,
    homologDate: row.homolog_date,
    prodDate: row.prod_date,
    pdfUrl: row.pdf_url,
    xsdUrl: row.xsd_url,
    pdfSha256: row.pdf_sha256,
    sourceStatus: row.source_status,
    fetchedAt: row.fetched_at,
  });
}

function mapRunRow(row: ComplianceRunRow): ComplianceRun {
  let parsedUsage: TokenUsage | null = null;
  if (row.token_usage_json) {
    try {
      parsedUsage = TokenUsageSchema.parse(JSON.parse(row.token_usage_json));
    } catch (err) {
      throw new Error(
        `token_usage_json inválido na execução ${row.run_id}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
  return ComplianceRunSchema.parse({
    runId: row.run_id,
    dfe: row.dfe,
    ntId: row.nt_id,
    status: row.status,
    failedStep: row.failed_step,
    errorMessage: row.error_message,
    operatorName: row.operator_name,
    provider: row.provider,
    modelId: row.model_id,
    baseCommitSha: row.base_commit_sha,
    branchName: row.branch_name,
    ncJsonPath: row.nc_json_path,
    prUrl: row.pr_url,
    tokenUsage: parsedUsage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
