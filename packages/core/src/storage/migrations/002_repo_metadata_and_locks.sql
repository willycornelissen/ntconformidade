ALTER TABLE dfe_repos ADD COLUMN parser_package TEXT NOT NULL DEFAULT '';
ALTER TABLE dfe_repos ADD COLUMN svrs_relative_path TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS repo_locks (
  dfe TEXT PRIMARY KEY REFERENCES dfe_repos(dfe),
  run_id TEXT NOT NULL,
  locked_at TEXT NOT NULL
);
