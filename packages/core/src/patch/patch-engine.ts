import { constants as fsConstants } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import type { DfeRepoEntry, NcDocument, PatchPayload } from '../domain/types.js';
import { normalizeRepoRelativePath } from '../domain/validators.js';
import type { OracleAnalyzerPort } from '../ports/interfaces.js';
import { listAllowedRepoFiles, readAllowedRepoFile } from '../privacy/dlp-filter.js';
import { readNoFollowUtf8, resolveContainedNoSymlinkPath } from '../toolchain/exec-utils.js';
import { assertPatchGuardrails, PatchGuardrailError } from './patch-guardrails.js';

/** Options for applying a guarded patch onto an isolated worktree directory. */
export interface ApplyPatchOptions {
  readonly xsdDir?: string;
  readonly oracle?: Pick<OracleAnalyzerPort, 'validateXml'>;
  readonly maxTouchedFiles?: number;
  readonly maxTotalChangedLines?: number;
}

/** Result returned after atomically applying guarded edits and creates to a worktree. */
export interface AppliedPatchResult {
  readonly modifiedFiles: readonly string[];
  readonly createdFiles: readonly string[];
  readonly totalLinesChanged: number;
}

async function writeNoFollowUtf8(absPath: string, content: string, exclusive = false): Promise<void> {
  const baseFlags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    (exclusive ? fsConstants.O_EXCL : fsConstants.O_TRUNC) |
    (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(absPath, baseFlags, 0o644);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`Alvo não é arquivo regular: '${absPath}'`);
    }
    await handle.writeFile(content, { encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

async function rollbackAppliedChanges(
  worktreeDir: string,
  originals: ReadonlyMap<string, string>,
  createdFiles: readonly string[],
): Promise<void> {
  for (const relPath of createdFiles) {
    const absCreated = await resolveContainedNoSymlinkPath(worktreeDir, relPath).catch(() => null);
    if (absCreated) {
      await rm(absCreated, { force: true }).catch(() => undefined);
    }
  }
  for (const [relPath, content] of originals.entries()) {
    const absEdit = await resolveContainedNoSymlinkPath(worktreeDir, relPath).catch(() => null);
    if (absEdit) {
      await writeNoFollowUtf8(absEdit, content, false).catch(() => undefined);
    }
  }
}

/**
 * Validates guardrails and atomically applies `edits` and `creates` inside `worktreeDir`
 * with `O_NOFOLLOW` containment checks and rollback on any failure.
 */
export async function applyPatchToWorktree(
  worktreeDir: string,
  repo: DfeRepoEntry,
  payload: PatchPayload,
  options: ApplyPatchOptions = {},
): Promise<AppliedPatchResult> {
  const guardrailResult = await assertPatchGuardrails({
    payload,
    repo,
    worktreeDir,
    xsdDir: options.xsdDir,
    oracle: options.oracle,
    maxTouchedFiles: options.maxTouchedFiles,
    maxTotalChangedLines: options.maxTotalChangedLines,
  });

  const originals = new Map<string, string>();
  const modifiedSet = new Set<string>();
  const createdFiles: string[] = [];

  try {
    for (const edit of payload.edits) {
      const relPath = normalizeRepoRelativePath(edit.filePath);
      const absPath = await resolveContainedNoSymlinkPath(worktreeDir, relPath);
      const current = await readNoFollowUtf8(absPath);
      if (!originals.has(relPath)) {
        originals.set(relPath, current);
      }
      const idx = current.indexOf(edit.searchBlock);
      if (idx < 0) {
        throw new PatchGuardrailError([`searchBlock ausente ao aplicar patch em '${relPath}'`]);
      }
      const nextContent = `${current.slice(0, idx)}${edit.replaceBlock}${current.slice(idx + edit.searchBlock.length)}`;
      await writeNoFollowUtf8(absPath, nextContent, false);
      modifiedSet.add(relPath);
    }

    for (const create of payload.creates) {
      const relPath = normalizeRepoRelativePath(create.filePath);
      const absPath = await resolveContainedNoSymlinkPath(worktreeDir, relPath);
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeNoFollowUtf8(absPath, create.content, true);
      createdFiles.push(relPath);
    }

    return {
      modifiedFiles: [...modifiedSet],
      createdFiles,
      totalLinesChanged: guardrailResult.totalLinesChanged,
    };
  } catch (error) {
    await rollbackAppliedChanges(worktreeDir, originals, createdFiles);
    throw error;
  }
}

/**
 * Collects DLP-allowlisted Java source and test files matching an `NcDocument` or XSD-AST hints
 * concurrently via `Promise.all` without exposing `test-files/**` or secrets.
 */
export async function extractAllowedJavaContextForNc(
  repoDir: string,
  repo: DfeRepoEntry,
  nc?: NcDocument,
  maxFiles = 25,
  extraTargetClasses: readonly string[] = [],
): Promise<ReadonlyArray<{ readonly filePath: string; readonly content: string }>> {
  const allowedPaths = await listAllowedRepoFiles(repoDir);
  const targetClasses = new Set<string>();

  for (const item of nc?.items ?? []) {
    const cls = item.targetClass?.trim().toLowerCase();
    if (cls) {
      targetClasses.add(cls);
    }
  }
  for (const extra of extraTargetClasses) {
    const trimmed = extra.trim().toLowerCase();
    if (trimmed) {
      targetClasses.add(trimmed);
    }
  }

  const packagePrefixes = [
    `src/main/java/${repo.domainPackage.replace(/\./g, '/')}/`,
    `src/main/java/${repo.mapperPackage.replace(/\./g, '/')}/`,
    `src/main/java/${repo.tablePackage.replace(/\./g, '/')}/`,
  ];
  const parserPrefix = `src/main/java/${repo.parserPackage.replace(/\./g, '/')}/`;

  const prioritized = allowedPaths
    .filter((relPath) => relPath.endsWith('.java'))
    .sort((a, b) => {
      const aBase = path.basename(a, '.java').toLowerCase();
      const bBase = path.basename(b, '.java').toLowerCase();
      const aHit = targetClasses.has(aBase) || (a.startsWith(parserPrefix) && /^default.*tableparser$/.test(aBase)) ? 0 : 1;
      const bHit = targetClasses.has(bBase) || (b.startsWith(parserPrefix) && /^default.*tableparser$/.test(bBase)) ? 0 : 1;
      if (aHit !== bHit) {
        return aHit - bHit;
      }
      const aInPkg = packagePrefixes.some((p) => a.startsWith(p)) ? 0 : 1;
      const bInPkg = packagePrefixes.some((p) => b.startsWith(p)) ? 0 : 1;
      return aInPkg - bInPkg || a.localeCompare(b);
    })
    .slice(0, maxFiles);

  return Promise.all(
    prioritized.map(async (relPath) => ({
      filePath: relPath,
      content: await readAllowedRepoFile(repoDir, relPath),
    })),
  );
}
