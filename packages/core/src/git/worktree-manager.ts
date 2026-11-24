import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GITEA_PAT_SECRET_KEY, type DfeRepoEntry } from '../domain/types.js';
import { isSafeHttpsUrl } from '../domain/validators.js';
import { scrubSecret } from '../llm/http-client.js';
import type { ExecFileAsyncFn } from '../oracle/xsd-ast-diff.js';
import type { SecretStorePort } from '../ports/interfaces.js';
import {
  defaultExecFileAsync,
  extractExecFailureDetails,
  pathExistsAsync,
} from '../toolchain/exec-utils.js';
import { buildSanitizedToolchainEnv } from '../toolchain/host-maven-runner.js';

const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const SAFE_BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]+$/;
const SAFE_SHA_RE = /^[a-f0-9]{40}$/i;

/** Options for instantiating `WorktreeManager`. */
export interface WorktreeManagerOptions {
  readonly gitBin?: string;
  readonly execFileFn?: ExecFileAsyncFn;
  readonly secretStore?: SecretStorePort;
  readonly allowLocalFileRemotes?: boolean;
  readonly gitAuthorName?: string;
  readonly gitAuthorEmail?: string;
  readonly tempDirRoot?: string;
  readonly timeoutMs?: number;
}

function assertValidBranchName(branchName: string): string {
  const trimmed = branchName.trim();
  if (!SAFE_BRANCH_RE.test(trimmed) || trimmed.includes('..') || trimmed.startsWith('/')) {
    throw new Error(`Nome de branch inválido ou inseguro: '${branchName}'`);
  }
  return trimmed;
}

function assertValidCommitSha(commitSha: string): string {
  const trimmed = commitSha.trim();
  if (!SAFE_SHA_RE.test(trimmed)) {
    throw new Error(`Commit SHA inválido (esperado 40 hex chars): '${commitSha}'`);
  }
  return trimmed;
}

function assertAllowedGitRemote(rawUrl: string, allowLocalFileRemotes: boolean): string {
  if (allowLocalFileRemotes && rawUrl.startsWith('file://')) {
    return rawUrl;
  }
  if (!isSafeHttpsUrl(rawUrl, false)) {
    throw new Error(`URL remota Git insegura (HTTPS sem credenciais obrigatório): '${rawUrl}'`);
  }
  return rawUrl;
}

async function createEphemeralAskpass(
  tempDirRoot: string,
  pat: string,
): Promise<{ readonly dir: string; readonly scriptPath: string; readonly token: string }> {
  const dir = await mkdtemp(path.join(tempDirRoot, 'ntc-askpass-'));
  const isWin = process.platform === 'win32';
  const scriptPath = path.join(dir, isWin ? 'askpass.cmd' : 'askpass.sh');
  const scriptBody = isWin
    ? `@echo off\r\n"${process.execPath}" -e "var a=process.argv[1]||'';process.stdout.write(/^username/i.test(a)?(process.env.NTC_GIT_ASKPASS_TOKEN||'')+'\\n':'x-oauth-basic\\n')" "%~1"\r\n`
    : '#!/bin/sh\ncase "$1" in [Uu]sername*) printf "%s\\n" "$NTC_GIT_ASKPASS_TOKEN" ;; *) printf "%s\\n" "x-oauth-basic" ;; esac\n';

  try {
    await writeFile(scriptPath, scriptBody, { encoding: 'utf8', mode: 0o700 });
    return { dir, scriptPath, token: pat };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Manages bare Git mirrors, detached inspection worktrees, active repair worktrees,
 * untracked-aware diffs, and ephemeral `GIT_ASKPASS` remote operations with `shell: false`.
 */
export class WorktreeManager {
  private readonly gitBin: string;
  private readonly execFileFn: ExecFileAsyncFn;
  private readonly secretStore?: SecretStorePort;
  private readonly allowLocalFileRemotes: boolean;
  private readonly gitAuthorName: string;
  private readonly gitAuthorEmail: string;
  private readonly tempDirRoot: string;
  private readonly timeoutMs: number;

  constructor(options: WorktreeManagerOptions = {}) {
    this.gitBin = options.gitBin ?? 'git';
    this.execFileFn = options.execFileFn ?? defaultExecFileAsync;
    this.secretStore = options.secretStore;
    this.allowLocalFileRemotes = options.allowLocalFileRemotes ?? false;
    this.gitAuthorName = options.gitAuthorName ?? 'NT Conformidade Bot';
    this.gitAuthorEmail = options.gitAuthorEmail ?? 'nt-conformidade@fazenda.mg.gov.br';
    this.tempDirRoot = options.tempDirRoot ?? os.tmpdir();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  }

  async ensureBareMirror(repo: DfeRepoEntry, mirrorsRootDir: string): Promise<string> {
    const remoteUrl = assertAllowedGitRemote(repo.giteaUrl, this.allowLocalFileRemotes);
    const safeSlug = repo.repoSlug.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const bareDir = path.join(path.resolve(mirrorsRootDir), `${safeSlug}.git`);
    await mkdir(path.dirname(bareDir), { recursive: true });

    if (await pathExistsAsync(path.join(bareDir, 'HEAD'))) {
      await this.runGit(['-C', bareDir, 'remote', 'set-url', 'origin', remoteUrl]);
      await this.runGitRemote([
        '-C',
        bareDir,
        'fetch',
        '--prune',
        'origin',
        '+refs/heads/*:refs/heads/*',
      ]);
    } else {
      await this.runGitRemote(['clone', '--bare', '--', remoteUrl, bareDir]);
    }
    return bareDir;
  }

  async getRemoteBranchHead(repo: DfeRepoEntry, branch: string): Promise<string> {
    const remoteUrl = assertAllowedGitRemote(repo.giteaUrl, this.allowLocalFileRemotes);
    const safeBranch = assertValidBranchName(branch);
    const { stdout } = await this.runGitRemote([
      'ls-remote',
      '--heads',
      '--',
      remoteUrl,
      `refs/heads/${safeBranch}`,
    ]);
    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error(`Branch remoto '${safeBranch}' não encontrado em '${repo.repoSlug}'`);
    }
    const sha = trimmed.split(/\s+/)[0] ?? '';
    return assertValidCommitSha(sha);
  }

  async createInspectionWorktree(
    bareRepoDir: string,
    commitSha: string,
    worktreeDir: string,
  ): Promise<void> {
    const safeSha = assertValidCommitSha(commitSha);
    await this.removeWorktree(bareRepoDir, worktreeDir);
    await mkdir(path.dirname(worktreeDir), { recursive: true });
    await this.runGit(['-C', bareRepoDir, 'worktree', 'add', '--detach', '--', worktreeDir, safeSha]);
  }

  async createWorktree(
    bareRepoDir: string,
    branchName: string,
    baseCommitSha: string,
    worktreeDir: string,
  ): Promise<void> {
    const safeBranch = assertValidBranchName(branchName);
    const safeSha = assertValidCommitSha(baseCommitSha);
    await this.removeWorktree(bareRepoDir, worktreeDir);
    await mkdir(path.dirname(worktreeDir), { recursive: true });
    await this.runGit([
      '-C',
      bareRepoDir,
      'worktree',
      'add',
      '-B',
      safeBranch,
      '--',
      worktreeDir,
      safeSha,
    ]);
  }

  async removeWorktree(bareRepoDir: string, worktreeDir: string): Promise<void> {
    if (await pathExistsAsync(worktreeDir)) {
      await this.runGit(['-C', bareRepoDir, 'worktree', 'remove', '--force', '--', worktreeDir]).catch(
        // Fall back to direct recursive cleanup if Git lost worktree metadata
        () => rm(worktreeDir, { recursive: true, force: true }),
      );
    }
    // Prune stale admin entries asynchronously after removal
    await this.runGit(['-C', bareRepoDir, 'worktree', 'prune']).catch(() => undefined);
  }

  async resetWorktreeClean(worktreeDir: string): Promise<void> {
    await this.runGit(['-C', worktreeDir, 'checkout', '--', '.']);
    await this.runGit(['-C', worktreeDir, 'clean', '-fdx']);
  }

  async getWorktreeDiff(worktreeDir: string): Promise<string> {
    await this.runGit(['-C', worktreeDir, 'add', '-N', '--', 'src']);
    const { stdout } = await this.runGit(['-C', worktreeDir, 'diff', 'HEAD', '--', 'src']);
    return stdout;
  }

  async exportDiffPatch(worktreeDir: string, outputPatchPath: string): Promise<string> {
    const diff = await this.getWorktreeDiff(worktreeDir);
    const absOut = path.resolve(outputPatchPath);
    await mkdir(path.dirname(absOut), { recursive: true });
    await writeFile(absOut, diff, 'utf8');
    return absOut;
  }

  async commitAndPushBranch(input: {
    readonly repo: DfeRepoEntry;
    readonly worktreeDir: string;
    readonly branchName: string;
    readonly commitMessage: string;
    readonly pathsToStage?: readonly string[];
  }): Promise<void> {
    const remoteUrl = assertAllowedGitRemote(input.repo.giteaUrl, this.allowLocalFileRemotes);
    const safeBranch = assertValidBranchName(input.branchName);

    const stageTargets = input.pathsToStage && input.pathsToStage.length > 0 ? input.pathsToStage : ['src'];
    await this.runGit(['-C', input.worktreeDir, 'add', '--', ...stageTargets]);
    await this.runGit([
      '-c',
      `user.name=${this.gitAuthorName}`,
      '-c',
      `user.email=${this.gitAuthorEmail}`,
      '-C',
      input.worktreeDir,
      'commit',
      '-m',
      input.commitMessage,
    ]);
    await this.runGitRemote([
      '-c',
      'http.followRedirects=false',
      '-C',
      input.worktreeDir,
      'push',
      '-u',
      '--',
      remoteUrl,
      `refs/heads/${safeBranch}:refs/heads/${safeBranch}`,
    ]);
  }

  private async runGit(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await this.execFileFn(this.gitBin, args, {
        shell: false,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        timeout: this.timeoutMs,
        env: buildSanitizedToolchainEnv(),
      });
    } catch (error) {
      const details = extractExecFailureDetails(error);
      throw new Error(`Falha Git: ${scrubSecret([details.message, details.stderr].filter(Boolean).join(' | '))}`);
    }
  }

  private async runGitRemote(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    const pat = this.secretStore ? await this.secretStore.getSecret(GITEA_PAT_SECRET_KEY) : null;
    let askpass: { readonly dir: string; readonly scriptPath: string; readonly token: string } | undefined;
    try {
      const env = buildSanitizedToolchainEnv();
      env.GIT_TERMINAL_PROMPT = '0';
      if (pat && pat.trim().length > 0) {
        askpass = await createEphemeralAskpass(this.tempDirRoot, pat);
        env.GIT_ASKPASS = askpass.scriptPath;
        env.NTC_GIT_ASKPASS_TOKEN = askpass.token;
      }

      return await this.execFileFn(this.gitBin, ['-c', 'http.followRedirects=false', ...args], {
        shell: false,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        timeout: this.timeoutMs,
        env,
      });
    } catch (error) {
      const details = extractExecFailureDetails(error);
      const raw = [details.message, details.stderr].filter(Boolean).join(' | ');
      const cleaned = scrubSecret(raw, pat ?? undefined);
      if (/authentication failed|failed to authenticate/i.test(raw)) {
        if (!pat || pat.trim().length === 0) {
          throw new Error(
            `Falha Git remoto: Token Gitea PAT ('${GITEA_PAT_SECRET_KEY}') não configurado. Cadastre-o na aba BYOK & Doctor. (${cleaned})`,
          );
        }
        throw new Error(
          `Falha Git remoto: Autenticação recusada pelo Gitea — verifique se o Token Gitea PAT ('${GITEA_PAT_SECRET_KEY}') na aba BYOK & Doctor é válido e tem acesso ao repositório. (${cleaned})`,
        );
      }
      throw new Error(`Falha Git remoto: ${cleaned}`);
    } finally {
      if (askpass) {
        await rm(askpass.dir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
