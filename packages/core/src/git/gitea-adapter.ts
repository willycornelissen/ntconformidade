import { z } from 'zod';
import { GITEA_PAT_SECRET_KEY, HttpsUrlSchema, type DfeRepoEntry } from '../domain/types.js';
import { isSafeHttpsUrl } from '../domain/validators.js';
import {
  HttpStatusError,
  postJsonWithManualRedirects,
  scrubSecret,
  type FetchFn,
} from '../llm/http-client.js';
import type {
  GitMavenForgePort,
  MavenTestRunResult,
  SecretStorePort,
} from '../ports/interfaces.js';
import { HostMavenRunner } from '../toolchain/host-maven-runner.js';
import { WorktreeManager } from './worktree-manager.js';

/** Parsed Gitea repository coordinates (`baseUrl`, `owner`, `repoName`). */
export interface ParsedGiteaRepo {
  readonly baseUrl: string;
  readonly owner: string;
  readonly repoName: string;
}

/** Input options for opening a Gitea Pull Request. */
export interface OpenGiteaPrInput {
  readonly repo: DfeRepoEntry;
  readonly headBranch: string;
  readonly title: string;
  readonly body: string;
}

const GiteaPrResponseSchema = z.object({
  html_url: HttpsUrlSchema.optional(),
  url: HttpsUrlSchema.optional(),
  number: z.number().int().optional(),
});

/** Parses and validates a Gitea HTTPS repository URL (including corporate internal domains). */
export function parseGiteaRepoUrl(giteaUrl: string): ParsedGiteaRepo {
  if (!isSafeHttpsUrl(giteaUrl, false)) {
    throw new Error(`URL Gitea insegura ou inválida (HTTPS sem credenciais obrigatório): '${giteaUrl}'`);
  }
  const parsed = new URL(giteaUrl);
  const segments = parsed.pathname
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);

  const owner = segments[segments.length - 2];
  const repoName = segments[segments.length - 1];
  if (!owner || !repoName) {
    throw new Error(`URL Gitea não contém '<owner>/<repo>': '${giteaUrl}'`);
  }
  return { baseUrl: parsed.origin, owner, repoName };
}

/** Gitea REST API v1 client for Pull Request creation with strict HTTPS and secret scrubbing. */
export class GiteaAdapter {
  private readonly secretStore: SecretStorePort;
  private readonly fetchFn?: FetchFn;

  constructor(options: { readonly secretStore: SecretStorePort; readonly fetchFn?: FetchFn }) {
    this.secretStore = options.secretStore;
    this.fetchFn = options.fetchFn;
  }

  async openPullRequest(input: OpenGiteaPrInput): Promise<{ readonly prUrl: string }> {
    const rawPat = await this.secretStore.getSecret(GITEA_PAT_SECRET_KEY);
    const pat = rawPat?.trim() ?? '';
    if (pat.length === 0) {
      throw new Error(`Gitea PAT não configurado no keychain ('${GITEA_PAT_SECRET_KEY}')`);
    }

    const { baseUrl, owner, repoName } = parseGiteaRepoUrl(input.repo.giteaUrl);
    const apiUrl = `${baseUrl}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/pulls`;

    try {
      const rawJson = await postJsonWithManualRedirects({
        url: apiUrl,
        headers: { Authorization: `token ${pat}` },
        body: {
          title: input.title,
          head: input.headBranch,
          base: input.repo.baseBranch,
          body: input.body,
        },
        allowLoopbackHttp: false,
        allowPrivateHttps: true,
        secretToRedact: pat,
        fetchFn: this.fetchFn,
      });

      const parsed = GiteaPrResponseSchema.parse(rawJson);
      const prUrl = parsed.html_url ?? parsed.url;
      if (!prUrl) {
        throw new Error('Gitea API não retornou html_url ao criar Pull Request');
      }
      return { prUrl };
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 409) {
        throw new Error(
          `Conflito 409 ao abrir PR no Gitea: já existe PR aberto para '${input.headBranch}' (${error.message})`,
        );
      }
      const msg = scrubSecret(error instanceof Error ? error.message : String(error), pat);
      throw new Error(`Falha ao criar PR no Gitea: ${msg}`);
    }
  }
}

/** Concrete `GitMavenForgePort` combining `WorktreeManager`, `HostMavenRunner`, and `GiteaAdapter`. */
export class GiteaForgeBridge implements GitMavenForgePort {
  private readonly worktrees: WorktreeManager;
  private readonly maven: HostMavenRunner;
  private readonly gitea: GiteaAdapter;
  private readonly useRelease8Flag: boolean | (() => Promise<boolean>);
  private resolvedRelease8Flag: boolean | null = null;

  constructor(options: {
    readonly worktrees: WorktreeManager;
    readonly maven: HostMavenRunner;
    readonly gitea: GiteaAdapter;
    readonly useRelease8Flag?: boolean | (() => Promise<boolean>);
  }) {
    this.worktrees = options.worktrees;
    this.maven = options.maven;
    this.gitea = options.gitea;
    this.useRelease8Flag = options.useRelease8Flag ?? false;
  }

  ensureBareMirror(repo: DfeRepoEntry, mirrorsRootDir: string): Promise<string> {
    return this.worktrees.ensureBareMirror(repo, mirrorsRootDir);
  }

  getRemoteBranchHead(repo: DfeRepoEntry, branch: string): Promise<string> {
    return this.worktrees.getRemoteBranchHead(repo, branch);
  }

  createInspectionWorktree(bareRepoDir: string, commitSha: string, worktreeDir: string): Promise<void> {
    return this.worktrees.createInspectionWorktree(bareRepoDir, commitSha, worktreeDir);
  }

  createWorktree(
    bareRepoDir: string,
    branchName: string,
    baseCommitSha: string,
    worktreeDir: string,
  ): Promise<void> {
    return this.worktrees.createWorktree(bareRepoDir, branchName, baseCommitSha, worktreeDir);
  }

  resetWorktreeClean(worktreeDir: string): Promise<void> {
    return this.worktrees.resetWorktreeClean(worktreeDir);
  }

  removeWorktree(bareRepoDir: string, worktreeDir: string): Promise<void> {
    return this.worktrees.removeWorktree(bareRepoDir, worktreeDir);
  }

  getWorktreeDiff(worktreeDir: string): Promise<string> {
    return this.worktrees.getWorktreeDiff(worktreeDir);
  }

  exportDiffPatch(worktreeDir: string, outputPatchPath: string): Promise<string> {
    return this.worktrees.exportDiffPatch(worktreeDir, outputPatchPath);
  }

  async runMavenTest(worktreeDir: string, createdTestClasses: readonly string[]): Promise<MavenTestRunResult> {
    if (this.resolvedRelease8Flag === null) {
      this.resolvedRelease8Flag =
        typeof this.useRelease8Flag === 'function'
          ? await this.useRelease8Flag()
          : this.useRelease8Flag;
    }
    return this.maven.runMavenTests({
      worktreeDir,
      useRelease8Flag: this.resolvedRelease8Flag,
      createdTestFiles: createdTestClasses,
    });
  }

  async commitPushAndOpenPr(input: {
    readonly repo: DfeRepoEntry;
    readonly worktreeDir: string;
    readonly branchName: string;
    readonly commitMessage: string;
    readonly prTitle: string;
    readonly prBodyMarkdown: string;
  }): Promise<{ readonly prUrl: string }> {
    await this.worktrees.commitAndPushBranch({
      repo: input.repo,
      worktreeDir: input.worktreeDir,
      branchName: input.branchName,
      commitMessage: input.commitMessage,
    });
    return this.gitea.openPullRequest({
      repo: input.repo,
      headBranch: input.branchName,
      title: input.prTitle,
      body: input.prBodyMarkdown,
    });
  }
}
