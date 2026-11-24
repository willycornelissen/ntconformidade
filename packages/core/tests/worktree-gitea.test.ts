import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DfeRepoEntry } from '../src/domain/types.js';
import type { FetchFn } from '../src/llm/http-client.js';
import type { SecretStorePort } from '../src/ports/interfaces.js';
import { GiteaAdapter, GiteaForgeBridge, parseGiteaRepoUrl } from '../src/git/gitea-adapter.js';
import { HostMavenRunner } from '../src/toolchain/host-maven-runner.js';
import { WorktreeManager } from '../src/git/worktree-manager.js';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createBareOriginWithMainCommit(): { bareDir: string; commitSha: string } {
  const root = createTempDir('ntc-git-');
  const bareDir = path.join(root, 'origin.git');
  const seedDir = path.join(root, 'seed');

  execFileSync('git', ['init', '--bare', '--initial-branch=main', bareDir]);
  execFileSync('git', ['clone', bareDir, seedDir]);
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: seedDir });
  execFileSync('git', ['config', 'user.email', 'test@fazenda.mg.gov.br'], { cwd: seedDir });

  mkdirSync(path.join(seedDir, 'src/main/java'), { recursive: true });
  writeFileSync(path.join(seedDir, 'src/main/java/Nfe.java'), 'public class Nfe {}\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: seedDir });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: seedDir });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: seedDir });

  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: seedDir,
    encoding: 'utf8',
  }).trim();
  return { bareDir, commitSha };
}

function makeSecretStore(pat: string): SecretStorePort {
  return {
    async setSecret() {},
    async getSecret(key) {
      return key === 'ntc:gitea:pat' ? pat : null;
    },
    async getSecretStatus(key) {
      return { configured: key === 'ntc:gitea:pat' && pat.length > 0 };
    },
    async deleteSecret() {},
  };
}

const SAMPLE_REPO: DfeRepoEntry = {
  dfe: 'NFe',
  repoSlug: 'nfe-parser',
  giteaUrl: 'https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfe-parser',
  baseBranch: 'main',
  basePackage: 'br.gov.mg.fazenda.nfeparser',
  domainPackage: 'br.gov.mg.fazenda.nfeparser.nfe',
  mapperPackage: 'br.gov.mg.fazenda.nfeparser.mapper',
  tablePackage: 'br.gov.mg.fazenda.nfeparser.table',
  parserPackage: 'br.gov.mg.fazenda.nfeparser.parser',
  utilPackage: 'br.gov.mg.fazenda.nfeparser.util',
  tagPrefix: 'NFEPROC',
  svrsRelativePath: '/Nfe/Documentos',
  baselineNt: null,
};

describe('WorktreeManager & GiteaAdapter', () => {
  it('WG-01: real bare git repo mirror, worktree creation, untracked-aware diff, .patch export, and cleanup', async () => {
    const { bareDir, commitSha } = createBareOriginWithMainCommit();
    const workRoot = createTempDir('ntc-wt-root-');
    const mirrorsRoot = path.join(workRoot, 'mirrors');
    const worktreeDir = path.join(workRoot, 'active-wt');
    const patchFile = path.join(workRoot, 'artifacts', 'fix.patch');

    const localRepo: DfeRepoEntry = {
      ...SAMPLE_REPO,
      giteaUrl: `file://${bareDir}` as string,
    };

    const manager = new WorktreeManager({ allowLocalFileRemotes: true });
    const mirrorPath = await manager.ensureBareMirror(localRepo, mirrorsRoot);
    expect(existsSync(path.join(mirrorPath, 'HEAD'))).toBe(true);

    const headSha = await manager.getRemoteBranchHead(localRepo, 'main');
    expect(headSha).toBe(commitSha);

    await manager.createWorktree(mirrorPath, 'ntc/nfe-nt-2025.002', commitSha, worktreeDir);
    writeFileSync(path.join(worktreeDir, 'src/main/java/Nfe.java'), 'public class Nfe { int v = 1; }\n', 'utf8');
    mkdirSync(path.join(worktreeDir, 'src/test/resources/synthetic'), { recursive: true });
    writeFileSync(path.join(worktreeDir, 'src/test/resources/synthetic/sample.xml'), '<nfeProc/>\n', 'utf8');

    const diff = await manager.getWorktreeDiff(worktreeDir);
    expect(diff).toContain('Nfe.java');
    expect(diff).toContain('synthetic/sample.xml');

    await manager.exportDiffPatch(worktreeDir, patchFile);
    expect(readFileSync(patchFile, 'utf8')).toContain('synthetic/sample.xml');

    await manager.removeWorktree(mirrorPath, worktreeDir);
    expect(existsSync(worktreeDir)).toBe(false);
  }, 15_000);

  it('WG-02: rejects unsafe HTTP git remotes and invalid branch names', async () => {
    const manager = new WorktreeManager();
    const httpRepo: DfeRepoEntry = {
      ...SAMPLE_REPO,
      giteaUrl: 'http://gitea.local/Integracao/nfe-parser',
    };

    await expect(manager.ensureBareMirror(httpRepo, createTempDir('ntc-m-'))).rejects.toThrow(
      /HTTPS|segura/i,
    );
    await expect(
      manager.createWorktree('/tmp/mirror.git', '--upload-pack=evil', '1'.repeat(40), '/tmp/wt'),
    ).rejects.toThrow(/branch inválido/i);
  });

  it('WG-03: commitAndPush uses ephemeral GIT_ASKPASS in tmpdir (never in URL/args) and cleans up askpass dir', async () => {
    const seenEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const seenArgs: Array<readonly string[]> = [];
    let askpassScriptExistedDuringRun = false;
    let askpassScriptPath = '';
    let askpassUsernameOut = '';
    let askpassPasswordOut = '';

    const manager = new WorktreeManager({
      secretStore: makeSecretStore('gitea-pat-secret-999'),
      execFileFn: async (_file, args, options) => {
        seenArgs.push(args);
        seenEnvs.push(options?.env);
        const askpass = options?.env?.GIT_ASKPASS;
        if (askpass) {
          askpassScriptPath = askpass;
          askpassScriptExistedDuringRun = existsSync(askpass);
          askpassUsernameOut = execFileSync(askpass, ["Username for 'https://gitea.apps.ticio.fazenda.mg.gov.br':"], {
            env: options?.env,
            encoding: 'utf8',
          }).trim();
          askpassPasswordOut = execFileSync(askpass, ["Password for 'https://gitea.apps.ticio.fazenda.mg.gov.br':"], {
            env: options?.env,
            encoding: 'utf8',
          }).trim();
        }
        return { stdout: 'ok', stderr: '' };
      },
    });

    await manager.commitAndPushBranch({
      repo: SAMPLE_REPO,
      worktreeDir: '/tmp/wt',
      branchName: 'ntc/nfe-2025-002',
      commitMessage: 'feat(nt-2025.002): adapt NFe schema',
    });

    const pushArgs = seenArgs.find((a) => a.includes('push'));
    expect(pushArgs?.join(' ')).not.toContain('gitea-pat-secret-999');
    expect(askpassScriptExistedDuringRun).toBe(true);
    expect(askpassUsernameOut).toBe('gitea-pat-secret-999');
    expect(askpassPasswordOut).toBe('x-oauth-basic');
    expect(existsSync(askpassScriptPath)).toBe(false);

    const missingPatMgr = new WorktreeManager({
      secretStore: makeSecretStore(''),
      execFileFn: async () => {
        throw new Error("remote: Failed to authenticate user\nfatal: Authentication failed for 'https://gitea/repo/'");
      },
    });
    await expect(missingPatMgr.getRemoteBranchHead(SAMPLE_REPO, 'main')).rejects.toThrow(/ntc:gitea:pat.*BYOK & Doctor/i);
  });

  it('WG-04: parseGiteaRepoUrl & GiteaAdapter openPullRequest send token auth, scrub secrets, and handle 409', async () => {
    expect(parseGiteaRepoUrl(SAMPLE_REPO.giteaUrl)).toEqual({
      baseUrl: 'https://gitea.apps.ticio.fazenda.mg.gov.br',
      owner: 'Integracao',
      repoName: 'nfe-parser',
    });

    let seenAuth = '';
    const fetchFn: FetchFn = async (url, init) => {
      seenAuth = (init.headers as Record<string, string>)['Authorization'] ?? '';
      expect(url).toBe('https://gitea.apps.ticio.fazenda.mg.gov.br/api/v1/repos/Integracao/nfe-parser/pulls');
      return new Response(
        JSON.stringify({
          html_url: 'https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfe-parser/pulls/42',
          number: 42,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    };

    const adapter = new GiteaAdapter({
      secretStore: makeSecretStore('gitea-pat-secret-abc'),
      fetchFn,
    });

    const pr = await adapter.openPullRequest({
      repo: SAMPLE_REPO,
      headBranch: 'ntc/nfe-2025-002',
      title: 'chore(nt-2025.002): adequação v1.30',
      body: 'Gerado pelo NT Conformidade',
    });

    expect(seenAuth).toBe('token gitea-pat-secret-abc');
    expect(pr.prUrl).toBe('https://gitea.apps.ticio.fazenda.mg.gov.br/Integracao/nfe-parser/pulls/42');

    const conflictAdapter = new GiteaAdapter({
      secretStore: makeSecretStore('gitea-pat-secret-abc'),
      fetchFn: async () => new Response('pull request already exists with gitea-pat-secret-abc', { status: 409 }),
    });

    let conflictErr = '';
    try {
      await conflictAdapter.openPullRequest({
        repo: SAMPLE_REPO,
        headBranch: 'ntc/nfe-2025-002',
        title: 'dup',
        body: 'dup',
      });
    } catch (error) {
      conflictErr = error instanceof Error ? error.message : String(error);
    }
    expect(conflictErr).toMatch(/409|PR aberto/i);
    expect(conflictErr).not.toContain('gitea-pat-secret-abc');
  });

  it('WG-05: GiteaForgeBridge delegates worktree/maven/PR lifecycle and allows corporate internal HTTPS Gitea', async () => {
    const internalRepo: DfeRepoEntry = {
      ...SAMPLE_REPO,
      giteaUrl: 'https://git.fazenda.internal/Integracao/nfe-parser.git',
    };
    expect(parseGiteaRepoUrl(internalRepo.giteaUrl)).toEqual({
      baseUrl: 'https://git.fazenda.internal',
      owner: 'Integracao',
      repoName: 'nfe-parser',
    });

    const missingPatAdapter = new GiteaAdapter({
      secretStore: makeSecretStore(''),
      fetchFn: async () => new Response('{}', { status: 201 }),
    });
    await expect(
      missingPatAdapter.openPullRequest({
        repo: internalRepo,
        headBranch: 'nc/test',
        title: 't',
        body: 'b',
      }),
    ).rejects.toThrow(/PAT não configurado/i);

    const { bareDir, commitSha } = createBareOriginWithMainCommit();
    const root = createTempDir('ntc-bridge-');
    const localRepo: DfeRepoEntry = { ...SAMPLE_REPO, giteaUrl: `file://${bareDir}` };
    const worktrees = new WorktreeManager({ allowLocalFileRemotes: true });
    const maven = new HostMavenRunner({
      execFileFn: async () => ({ stdout: '[INFO] BUILD SUCCESS', stderr: '' }),
    });
    const gitea = new GiteaAdapter({
      secretStore: makeSecretStore('pat-bridge-123'),
      fetchFn: async () =>
        new Response(JSON.stringify({ html_url: 'https://git.fazenda.internal/Integracao/nfe-parser/pulls/12' }), {
          status: 201,
        }),
    });
    const bridge = new GiteaForgeBridge({ worktrees, maven, gitea, useRelease8Flag: true });

    const bare = await bridge.ensureBareMirror(localRepo, path.join(root, 'mirrors'));
    expect(await bridge.getRemoteBranchHead(localRepo, 'main')).toBe(commitSha);

    const inspectWt = path.join(root, 'inspect-wt');
    await bridge.createInspectionWorktree(bare, commitSha, inspectWt);
    await bridge.removeWorktree(bare, inspectWt);

    const activeWt = path.join(root, 'active-wt');
    await bridge.createWorktree(bare, 'nc/nfe-nt-test', commitSha, activeWt);
    writeFileSync(path.join(activeWt, 'src/main/java/Nfe.java'), 'public class Nfe { int x; }\n', 'utf8');
    expect(await bridge.getWorktreeDiff(activeWt)).toContain('int x');
    await bridge.resetWorktreeClean(activeWt);
    expect(await bridge.getWorktreeDiff(activeWt)).toBe('');

    const mvnRes = await bridge.runMavenTest(activeWt, []);
    expect(mvnRes.passed).toBe(true);
    await bridge.exportDiffPatch(activeWt, path.join(root, 'p.patch'));

    const prRemoteBridge = new GiteaForgeBridge({
      worktrees: new WorktreeManager({
        secretStore: makeSecretStore('pat-bridge-123'),
        execFileFn: async () => ({ stdout: '', stderr: '' }),
      }),
      maven,
      gitea,
    });
    const pushedPr = await prRemoteBridge.commitPushAndOpenPr({
      repo: internalRepo,
      worktreeDir: activeWt,
      branchName: 'nc/nfe-nt-test',
      commitMessage: 'feat: adapt',
      prTitle: 'PR Title',
      prBodyMarkdown: 'PR Body',
    });
    expect(pushedPr.prUrl).toContain('/pulls/12');

    await bridge.removeWorktree(bare, activeWt);
  }, 15_000);
});
