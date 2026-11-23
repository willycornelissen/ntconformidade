CREATE TABLE IF NOT EXISTS nt_catalog (
  id TEXT PRIMARY KEY,
  dfe TEXT NOT NULL,
  nt_number TEXT NOT NULL,
  nt_version TEXT NOT NULL,
  published_date TEXT NOT NULL,
  homolog_date TEXT,
  prod_date TEXT,
  pdf_url TEXT,
  xsd_url TEXT,
  pdf_sha256 TEXT,
  source_status TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE(dfe, nt_number, nt_version)
);

CREATE INDEX IF NOT EXISTS idx_nt_catalog_dfe_date
  ON nt_catalog(dfe, published_date DESC);

CREATE TABLE IF NOT EXISTS dfe_repos (
  dfe TEXT PRIMARY KEY,
  repo_slug TEXT NOT NULL,
  gitea_url TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_package TEXT NOT NULL,
  domain_package TEXT NOT NULL,
  mapper_package TEXT NOT NULL,
  table_package TEXT NOT NULL,
  util_package TEXT,
  tag_prefix TEXT NOT NULL,
  baseline_nt TEXT
);

CREATE TABLE IF NOT EXISTS compliance_runs (
  run_id TEXT PRIMARY KEY,
  dfe TEXT NOT NULL,
  nt_id TEXT NOT NULL REFERENCES nt_catalog(id),
  status TEXT NOT NULL CHECK(status IN ('DRAFT','APPROVED','TESTED','PR_OPENED','FAILED')),
  failed_step TEXT,
  error_message TEXT,
  operator_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  base_commit_sha TEXT,
  branch_name TEXT,
  nc_json_path TEXT,
  pr_url TEXT,
  token_usage_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_compliance_runs_dfe_status
  ON compliance_runs(dfe, status);
